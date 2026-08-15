/**
 * extlens server for AgenticMigrator. The backend serves the run/ directory.
 *
 * Two entry points:
 * - `migrate --extlens-port <port>` (see cli.ts) serves the run it just wrote.
 * - Standalone: `tsx src/extlens/index.ts [--port 8081] [--run ./run]` serves a
 *   pre-populated run directory without re-running a migration.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createExtlensServer } from "extlens-sdk";
import { makeAgenticBackend } from "./adapter.js";
import logger from "../logger.js";

export function startExtlensServer(opts: { port?: number; runDir?: string } = {}) {
    const runDir = opts.runDir ?? process.env.EXLENS_RUN_DIR ?? "./run";
    const port = opts.port ?? Number(process.env.EXLENS_PORT ?? 8081);
    const server = createExtlensServer({ port, backend: makeAgenticBackend(runDir) });
    logger.info(`extlens server on ws://localhost:${server.port} (run dir ${runDir})`, { module: "extlens" });
    return server;
}

// Standalone entry: tsx src/extlens/index.ts [--port N] [--run <dir>]
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const arg = (flag: string) => {
        const i = process.argv.indexOf(flag);
        return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
    };
    const portArg = arg("--port");
    const runArg = arg("--run");
    const server = startExtlensServer({
        ...(portArg !== undefined ? { port: Number(portArg) } : {}),
        ...(runArg !== undefined ? { runDir: runArg } : {}),
    });
    const stop = async () => {
        await server.close();
        process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}
