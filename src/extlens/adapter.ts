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
 */
import { join, basename, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
    computeProfile,
    type Backend,
    type ExtensionProfile,
    type ExtensionSource,
    type ListParams,
    type ListResult,
    type Report as ExtlensReport,
    type ReportDraft,
    type SourceFile,
} from "extlens-sdk";

const MAX_TEXT_FILE = 10 * 1024 * 1024;

interface RunEntry {
    id: string;
    dir: string;
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
    const manifest = readJson(join(dir, "manifest.json")) as ExtensionSource["manifest"];
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

export function makeAgenticBackend(runRoot: string): Backend {
    const sourcePath = (run: RunEntry): string | null => {
        const p = join(run.dir, "source-path.txt");
        return existsSync(p) ? resolve(readFileSync(p, "utf8").trim()) : null;
    };

    const cached = new Map<string, { source: ExtensionSource; profile: ExtensionProfile }>();
    const profileFor = (run: RunEntry) => {
        const hit = cached.get(run.id);
        if (hit) return hit;
        const source = extensionSource(run);
        const profile: ExtensionProfile = { ...computeProfile(source), hasMv3: true };
        const entry = { source, profile };
        cached.set(run.id, entry);
        return entry;
    };

    return {
        async listExtensions(params: ListParams): Promise<ListResult> {
            const runs = findRuns(runRoot);
            const search = params.search?.trim().toLowerCase();
            let filtered = runs;
            if (search) {
                filtered = runs.filter((r) => r.id.toLowerCase().includes(search));
            }
            if (params.sort === "name") {
                filtered = [...filtered].sort((a, b) => a.id.localeCompare(b.id));
            } else if (params.sort === "interestingness_asc") {
                filtered = [...filtered].sort((a, b) => profileFor(a).profile.score - profileFor(b).profile.score);
            } else {
                filtered = [...filtered].sort((a, b) => profileFor(b).profile.score - profileFor(a).profile.score);
            }

            const start = (params.page - 1) * params.pageSize;
            const page = filtered.slice(start, start + params.pageSize);

            const extensions = page.map((run) => {
                const { profile } = profileFor(run);
                const manifest = profileFor(run).source.manifest as { name?: string; version?: string; manifest_version?: number } | null;
                return {
                    id: run.id,
                    name: manifest?.name ?? run.id,
                    version: manifest?.version ?? null,
                    manifestVersion: manifest?.manifest_version ?? 3,
                    score: profile.score,
                    tags: profile.tags,
                    hasMv3: true,
                };
            });

            const scores = filtered.map((r) => profileFor(r).profile.score);
            return {
                extensions,
                stats: {
                    total: filtered.length,
                    analyzed: filtered.length,
                    withMv3: filtered.length,
                    avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
                },
                page: params.page,
                pageSize: params.pageSize,
                totalPages: Math.max(1, Math.ceil(filtered.length / params.pageSize)),
            };
        },

        async getExtension(id: string) {
            const run = findRuns(runRoot).find((r) => r.id === id);
            if (!run) return null;
            const { source, profile } = profileFor(run);
            return { source, profile };
        },

        async getFiles(id: string) {
            const run = findRuns(runRoot).find((r) => r.id === id);
            if (!run) return null;
            const mv2 = sourcePath(run);
            return {
                ...(mv2 ? { mv2 } : {}),
                mv3: outDir(run),
            };
        },

        async getReport(extensionId: string) {
            const run = findRuns(runRoot).find((r) => r.id === extensionId);
            if (!run) return null;
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
            if (!run) throw new Error(`unknown extension: ${report.extensionId}`);
            writeFileSync(join(run.dir, "report.manual.json"), JSON.stringify(doc, null, 2));
            return doc.id;
        },
    };
}
