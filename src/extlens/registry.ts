/**
 * SQLite registry (better-sqlite3) for the extlens server: a persistent index
 * over the run/ directory plus the controller's ephemeral lifecycle state.
 *
 * The filesystem stays the source of truth for artifacts (out/, plan.json,
 * analysis.json, report.json, migrate.jsonl, source-path.txt). The DB holds:
 *   sources — the discovered source corpus (id -> dir), reseeded each start
 *   runs    — one row per run dir: state/phase/timestamps, the report summary
 *             (passed/reason), and the last captured log tail
 *
 * The server lists runs and sources from the DB, so a restart preserves the
 * status and tail the client last saw. On-disk run dirs are reconciled into
 * the DB at startup, and rows a crashed server left "running" are orphaned.
 */
import { basename, join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import Database from "better-sqlite3";

/** A served source extension: a corpus subdirectory or a single extension dir. */
export interface SourceEntry {
    id: string;
    dir: string;
}

/** A run: the run directory name plus its absolute path. */
export interface RunEntry {
    id: string;
    dir: string;
}

/**
 * One `runs` row. `state` mirrors HostStatus.state (idle|running|stopping);
 * `phase` is preparing|migrating|verifying|done|failed|stopped.
 */
export interface RunRow {
    id: string;
    source_dir: string | null;
    state: string;
    phase: string | null;
    started_at: string | null;
    ended_at: string | null;
    report_passed: number | null;
    report_reason: string | null;
    tail: string | null;
    updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  dir TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  source_dir TEXT,
  state TEXT NOT NULL DEFAULT 'idle',
  phase TEXT,
  started_at TEXT,
  ended_at TEXT,
  report_passed INTEGER,
  report_reason TEXT,
  tail TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_updated ON runs(updated_at DESC);
`;

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return null;
    }
}

/** True when `dir` holds a migrated MV3 output at out/manifest.json. */
export function isRunDir(dir: string): boolean {
    return existsSync(join(dir, "out")) && existsSync(join(dir, "out", "manifest.json"));
}

/** On-disk run discovery: the run root itself or its subdirectories. */
export function findRunsOnDisk(runRoot: string): RunEntry[] {
    const root = resolve(runRoot);
    if (!existsSync(root)) return [];
    if (isRunDir(root)) return [{ id: basename(root), dir: root }];
    return readdirSync(root)
        .sort()
        .filter((entry) => {
            const p = join(root, entry);
            return statSync(p).isDirectory() && isRunDir(p);
        })
        .map((entry) => ({ id: entry, dir: join(root, entry) }));
}

/** Phase derived from run dir contents, independent of any live child. */
export function derivePhaseFromDir(dir: string): string {
    const report = readJson(join(dir, "report.json")) as { passed?: boolean } | null;
    if (report) return report.passed ? "done" : "failed";
    if (existsSync(join(dir, "out", "manifest.json"))) return "verifying";
    if (existsSync(join(dir, "plan.json")) || existsSync(join(dir, "analysis.json"))) return "migrating";
    return "preparing";
}

export class Registry {
    private readonly runRoot: string;
    private readonly db: Database.Database;

    constructor(runRoot: string) {
        this.runRoot = resolve(runRoot);
        mkdirSync(this.runRoot, { recursive: true });
        this.db = new Database(join(this.runRoot, "migrator.db"));
        this.db.pragma("journal_mode = WAL");
        this.db.exec(SCHEMA);
    }

    close(): void {
        this.db.close();
    }

    /** Replace the source list with the current scan (upsert + prune stale). */
    syncSources(entries: SourceEntry[]): void {
        const now = new Date().toISOString();
        const upsert = this.db.prepare(
            `INSERT INTO sources (dir, id, added_at) VALUES (?, ?, ?)
             ON CONFLICT(dir) DO UPDATE SET id = excluded.id`,
        );
        for (const e of entries) upsert.run(resolve(e.dir), e.id, now);
        if (entries.length === 0) {
            this.db.prepare("DELETE FROM sources").run();
            return;
        }
        const placeholders = entries.map(() => "?").join(", ");
        this.db
            .prepare(`DELETE FROM sources WHERE dir NOT IN (${placeholders})`)
            .run(...entries.map((e) => resolve(e.dir)));
    }

    listSources(): SourceEntry[] {
        const rows = this.db.prepare("SELECT dir, id FROM sources ORDER BY id").all() as {
            dir: string;
            id: string;
        }[];
        return rows.map((r) => ({ id: r.id, dir: r.dir }));
    }

    /**
     * Reconcile on-disk runs into the DB (a row per run dir, phase derived from
     * disk) and orphan rows a crashed server left in running/stopping state.
     */
    seedRunsFromDisk(): void {
        const now = new Date().toISOString();
        const insert = this.db.prepare(
            `INSERT OR IGNORE INTO runs (id, source_dir, state, phase, started_at, ended_at, tail, updated_at)
             VALUES (?, NULL, 'idle', ?, NULL, NULL, NULL, ?)`,
        );
        for (const run of findRunsOnDisk(this.runRoot)) {
            insert.run(run.id, derivePhaseFromDir(run.dir), now);
        }
        this.db
            .prepare(
                `UPDATE runs SET state = 'idle', ended_at = ?, tail = COALESCE(tail, '') || ?
                 WHERE state IN ('running', 'stopping')`,
            )
            .run(now, "\n(server restarted mid-migration; run orphaned)");
    }

    /** Record a job start: the row resets to running/preparing. */
    startRun(id: string, sourceDir: string, startedAt: string): void {
        this.db
            .prepare(
                `INSERT INTO runs (id, source_dir, state, phase, started_at, tail, updated_at)
                 VALUES (?, ?, 'running', 'preparing', ?, '', ?)
                 ON CONFLICT(id) DO UPDATE SET
                   source_dir = excluded.source_dir, state = 'running', phase = 'preparing',
                   started_at = excluded.started_at, ended_at = NULL, tail = '',
                   updated_at = excluded.updated_at`,
            )
            .run(id, resolve(sourceDir), startedAt, new Date().toISOString());
    }

    /** Patch lifecycle fields (state/phase/tail) of a live run. */
    updateRun(id: string, patch: { state?: string; phase?: string | null; tail?: string | null }): void {
        const fields: string[] = [];
        const values: unknown[] = [];
        if (patch.state !== undefined) {
            fields.push("state = ?");
            values.push(patch.state);
        }
        if (patch.phase !== undefined) {
            fields.push("phase = ?");
            values.push(patch.phase);
        }
        if (patch.tail !== undefined) {
            fields.push("tail = ?");
            values.push(patch.tail);
        }
        if (fields.length === 0) return;
        fields.push("updated_at = ?");
        values.push(new Date().toISOString(), id);
        this.db.prepare(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }

    /** Record a job end: idle state plus the terminal phase and report summary. */
    finishRun(id: string, phase: string, tail: string | null, report: { passed: boolean; reason: string | null } | null): void {
        const now = new Date().toISOString();
        this.db
            .prepare(
                `UPDATE runs SET state = 'idle', phase = ?, ended_at = ?, tail = ?,
                   report_passed = ?, report_reason = ?, updated_at = ?
                 WHERE id = ?`,
            )
            .run(phase, now, tail ?? "", report ? (report.passed ? 1 : 0) : null, report?.reason ?? null, now, id);
    }

    getRun(id: string): RunRow | null {
        const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
        return row ?? null;
    }

    listRuns(): RunRow[] {
        return this.db.prepare("SELECT * FROM runs ORDER BY id").all() as unknown as RunRow[];
    }

    /** Most recently updated run row (restart continuity for the controller). */
    mostRecentRun(): RunRow | null {
        const row = this.db.prepare("SELECT * FROM runs ORDER BY updated_at DESC LIMIT 1").get() as RunRow | undefined;
        return row ?? null;
    }
}
