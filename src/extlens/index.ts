/**
 * extlens server for AgenticMigrator. It serves a RUNS ROOT: a directory of runs, where a run is one
 * model's attempt at one corpus (see host/runs.ts). An optional source dir supplies the corpus a new
 * run gets by default.
 *
 * Two entry points:
 * - `migrate --extlens-port <port>` (see cli.ts) serves `--out` and waits for the client.
 * - Standalone: `tsx src/extlens/index.ts [--port 8081] [--host 0.0.0.0] [--run ./runs] [--source-dir <corpus>]`
 *
 * There is exactly one layout. An empty or missing directory is not a special case — it is what a
 * fresh root looks like, and the server creates what it needs and serves no runs until the client
 * makes one. The alternative, sniffing the directory and falling back to an older flat layout, meant
 * the run UI silently vanished depending on what happened to be on disk.
 */
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createExtlensServer } from "extlens-sdk";
import { createRunSwitch } from "./runs.js";
import { providerModels } from "./providerModels.js";
import { collectSources } from "./adapter.js";
import { reportSdkCheck } from "./sdkCheck.js";
import logger from "../logger.js";

export function startExtlensServer(
    opts: { port?: number; host?: string; runDir?: string; sourceDir?: string; extraSource?: string } = {},
) {
    const runDir = opts.runDir ?? (process.env.EXTLENS_RUN_DIR ?? process.env.EXLENS_RUN_DIR) ?? "./runs";
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

    // Generate the structure rather than requiring it: pointing at a path that does not exist yet is
    // the normal way to start a new set of runs.
    mkdirSync(resolve(runDir), { recursive: true });

    const runs = createRunSwitch({
        root: runDir,
        defaultCorpus: sourceDir ? resolve(sourceDir) : null,
        cwd: repoRoot,
        models: () => providerModels(),
    });
    // Passed as-is, never spread: its members delegate to the active run through getters, and a spread
    // would evaluate them once and freeze the first run's session into the server.
    const server = createExtlensServer({ port, host: bindHost, backend: runs.backend });
    logger.info(
        `extlens server on ws://${bindHost ?? "0.0.0.0"}:${server.port} ` +
        `(runs root ${resolve(runDir)}, serving ${runs.activeRunDir() ?? "no run yet"}${srcs})`,
        { module: "extlens" },
    );
    // Close also aborts any migration the client triggered.
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
    const server = startExtlensServer({
        ...(portArg !== undefined ? { port: Number(portArg) } : {}),
        ...(hostArg !== undefined ? { host: hostArg } : {}),
        ...(runArg !== undefined ? { runDir: runArg } : {}),
        ...(sourceArg !== undefined ? { sourceDir: sourceArg } : {}),
    });
    const stop = async () => {
        await server.close();
        process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}
