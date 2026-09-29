/**
 * extlens server for AgenticMigrator. The backend serves the run/ directory;
 * an optional source dir adds unmigrated corpus extensions.
 *
 * Two entry points:
 * - `migrate --extlens-port <port>` (see cli.ts) serves the run it just wrote.
 * - Standalone: `tsx src/extlens/index.ts [--port 8081] [--host 0.0.0.0] [--run ./run] [--source-dir <corpus>]`
 *   serves a pre-populated run directory without re-running a migration.
 *
 * Two layouts, told apart by what is on disk (host/runs.ts, isRunsRoot):
 * - A RUNS ROOT holds one directory per run, each with a run.json manifest, plus a blobs/ store. The
 *   client can create runs, switch between them and delete them. This is what `--runs` makes.
 * - A FLAT root holds extension directories directly. Every existing run on disk looks like this and
 *   keeps working untouched: one model from the environment, and no run UI (runs.* answer -32601).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createExtlensServer } from "extlens-sdk";
import { isRunsRoot } from "../host/runs.js";
import { createRunSwitch } from "./runs.js";
import { providerModels } from "./providerModels.js";
import { collectSources, makeAgenticBackend } from "./adapter.js";
import { MigratorController } from "./migrator.js";
import { Registry } from "./registry.js";
import { reportSdkCheck } from "./sdkCheck.js";
import logger from "../logger.js";

export function startExtlensServer(
    opts: {
        port?: number;
        host?: string;
        runDir?: string;
        sourceDir?: string;
        extraSource?: string;
        /**
         * Treat `runDir` as a runs root even when it is empty, so the client can create the first
         * run into it. A root that already holds runs is detected without this.
         */
        runs?: boolean;
    } = {},
) {
    const runDir = opts.runDir ?? (process.env.EXTLENS_RUN_DIR ?? process.env.EXLENS_RUN_DIR) ?? "./run";
    const sourceDir = opts.sourceDir ?? (process.env.EXTLENS_SOURCE_DIR ?? process.env.EXLENS_SOURCE_DIR) ?? null;
    const port = opts.port ?? Number((process.env.EXTLENS_PORT ?? process.env.EXLENS_PORT) ?? 8081);
    // EXLENS_* (missing the T) was the original spelling and is what existing shell history and
    // scripts set; EXTLENS_* is the documented one. Both work, documented one wins.
    const bindHost = opts.host ?? process.env.EXTLENS_HOST ?? process.env.EXLENS_HOST;
    // Before anything is served: is the SDK we loaded the one that was built? A stale copy makes
    // the analyzer look broken rather than out of date (see sdkCheck.ts).
    reportSdkCheck();
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const sources = collectSources(sourceDir, opts.extraSource ?? null);
    const srcs = sources.length ? `, ${sources.length} source(s)` : "";

    // Runs mode: a directory of runs the client manages. Detected from disk so pointing at an
    // existing runs root just works; `runs: true` opts an empty directory in.
    if (opts.runs || isRunsRoot(runDir)) {
        const runs = createRunSwitch({
            root: runDir,
            defaultCorpus: sourceDir ? resolve(sourceDir) : null,
            cwd: repoRoot,
            models: () => providerModels(),
        });
        // Passed as-is, never spread: its members delegate to the active run through getters, and a
        // spread would evaluate them once and freeze the first run's session into the server.
        const server = createExtlensServer({ port, host: bindHost, backend: runs.backend });
        logger.info(
            `extlens server on ws://${bindHost ?? "0.0.0.0"}:${server.port} ` +
            `(runs root ${runDir}, serving ${runs.activeRunDir() ?? "no run yet"}${srcs})`,
            { module: "extlens" },
        );
        return {
            get port(): number {
                return server.port;
            },
            close: async () => {
                runs.dispose();
                await server.close();
            },
        };
    }

    const registry = new Registry(runDir);
    registry.syncSources(sources);
    registry.seedRunsFromDisk();
    const host = new MigratorController({ runRoot: runDir, sources, cwd: repoRoot }, registry);
    const server = createExtlensServer({ port, host: bindHost, backend: makeAgenticBackend(runDir, registry, host) });
    logger.info(`extlens server on ws://${bindHost ?? "0.0.0.0"}:${server.port} (run dir ${runDir}${srcs})`, { module: "extlens" });
    // Close also aborts any host.start migration the client triggered.
    return {
        get port(): number {
            return server.port;
        },
        close: async () => {
            host.dispose();
            registry.close();
            await server.close();
        },
    };
}

// Standalone entry: tsx src/extlens/index.ts [--port N] [--run <dir>] [--source-dir <dir>]
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const arg = (flag: string) => {
        const i = process.argv.indexOf(flag);
        return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
    };
    const portArg = arg("--port");
    const hostArg = arg("--host");
    const runArg = arg("--run");
    const sourceArg = arg("--source-dir");
    const runsFlag = process.argv.includes("--runs");
    const server = startExtlensServer({
        ...(portArg !== undefined ? { port: Number(portArg) } : {}),
        ...(hostArg !== undefined ? { host: hostArg } : {}),
        ...(runArg !== undefined ? { runDir: runArg } : {}),
        ...(sourceArg !== undefined ? { sourceDir: sourceArg } : {}),
        ...(runsFlag ? { runs: true } : {}),
    });
    const stop = async () => {
        await server.close();
        process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}
