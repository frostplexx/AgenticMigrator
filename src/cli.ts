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
import { convert, emcDir } from "./host/convert.js";
import { classifyRun, readRunReport } from "./host/runReport.js";
import { hashDir } from "./host/hashDir.js";
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

/**
 * Validate the LLM API key before doing any work. Resolves the key (env or
 * secretspec), then posts a minimal chat-completion to the configured backend
 * to confirm the key is accepted. Exits with a clear error on failure so mis-keys
 * are caught on first boot rather than deep in a migration.
 */
async function validateApiKey(): Promise<void> {
    await resolveApiKey();
    const key = process.env.LLM_API_KEY;
    const model = process.env.LLM_MODEL ?? "ollama/gemma4:31b-cloud";
    // Strip any provider/ prefix (saia/... or ollama/...) to get the model id
    // the API expects, matching src/container/model.ts.
    const id = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
    let base = (process.env.LLM_BASE_URL ?? "http://host.docker.internal:11434").replace(/\/+$/, "");
    if (!/\/v1$/.test(base)) base += "/v1";
    const url = `${base}/chat/completions`;
    logger.info(`validating LLM API key against ${url} (${id})...`, { module: "cli" });
    // The endpoint can fail transiently (vllm boot/load races, 5xx blips).
    // Retry a few times, then degrade to a warning: serving runs does not need
    // the LLM, so a flaky endpoint must not take the server down. Migrations
    // surface a bad key at run time instead.
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: id,
                    messages: [{ role: "user", content: "ping" }],
                    temperature: 0,
                    max_tokens: 1,
                }),
            });
            if (!res.ok) {
                const detail = (await res.text().catch(() => "")).slice(0, 300);
                throw new Error(`HTTP ${res.status}: ${detail || "request rejected"}`);
            }
            await res.json().catch(() => undefined);
            logger.success("LLM API key is valid", { module: "cli" });
            return;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt < attempts) {
                logger.warn(
                    `LLM API key validation failed (${msg}); retrying ${attempt}/${attempts}...`, { module: "cli" }
                );
                await new Promise((r) => setTimeout(r, 3000));
            } else {
                logger.warn(
                    `LLM API key validation failed (${msg}); continuing without the LLM check`, { module: "cli" }
                );
            }
        }
    }
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
    // Hash EVERY directory the Dockerfile copies. assets/ holds the mv3-* migration skills the
    // in-container agent reads; leaving it out meant editing a skill produced the same tag, so
    // `docker image inspect` hit and the run silently used the previous skills.
    h.update(hashDir(join(PROJ, "dist")));
    h.update(hashDir(join(PROJ, "assets")));
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
 * Refuse to start when the vendored extension-manifest-converter submodule is missing.
 * A fresh `git clone` does not fetch submodules, so third_party/extension-manifest-converter
 * stays empty until `git submodule update --init --recursive` runs. Converting MV2
 * manifests requires it; same resolution as convert.ts (EMC_DIR override, else vendored).
 */
function ensureConverter(): void {
    // Resolve through convert.ts's own resolver — never re-derive the path here. A guard that
    // computes it differently passes while convert() looks elsewhere and silently falls back,
    // which shipped 52 unconverted (still-MV2) extensions before it was caught.
    const dir = emcDir();
    if (existsSync(join(dir, "emc.py"))) {
        // File-exists is not enough: a broken python3 or an unimportable emc.py fails the same
        // way at run time, one extension at a time. Smoke-test the converter once, up front.
        try {
            execSync("python3 emc.py", { cwd: dir, stdio: "pipe", timeout: 30_000 });
        } catch (e: any) {
            logger.error(`converter at ${dir} is present but not runnable: ${e.message}`, { module: "cli" });
            logger.error("check python3 and the submodule contents", { module: "cli" });
            process.exit(1);
        }
        return;
    }
    const emcDirPath = dir;
    logger.error(
        `extension-manifest-converter not found at ${emcDirPath}; the pipeline converts MV2 manifests with it`,
        { module: "cli" },
    );
    logger.error(
        "initialize the submodule: git submodule update --init --recursive",
        { module: "cli" },
    );
    process.exit(1);
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
    // Refuse to boot without the vendored MV2->MV3 converter (git submodule).
    ensureConverter();
    // Validate the LLM key on first boot, before starting the server or any run.
    await validateApiKey();
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

    // Build/verify the Docker image once for all jobs. The LLM key was already
    // resolved and validated at boot (validateApiKey).
    if (!process.env.MIGRATOR_IMAGE) ensureImage();

    let migrated = 0;
    let possible = 0;
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
        const outcome = classifyRun(jobDir, code);
        if (outcome === "migrated") {
            migrated += 1;
        } else if (outcome === "possible_failure") {
            possible += 1;
            logger.warn(
                `extension ${target.id}: possible failure — Chrome could not load the migration; continuing`,
                { module: "cli" },
            );
        } else {
            failed += 1;
            logger.error(`extension ${target.id} failed (exit ${code})`, { module: "cli" });
        }
    }
    logger.info(`migration complete: ${migrated} migrated, ${possible} possible failure(s), ${failed} failed`, { module: "cli" });
    process.exit(failed ? 1 : 0);
}

/** True when a job dir already holds a successful migration report. */
function isMigrated(jobDir: string): boolean {
    return readRunReport(jobDir)?.passed === true;
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
    const { dir: convertedDir, log: convLog, converted } = convert(extPath);
    if (convLog) {
      for (const line of convLog.split("\n")) logger.info(line, { module: "cli" });
    } else {
      logger.info("(no converter output)", { module: "cli" });
    }
    // Persist the converter outcome next to the run: the fallbacks are silent otherwise, and
    // an unconverted (still-MV2) extension is the usual cause of "unsupported manifest version".
    writeFileSync(join(runDir, "convert.log"), `converted=${converted}\n${convLog}\n`);
    if (!converted) {
      logger.warn(`converter did NOT convert ${extPath}; the extension is still MV2 going in`, { module: "cli" });
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
        "-e", `LLM_TEMPERATURE=${process.env.LLM_TEMPERATURE ?? "1"}`,
        "-e", `LLM_TOP_P=${process.env.LLM_TOP_P ?? "0.95"}`,
        "-e", `LLM_TOP_K=${process.env.LLM_TOP_K ?? "20"}`,
        "-e", `MAX_FIX_ATTEMPTS=${process.env.MAX_FIX_ATTEMPTS ?? "6"}`,
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
          logger.warn(`Possible failure migrating extension in ${join(runDir, "out")}`, { module: "cli" });
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
