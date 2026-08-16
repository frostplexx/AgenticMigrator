/**
 * extlens server for AgenticMigrator. The backend serves the run/ directory;
 * an optional source dir adds unmigrated corpus extensions.
 *
 * Two entry points:
 * - `migrate --extlens-port <port>` (see cli.ts) serves the run it just wrote.
 * - Standalone: `tsx src/extlens/index.ts [--port 8081] [--run ./run] [--source-dir <corpus>]`
 *   serves a pre-populated run directory without re-running a migration.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createExtlensServer } from "extlens-sdk";
import { collectSources, makeAgenticBackend } from "./adapter.js";
import { MigratorController } from "./migrator.js";
import logger from "../logger.js";

export function startExtlensServer(opts: { port?: number; runDir?: string; sourceDir?: string; extraSource?: string } = {}) {
    const runDir = opts.runDir ?? process.env.EXLENS_RUN_DIR ?? "./run";
    const sourceDir = opts.sourceDir ?? process.env.EXLENS_SOURCE_DIR ?? null;
    const port = opts.port ?? Number(process.env.EXLENS_PORT ?? 8081);
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const sources = collectSources(sourceDir, opts.extraSource ?? null);
    const host = new MigratorController({ runRoot: runDir, sources, cwd: repoRoot });
    const server = createExtlensServer({ port, backend: makeAgenticBackend(runDir, sources, host) });
    const srcs = sources.length ? `, ${sources.length} source(s)` : "";
    logger.info(`extlens server on ws://localhost:${server.port} (run dir ${runDir}${srcs})`, { module: "extlens" });
    // Close also aborts any host.start migration the client triggered.
    return {
        get port(): number {
            return server.port;
        },
        close: async () => {
            host.dispose();
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
    const runArg = arg("--run");
    const sourceArg = arg("--source-dir");
    const server = startExtlensServer({
        ...(portArg !== undefined ? { port: Number(portArg) } : {}),
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
