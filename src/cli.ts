// Host CLI: serve runs and sources over extlens; migrations start on demand.
//   migrate [--source-dir <corpus|ext-dir>] [--out <run-dir>] [--port <n>]
//   migrate <extension-dir>            (register pending source, serve)
// With the server on (always), nothing migrates automatically: a positional
// extension dir is registered as a pending source and the client triggers the
// migration via the protocol's host.start (see src/extlens/migrator.ts). The
// controller spawns a one-shot child with MIGRATOR_ONESHOT=1 set in its env. --source-dir accepts a corpus (subdirs with manifest.json)
// or a single extension dir.
// Pipeline (TS/pi port of src/manager.py's host side):
//   1. convert (vendored emc, Python subprocess)
//   2. static analysis -> plan.json + analysis.json
//   3. docker run the migrator image (pi agent + headed verify) with mounts
//   4. report exit status; migrated extension lands in <run-dir>/out
import { createHash } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, basename } from "node:path";
import { SecretSpec, SecretSpecError } from "secretspec";
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

// Resolve LLM_API_KEY from secretspec (1Password backend) when the environment does not
// already provide it. Fail fast: the saia endpoint refuses requests without the key.
async function resolveApiKey(): Promise<void> {
    if (process.env.LLM_API_KEY) return;
    let resolved: import("secretspec").Resolved;
    try {
        resolved = await SecretSpec.builder()
            .withReason("agentic-migrator cli: resolve LLM_API_KEY")
            .loadAsync();
    } catch (e) {
        const kind = e instanceof SecretSpecError ? ` (kind: ${e.kind})` : "";
        const detail = e instanceof Error ? e.message : String(e);
        logger.error(
            `LLM_API_KEY is not set and secretspec could not resolve it${kind}: ${detail}`, { module: "cli" }
        );
        logger.error("Start the 1Password desktop app (Settings → Developer → Integrate with 1Password CLI) and run 'secretspec set LLM_API_KEY'. Alternatively export LLM_API_KEY.");
        process.exit(1);
    }
    const value = resolved.secrets.LLM_API_KEY?.get();
    if (!value) {
        logger.error("LLM_API_KEY is not set: secretspec returned an empty value. Run 'secretspec set LLM_API_KEY'.");
        process.exit(1);
    }
    process.env.LLM_API_KEY = value;
}

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

/**
 * Resolve migration targets for the CLI. A positional extension dir and a
 * --source-dir are combined via collectSources (single extension or corpus of
 * extensions). When a positional dir is itself a corpus (its subdirectories
 * hold extensions), it is promoted to the source slot so corpus recursion
 * applies; otherwise it is a single extra extension.
 */
async function collectSourcesForCli(sourceDir: string | null, extPath: string | null): Promise<{ id: string; dir: string }[]> {
    const mod = await import("./extlens/adapter.js");
    const collect = mod.collectSources;
    if (!sourceDir) return collect(extPath, null);
    return collect(sourceDir, extPath);
}

async function main() {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        logger.info("usage: migrate [--source-dir <corpus|ext-dir>] [--out <run-dir>] [--port <n>] [<extension-dir>]");
        logger.info("  no positional arg  serve runs (+ sources); wait for host.start from the client");
        logger.info("  <extension-dir>     single extension or a corpus of extensions to migrate");
        process.exit(0);
    }
    const args = process.argv.slice(2);
    const valueFlags = new Set(["--out", "--port", "--extlens-port", "--source-dir"]);
    const extInput = args.find((a, i) => !a.startsWith("--") && a !== "-h" && !(i > 0 && valueFlags.has(args[i - 1])));
    const extPath = extInput ? resolve(extInput) : null;
    const runDir = resolve(arg("--out", "./run"));
    const sourceArg = arg("--source-dir", "");
    const sourceDir = sourceArg || process.env.EXLENS_SOURCE_DIR || null;
    // Internal one-shot mode: the extlens controller (src/extlens/migrator.ts)
    // spawns the migration child with MIGRATOR_ONESHOT=1. Not a user-facing flag.
    const oneShot = process.env.MIGRATOR_ONESHOT === "1";
    const parsedPort = Number(process.env.EXLENS_PORT ?? arg("--extlens-port", arg("--port", "8081")));
    const port = Number.isFinite(parsedPort) && parsedPort > 0 ? Math.trunc(parsedPort) : 8081;

    if (extPath && !existsSync(join(extPath, "manifest.json"))) {
        logger.warn(`${extPath} has no manifest.json; it will not be listed as an extension`, { module: "cli" });
    }

    // extlens server, always on for the CLI. It never auto-migrates: the client
    // triggers host.start, and the controller runs the migration as a child.
    const extlens = await import("./extlens/index.js");
    let server: { port: number; close(): Promise<void> } | null = null;
    if (!oneShot) {
        mkdirSync(runDir, { recursive: true });
        if (sourceDir && !existsSync(sourceDir)) {
            logger.warn(`source dir ${sourceDir} does not exist; no unmigrated extensions will be listed`, { module: "cli" });
        }
        server = extlens.startExtlensServer({
            port,
            runDir,
            ...(sourceDir ? { sourceDir } : {}),
            ...(extPath ? { extraSource: extPath } : {}),
        });
        logger.info(`extlens server serving ${runDir} on port ${server.port}`, { module: "cli" });
    }

    // Interactive mode: serve runs and pending sources; wait for the client.
    if (server) {
        if (extPath) {
            logger.info(`extension ${extPath} registered as pending source (id \"${basename(extPath)}\"); waiting for host.start from the client`, { module: "cli" });
        } else {
            logger.info(`serving existing runs under ${runDir} (no migration requested)`, { module: "cli" });
        }
        await waitForSignal();
        await server.close();
        process.exit(0);
    }

    // One-shot / headless migration path (MIGRATOR_ONESHOT=1, what the extlens
    // controller spawns as a detached child). Auto-detects the input shape: a
    // single extension dir, a corpus dir of extensions, or a --source-dir. It
    // migrates every target into the output root.
    const targets = await collectSourcesForCli(sourceDir, extPath);
    if (targets.length === 0) {
        logger.error("nothing to do: pass an extension dir or --source-dir to migrate");
        process.exit(64);
    }

    // Resolve the LLM key and build/verify the Docker image once for all jobs.
    await resolveApiKey();
    if (!process.env.MIGRATOR_IMAGE) ensureImage();

    let migrated = 0;
    let failed = 0;
    for (const target of targets) {
        // A single positional extension keeps the legacy flat layout
        // (<out>/out, <out>/report.json). A corpus writes one subdir per
        // extension (<out>/<id>/out).
        const isSingleDirect = targets.length === 1 && extPath && resolve(target.dir) === resolve(extPath);
        const jobDir = isSingleDirect ? runDir : join(runDir, target.id);
        if (isMigrated(jobDir)) {
            logger.info(`skip ${target.id}: already migrated`, { module: "cli" });
            migrated += 1;
            continue;
        }
        logger.info(`migrating ${target.id} (${target.dir})`, { module: "cli" });
        const code = await migrateOne(target.dir, jobDir);
        if (code === 0) migrated += 1;
        else {
            failed += 1;
            logger.error(`extension ${target.id} failed (exit ${code})`, { module: "cli" });
        }
    }
    logger.info(`migration complete: ${migrated} migrated, ${failed} failed`, { module: "cli" });
    process.exit(failed ? 1 : 0);
}

/** True when a job dir already holds a successful migration report. */
function isMigrated(jobDir: string): boolean {
    const reportPath = join(jobDir, "report.json");
    if (!existsSync(reportPath)) return false;
    try {
        const r = JSON.parse(readFileSync(reportPath, "utf8")) as { passed?: boolean };
        return r.passed === true;
    } catch {
        return false;
    }
}

/**
 * Migrate one extension into runDir. The run dir starts fresh. Returns the
 * container/process exit code (0 on success, non-zero on failure).
 */
async function migrateOne(extPath: string, runDir: string): Promise<number> {
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

    return code;
}

function waitForSignal(): Promise<void> {
    return new Promise((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
    });
}

main().catch((e) => { logger.error("fatal: " + e, { module: "cli" }); process.exit(1); });
