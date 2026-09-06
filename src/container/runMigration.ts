// In-container entrypoint: drive the pi agent to migrate the extension, then verify in a
// headed browser and feed failures back for a bounded fix loop. Writes the migrated tree to
// /work/out and a report to /work/report.json. This is the pi/TS replacement for the
// OpenHands orchestrator + nudge/test-fix loops in src/manager.py.
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import logger, { ensureFileTransport, formatDuration } from "../logger.js";
import { resolveModel } from "./model.js";
import { buildPrompt } from "./prompt.js";
import { verify, type VerifyReport } from "./verify.js";
import { checkExtension, formatIssues, isBlocking, type Issue } from "./checks.js";

const EXT = process.env.EXTENSION_DIR ?? "/work/extension";
const OUT = process.env.OUT_DIR ?? "/work/run/out";
const PLAN = process.env.PLAN_FILE ?? "/work/run/plan.json";
const REPORT = process.env.REPORT_FILE ?? "/work/run/report.json";
const SKILLS_DIR = process.env.SKILLS_DIR ?? "/app/assets/skills";
const MAX_FIX = Number(process.env.MAX_FIX_ATTEMPTS ?? 6);

async function main() {
    // Seed OUT with a full copy so binaries/unchanged files are guaranteed present; the agent
    // only edits. Large non-code files (data files like dictionaries, images) are excluded
    // because they waste model context and never need MV3 migration — restored after migration.
    mkdirSync(OUT, { recursive: true });
    ensureFileTransport();
    if (readdirSync(OUT).length === 0) cpSync(EXT, OUT, { recursive: true });
    const excludedFiles = stripDataFiles(OUT);

    const t0 = Date.now();
    const plan = existsSync(PLAN)
        ? JSON.parse(readFileSync(PLAN, "utf8"))
        : { findings: [], signals: [] };

    // Discover the mv3-* migration skills in SKILLS_DIR and register them with pi's skill
    // system so the agent finds them natively. The `verify` skill is deliberately EXCLUDED:
    // the host verifies authoritatively via verify.ts (see below) and drives the fix loop, so
    // the agent must not self-verify — otherwise it burns turns running verify.py (redundant,
    // and its SKILL.md points at stale OpenHands paths + needs Python Playwright installed).
    const EXCLUDED_SKILLS = new Set(["verify"]);
    const skillPaths = existsSync(SKILLS_DIR)
        ? readdirSync(SKILLS_DIR)
              .filter((name) => !EXCLUDED_SKILLS.has(name))
              .map((name) => join(SKILLS_DIR, name))
              .filter((p) => existsSync(join(p, "SKILL.md")))
        : [];
    const resourceLoader = new DefaultResourceLoader({
        cwd: "/work",
        agentDir: getAgentDir(),
        additionalSkillPaths: skillPaths,
    });
    await resourceLoader.reload();

    // Keep the top-level mv3-migration skill inlined in the prompt for immediate context.
    const skillMdPath = join(SKILLS_DIR, "mv3-migration", "SKILL.md");
    const skillMd = existsSync(skillMdPath) ? readFileSync(skillMdPath, "utf8") : "(mv3-migration skill unavailable)";

    const { model, modelRuntime } = await resolveModel();
    logger.info("model: " + model.id, { module: "migrate" });

    const settingsManager = SettingsManager.inMemory({
        // Absorb transient rate limits (the Python side's num_retries fix) and keep history
        // bounded (the condenser lesson) without stalling — pi's compaction.
        retry: { enabled: true, maxRetries: Number(process.env.LLM_NUM_RETRIES ?? 8) },
        compaction: { enabled: true },
    });

    const tools = ["read", "bash", "edit", "write", "ls", "grep", "find"];

    const { session } = await createAgentSession({
        cwd: "/work",
        sessionManager: SessionManager.inMemory("/work"),
        settingsManager,
        modelRuntime,
        model,
        resourceLoader,
        tools,
    });
    logger.info("session: main (single agent, direct edits)", { module: "migrate" });

    // Thinking/reasoning level.
    const thinkLevel = process.env.LLM_THINKING ?? "off";
    if (thinkLevel !== "off") {
        session.setThinkingLevel(thinkLevel as any);
    }
    logger.info("thinking: " + thinkLevel, { module: "migrate" });

    let turns = 0;
    session.subscribe((ev: any) => {
        if (ev.type === "turn_end") { turns++; logger.debug(`turn ${turns}`, { module: "migrate" }); }
        if (ev.type === "tool_execution_start") logger.debug("tool: " + ev.toolName, { module: "migrate" });
    });

    // Restore excluded data files before verify so the extension loads fully.
    const restoreExcluded = () => {
        for (const f of excludedFiles) {
            const src = join(EXT, f);
            const dst = join(OUT, f);
            if (existsSync(src)) {
                mkdirSync(dst.split(sep).slice(0, -1).join(sep), { recursive: true });
                cpSync(src, dst);
                logger.debug(`restored data file: ${f}`, { module: "migrate" });
            }
        }
    };

    const prompt = buildPrompt({ findings: plan.findings ?? [], signals: plan.signals ?? [], skillMd, extDir: EXT, outDir: OUT });
    logger.info("sending migration prompt...", { module: "migrate" });
    await session.prompt(prompt);

    restoreExcluded();

    /**
     * One verification round: cheap static checks first, then the real browser load.
     * The static pass runs even when Chrome is happy, because plenty of MV3 defects (remote
     * code, executeScript with a code string, a stray browserAction call on a cold path) load
     * fine and break later.
     */
    async function checkAndVerify(): Promise<{ report: VerifyReport; issues: Issue[] }> {
        const issues = checkExtension(OUT);
        const errs = issues.filter((i) => i.severity === "error").length;
        logger.info(`static checks: ${errs} error(s), ${issues.length - errs} warning(s)`, { module: "migrate" });
        return { report: await verify(OUT), issues };
    }

    let { report, issues } = await checkAndVerify();
    if (report.passed) {
        logger.info("verify #1: PASS", { module: "migrate" });
    } else {
        logger.warn("verify #1: FAIL — " + report.reason, { module: "migrate" });
    }

    /** Everything known to be wrong right now, as one actionable brief for the agent. */
    function buildFixPrompt(report: VerifyReport, issues: Issue[]): string {
        const parts: string[] = [];
        if (!report.passed) {
            parts.push(
                `The migrated extension in ${OUT} FAILED to load in Chrome:\n- ${report.reason}`,
                report.errors.length ? `Chrome reported:\n${report.errors.map((e) => "- " + e).join("\n")}` : "",
            );
        } else {
            parts.push(
                `The extension in ${OUT} loads in Chrome, but static validation found problems that ` +
                `will break it at runtime or at review time.`,
                report.runtimeErrors?.length
                    ? `The service worker logged errors after starting:\n${report.runtimeErrors.map((e) => "- " + e).join("\n")}`
                    : "",
            );
        }
        if (issues.length) {
            parts.push(
                `Static validation of ${OUT} found ${issues.length} issue(s). Each line gives the ` +
                `location, the problem, and the fix — apply them all:\n${formatIssues(issues)}`,
            );
        }
        parts.push(
            `Fix the files in ${OUT} so the extension loads and its MV3 service worker registers. ` +
            `Work through EVERY issue above with your edit/write tools, then stop — do not run any ` +
            `verification yourself.`,
        );
        return parts.filter(Boolean).join("\n\n");
    }

    let fixAttempts = 0;
    // Keep fixing while Chrome rejects the extension OR a load-blocking static error remains.
    // Non-blocking errors (a stray browserAction call, DOM use inside a vendored bundle) still
    // go into every fix prompt, and get ONE dedicated round if nothing else is left — but they
    // never hold the loop open, because some of them cannot be fixed at all and the loop costs
    // ~10 minutes a round.
    let qualityRoundUsed = false;
    const needsWork = (r: VerifyReport, is: Issue[]): boolean => {
        if (!r.passed || is.some(isBlocking)) return true;
        if (is.some((i) => i.severity === "error") && !qualityRoundUsed) {
            qualityRoundUsed = true;
            return true;
        }
        return false;
    };
    for (let attempt = 1; needsWork(report, issues) && attempt <= MAX_FIX; attempt++) {
        fixAttempts = attempt;
        logger.info(`fix attempt ${attempt}/${MAX_FIX}`, { module: "migrate" });
        restoreExcluded();
        await session.prompt(buildFixPrompt(report, issues));
        restoreExcluded();
        ({ report, issues } = await checkAndVerify());
        const staticErrs = issues.filter((i) => i.severity === "error").length;
        if (report.passed && !staticErrs) {
            logger.info(`verify after fix ${attempt}: PASS`, { module: "migrate" });
        } else if (report.passed) {
            logger.warn(`verify after fix ${attempt}: loads, but ${staticErrs} static error(s) remain`, { module: "migrate" });
        } else {
            logger.warn(`verify after fix ${attempt}: FAIL — ${report.reason}`, { module: "migrate" });
        }
    }

    // Invariant: the output MUST be MV3. The converter bumps manifest_version deterministically
    // and the agent is told to confirm it, so an MV2 manifest here means both stages were
    // skipped or reverted — a distinct, actionable failure that read as a generic
    // "no service worker registered" for a whole batch before this check existed.
    const outMv = manifestVersion(join(OUT, "manifest.json"));
    if (outMv !== 3) {
        const detail =
            `output manifest_version is ${outMv ?? "missing/unparseable"}, not 3` +
            (manifestVersion(join(EXT, "manifest.json")) !== 3
                ? " (input was not MV3 either — the host-side converter pre-pass did not run; check convert.log)"
                : "");
        logger.error(detail, { module: "migrate" });
        if (report.passed) {
            report = { ...report, passed: false, reason: detail };
        } else {
            report = { ...report, reason: `${report.reason}; ${detail}` };
        }
    }

    // `passed` stays "Chrome loaded it and the worker registered" so pass rates remain
    // comparable across runs; unresolved static issues ride alongside it rather than
    // redefining it, but they are recorded so a "pass" with known defects is visible.
    const staticErrors = issues.filter((i) => i.severity === "error");
    const result = {
        passed: report.passed,
        verdict: report.passed ? (staticErrors.length ? "passed_with_issues" : "passed") : "possible_failed",
        serviceWorker: report.serviceWorker ?? null,
        extensionId: report.extensionId ?? null,
        reason: report.reason ?? null,
        errors: report.errors,
        runtimeErrors: report.runtimeErrors ?? [],
        staticErrorCount: staticErrors.length,
        staticWarningCount: issues.length - staticErrors.length,
        issues,
        turns,
    };
    writeFileSync(REPORT, JSON.stringify(result, null, 2));
    // Save full LLM transcript (messages + tool calls) as JSONL.
    const transcriptPath = join(dirname(REPORT), "transcript.jsonl");
    session.exportToJsonl(transcriptPath);

    printSummary({
        passed: report.passed,
        duration: formatDuration(Date.now() - t0),
        turns,
        verify: report.passed
            ? `PASS${fixAttempts ? ` (after ${fixAttempts} fix ${fixAttempts === 1 ? "round" : "rounds"})` : " (first try)"}` +
              (staticErrors.length ? ` — ${staticErrors.length} static error(s) unresolved` : "")
            : `FAIL — ${report.reason}`,
        serviceWorker: report.serviceWorker,
        extensionId: report.extensionId,
        errorCount: report.errors.length,
        report: REPORT,
        transcript: transcriptPath,
    });

    session.dispose();
    process.exit(report.passed ? 0 : 1);
}

/** Print a clean, aligned end-of-run summary banner (bypasses winston so there's no per-line prefix). */
function printSummary(s: {
    passed: boolean;
    duration: string;
    turns: number;
    verify: string;
    serviceWorker?: string;
    extensionId?: string;
    errorCount: number;
    report: string;
    transcript: string;
}): void {
    const DIM = "\x1b[2m", RESET = "\x1b[0m";
    const head = s.passed ? "\x1b[1;32m✓ Migration SUCCESS" : "\x1b[1;33m△ Migration POSSIBLE FAILURE (verify could not load it)";
    const bar = DIM + "─".repeat(60) + RESET;
    const rows: [string, string][] = [
        ["turns", String(s.turns)],
        ["verify", s.verify],
    ];
    if (s.serviceWorker) rows.push(["service worker", s.serviceWorker]);
    if (s.extensionId) rows.push(["extension id", s.extensionId]);
    if (s.errorCount) rows.push(["errors", String(s.errorCount)]);
    rows.push(["report", s.report], ["transcript", s.transcript]);
    const lines = ["", bar, `  ${head}${RESET}  ${DIM}${s.duration}${RESET}`, ""];
    for (const [k, v] of rows) lines.push(`  ${DIM}${k.padEnd(15)}${RESET}${v}`);
    lines.push(bar, "");
    process.stdout.write(lines.join("\n") + "\n");
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
                logger.debug(`excluded: ${relative(outDir, full)} (${s.size} bytes)`, { module: "migrate" });
            }
        }
    }

    walk(outDir);
    return excluded;
}

main().catch((e) => { logger.error("fatal: " + e, { module: "migrate" }); process.exit(2); });

/** manifest_version of a manifest.json, or null when missing/unparseable. */
function manifestVersion(manifestPath: string): number | null {
    try {
        const v = JSON.parse(readFileSync(manifestPath, "utf8")).manifest_version;
        return typeof v === "number" ? v : null;
    } catch {
        return null;
    }
}
