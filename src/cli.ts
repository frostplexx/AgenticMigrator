// Host CLI: migrate one extension end-to-end.
//   migrate <extension-dir> [--out <run-dir>]
// Pipeline (TS/pi port of src/manager.py's host side):
//   1. convert (vendored emc, Python subprocess)
//   2. static analysis -> plan.json + analysis.json
//   3. docker run the migrator image (pi agent + headed verify) with mounts
//   4. report exit status; migrated extension lands in <run-dir>/out
import { createHash } from "node:crypto";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { StaticAnalyzer, buildAnalysis } from "./host/staticAnalyzer.js";
import { convert } from "./host/convert.js";
import logger from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJ = resolve(__dirname, "..");

// Inline dotenv: load .env (project root) into process.env, never override existing.
(function loadDotenv() {
    const envFile = resolve(__dirname, "..", ".env");
    if (!existsSync(envFile)) return;
    const text = readFileSync(envFile, "utf8");
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes.
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
            val = val.slice(1, -1);
        if (!process.env[key]) process.env[key] = val;
    }
})();

function arg(flag: string, def: string): string {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** Latest mtime under a path (recursive for dirs). 0 if missing. */
function latestMtime(p: string): number {
    try {
        const s = statSync(p);
        if (s.isDirectory()) {
            let latest = s.mtimeMs;
            for (const entry of readdirSync(p))
                latest = Math.max(latest, latestMtime(join(p, entry)));
            return latest;
        }
        return s.mtimeMs;
    } catch {
        return 0;
    }
}

/** Recursively hash a directory's contents (sorted paths). */
function hashDir(dir: string): string {
    const entries: string[] = [];
    function walk(d: string) {
        for (const entry of readdirSync(d)) {
            const p = join(d, entry);
            if (statSync(p).isDirectory()) walk(p);
            else entries.push(relative(dir, p));
        }
    }
    walk(dir);
    entries.sort();
    const h = createHash("sha256");
    for (const e of entries) {
        h.update(e);
        h.update(readFileSync(join(dir, e)));
    }
    return h.digest("hex").slice(0, 16);
}

/** Ensure dist/ is compiled and Docker image is built & tagged. */
function ensureImage(): void {
    // 1. Compile TS if dist/ is stale vs src/.
    if (latestMtime(join(PROJ, "dist")) < latestMtime(join(PROJ, "src"))) {
        logger.warn("dist/ out of date — recompiling...", { module: "cli" });
        execSync("npm run build", { cwd: PROJ, stdio: "inherit" });
    }

    // 2. Hash Docker build inputs.
    const inputFiles = ["Dockerfile", ".dockerignore", "entrypoint.sh", "package.json"];
    const lock = join(PROJ, "package-lock.json");
    if (existsSync(lock)) inputFiles.push("package-lock.json");

    const h = createHash("sha256");
    for (const f of inputFiles) h.update(readFileSync(join(PROJ, f)));
    h.update(hashDir(join(PROJ, "dist")));
    const tag = `agentic-migrator-ts:build-${h.digest("hex").slice(0, 12)}`;

    // 3. If image already exists, use it & skip build.
    try {
        execSync(`docker image inspect ${tag}`, { stdio: "ignore" });
        process.env.MIGRATOR_IMAGE = tag;
        logger.info(`Docker image ${tag} is current`, { module: "cli" });
        return;
    } catch {
        // image missing — build below
    }

    // 4. Build, tagging with content hash + latest.
    logger.info(`building Docker image ${tag} ...`, { module: "cli" });
    execSync(`docker build -t ${tag} -t agentic-migrator-ts:latest .`, { cwd: PROJ, stdio: "inherit" });
    process.env.MIGRATOR_IMAGE = tag;
}

async function main() {
    const extInput = process.argv[2];
    if (!extInput || extInput.startsWith("--")) {
        logger.error("usage: migrate <extension-dir> [--out <run-dir>]");
        process.exit(64);
    }
    const extPath = resolve(extInput);
    const runDir = resolve(arg("--out", "./run"));

    // Fresh run dir. Clear its CONTENTS rather than removing runDir itself: a shell parked in
    // runDir (it's the session's working dir) would otherwise be orphaned when the inode is
    // recreated, and the next command crashes with `ENOENT: uv_cwd`.
    mkdirSync(runDir, { recursive: true });
    for (const entry of readdirSync(runDir)) rmSync(join(runDir, entry), { recursive: true, force: true });
    mkdirSync(join(runDir, "out"), { recursive: true });
    // Record the source extension path so the extlens adapter can serve MV2 file refs.
    writeFileSync(join(runDir, "source-path.txt"), resolve(extPath));

    // 1. convert (host-side deterministic pre-pass).
    logger.info("converting (extension-manifest-converter)...", { module: "cli" });
    const { dir: convertedDir, log: convLog } = convert(extPath);
    if (convLog) {
      for (const line of convLog.split("\n")) logger.info(line, { module: "cli" });
    } else {
      logger.info("(no converter output)", { module: "cli" });
    }

    // 2. static analysis -> plan + analysis.
    const mappings = JSON.parse(readFileSync(join(__dirname, "..", "assets", "api_mappings.json"), "utf8"));
    const { findings, signals } = new StaticAnalyzer(mappings).scan(convertedDir);
    logger.info(`static analysis: ${findings.length} deprecated API site(s), ${signals.length} signal(s)`, { module: "cli" });
    writeFileSync(join(runDir, "plan.json"), JSON.stringify({ findings, signals }, null, 2));
    writeFileSync(join(runDir, "analysis.json"), JSON.stringify(buildAnalysis(findings, convertedDir), null, 2));

    // 3. ensure image is current, then docker run the migrator container.
    if (!process.env.MIGRATOR_IMAGE) ensureImage();
    const migratorImage = process.env.MIGRATOR_IMAGE;
    const portBase = process.env.DOCKER_PORT_BASE ? Number(process.env.DOCKER_PORT_BASE) + 2 : 0;
    const vncEnabled = process.env.ENABLE_VNC === "1";
    if (vncEnabled) {
        logger.silly(`VNC at http://localhost:${portBase}/vnc.html?autoconnect=1`, { module: "cli" });
    }
    const dockerArgs = [
        "run", "--rm", "--shm-size=1g",
        "--add-host=host.docker.internal:host-gateway",
        "-v", `${convertedDir}:/work/extension:ro`,
        "-v", `${runDir}:/work/run`,
        "-e", `LLM_MODEL=${process.env.LLM_MODEL ?? "ollama/gemma4:31b-cloud"}`,
        "-e", `LLM_BASE_URL=${process.env.LLM_BASE_URL ?? "http://host.docker.internal:11434"}`,
        "-e", `LLM_NUM_CTX=${process.env.LLM_NUM_CTX ?? "65536"}`,
        "-e", `MAX_FIX_ATTEMPTS=${process.env.MAX_FIX_ATTEMPTS ?? "3"}`,
        "-e", `LLM_THINKING=${process.env.LLM_THINKING ?? "off"}`,
        "-e", `LOG_FILE=/work/run/migrate.jsonl`,
        ...(process.env.ENABLE_VNC === "1" ? [
            "-e", "ENABLE_VNC=1",
            "-p", `${portBase}:6080`,
        ] : []),
        ...(process.env.LLM_API_KEY ? ["-e", `LLM_API_KEY=${process.env.LLM_API_KEY}`] : []),
        migratorImage!,
        "node", "dist/container/runMigration.js",
    ];
    logger.info("docker run " + migratorImage + " ...", { module: "cli" });
    const code = await new Promise<number>((res) => {
        const p = spawn("docker", dockerArgs, { stdio: "inherit" });
        p.on("close", (c) => res(c ?? 1));
    });

    rmSync(convertedDir, { recursive: true, force: true });

    // 4. report.
    const reportPath = join(runDir, "report.json");
    if (existsSync(reportPath)) {
        const r = JSON.parse(readFileSync(reportPath, "utf8"));
        if (r.passed) {
          logger.success(`Migrated extension in ${join(runDir, "out")}`, { module: "cli" });
        } else {
          logger.error(`Failed to migrate extension in ${join(runDir, "out")}`, { module: "cli" });
        }
        if (r.serviceWorker) logger.info(`service worker: ${r.serviceWorker}`, { module: "cli" });
        if (!r.passed && r.reason) logger.warn(`reason: ${r.reason}`, { module: "cli" });
    } else {
        logger.warn(`no report produced (container exit ${code})`, { module: "cli" });
    }

    // Optional extlens server: serve the completed run and stay alive.
    const extlensPort = Number(process.env.EXLENS_PORT ?? arg("--extlens-port", ""));
    if (extlensPort) {
        const { startExtlensServer } = await import("./extlens/index.js");
        const server = startExtlensServer({ port: extlensPort, runDir });
        logger.info("press Ctrl+C to stop the extlens server", { module: "extlens" });
        await new Promise<void>((res) => {
            process.on("SIGINT", () => res());
            process.on("SIGTERM", () => res());
        });
        await server.close();
    }
    process.exit(code);
}

main().catch((e) => { logger.error("fatal: " + e, { module: "cli" }); process.exit(1); });
