#!/usr/bin/env npx tsx
/**
 * Distribution of observed changes across the necessary MV3 migrations — appendix report.
 *
 * The tags exist to answer one question: for each necessary migration described in the paper
 * (operationalized in assets/skills/mv3-{trivial,semi-trivial,non-trivial}), how did the corpus's
 * changes distribute — how often was it needed, applied, skipped (and why), spurious, or repaired,
 * and what did that do to verification outcomes? This script folds every measurement channel into
 * one appendix-ready Markdown document:
 *
 *   - tagsBackfill in the export (pipeline ledger lines, transcripts, legacy tags)
 *   - data/api-conversion.json (two-sided call-site accounting for the semi-trivial rewrites)
 *
 * It writes nothing but the report; it reads, never mutates.
 *
 * Usage: npx tsx scripts/tag_distribution.ts [--out data/tag-distribution.md]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHANGE_TITLES, type ChangeId } from "../src/host/changes.js";
import type { ResidualFamily } from "./mv2_residuals.js";
import type { ConversionByExt } from "./api_conversion.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALL_CHANGE_IDS = Object.keys(CHANGE_TITLES) as ChangeId[];

type Tier = "trivial" | "semi-trivial" | "non-trivial";

/** The paper's necessary migrations, operationalized by the three skill files. */
const TIER: Record<ChangeId, Tier> = {
    manifest_version: "trivial",
    background_service_worker: "trivial",
    background_persistent_removed: "trivial",
    action_rename: "trivial",
    host_permissions_split: "trivial",
    web_accessible_resources_v3: "trivial",
    csp_object_form: "trivial",
    commands_execute_action: "trivial",
    execute_script_api: "semi-trivial",
    webrequest_to_dnr: "non-trivial",
    webrequest_header_modification: "non-trivial",
    webrequest_response_inspection: "non-trivial",
    offscreen_document: "non-trivial",
    remote_code_removed: "non-trivial",
    eval_removed: "non-trivial",
    storage_over_dom_state: "non-trivial",
};

/** Semi-trivial JS-level API families measured by the two-sided call-site scan. */
const API_FAMILIES: { family: ResidualFamily; title: string; id: ChangeId | null }[] = [
    { family: "extension", title: "`chrome.extension.*` → `chrome.runtime.*`", id: null },
    { family: "tabs", title: "MV2-only `chrome.tabs.*` forms → `chrome.tabs.query` / `chrome.tabs.onActivated`", id: null },
    { family: "browser_action", title: "`chrome.browserAction.*` → `chrome.action.*` (JS level)", id: null },
    { family: "page_action", title: "`chrome.pageAction.*` → `chrome.action.*` (JS level)", id: null },
    { family: "runtime", title: "`chrome.runtime.onSuspend` removed", id: null },
];

interface Tag {
    tag: string;
    kind: string;
    title: string;
    provenance: string;
    reason?: string;
    evidence?: { file: string; snippet?: string }[];
}
interface Report {
    report?: { extensionId?: string; verdict?: string; notes?: string };
    tagsBackfill?: {
        source?: string;
        tailTagLines?: string[];
        summaryLine?: string | null;
        counts?: { applied: number; needed: number; skipped: number; misc: number } | null;
        runMeta?: { label?: string | null; abstained?: boolean; hasHardBlocker?: boolean | null } | null;
        neededSignals?: Record<string, string> | null;
        warnings?: string[];
        tags: Tag[];
    };
}

const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const n = (x: number): string => String(x);

function verdictRow(vd: Record<string, number>, count: number): string {
    const order = ["working", "not_testable", "not_working", "partially_working"];
    return order.map((v) => `${vd[v] ?? 0} (${Math.round((100 * (vd[v] ?? 0)) / count)}%)`).join(" | ") + ` | **${count}**`;
}

function main(): void {
    const args = process.argv.slice(2);
    const outFlag = args.indexOf("--out");
    const outPath = outFlag >= 0 ? args[outFlag + 1] : join(ROOT, "data/tag-distribution.md");

    const data = JSON.parse(readFileSync(join(ROOT, "data/extlens-reports-2026-10-12.json"), "utf8")) as { reports: Report[] };
    const reports = data.reports;
    const total = reports.length;
    const conversion: ConversionByExt = JSON.parse(readFileSync(join(ROOT, "data/api-conversion.json"), "utf8"));
    const conversionByExtId = new Map<string, (typeof conversion)[string]>();
    for (const [key, fams] of Object.entries(conversion)) conversionByExtId.set(key.includes("/") ? key.split("/")[1] : key, fams);

    const extId = (r: Report): string => r.report?.extensionId ?? "";
    const verdict = (r: Report): string => r.report?.verdict ?? "?";
    const tagOf = (r: Report, name: string): Tag | undefined => r.tagsBackfill?.tags.find((t) => t.tag === name);
    const byKind = (r: Report, kind: string): Tag[] => r.tagsBackfill?.tags.filter((t) => t.kind === kind) ?? [];

    const L: string[] = [];
    const line = (s = ""): void => L.push(s);

    // ---------------------------------------------------------------- header
    line("# Appendix — Distribution of changes across the necessary MV3 migrations");
    line();
    line(`Corpus: **${total} Chrome extensions** migrated MV2→MV3 by one pipeline run (converter + LLM agent, model \`saia/gemma-4-31b-it-fp8-256k\`), then installed and verified in Chrome.`);
    line();
    line("Every change is attributed through one of four measurement channels, each lossless at its source:");
    line();
    line("1. **pipeline ledger** (`runs.tail` in migrator.db): the run's own final log lines, copied verbatim — exact per-migration skip reasons, spurious and repair events;");
    line("2. **transcript replay**: the agent's read/edit/write calls replayed over the extension's files — applied changes and final manifest state, with file-level evidence;");
    line("3. **verification report**: surfaces exposed and the verdict after install-and-test;");
    line("4. **two-sided call-site scan**: MV2-only API forms counted in the MV2 source (`needed`) and in the migrated output (`residual`); `converted = needed − residual`.");
    line();
    line(`A migration counts as *needed* for an extension when the task-build's static analysis flagged it (\`neededSignals\`) or the call-site scan found \`needed > 0\`; for the manifest-mechanical migrations the final state is the observation, since the converter applies them before the transcript begins.`);
    line();

    // ---------------------------------------------------------------- taxonomy
    line("## Necessary migrations");
    line();
    line("| tier | migration | observed via |");
    line("|---|---|---|");
    for (const id of ALL_CHANGE_IDS) {
        const via = TIER[id] === "trivial" ? "final-state scan + ledger" : TIER[id] === "semi-trivial" ? "ledger + call-site scan" : "ledger + transcript + static signal";
        line(`| ${TIER[id]} | ${esc(CHANGE_TITLES[id])} | ${via} |`);
    }
    for (const f of API_FAMILIES) line(`| semi-trivial | ${esc(f.title)} | call-site scan |`);
    line();

    // ---------------------------------------------------------------- per-migration distribution
    line("## Distribution per migration");
    line();
    line("Verdicts after install-and-test, % within the extension set marked by the migration. `needed` is the number of extensions the migration applied to; `skipped` is needed-but-not-applied, with the pipeline's own reason.");
    line();

    for (const tier of ["trivial", "semi-trivial", "non-trivial"] as Tier[]) {
        line(`### ${tier}`);
        line();
        for (const id of ALL_CHANGE_IDS.filter((i) => TIER[i] === tier)) {
            const stateTag = `state.${id}`;
            const changeTag = `change.${id}`;
            const skipTag = `skipped.${id}`;
            const spuriousTag = `spurious.${id}`;
            const stateExts = reports.filter((r) => tagOf(r, stateTag));
            const changeExts = reports.filter((r) => tagOf(r, changeTag));
            const skipExts = reports.filter((r) => tagOf(r, skipTag));
            const spuriousExts = reports.filter((r) => tagOf(r, spuriousTag));
            const observed = reports.filter((r) => tagOf(r, stateTag) || tagOf(r, changeTag) || tagOf(r, skipTag) || tagOf(r, spuriousTag));
            if (!observed.length) {
                line(`- **${esc(CHANGE_TITLES[id])}** — never needed in this corpus.`);
                continue;
            }
            const vd: Record<string, number> = {};
            for (const r of observed) vd[verdict(r)] = (vd[verdict(r)] ?? 0) + 1;
            const reasons: Record<string, number> = {};
            for (const r of skipExts) {
                const t = tagOf(r, skipTag)!;
                reasons[t.reason ?? "?"] = (reasons[t.reason ?? "?"] ?? 0) + 1;
            }
            const reasonStr = Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(", ");
            line(`- **${esc(CHANGE_TITLES[id])}**`);
            line(`  - needed/applied/skipped/spurious: ${observed.length} / ${stateExts.length + changeExts.length} / ${skipExts.length} / ${spuriousExts.length}${reasonStr ? ` (skips: ${reasonStr})` : ""}`);
            line(`  - verdicts: ${verdictRow(vd, observed.length)}`);
            if (skipExts.length) {
                const svd: Record<string, number> = {};
                for (const r of skipExts) svd[verdict(r)] = (svd[verdict(r)] ?? 0) + 1;
                line(`  - verdicts when skipped: ${verdictRow(svd, skipExts.length)}`);
            }
        }
        // Semi-trivial call-site rows folded into the tier they belong to
        if (tier === "semi-trivial") {
            for (const f of API_FAMILIES) {
                const rows: { counts: { needed: number; residual: number }; verdict: string }[] = [];
                for (const r of reports) {
                    const c = conversionByExtId.get(extId(r))?.[f.family];
                    if (c) rows.push({ counts: c, verdict: verdict(r) });
                }
                if (!rows.length) {
                    line(`- **${esc(f.title)}** — never needed in this corpus.`);
                    continue;
                }
                const needed = rows.reduce((s, x) => s + x.counts.needed, 0);
                const residual = rows.reduce((s, x) => s + x.counts.residual, 0);
                const full = rows.filter((x) => x.counts.needed > 0 && x.counts.residual === 0).length;
                const part = rows.filter((x) => x.counts.needed > 0 && x.counts.residual > 0).length;
                const vd: Record<string, number> = {};
                for (const x of rows) vd[x.verdict] = (vd[x.verdict] ?? 0) + 1;
                line(`- **${esc(f.title)}** — ${needed} call sites needed in ${rows.length} extensions; ${needed - residual} converted, ${residual} residual (${full} extensions fully converted, ${part} partial)`);
                line(`  - verdicts: ${verdictRow(vd, rows.length)}`);
            }
        }
        line();
    }

    // ---------------------------------------------------------------- per-extension detail
    line("## Per-extension detail");
    line();
    line("One row per extension. `applied` lists applied migrations (state = converter-applied manifest form, change = agent-attributable); `skipped` carries the pipeline's reason; API conversion cells are `converted/needed` call sites.");
    line();
    line("| extension | verdict | label | applied (state) | applied (change) | skipped | spurious | repairs | " + API_FAMILIES.map((f) => f.family).join(" | ") + " |");
    line("|---|---|---|---|---|---|---|---|" + API_FAMILIES.map(() => "---").join("|"));
    const sorted = [...reports].sort((a, b) => extId(a).localeCompare(extId(b)));
    for (const r of sorted) {
        const id = extId(r);
        const state = byKind(r, "misc").filter((t) => t.tag.startsWith("state.") && !t.tag.startsWith("state.mv2_api_residual")).map((t) => t.tag.slice(6));
        const change = byKind(r, "applied").map((t) => t.tag.slice(7));
        const skipped = byKind(r, "skipped").map((t) => `${t.tag.slice(8)}${t.reason && t.reason !== "unexplained" ? ` (${t.reason})` : ""}`);
        const spurious = byKind(r, "spurious").map((t) => t.tag.slice(9));
        const repair = byKind(r, "repair");
        const conv = conversionByExtId.get(id);
        const convCells = API_FAMILIES.map((f) => {
            const c = conv?.[f.family];
            return c ? `${c.converted}/${c.needed}` : "—";
        });
        line(`| \`${id.slice(0, 12)}…\` | ${verdict(r)} | ${r.tagsBackfill?.runMeta?.label ?? "—"} | ${state.length ? esc(state.join(", ")) : "—"} | ${change.length ? esc(change.join(", ")) : "—"} | ${skipped.length ? esc(skipped.join(", ")) : "—"} | ${spurious.length ? esc(spurious.join(", ")) : "—"} | ${repair.length} | ${convCells.join(" | ")} |`);
    }
    line();

    // ---------------------------------------------------------------- residual evidence
    line("## Residual MV2 API forms (verbatim)");
    line();
    line("Every MV2-only call site that survived migration, exactly as written in the migrated output.");
    line();
    for (const [key, fams] of Object.entries(conversion).sort()) {
        const lines: string[] = [];
        for (const [fam, c] of Object.entries(fams)) {
            for (const h of c!.residuals) lines.push(`- \`${h.file}:${h.line}\`: \`${esc(h.snippet)}\``);
        }
        if (!lines.length) continue;
        line(`### \`${key}\``);
        line();
        for (const l of lines) line(l);
        line();
    }

    writeFileSync(outPath, L.join("\n"));
    console.log(`wrote ${outPath} (${L.length} lines)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
