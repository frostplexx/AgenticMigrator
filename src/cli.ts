// Host CLI: migrate one extension end-to-end.
//   migrate <extension-dir> [--out <run-dir>]
// Pipeline (TS/pi port of src/manager.py's host side):
//   1. convert (vendored emc, Python subprocess)
//   2. static analysis -> plan.json + analysis.json
//   3. docker run the migrator image (pi agent + headed verify) with mounts
//   4. report exit status; migrated extension lands in <run-dir>/out
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StaticAnalyzer, buildAnalysis } from "./host/staticAnalyzer.js";
import { convert } from "./host/convert.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGE = process.env.MIGRATOR_IMAGE ?? "agentic-migrator-ts:latest";

function arg(flag: string, def: string): string {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
    const extInput = process.argv[2];
    if (!extInput || extInput.startsWith("--")) {
        console.error("usage: migrate <extension-dir> [--out <run-dir>]");
        process.exit(64);
    }
    const extPath = resolve(extInput);
    const runDir = resolve(arg("--out", "./run"));

    // Fresh run dir.
    rmSync(runDir, { recursive: true, force: true });
    mkdirSync(join(runDir, "out"), { recursive: true });

    // 1. convert (host-side deterministic pre-pass).
    console.log("[cli] converting (extension-manifest-converter)...");
    const { dir: convertedDir, log } = convert(extPath);
    console.log(log ? "[cli] " + log.split("\n").join("\n[cli] ") : "[cli] (no converter output)");

    // 2. static analysis -> plan + analysis.
    const mappings = JSON.parse(readFileSync(join(__dirname, "..", "assets", "api_mappings.json"), "utf8"));
    const { findings, signals } = new StaticAnalyzer(mappings).scan(convertedDir);
    console.log(`[cli] static analysis: ${findings.length} deprecated API site(s), ${signals.length} signal(s)`);
    writeFileSync(join(runDir, "plan.json"), JSON.stringify({ findings, signals }, null, 2));
    writeFileSync(join(runDir, "analysis.json"), JSON.stringify(buildAnalysis(findings, convertedDir), null, 2));

    // 3. docker run the migrator container.
    const dockerArgs = [
        "run", "--rm", "--shm-size=1g",
        "--add-host=host.docker.internal:host-gateway",
        "-v", `${convertedDir}:/work/extension:ro`,
        "-v", `${runDir}:/work/run`,
        "-e", `LLM_MODEL=${process.env.LLM_MODEL ?? "ollama/gemma4:31b-cloud"}`,
        "-e", `LLM_BASE_URL=${process.env.LLM_BASE_URL ?? "http://host.docker.internal:11434"}`,
        "-e", `LLM_NUM_CTX=${process.env.LLM_NUM_CTX ?? "65536"}`,
        "-e", `MAX_FIX_ATTEMPTS=${process.env.MAX_FIX_ATTEMPTS ?? "3"}`,
        "-e", `USE_SUBAGENTS=${process.env.USE_SUBAGENTS ?? ""}`,
        ...(process.env.LLM_API_KEY ? ["-e", `LLM_API_KEY=${process.env.LLM_API_KEY}`] : []),
        IMAGE,
        "node", "dist/container/runMigration.js",
    ];
    console.log("[cli] docker run", IMAGE, "...");
    const code = await new Promise<number>((res) => {
        const p = spawn("docker", dockerArgs, { stdio: "inherit" });
        p.on("close", (c) => res(c ?? 1));
    });

    rmSync(convertedDir, { recursive: true, force: true });

    // 4. report.
    const reportPath = join(runDir, "report.json");
    if (existsSync(reportPath)) {
        const r = JSON.parse(readFileSync(reportPath, "utf8"));
        console.log(`\n[cli] ${r.passed ? "SUCCESS ✅" : "FAILED ❌"} — migrated extension in ${join(runDir, "out")}`);
        if (r.serviceWorker) console.log(`[cli] service worker: ${r.serviceWorker}`);
        if (!r.passed && r.reason) console.log(`[cli] reason: ${r.reason}`);
    } else {
        console.log(`\n[cli] no report produced (container exit ${code})`);
    }
    process.exit(code);
}

main().catch((e) => { console.error("[cli] fatal:", e); process.exit(1); });
