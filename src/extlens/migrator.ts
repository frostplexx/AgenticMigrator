/**
 * HostController for the extlens protocol: starts and aborts a real migration
 * and reports lifecycle status. The controller spawns the host CLI as a child
 * process (`MIGRATOR_ONESHOT=1 cli.ts <source> --out <runRoot>/<id>`) so a migration
 * runs detached from the server loop; the run dir it writes into is served by
 * the adapter the moment `out/` appears.
 *
 * Phases are derived from the run dir, not parsed from logs:
 *   preparing  — child started, nothing written yet
 *   migrating  — plan.json/analysis.json present, no out/ yet (docker phase)
 *   verifying  — out/ present, no report.json yet (container verify loop)
 *   done       — report.json present and passed
 *   failed     — report.json failed, or the child exited without one
 *   stopped    — aborted via host.stop
 * After a job ends, state returns to "idle" while phase/extensionId keep the
 * terminal state of the last job until the next start.
 *
 * host.startAll queues the outstanding sources (no run with phase "done")
 * and runs them one child at a time. One startedAt and one log stream cover
 * the whole queue, so the client log dock shows the run uninterrupted.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ErrorCodes, RpcError, type HostController, type HostLogResult, type HostStatus, type LogLine } from "extlens-sdk";
import { Registry, derivePhaseFromDir, type SourceEntry } from "./registry.js";
import { quotaWallUntil, readRunReport } from "../host/runReport.js";

const TAIL_MAX = 2000;
const MESSAGE_MAX = 300;
/** Max structured log lines held in memory per run (ring buffer). */
const LOG_MAX = 5000;

/** Strip winston's ANSI color codes from captured log lines. */
function stripAnsi(s: string): string {
    return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function clip(s: string): string {
    s = s.trim();
    return s.length > MESSAGE_MAX ? s.slice(-MESSAGE_MAX) : s;
}

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return null;
    }
}

export interface MigratorOptions {
    runRoot: string;
    /** Served source extensions: id -> dir. The child migrates dir into runRoot/<id>. */
    sources: SourceEntry[];
    /** Repo root: the child runs `npx tsx src/cli.ts` from here. */
    cwd: string;
    /** Override the migration command (tests). Default: `npx --no-install tsx src/cli.ts`. */
    command?: string[];
    /**
     * Environment the migration child gets on top of this process's, naming the model to run.
     *
     * Set when the host serves a runs root, from the active run's manifest (see runs.ts). Absent, the
     * child inherits the environment the host was started with — the flat-layout behaviour this host
     * has always had.
     */
    env?: Record<string, string>;
    /**
     * Content-addressed store to hardlink finished output into (host/blobs.ts).
     *
     * Passed to the child as `--blobs`, so the dedupe happens where the run is known to be finished
     * — the agent edits files in place all through a migration, and hardlinking a live run would
     * rewrite every earlier run that shared a byte-identical file. Absent on the flat layout, which
     * has no store and keeps full copies as it always has.
     */
    blobs?: string;
}

interface MigrateReport {
    passed: boolean;
    reason: string | null;
}

/**
 * The model this host migrates with, as the reviewer should see it.
 *
 * Read at call time rather than captured: the host outlives any one migration, and the value comes
 * from the environment it was started with. The provider prefix is kept — "saia/qwen3" and
 * "ollama/qwen3" are different runs and a results table has to be able to tell them apart.
 */
export function configuredModel(): string | null {
    return process.env.LLM_MODEL ?? null;
}

export class MigratorController implements HostController {
    private child: ChildProcessWithoutNullStreams | null = null;
    private extensionId: string | null = null;
    private startedAt: string | null = null;
    private stopping = false;
    private tail = "";
    /** Structured log lines captured this run, in seq order. */
    private logs: LogLine[] = [];
    private seq = 0;
    private pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    /** Terminal status of the most recent job; served until the next start. */
    private last: HostStatus | null = null;
    /** Corpus queue for host.startAll: remaining source ids, in order. */
    private queue: string[] = [];
    /** Sources in the current queue job; 0 for a single host.start. */
    private queueTotal = 0;
    /** Completed/failed runs in the current queue job. */
    private succeeded = 0;
    private failed = 0;
    /** When the current batch began, so a client can derive a rate from it. */
    private batchStartedAt: string | null = null;
    /**
     * When the provider's quota window reopens, once a run has proved it is shut for longer than
     * waiting can cover. Set from the finished run's report; cleared when a batch starts.
     */
    private quotaWall: Date | null = null;

    /**
     * The model this controller will actually run, as the reviewer should see it.
     *
     * The active run's when the host serves a runs root, otherwise the environment's. Read at call
     * time rather than captured, because both can change under a long-lived host — the run by
     * `runs.select`, the environment by whoever started the process.
     */
    private model(): string | null {
        return this.opts.env?.LLM_MODEL ?? configuredModel();
    }

    constructor(
        private readonly opts: MigratorOptions,
        private readonly registry: Registry | null = null,
    ) {
        // Restart continuity: serve the most recent run's terminal state so the
        // client sees the last phase/tail instead of a blank idle status.
        const lastRow = this.registry?.mostRecentRun();
        if (lastRow && lastRow.phase) {
            this.last = {
                state: "idle",
                extensionId: lastRow.id,
                phase: lastRow.phase,
                startedAt: null,
                message: clip(lastRow.tail ?? "") || null,
                model: this.model(),
                progress: this.progress(),
            };
        }
    }

    async getStatus(): Promise<HostStatus> {
        const child = this.child;
        if (!child) {
            return this.last ?? {
                state: "idle",
                extensionId: null,
                phase: null,
                startedAt: null,
                message: null,
                model: this.model(),
                progress: null,
            };
        }
        if (child.exitCode !== null) {
            // Exited between polls; finalize now. finalize() leaves `last` null when it starts
            // the next queued source instead of ending the job, so fall through to the live
            // status of that new child rather than asserting a terminal status exists.
            this.finalize(child.exitCode);
            if (this.last) return this.last;
            return this.getStatus();
        }
        const phase = this.derivePhase();
        // Persist the phase and tail so a restart mid-run preserves them.
        if (this.extensionId) this.registry?.updateRun(this.extensionId, { phase, tail: this.tail });
        return {
            state: this.stopping ? "stopping" : "running",
            extensionId: this.extensionId,
            phase,
            startedAt: this.startedAt,
            message: this.tailMessage(),
            model: this.model(),
            progress: this.progress(),
        };
    }

    /**
     * How far through the batch, or null for a single migration.
     *
     * `done` counts finished attempts rather than successes: the watcher is asking how much is
     * left to wait for, and a failed attempt took just as long as a successful one.
     */
    private progress(): { done: number; total: number; startedAt: string | null } | null {
        if (this.queueTotal <= 0) return null;
        return {
            done: this.succeeded + this.failed,
            total: this.queueTotal,
            startedAt: this.batchStartedAt,
        };
    }

    async getLog(offset: number): Promise<HostLogResult> {
        return { lines: this.logs.filter((l) => l.seq > offset), nextOffset: this.seq };
    }

    async start(id: string): Promise<HostStatus> {
        this.assertIdle();
        this.resetQueue();
        return this.launch(id, new Date().toISOString(), true);
    }

    /** Start the queue: every outstanding source, one child at a time. */
    async startAll(): Promise<HostStatus> {
        this.assertIdle();
        this.resetQueue();
        const pending = this.opts.sources.filter(
            (s) => existsSync(join(s.dir, "manifest.json")) && !this.hasSuccessfulRun(s.id),
        );
        if (pending.length === 0) {
            this.last = {
                state: "idle",
                extensionId: null,
                phase: "done",
                startedAt: null,
                message: "all extensions already migrated",
                model: this.model(),
                progress: this.progress(),
            };
            return this.last;
        }
        this.queue = pending.map((s) => s.id);
        this.queueTotal = this.queue.length;
        this.batchStartedAt = new Date().toISOString();
        const first = this.queue.shift()!;
        return this.launch(first, new Date().toISOString(), true);
    }

    private assertIdle(): void {
        if (this.busy()) {
            throw new RpcError(ErrorCodes.HOST_BUSY, `migration already running for ${this.extensionId}`);
        }
    }

    /**
     * Is a migration in flight right now?
     *
     * Synchronous, unlike getStatus, because the callers that need it must REFUSE rather than wait —
     * and because getStatus finalizes a finished child and writes to the registry, which is not
     * something a read-only question should do. See models.ts, which uses it to reject a model
     * switch that would swap the run root under a running migration.
     */
    busy(): boolean {
        return this.child !== null && this.child.exitCode === null;
    }

    /** Which extension is running, or null. For a caller explaining why it refused. */
    runningExtension(): string | null {
        return this.busy() ? this.extensionId : null;
    }

    private resetQueue(): void {
        this.quotaWall = null;
        this.queue = [];
        this.queueTotal = 0;
        this.succeeded = 0;
        this.failed = 0;
    }

    /** True when the source already produced a successful migration run. */
    private hasSuccessfulRun(id: string): boolean {
        return this.registry?.getRun(id)?.phase === "done";
    }

    /** Reset per-run state and spawn the child for `id`. */
    private launch(id: string, startedAt: string, freshLogs: boolean): HostStatus {
        const src = this.opts.sources.find((s) => s.id === id);
        if (!src || !existsSync(join(src.dir, "manifest.json"))) {
            throw new RpcError(ErrorCodes.UNKNOWN_EXTENSION, `unknown source extension: ${id}`);
        }
        this.last = null;
        this.stopping = false;
        this.extensionId = id;
        this.startedAt = startedAt;
        this.tail = "";
        if (freshLogs) {
            this.logs = [];
            this.seq = 0;
        }
        this.pending = { stdout: "", stderr: "" };
        this.registry?.startRun(id, src.dir, startedAt);

        const runDir = join(resolve(this.opts.runRoot), id);
        const [cmd, ...baseArgs] = this.opts.command ?? ["npx", "--no-install", "tsx", "src/cli.ts"];
        const child = spawn(
            cmd,
            [...baseArgs, src.dir, "--out", runDir, ...(this.opts.blobs ? ["--blobs", this.opts.blobs] : [])],
            {
            cwd: this.opts.cwd,
            env: { ...process.env, ...(this.opts.env ?? {}), MIGRATOR_ONESHOT: "1" },
            detached: true,
        },
        );
        this.child = child;
        child.stdout.on("data", (data: Buffer) => this.capture("stdout", data));
        child.stderr.on("data", (data: Buffer) => this.capture("stderr", data));
        child.on("error", (err) => {
            if (this.child !== child) return; // replaced by a queued continuation
            const msg = `spawn error: ${err.message}`;
            this.tail += `\n${msg}`;
            this.pushLine("stderr", msg);
            this.finalize(1);
        });
        child.on("exit", (code) => {
            if (this.child === child) this.finalize(code ?? 1);
        });
        return {
            state: "running",
            extensionId: id,
            phase: "preparing",
            startedAt,
            message: null,
        };
    }

    async stop(): Promise<HostStatus> {
        const child = this.child;
        if (!child || child.exitCode !== null) {
            return this.getStatus();
        }
        if (!this.stopping) {
            this.stopping = true;
            this.registry?.updateRun(this.extensionId ?? "", { state: "stopping" });
            this.killChild();
        }
        return this.getStatus();
    }

    /** Kill any running child (server shutdown). */
    dispose(): void {
        this.queue = [];
        this.killChild();
    }

    /** SIGTERM the child's whole process group (npx -> tsx -> node). */
    private killChild(): void {
        const child = this.child;
        if (!child || child.exitCode !== null || child.pid === undefined) return;
        try {
            process.kill(-child.pid, "SIGTERM");
        } catch {
            child.kill("SIGTERM");
        }
    }

    private runDir(): string | null {
        return this.extensionId ? join(resolve(this.opts.runRoot), this.extensionId) : null;
    }

    private derivePhase(): string {
        const dir = this.runDir();
        return dir ? derivePhaseFromDir(dir) : "preparing";
    }

    private tailMessage(): string | null {
        const msg = clip(this.tail);
        return msg || null;
    }

    private pushLine(stream: "stdout" | "stderr", text: string): void {
        this.seq += 1;
        this.logs.push({ seq: this.seq, ts: new Date().toISOString(), stream, text });
        if (this.logs.length > LOG_MAX) this.logs.splice(0, this.logs.length - LOG_MAX);
    }

    /** Buffer stdout/stderr chunks, split on newlines, and emit complete lines. */
    private capture(stream: "stdout" | "stderr", data: Buffer): void {
        const text = stripAnsi(String(data));
        this.tail = (this.tail + text).slice(-TAIL_MAX);
        this.pending[stream] += text;
        const idx = this.pending[stream].lastIndexOf("\n");
        if (idx < 0) return;
        const complete = this.pending[stream].slice(0, idx);
        this.pending[stream] = this.pending[stream].slice(idx + 1);
        for (const piece of complete.split("\n")) {
            if (piece.trim()) this.pushLine(stream, piece);
        }
    }

    /** Emit an unterminated last line before exit. */
    private flushPending(): void {
        for (const stream of ["stdout", "stderr"] as const) {
            const rest = this.pending[stream];
            if (rest.trim()) this.pushLine(stream, rest);
            this.pending[stream] = "";
        }
    }

    private finalize(exitCode: number): void {
        // The exit event and getStatus (child.exitCode !== null) can both call
        // this; the first run nulls the child, so later calls are no-ops.
        if (!this.child) return;
        this.flushPending();
        const id = this.extensionId;
        const dir = this.runDir();
        const stopRequested = this.stopping;
        const tail = this.tail;
        this.child = null;

        const report = dir ? (readJson(join(dir, "report.json")) as MigrateReport | null) : null;
        let phase: string;
        let message: string | null;
        if (report) {
            phase = report.passed ? "done" : "failed";
            message = report.passed ? "migration completed" : clip(report.reason ?? (tail || "migration failed"));
        } else if (stopRequested) {
            // npm/npx converts the SIGTERM into a normal exit code, so signalCode
            // is unreliable; the stop flag is the truth.
            phase = "stopped";
            message = "stopped by user";
        } else {
            phase = "failed";
            message = clip(`migration failed (exit ${exitCode})` + (tail ? `: ${tail}` : ""));
        }
        if (id) this.registry?.finishRun(id, phase, tail, report);
        if (phase === "done") this.succeeded += 1;
        else if (phase === "failed") this.failed += 1;

        /*
         * A shut quota window stops the batch rather than the extension.
         *
         * The container waits out a rate limit against the provider's own published reset and gives
         * up when the window is wider than the wait budget — hours, or in the monthly case weeks. The
         * next extension cannot get past that either: it would spend the whole budget to be told the
         * same thing, fifteen minutes at a time, for the rest of the corpus. The CLI's own batch loop
         * has stopped on this since the quota fix; the queue here did not, so a client-driven run
         * marched through the corpus producing nothing but harness failures.
         */
        const wall = dir ? quotaWallUntil(readRunReport(dir)) : null;
        if (wall) {
            this.quotaWall = wall;
            this.failed += this.queue.length;
            this.queue = [];
        }

        // Corpus queue: start the next source with its own startedAt and the
        // same log stream, so the client dock shows the whole run. stopping
        // (host.stop / dispose) drops the remaining queue.
        let continueQueue = !stopRequested && this.queue.length > 0;
        if (continueQueue) {
            const next = this.queue.shift()!;
            try {
                // Its own timestamp, not the batch's. Reusing the first item's made startedAt mean
                // "when the queue began", which is what progress.startedAt is for — and it left the
                // runs table recording the same start for every extension in a batch.
                this.launch(next, new Date().toISOString(), false);
            } catch {
                // Source vanished or unspawnable: count the rest as failed.
                this.failed = this.queueTotal - this.succeeded;
                this.queue = [];
                continueQueue = false;
            }
        }
        if (continueQueue) return;
        this.extensionId = null;
        this.startedAt = null;
        this.stopping = false;
        this.queue = [];
        const queued = this.queueTotal > 0;
        let terminalPhase: string;
        let terminalMessage: string | null;
        if (stopRequested) {
            terminalPhase = "stopped";
            terminalMessage =
                queued && this.succeeded > 0 ? `stopped by user (${this.succeeded} of ${this.queueTotal} migrated)` : "stopped by user";
        } else if (this.quotaWall) {
            // Named rather than counted: "12 failed" invites a retry that cannot work yet.
            terminalPhase = "failed";
            terminalMessage =
                `stopped: the provider's quota is exhausted until ${this.quotaWall.toISOString()}. ` +
                `${this.succeeded} of ${this.queueTotal || 1} migrated before it ran out.`;
        } else if (queued) {
            terminalPhase = this.failed > 0 ? "failed" : "done";
            terminalMessage =
                this.failed > 0
                    ? `${this.succeeded} of ${this.queueTotal} migrated, ${this.failed} failed`
                    : `${this.succeeded} of ${this.queueTotal} migrated`;
        } else {
            terminalPhase = phase;
            terminalMessage = message;
        }
        this.last = {
            state: "idle",
            extensionId: id,
            phase: terminalPhase,
            startedAt: null,
            message: terminalMessage,
                model: this.model(),
                progress: this.progress(),
            };
    }
}
