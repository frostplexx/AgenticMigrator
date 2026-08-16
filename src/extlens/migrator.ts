/**
 * HostController for the extlens protocol: starts and aborts a real migration
 * and reports lifecycle status. The controller spawns the host CLI as a child
 * process (`cli.ts <source> --out <runRoot>/<id> --no-server`) so a migration
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
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ErrorCodes, RpcError, type HostController, type HostStatus } from "extlens-sdk";
import type { SourceEntry } from "./adapter.js";

const TAIL_MAX = 2000;
const MESSAGE_MAX = 300;

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
}

interface MigrateReport {
    passed: boolean;
    reason: string | null;
}

export class MigratorController implements HostController {
    private child: ChildProcessWithoutNullStreams | null = null;
    private extensionId: string | null = null;
    private startedAt: string | null = null;
    private stopping = false;
    private tail = "";
    /** Terminal status of the most recent job; served until the next start. */
    private last: HostStatus | null = null;

    constructor(private readonly opts: MigratorOptions) {}

    async getStatus(): Promise<HostStatus> {
        const child = this.child;
        if (!child) {
            return this.last ?? {
                state: "idle",
                extensionId: null,
                phase: null,
                startedAt: null,
                message: null,
            };
        }
        if (child.exitCode !== null) {
            // Exited between polls; finalize now.
            this.finalize(child.exitCode);
            return this.last!;
        }
        return {
            state: this.stopping ? "stopping" : "running",
            extensionId: this.extensionId,
            phase: this.derivePhase(),
            startedAt: this.startedAt,
            message: this.tailMessage(),
        };
    }

    async start(id: string): Promise<HostStatus> {
        if (this.child && this.child.exitCode === null) {
            throw new RpcError(ErrorCodes.HOST_BUSY, `migration already running for ${this.extensionId}`);
        }
        const src = this.opts.sources.find((s) => s.id === id);
        if (!src || !existsSync(join(src.dir, "manifest.json"))) {
            throw new RpcError(ErrorCodes.UNKNOWN_EXTENSION, `unknown source extension: ${id}`);
        }
        const srcDir = src.dir;

        const runDir = join(resolve(this.opts.runRoot), id);
        this.last = null;
        this.stopping = false;
        this.extensionId = id;
        this.startedAt = new Date().toISOString();
        this.tail = "";

        const [cmd, ...baseArgs] = this.opts.command ?? ["npx", "--no-install", "tsx", "src/cli.ts"];
        const child = spawn(cmd, [...baseArgs, srcDir, "--out", runDir, "--no-server"], {
            cwd: this.opts.cwd,
            env: process.env,
            detached: true,
        });
        this.child = child;

        const buffer = (data: Buffer) => {
            this.tail = (this.tail + stripAnsi(String(data))).slice(-TAIL_MAX);
        };
        child.stdout.on("data", buffer);
        child.stderr.on("data", buffer);
        child.on("error", (err) => {
            this.tail += `\nspawn error: ${err.message}`;
            this.finalize(1);
        });
        child.on("exit", (code) => {
            this.finalize(code ?? 1);
        });

        return {
            state: "running",
            extensionId: id,
            phase: "preparing",
            startedAt: this.startedAt,
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
            this.killChild();
        }
        return this.getStatus();
    }

    /** Kill any running child (server shutdown). */
    dispose(): void {
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
        if (!dir) return "preparing";
        if (existsSync(join(dir, "report.json"))) {
            const report = readJson(join(dir, "report.json")) as MigrateReport | null;
            return report?.passed ? "done" : "failed";
        }
        if (existsSync(join(dir, "out", "manifest.json"))) return "verifying";
        if (existsSync(join(dir, "plan.json")) || existsSync(join(dir, "analysis.json"))) return "migrating";
        return "preparing";
    }

    private tailMessage(): string | null {
        const msg = clip(this.tail);
        return msg || null;
    }

    private finalize(exitCode: number): void {
        const child = this.child;
        const id = this.extensionId;
        const dir = this.runDir();
        const stopRequested = this.stopping;
        this.child = null;
        this.extensionId = null;
        this.startedAt = null;
        this.stopping = false;

        const report = dir ? (readJson(join(dir, "report.json")) as MigrateReport | null) : null;
        let phase: string;
        let message: string | null;
        if (report) {
            phase = report.passed ? "done" : "failed";
            message = report.passed ? "migration completed" : clip(report.reason ?? (this.tail || "migration failed"));
        } else if (stopRequested) {
            // npm/npx converts the SIGTERM into a normal exit code, so signalCode
            // is unreliable; the stop flag is the truth.
            phase = "stopped";
            message = "stopped by user";
        } else {
            phase = "failed";
            message = clip(`migration failed (exit ${exitCode})` + (this.tail ? `: ${this.tail}` : ""));
        }
        this.last = {
            state: "idle",
            extensionId: id,
            phase,
            startedAt: null,
            message,
        };
    }
}
