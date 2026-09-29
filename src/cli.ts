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
import { Registry } from "./extlens/registry.js";
import { mixedModelError } from "./host/runRoot.js";
import { analyzeCompat } from "./host/compat.js";
import { convert, emcDir } from "./host/convert.js";
import { classifyRun, quotaWallUntil, readRunReport } from "./host/runReport.js";
import { hashDir } from "./host/hashDir.js";
import { dedupe } from "./host/blobs.js";
import logger, { formatDuration } from "./logger.js";

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
    const valueFlags = new Set(["--out", "--port", "--extlens-port", "--source-dir", "--blobs"]);
    const extInput = args.find((a, i) => !a.startsWith("--") && a !== "-h" && !(i > 0 && valueFlags.has(args[i - 1])));
    const extPath = extInput ? resolve(extInput) : null;
    const runDir = resolve(arg("--out", "./run"));
    const sourceArg = arg("--source-dir", "");
    const sourceDir = sourceArg || (process.env.EXTLENS_SOURCE_DIR ?? process.env.EXLENS_SOURCE_DIR) || null;

    // Internal one-shot mode: the extlens controller (src/extlens/migrator.ts)
    // spawns the migration child with MIGRATOR_ONESHOT=1. Not a user-facing flag.
    const oneShot = process.env.MIGRATOR_ONESHOT === "1";
    const parsedPort = Number((process.env.EXTLENS_PORT ?? process.env.EXLENS_PORT) ?? arg("--extlens-port", arg("--port", "8081")));
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

    assertRunRootBelongsToModel(runDir);

    // Build/verify the Docker image once for all jobs. The LLM key was already
    // resolved and validated at boot (validateApiKey).
    if (!process.env.MIGRATOR_IMAGE) ensureImage();

    let migrated = 0;
    let possible = 0;
    let failed = 0;
    /** Set when a run proves the provider's quota is shut for longer than the batch can wait. */
    let quotaWall: { until: Date; after: string } | null = null;
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

        // Stop on a quota window the next extension cannot get past either. Each container gets a
        // fresh wait budget, so without this the batch spends it once per remaining extension —
        // 15 minutes each, for reports with no model output in them — on a number that will not
        // change until the window reopens.
        const until = quotaWallUntil(readRunReport(jobDir));
        if (until) {
            quotaWall = { until, after: target.id };
            break;
        }
    }

    if (quotaWall) {
        const left = Math.max(0, quotaWall.until.getTime() - Date.now());
        const attempted = migrated + possible + failed;
        logger.error(
            `stopping after ${quotaWall.after}: the provider's quota window is shut until ` +
            `${quotaWall.until.toISOString()} (${formatDuration(left)} away). ` +
            `${targets.length - attempted} extension(s) not attempted — rerun then, and the ` +
            `already-migrated ones will be skipped.`,
            { module: "cli" },
        );
    }
    logger.info(`migration complete: ${migrated} migrated, ${possible} possible failure(s), ${failed} failed`, { module: "cli" });
    // 75 is EX_TEMPFAIL: nothing here is wrong, it is worth running again later. Distinct from 1,
    // which says these extensions failed on their merits.
    process.exit(quotaWall ? 75 : failed ? 1 : 0);
}

/** Guard the run root against a second model; see host/runRoot.ts for why. */
function assertRunRootBelongsToModel(runDir: string, modelSpec?: string): void {
    if (process.env.ALLOW_MIXED_MODELS === "1") return;
    const current = modelSpec ?? process.env.LLM_MODEL ?? "unknown";
    let existing: string[] = [];
    try {
        const registry = new Registry(runDir);
        existing = registry.outcomeModels();
        registry.close();
    } catch {
        return; // no registry yet, so nothing to conflict with
    }
    const problem = mixedModelError(existing, current);
    if (!problem) return;
    logger.error(problem, { module: "cli" });
    process.exit(64);
}

/** True when a job dir already holds a successful migration report. */
function isMigrated(jobDir: string): boolean {
    return readRunReport(jobDir)?.passed === true;
}

/**
 * Everything about one extension that is the same whichever model migrates it.
 *
 * Split out from the run itself because it is the same for every model: conversion and static analysis
 * depend only on the extension. Computing it once per attempt keeps "two runs were given identical
 * input" a property of the code rather than of the conversion being deterministic and nobody having
 * touched the corpus in between.
 */
interface PreparedExtension {
    /** Temp dir holding the converted MV2→MV3 tree. The caller disposes of it. */
    convertedDir: string;
    convLog: string;
    converted: boolean;
    findings: unknown[];
    signals: unknown[];
    compat: Awaited<ReturnType<typeof analyzeCompat>>;
    compatConverted: Awaited<ReturnType<typeof analyzeCompat>>;
    analysis: unknown;
}

/** Fresh run dir for one attempt, plus the pointer the extlens adapter needs to serve MV2 files. */
function resetRunDir(runDir: string, extPath: string): void {
    // Clear its CONTENTS rather than removing runDir itself: a shell parked in runDir (it's the
    // session's working dir) would otherwise be orphaned when the inode is recreated, and the next
    // command crashes with `ENOENT: uv_cwd`.
    mkdirSync(runDir, { recursive: true });
    for (const entry of readdirSync(runDir)) rmSync(join(runDir, entry), { recursive: true, force: true });
    mkdirSync(join(runDir, "out"), { recursive: true });
    writeFileSync(join(runDir, "source-path.txt"), resolve(extPath));
}

/** Convert and analyse one extension, without writing into any run dir. */
async function prepareExtension(extPath: string): Promise<PreparedExtension> {
    // 1. convert (host-side deterministic pre-pass).
    logger.info("converting (extension-manifest-converter)...", { module: "cli" });
    const { dir: convertedDir, log: convLog, converted } = convert(extPath);
    if (convLog) {
      for (const line of convLog.split("\n")) logger.info(line, { module: "cli" });
    } else {
      logger.info("(no converter output)", { module: "cli" });
    }
    if (!converted) {
      logger.warn(`converter did NOT convert ${extPath}; the extension is still MV2 going in`, { module: "cli" });
    }

    // 2. static analysis -> plan + analysis.
    const mappings = JSON.parse(readFileSync(join(__dirname, "..", "assets", "api_mappings.json"), "utf8"));
    const { findings, signals } = new StaticAnalyzer(mappings).scan(convertedDir);
    logger.info(`static analysis: ${findings.length} deprecated API site(s), ${signals.length} signal(s)`, { module: "cli" });
    // MDN compat data over the converted input: HARD findings are capabilities MV3 cannot express
    // at all, so they bound what any model could achieve on this extension (and are recorded
    // per-run so the corpus-wide ceiling is a query, not a re-scan).
    // Two passes. The ceiling is a property of the ORIGINAL extension, so it is measured there;
    // the prompt gets the converted tree instead, because the converter has already fixed part of
    // what the original still shows and re-reporting it would send the agent after non-problems.
    const compat = await analyzeCompat(extPath);
    const compatConverted = await analyzeCompat(convertedDir);
    const hard = compat.findings.filter((f) => f.severity === "HARD").length;
    const soft = compat.findings.filter((f) => f.severity === "SOFT").length;
    logger.info(
        `compat (chrome ${compat.version}, bcd ${compat.bcdVersion ?? "?"}): ${hard} hard, ${soft} soft finding(s)`,
        { module: "cli" },
    );
    if (compat.hasHardBlocker) {
        logger.warn("extension uses capabilities with no MV3 equivalent; a faithful migration may be impossible", { module: "cli" });
    }

    return {
        convertedDir,
        convLog,
        converted,
        findings,
        signals,
        compat,
        compatConverted,
        analysis: buildAnalysis(findings, convertedDir),
    };
}

/**
 * Write one attempt's starting state into its run dir.
 *
 * Every run gets its own copy of these, which is what makes a comparison readable months later: the
 * plan the agent worked from sits beside its output, not in a shared parent directory that says
 * nothing about which run saw what.
 */
function writePrepared(runDir: string, extPath: string, p: PreparedExtension): void {
    // Persist the converter outcome next to the run: the fallbacks are silent otherwise, and
    // an unconverted (still-MV2) extension is the usual cause of "unsupported manifest version".
    writeFileSync(join(runDir, "convert.log"), `converted=${p.converted}\n${p.convLog}\n`);
    writeFileSync(join(runDir, "compat.json"), JSON.stringify(p.compat, null, 2));
    writeFileSync(
        join(runDir, "plan.json"),
        JSON.stringify({ findings: p.findings, signals: p.signals, compat: p.compatConverted }, null, 2),
    );
    writeFileSync(join(runDir, "analysis.json"), JSON.stringify(p.analysis, null, 2));
}

/**
 * Run the migrator container over a prepared extension.
 *
 * `env` overrides the process environment per run, so two runs can use different models, endpoints,
 * context windows or thinking levels under one host. Everything unset falls back to the process env
 * and then to the same defaults a single run uses, so a run naming only a model behaves exactly as
 * `LLM_MODEL=<it>` would.
 */
async function runMigrationContainer(
    extPath: string,
    runDir: string,
    convertedDir: string,
    override: Record<string, string> = {},
): Promise<number> {
    const env: Record<string, string | undefined> = { ...process.env, ...override };
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
        // The UNCONVERTED original, for the MV2 behavioural baseline. Without it the container
        // has nothing to compare the migration against and the run cannot be scored.
        "-v", `${extPath}:/work/original:ro`,
        "-v", `${runDir}:/work/run`,
        "-e", `LLM_MODEL=${env.LLM_MODEL ?? "ollama/gemma4:31b-cloud"}`,
        "-e", `LLM_BASE_URL=${env.LLM_BASE_URL ?? "http://host.docker.internal:11434"}`,
        "-e", `LLM_NUM_CTX=${env.LLM_NUM_CTX ?? "65536"}`,
        "-e", `LLM_TEMPERATURE=${env.LLM_TEMPERATURE ?? "1"}`,
        "-e", `LLM_TOP_P=${env.LLM_TOP_P ?? "0.95"}`,
        "-e", `LLM_TOP_K=${env.LLM_TOP_K ?? "20"}`,
        "-e", `MAX_FIX_ATTEMPTS=${env.MAX_FIX_ATTEMPTS ?? "6"}`,
        "-e", `LLM_THINKING=${env.LLM_THINKING ?? "off"}`,
        "-e", `LOG_FILE=/work/run/migrate.jsonl`,
        "-e", `ORIGINAL_DIR=/work/original`,
        // The MV2-capable Chrome the image installs, for the behavioural baseline. Overridable so a
        // host with its own build can point at that instead.
        "-e", `CHROME_OLD=${env.CHROME_OLD ?? "/opt/chrome-mv2/chrome"}`,
        "-e", `BEHAVIOUR_CHECK_TIMEOUT_MS=${env.BEHAVIOUR_CHECK_TIMEOUT_MS ?? "30000"}`,
        "-e", `BEHAVIOUR_SESSION_TIMEOUT_MS=${env.BEHAVIOUR_SESSION_TIMEOUT_MS ?? "300000"}`,
        ...(env.ENABLE_VNC === "1" ? [
            "-e", "ENABLE_VNC=1",
            "-p", `${portBase}:6080`,
        ] : []),
        ...(env.LLM_API_KEY ? ["-e", `LLM_API_KEY=${env.LLM_API_KEY}`] : []),
        migratorImage!,
        "node", "dist/container/runMigration.js",
    ];
    logger.info("docker run " + migratorImage + " ...", { module: "cli" });
    return await new Promise<number>((res) => {
        const p = spawn("docker", dockerArgs, { stdio: "inherit" });
        p.on("close", (c) => res(c ?? 1));
    });
}

/**
 * Log what a finished attempt produced, and index its outcome.
 *
 * `index` is a shared outcomes DB, written IN ADDITION to the run's own. The per-run row is what
 * extlens reads; a shared row is what would make "which extensions did A pass and B fail" one query
 * instead of a merge of several databases. Nothing passes it today — the runs UI reads per-run
 * counts — so it is the seam a cross-run comparison would use, not a feature.
 */
async function reportAttempt(
    extPath: string,
    runDir: string,
    code: number,
    /** The fully-qualified `provider/id` this attempt ran, for the outcomes index. */
    modelSpec: string,
    index?: { root: string; runId: string },
): Promise<void> {
    const reportPath = join(runDir, "report.json");
    if (!existsSync(reportPath)) {
        logger.warn(`no report produced (container exit ${code})`, { module: "cli" });
        return;
    }
    const r = JSON.parse(readFileSync(reportPath, "utf8"));
    if (r.passed) {
      logger.success(`Migrated extension in ${join(runDir, "out")}`, { module: "cli" });
    } else {
      logger.warn(`Possible failure migrating extension in ${join(runDir, "out")}`, { module: "cli" });
    }
    if (r.serviceWorker) logger.info(`service worker: ${r.serviceWorker}`, { module: "cli" });
    if (!r.passed && r.reason) logger.warn(`reason: ${r.reason}`, { module: "cli" });
    if (typeof r.score === "number") {
        logger.info(`behaviour score: ${r.score.toFixed(2)} (${r.scoreDenominator} baseline check(s))`, { module: "cli" });
    }
    if (r.label) logger.warn(`label: ${r.label}`, { module: "cli" });
    await recordOutcome(runDir, extPath, r, modelSpec);
    if (index) await recordOutcome(runDir, extPath, r, modelSpec, index);
}

/**
 * Migrate one extension into runDir. The run dir starts fresh. Returns the
 * container/process exit code (0 on success, non-zero on failure).
 */
async function migrateOne(extPath: string, runDir: string): Promise<number> {
    resetRunDir(runDir, extPath);
    const prepared = await prepareExtension(extPath);
    try {
        writePrepared(runDir, extPath, prepared);
        const code = await runMigrationContainer(extPath, runDir, prepared.convertedDir);
        await reportAttempt(extPath, runDir, code, process.env.LLM_MODEL ?? "unknown");
        dedupeFinished(runDir);
        return code;
    } finally {
        rmSync(prepared.convertedDir, { recursive: true, force: true });
    }
}

/**
 * Hardlink this extension's finished output into the run root's blob store.
 *
 * Only when `--blobs` says where, which is only when the host is serving a runs root: the store is a
 * property of that layout. Called after the container has exited and the report is written, never
 * before — a hardlinked file has no copy-on-write, so linking a tree the agent is still editing would
 * rewrite the same content inside every earlier run that shared it.
 *
 * Best-effort by design. The saving is real but it is an optimisation, and a migration that worked
 * must not be reported as failed because a link could not be made.
 */
function dedupeFinished(runDir: string): void {
    const store = arg("--blobs", "");
    if (!store) return;
    try {
        const out = join(runDir, "out");
        const result = dedupe(out, store);
        if (result.linked > 0) {
            logger.info(
                `dedupe: ${result.linked} file(s) linked, ` +
                `${(result.freedBytes / 1e6).toFixed(1)} MB shared, ${(result.addedBytes / 1e6).toFixed(1)} MB new`,
                { module: "cli" },
            );
        }
        for (const skip of result.skipped.slice(0, 5)) {
            logger.debug(`dedupe skipped ${skip.path}: ${skip.reason}`, { module: "cli" });
        }
    } catch (e) {
        logger.warn(`dedupe skipped: ${e instanceof Error ? e.message : String(e)}`, { module: "cli" });
    }
}

function waitForSignal(): Promise<void> {
    return new Promise((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
    });
}

main().catch((e) => { logger.error("fatal: " + e, { module: "cli" }); process.exit(1); });


/**
 * Append this run to the cross-model outcome index, so a second model accumulates alongside the
 * first instead of overwriting it. Best-effort by design: the index is analysis infrastructure,
 * and a migration must not fail because better-sqlite3 is unavailable or the DB is locked.
 */
async function recordOutcome(
    runDir: string,
    extPath: string,
    report: any,
    /**
     * The `provider/id` spec, recorded in preference to the report's bare `model.id`.
     *
     * The report carries only the id, so rows used to read `deepseek-v4-flash-0731` while
     * LLM_MODEL said `saia/deepseek-v4-flash-0731` — and the run-root guard compared the two and
     * refused every resume. See host/runRoot.ts, which still matches legacy bare rows.
     */
    modelSpec: string,
    /**
     * A shared index instead of this run's own root.
     *
     * `runId` carries the RUN's id rather than the extension id, because the outcomes primary key is
     * (extension, model, run_id) and two runs of one model under different settings are a normal
     * thing to compare. Keyed by model alone those rows collapse into one and a column is lost.
     */
    index?: { root: string; runId: string },
): Promise<void> {
    try {
        const { Registry } = await import("./extlens/registry.js");
        const registry = index
            ? new Registry(index.root, "outcomes.db")
            : new Registry(dirname(resolve(runDir)));
        try {
            registry.recordOutcome({
                extension: basename(resolve(extPath)),
                model: modelSpec || report.model || "unknown",
                runId: index ? index.runId : basename(resolve(runDir)),
                passed: Boolean(report.passed),
                score: report.score ?? null,
                label: report.label ?? null,
                abstained: Boolean(report.abstained),
                hasHardBlocker: report.blockers?.inputHasHardBlocker ?? null,
                costUsd: report.usage?.costUsd ?? null,
                wallTimeMs: report.wallTimeMs ?? null,
            });
        } finally {
            registry.close();
        }
    } catch (e) {
        logger.debug(`outcome not recorded: ${e}`, { module: "cli" });
    }
}
