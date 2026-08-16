/**
 * extlens Backend over AgenticMigrator's run/ directory. Each run produced by
 * `migrate --out <dir>` contains the migrated MV3 tree (out/), the static
 * analysis (analysis.json), the migration verification result (report.json),
 * and the recorded source path (source-path.txt). The adapter serves the
 * migrated output through the SDK's default analysis flow (computeProfile over
 * the on-disk tree) and maps report.json to the protocol Report.
 *
 * Run layout: the run root may be a single run (contains out/) or a directory
 * of runs (each subdirectory with out/ is one run). Extension ids are the run
 * directory names.
 *
 * An optional source dir (the corpus) adds unmigrated extensions: every
 * extension root that no run's source-path.txt points at is listed with an MV2
 * profile and hasMv3: false. They are read-only (no run dir to write reports
 * into). A corpus entry may hold its manifest directly (<id>/manifest.json) or
 * nested (downloads land as <id>/mv2 and <id>/mv3 pairs; mv2 is the source).
 */
import { join, basename, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
    computeProfile,
    summarizeManifest,
    type Backend,
    type ExtensionProfile,
    type ExtensionSource,
    type ListParams,
    type ListResult,
    type Report as ExtlensReport,
    type ReportDraft,
    type SourceFile,
    type HostController,
} from "extlens-sdk";

const MAX_TEXT_FILE = 10 * 1024 * 1024;

interface RunEntry {
    id: string;
    dir: string;
}

/** A source extension: a corpus subdirectory or a single extension dir. */
export interface SourceEntry {
    id: string;
    dir: string;
}

/**
 * True when `dir` holds a Chrome extension manifest (declares manifest_version).
 * The corpus root may carry a downloader metadata manifest.json (no
 * manifest_version); it must not count as an extension.
 */
function isExtensionRoot(dir: string): boolean {
    const mf = join(dir, "manifest.json");
    if (!existsSync(mf)) return false;
    try {
        const parsed = JSON.parse(readFileSync(mf, "utf8")) as { manifest_version?: unknown };
        return Number.isFinite(parsed.manifest_version);
    } catch {
        return false;
    }
}

/**
 * Locate the extension root inside `dir`: a directory with a Chrome extension
 * manifest. Prefers `dir` itself, then `dir/mv2` (corpus layout: <id>/mv2 and
 * <id>/mv3 pairs; the migrator consumes the MV2 source), then the shallowest
 * nested directory with one. Returns null when none exists.
 */
function findExtensionRoot(dir: string): string | null {
    if (isExtensionRoot(dir)) return dir;
    const mv2 = join(dir, "mv2");
    if (isExtensionRoot(mv2)) return mv2;
    let best: string | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    const walk = (d: string, depth: number) => {
        if (depth >= bestDepth) return;
        for (const entry of readdirSync(d).sort()) {
            const p = join(d, entry);
            if (!statSync(p).isDirectory()) continue;
            if (isExtensionRoot(p)) {
                best = p;
                bestDepth = depth + 1;
            } else {
                walk(p, depth + 1);
            }
        }
    };
    walk(dir, 0);
    return best;
}

/**
 * Collect served source extensions. `sourceDir` may be a corpus (subdirs that
 * contain a manifest.json, directly or nested) or a single extension dir;
 * `extraSource` is a positional extension dir. Entries dedupe by resolved path.
 */
export function collectSources(sourceDir: string | null, extraSource: string | null = null): SourceEntry[] {
    const out: SourceEntry[] = [];
    const seen = new Set<string>();
    const add = (id: string, dir: string) => {
        const resolved = resolve(dir);
        if (seen.has(resolved)) return;
        seen.add(resolved);
        out.push({ id, dir: resolved });
    };
    if (sourceDir && existsSync(sourceDir)) {
        const sd = resolve(sourceDir);
        if (isExtensionRoot(sd)) {
            add(basename(sd), sd);
        } else {
            for (const entry of readdirSync(sd).sort()) {
                const p = join(sd, entry);
                if (!statSync(p).isDirectory()) continue;
                const root = findExtensionRoot(p);
                if (root) add(entry, root);
            }
        }
    }
    if (extraSource && existsSync(extraSource)) {
        add(basename(extraSource), resolve(extraSource));
    }
    return out;
}

/** A run dir holds the migrated MV3 output at out/manifest.json. */
function isRunDir(dir: string): boolean {
    return existsSync(join(dir, "out")) && existsSync(join(dir, "out", "manifest.json"));
}

function findRuns(runRoot: string): RunEntry[] {
    if (!existsSync(runRoot)) return [];
    if (isRunDir(runRoot)) return [{ id: basename(runRoot), dir: runRoot }];
    return readdirSync(runRoot)
        .sort()
        .filter((entry) => {
            const p = join(runRoot, entry);
            return statSync(p).isDirectory() && isRunDir(p);
        })
        .map((entry) => ({ id: entry, dir: join(runRoot, entry) }));
}

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return null;
    }
}

function fileType(path: string): SourceFile["type"] {
    const ext = path.toLowerCase().split(".").pop() ?? "";
    if (["js", "mjs", "cjs", "ts"].includes(ext)) return "js";
    if (["html", "htm"].includes(ext)) return "html";
    if (ext === "css") return "css";
    return "other";
}

function readTree(dir: string, prefix = ""): SourceFile[] {
    const files: SourceFile[] = [];
    for (const entry of readdirSync(dir).sort()) {
        if (entry === "node_modules" || entry === ".git") continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            files.push(...readTree(full, `${prefix}${entry}/`));
        } else if (stat.size <= MAX_TEXT_FILE) {
            files.push({ path: `${prefix}${entry}`, type: fileType(entry), content: readFileSync(full, "utf8") });
        }
    }
    return files;
}

function outDir(run: RunEntry): string {
    return join(run.dir, "out");
}

function extensionSource(run: RunEntry): ExtensionSource {
    const dir = outDir(run);
    // Default to {} while the migration writes out/ (manifest may be mid-write
    // and unparseable); computeProfile must not throw on it.
    const manifest = (readJson(join(dir, "manifest.json")) ?? {}) as ExtensionSource["manifest"];
    return { id: run.id, manifest, files: readTree(dir) };
}

/** Migration verification result written by the container. */
interface MigrateReport {
    passed: boolean;
    serviceWorker: string | null;
    extensionId: string | null;
    reason: string | null;
    errors: string[];
    turns: number;
}

function mtimeMs(path: string): number {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return Date.now();
    }
}

function migrateReportToProtocol(run: RunEntry, r: MigrateReport | null): ExtlensReport | null {
    if (!r) return null;
    const notes = [
        r.reason ? `reason: ${r.reason}` : null,
        r.errors.length ? `errors: ${r.errors.join("; ")}` : null,
        `turns: ${r.turns}`,
    ]
        .filter((x): x is string => x !== null)
        .join("\n");
    const ts = new Date(mtimeMs(join(run.dir, "report.json"))).toISOString();
    return {
        id: run.id,
        extensionId: r.extensionId ?? run.id,
        tested: r.passed,
        createdAt: ts,
        updatedAt: ts,
        overallWorking: r.passed,
        hasErrors: r.errors.length > 0,
        seemsSlower: null,
        needsLogin: null,
        isPopupBroken: null,
        isSettingsBroken: null,
        isInteresting: null,
        notes,
        listeners: [],
    };
}

export function makeAgenticBackend(runRoot: string, sources: SourceEntry[] = [], host?: HostController): Backend {
    runRoot = resolve(runRoot);
    const sourcePath = (run: RunEntry): string | null => {
        const p = join(run.dir, "source-path.txt");
        return existsSync(p) ? resolve(readFileSync(p, "utf8").trim()) : null;
    };

    const cached = new Map<string, { sig: string; source: ExtensionSource; profile: ExtensionProfile }>();
    const profileFor = (run: RunEntry) => {
        // Invalidate the cache when out/ changes: the server may run across a
        // whole migration and the manifest mtime changes as the container writes.
        const sig = `${run.id}:${mtimeMs(join(outDir(run), "manifest.json"))}`;
        const hit = cached.get(run.id);
        if (hit && hit.sig === sig) return { source: hit.source, profile: hit.profile };
        const source = extensionSource(run);
        const profile: ExtensionProfile = { ...computeProfile(source), hasMv3: true };
        cached.set(run.id, { sig, source, profile });
        return { source, profile };
    };

    const sourceCached = new Map<string, { sig: string; source: ExtensionSource; profile: ExtensionProfile }>();
    const sourceProfileFor = (src: SourceEntry) => {
        const sig = `${src.id}:${mtimeMs(join(src.dir, "manifest.json"))}`;
        const hit = sourceCached.get(src.id);
        if (hit && hit.sig === sig) return { source: hit.source, profile: hit.profile };
        const manifest = (readJson(join(src.dir, "manifest.json")) ?? {}) as ExtensionSource["manifest"];
        const source: ExtensionSource = { id: src.id, manifest, files: readTree(src.dir) };
        const profile: ExtensionProfile = { ...computeProfile(source), hasMv3: false };
        const entry = { sig, source, profile };
        sourceCached.set(src.id, entry);
        return entry;
    };

    type Row = { id: string; entry: { kind: "run"; run: RunEntry } | { kind: "source"; src: SourceEntry } };
    const profileOf = (row: Row) =>
        row.entry.kind === "run" ? profileFor(row.entry.run) : sourceProfileFor(row.entry.src);
    const allRows = (): Row[] => {
        const runs = findRuns(runRoot);
        // A source extension counts as migrated when a run's source-path.txt
        // points at it; the run row then represents it (hasMv3: true).
        const migratedDirs = new Set(runs.map(sourcePath).filter((p): p is string => p !== null));
        const unmigrated = sources.filter((s) => !migratedDirs.has(resolve(s.dir)));
        return [
            ...runs.map((run) => ({ id: run.id, entry: { kind: "run", run } as const })),
            ...unmigrated.map((src) => ({ id: src.id, entry: { kind: "source", src } as const })),
        ];
    };

    return {
        async listExtensions(params: ListParams): Promise<ListResult> {
            const rows = allRows();
            const search = params.search?.trim().toLowerCase();
            let filtered = rows;
            if (search) {
                filtered = rows.filter((r) => r.id.toLowerCase().includes(search));
            }
            if (params.sort === "name") {
                filtered = [...filtered].sort((a, b) => a.id.localeCompare(b.id));
            } else if (params.sort === "interestingness_asc") {
                filtered = [...filtered].sort((a, b) => profileOf(a).profile.score - profileOf(b).profile.score);
            } else {
                filtered = [...filtered].sort((a, b) => profileOf(b).profile.score - profileOf(a).profile.score);
            }

            const start = (params.page - 1) * params.pageSize;
            const page = filtered.slice(start, start + params.pageSize);

            const extensions = page.map((row) => {
                const { source, profile } = profileOf(row);
                const manifest = source.manifest as { version?: string; manifest_version?: number } | null;
                return {
                    id: row.id,
                    name: profile.name,
                    version: manifest?.version ?? null,
                    manifestVersion: manifest?.manifest_version ?? (row.entry.kind === "run" ? 3 : 2),
                    score: profile.score,
                    tags: profile.tags,
                    hasMv3: row.entry.kind === "run",
                };
            });

            const scores = filtered.map((r) => profileOf(r).profile.score);
            return {
                extensions,
                stats: {
                    total: filtered.length,
                    analyzed: filtered.length,
                    withMv3: filtered.filter((r) => r.entry.kind === "run").length,
                    avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
                },
                page: params.page,
                pageSize: params.pageSize,
                totalPages: Math.max(1, Math.ceil(filtered.length / params.pageSize)),
            };
        },

        async getExtension(id: string) {
            const run = findRuns(runRoot).find((r) => r.id === id);
            if (run) {
                const { source, profile } = profileFor(run);
                const mv2Path = sourcePath(run);
                let mv2: ExtensionProfile["mv2"] = null;
                if (mv2Path && existsSync(join(mv2Path, "manifest.json"))) {
                    const mv2Manifest = (readJson(join(mv2Path, "manifest.json")) ?? {}) as ExtensionSource["manifest"];
                    mv2 = summarizeManifest(mv2Manifest, readTree(mv2Path), basename(mv2Path));
                }
                return { source, profile: { ...profile, mv2 } };
            }
            const src = sources.find((s) => s.id === id);
            if (src) {
                const { source, profile } = sourceProfileFor(src);
                return { source, profile };
            }
            return null;
        },

        async getFiles(id: string) {
            const run = findRuns(runRoot).find((r) => r.id === id);
            if (run) {
                const mv2 = sourcePath(run);
                return {
                    ...(mv2 ? { mv2 } : {}),
                    mv3: outDir(run),
                };
            }
            const src = sources.find((s) => s.id === id);
            if (src) return { mv2: src.dir };
            return null;
        },

        async getReport(extensionId: string) {
            const run = findRuns(runRoot).find((r) => r.id === extensionId);
            if (!run) return null; // unmigrated sources have no report
            const manual = readJson(join(run.dir, "report.manual.json")) as ExtlensReport | null;
            if (manual) return manual;
            return migrateReportToProtocol(run, readJson(join(run.dir, "report.json")) as MigrateReport | null);
        },

        async submitReport(report: ReportDraft) {
            const now = new Date().toISOString();
            const doc: ExtlensReport = {
                ...report,
                id: `manual-${report.extensionId}`,
                createdAt: now,
                updatedAt: now,
            };
            const run = findRuns(runRoot).find((r) => r.id === report.extensionId);
            if (!run) {
                const src = sources.find((s) => s.id === report.extensionId);
                if (src) throw new Error(`cannot submit report for unmigrated extension: ${report.extensionId}`);
                throw new Error(`unknown extension: ${report.extensionId}`);
            }
            writeFileSync(join(run.dir, "report.manual.json"), JSON.stringify(doc, null, 2));
            return doc.id;
        },
        ...(host ? { host } : {}),
    };
}
