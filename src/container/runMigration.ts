// In-container entrypoint: drive the pi agent to migrate the extension, then verify in a
// headed browser and feed failures back for a bounded fix loop. Writes the migrated tree to
// /work/out and a report to /work/report.json. This is the pi/TS replacement for the
// OpenHands orchestrator + subagent + nudge/test-fix loops in src/manager.py.
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { resolveModel } from "./model.js";
import { buildPrompt } from "./prompt.js";
import { makeTransformerTool } from "./subagent.js";
import { verify, type VerifyReport } from "./verify.js";

const EXT = process.env.EXTENSION_DIR ?? "/work/extension";
const OUT = process.env.OUT_DIR ?? "/work/run/out";
const PLAN = process.env.PLAN_FILE ?? "/work/run/plan.json";
const REPORT = process.env.REPORT_FILE ?? "/work/run/report.json";
const SKILL = process.env.SKILL_FILE ?? "/app/assets/skills/mv3-migration/SKILL.md";
const MAX_FIX = Number(process.env.MAX_FIX_ATTEMPTS ?? 3);

function log(...a: unknown[]) { console.log("[migrate]", ...a); }

async function main() {
    // Seed OUT with a full copy so binaries/unchanged files are guaranteed present; the agent
    // only edits. Large non-code files (data files like dictionaries, images) are excluded
    // because they waste model context and never need MV3 migration — restored after migration.
    mkdirSync(OUT, { recursive: true });
    if (readdirSync(OUT).length === 0) cpSync(EXT, OUT, { recursive: true });
    const excludedFiles = stripDataFiles(OUT);

    const plan = existsSync(PLAN)
        ? JSON.parse(readFileSync(PLAN, "utf8"))
        : { findings: [], signals: [] };
    const skillMd = existsSync(SKILL) ? readFileSync(SKILL, "utf8") : "(mv3-migration skill unavailable)";

    const { model, modelRegistry, authStorage } = resolveModel();
    log("model:", model.id);

    const settingsManager = SettingsManager.inMemory({
        // Absorb transient rate limits (the Python side's num_retries fix) and keep history
        // bounded (the condenser lesson) without stalling — pi's compaction.
        retry: { enabled: true, maxRetries: Number(process.env.LLM_NUM_RETRIES ?? 8) },
        compaction: { enabled: true },
    });

    // Subagent mode (USE_SUBAGENTS=1): the main session is an ORCHESTRATOR with read-only
    // tools + an extension_transformer tool that spawns a nested coding sub-session — the pi
    // form of the OpenHands orchestrator/subagent split. Default is the faster single session.
    const useSubagents = /^(1|true|yes|on)$/i.test(process.env.USE_SUBAGENTS ?? "");
    const mode = useSubagents ? "orchestrator" : "direct";
    log("mode:", mode);

    const customTools = useSubagents
        ? [makeTransformerTool({ model, modelRegistry, authStorage, settingsManager, cwd: "/work", log })]
        : [];
    const tools = useSubagents
        ? ["read", "ls", "grep", "find", "extension_transformer"]
        : ["read", "bash", "edit", "write", "ls", "grep", "find"];

    const { session } = await createAgentSession({
        cwd: "/work",
        sessionManager: SessionManager.inMemory("/work"),
        settingsManager,
        authStorage,
        modelRegistry,
        model,
        tools,
        customTools,
    });

    let turns = 0;
    session.subscribe((ev: any) => {
        if (ev.type === "turn_end") { turns++; log(`turn ${turns}`); }
        if (ev.type === "tool_execution_start") log("tool:", ev.toolName);
    });

    // Restore excluded data files before verify so the extension loads fully.
    const restoreExcluded = () => {
        for (const f of excludedFiles) {
            const src = join(EXT, f);
            const dst = join(OUT, f);
            if (existsSync(src)) {
                mkdirSync(dst.split(sep).slice(0, -1).join(sep), { recursive: true });
                cpSync(src, dst);
                log(`restored data file: ${f}`);
            }
        }
    };

    const prompt = buildPrompt({ findings: plan.findings ?? [], signals: plan.signals ?? [], skillMd, extDir: EXT, outDir: OUT, mode });
    log("sending migration prompt...");
    await session.prompt(prompt);

    restoreExcluded();
    let report: VerifyReport = await verify(OUT);
    log("verify #1:", report.passed ? "PASS" : `FAIL — ${report.reason}`);

    for (let attempt = 1; !report.passed && attempt <= MAX_FIX; attempt++) {
        log(`fix attempt ${attempt}/${MAX_FIX}`);
        restoreExcluded();
        await session.prompt(
            `The migrated extension in ${OUT} FAILED to load in Chrome:\n` +
            `- ${report.reason}\n` +
            (report.errors.length ? `Runtime errors:\n${report.errors.map((e) => "- " + e).join("\n")}\n` : "") +
            `Fix the files in ${OUT} so the extension loads and its MV3 service worker registers. ` +
            `Common causes: manifest_version/background.service_worker wrong, an invalid rules.json ` +
            `(declarative_net_request needs id+enabled+path), or service-worker code using window/DOM.`,
        );
        restoreExcluded();
        report = await verify(OUT);
        log(`verify after fix ${attempt}:`, report.passed ? "PASS" : `FAIL — ${report.reason}`);
    }

    const result = {
        passed: report.passed,
        serviceWorker: report.serviceWorker ?? null,
        extensionId: report.extensionId ?? null,
        reason: report.reason ?? null,
        errors: report.errors,
        turns,
    };
    writeFileSync(REPORT, JSON.stringify(result, null, 2));
    log("RESULT:", report.passed ? "SUCCESS" : "FAILED", "→", REPORT);
    session.dispose();
    process.exit(report.passed ? 0 : 1);
}

/**
 * Remove large non-code files from the agent workspace.
 * These are data files (dictionaries, images, etc.) that don't need
 * MV3 migration and would waste model context if read by the agent.
 * Returns list of relative paths to restore after migration.
 */
function stripDataFiles(outDir: string): string[] {
    const excluded: string[] = [];
    const MAX_SIZE = 50 * 1024; // 50KB
    const KEEP_EXT = new Set([".js", ".mjs", ".cjs", ".mts", ".cts", ".json"]);

    function walk(dir: string): void {
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const entry of entries) {
            const full = join(dir, entry);
            let s;
            try { s = statSync(full); } catch { continue; }
            if (s.isDirectory()) {
                walk(full);
                // Remove empty directories left behind
                try { if (readdirSync(full).length === 0) rmSync(full); } catch { }
            } else if (s.size > MAX_SIZE) {
                const ext = entry.slice(entry.lastIndexOf(".")).toLowerCase();
                if (KEEP_EXT.has(ext)) continue; // keep large JS bundles
                rmSync(full);
                excluded.push(relative(outDir, full));
                log(`excluded: ${relative(outDir, full)} (${s.size} bytes)`);
            }
        }
    }

    walk(outDir);
    return excluded;
}

main().catch((e) => { console.error("[migrate] fatal:", e); process.exit(2); });
