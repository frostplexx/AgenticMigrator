#!/usr/bin/env npx tsx
/**
 * Self-contained HTML dashboard for the tag distribution (appendix companion).
 *
 * Folds the tagged export and the two-sided API conversion scan into one file with inline
 * charts and a searchable per-extension table. No dependencies, no server: open it in a browser.
 *
 * Usage: npx tsx scripts/tag_dashboard.ts [--out data/tag-dashboard.html]
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

interface Tag { tag: string; kind: string; title: string; provenance: string; reason?: string }
interface Row {
    id: string; verdict: string; label: string;
    state: string[]; change: string[]; skipped: { id: string; reason?: string }[];
    spurious: string[]; repairs: number;
    conv: Partial<Record<ResidualFamily, { needed: number; residual: number }>>;
    surfaces: string[]; legacy: string[]; tools: number; reportSurfaces: { surface: string; status: string }[];
}

const API_FAMILIES: { family: ResidualFamily; title: string }[] = [
    { family: "extension", title: "chrome.extension.* → chrome.runtime.*" },
    { family: "tabs", title: "MV2-only chrome.tabs.* forms" },
    { family: "browser_action", title: "chrome.browserAction.* → chrome.action.*" },
    { family: "page_action", title: "chrome.pageAction.* → chrome.action.*" },
    { family: "runtime", title: "chrome.runtime.onSuspend removed" },
];

function main(): void {
    const args = process.argv.slice(2);
    const outFlag = args.indexOf("--out");
    const outPath = outFlag >= 0 ? args[outFlag + 1] : join(ROOT, "data/tag-dashboard.html");

    const data = JSON.parse(readFileSync(join(ROOT, "data/extlens-reports-2026-10-12.json"), "utf8")) as { reports: any[] };
    const conversion: ConversionByExt = JSON.parse(readFileSync(join(ROOT, "data/api-conversion.json"), "utf8"));
    const conversionByExtId = new Map<string, (typeof conversion)[string]>();
    for (const [key, fams] of Object.entries(conversion)) conversionByExtId.set(key.includes("/") ? key.split("/")[1] : key, fams);

    const rows: Row[] = data.reports.map((r) => {
        const id = r.report?.extensionId ?? "";
        const tags: Tag[] = r.tagsBackfill?.tags ?? [];
        return {
            id,
            verdict: r.report?.verdict ?? "?",
            label: r.tagsBackfill?.runMeta?.label ?? "",
            state: tags.filter((t) => t.kind === "misc" && t.tag.startsWith("state.") && !t.tag.startsWith("state.mv2_api_residual")).map((t) => t.tag.slice(6)),
            change: tags.filter((t) => t.kind === "applied").map((t) => t.tag.slice(7)),
            skipped: tags.filter((t) => t.kind === "skipped").map((t) => ({ id: t.tag.slice(8), reason: t.reason })),
            spurious: tags.filter((t) => t.kind === "spurious").map((t) => t.tag.slice(9)),
            repairs: tags.filter((t) => t.kind === "repair").length,
            conv: Object.fromEntries(
                Object.entries(conversionByExtId.get(id) ?? {}).map(([fam, c]) => [fam, { needed: c!.needed, residual: c!.residual }]),
            ),
            surfaces: tags.filter((t) => t.tag.startsWith("surface.")).map((t) => t.tag.slice(8)),
            legacy: (r.tags ?? []) as string[],
            tools: r.agentUsage?.toolCallCount ?? 0,
            reportSurfaces: (r.report?.surfaces ?? []).map((s: any) => ({ surface: s.surface, status: s.status ?? "?" })),
        };
    });

    // Per-migration aggregates for the ledger-tracked ChangeIds
    const migrations = ALL_CHANGE_IDS.map((id) => {
        const stateKey = `state.${id}`;
        const mark = (r: Row): number =>
            (r.state.includes(id) || r.change.includes(id) ? 1 : 0) +
            (r.skipped.some((s) => s.id === id) ? 1 : 0) +
            (r.spurious.includes(id) ? 1 : 0);
        const applied: Row[] = [], skipped: Row[] = [], spurious: Row[] = [];
        for (const r of rows) {
            if (r.state.includes(id) || r.change.includes(id)) applied.push(r);
            else if (r.skipped.some((s) => s.id === id)) skipped.push(r);
            if (r.spurious.includes(id)) spurious.push(r);
        }
        void mark;
        const observed = new Set([...applied, ...skipped]);
        const vd: Record<string, number> = {};
        for (const r of observed) vd[r.verdict] = (vd[r.verdict] ?? 0) + 1;
        const reasons: Record<string, number> = {};
        for (const r of skipped) for (const s of r.skipped.filter((x) => x.id === id)) reasons[s.reason ?? "unexplained"] = (reasons[s.reason ?? "unexplained"] ?? 0) + 1;
        return { id, title: CHANGE_TITLES[id], tier: TIER[id], applied: applied.length, skipped: skipped.length, spurious: spurious.length, verdicts: vd, reasons };
    });

    const apiStats = API_FAMILIES.map((f) => {
        let needed = 0, residual = 0, exts = 0, full = 0;
        const vd: Record<string, number> = {};
        for (const r of rows) {
            const c = r.conv[f.family];
            if (!c) continue;
            exts++;
            needed += c.needed;
            residual += c.residual;
            if (c.needed > 0 && c.residual === 0) full++;
            vd[r.verdict] = (vd[r.verdict] ?? 0) + 1;
        }
        return { ...f, needed, residual, converted: needed - residual, exts, full, verdicts: vd };
    });

    const verdicts = ["working", "not_testable", "not_working", "partially_working"];

    // Corpus-level overview
    const verdictTotals: Record<string, number> = {}, labelTotals: Record<string, number> = {},
        surfaceTotals: Record<string, number> = {}, stateTotals: Record<string, number> = {},
        reasonTotals: Record<string, number> = {}, legacyTotals: Record<string, number> = {},
        surfaceStatus: Record<string, Record<string, number>> = {};
    let totApplied = 0, totSkipped = 0, totSpurious = 0, totRepairs = 0;
    for (const r of rows) {
        verdictTotals[r.verdict] = (verdictTotals[r.verdict] ?? 0) + 1;
        labelTotals[r.label || "(unlabeled)"] = (labelTotals[r.label || "(unlabeled)"] ?? 0) + 1;
        totApplied += r.change.length;
        totSkipped += r.skipped.length;
        totSpurious += r.spurious.length;
        totRepairs += r.repairs;
        for (const s of r.skipped) reasonTotals[s.reason ?? "unexplained"] = (reasonTotals[s.reason ?? "unexplained"] ?? 0) + 1;
        for (const s of r.surfaces) surfaceTotals[s] = (surfaceTotals[s] ?? 0) + 1;
        for (const s of r.state) stateTotals[s] = (stateTotals[s] ?? 0) + 1;
        for (const l of r.legacy) legacyTotals[l] = (legacyTotals[l] ?? 0) + 1;
        for (const s of r.reportSurfaces) {
            const agg = (surfaceStatus[s.surface] ??= {});
            agg[s.status] = (agg[s.status] ?? 0) + 1;
        }
    }
    const tagCats = new Map<string, Map<string, number>>();
    const catOf = (t: Tag): string =>
        t.kind === "misc"
            ? t.tag.startsWith("state.mv2_api_residual") ? "MV2 API residuals"
            : t.tag.startsWith("state.") ? "state.* (mechanical / converter)"
            : t.tag.startsWith("surface.") ? "surface.* (surfaces)"
            : t.tag.startsWith("source.") ? "source.* (MV2 source)" : t.tag
        : t.kind === "applied" ? "applied (change.*)"
        : t.kind === "skipped" ? "skipped"
        : t.kind === "spurious" ? "spurious"
        : t.kind === "repair" ? "repair" : t.kind;
    for (const r of data.reports) {
        for (const t of (r.tagsBackfill?.tags ?? []) as Tag[]) {
            const cat = catOf(t);
            const m = tagCats.get(cat) ?? new Map<string, number>();
            m.set(t.tag, (m.get(t.tag) ?? 0) + 1);
            tagCats.set(cat, m);
        }
        for (const l of (r.tags ?? []) as string[]) {
            const m = tagCats.get("MV2 properties (extlens)") ?? new Map<string, number>();
            m.set(l, (m.get(l) ?? 0) + 1);
            tagCats.set("MV2 properties (extlens)", m);
        }
    }
    const tagList = [...tagCats.entries()].map(([category, items]) => ({
        category,
        total: [...items.values()].reduce((a, b) => a + b, 0),
        items: [...items.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count),
    })).sort((a, b) => b.total - a.total);
    const summary = { tagList, totApplied, totSkipped, totSpurious, totRepairs };
    const VD_COLOR: Record<string, string> = {
        working: "#2e9e5b", not_testable: "#b8b8b8", not_working: "#d64545", partially_working: "#e2a33d",
    };
    const REASON_COLOR: Record<string, string> = {
        platform: "#4a7dbd", limited: "#7a5fb5", abstained: "#d689b4", unexplained: "#d64545",
    };

    const payload = JSON.stringify({ summary, migrations, apiStats, verdicts, vdColor: VD_COLOR, reasonColor: REASON_COLOR, rows });

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>MV3 migration — tag distribution</title>
<style>
:root { --fg:#1c1c1c; --muted:#666; --line:#e3e3e3; --bg:#fff; --card:#fafafa; }
* { box-sizing:border-box; }
body { font:14px/1.45 -apple-system, "Segoe UI", sans-serif; color:var(--fg); background:var(--bg); margin:0; padding:32px; max-width:1200px; margin-inline:auto; }
h1 { font-size:22px; } h2 { font-size:17px; margin-top:40px; border-bottom:2px solid var(--line); padding-bottom:6px; }
.muted { color:var(--muted); }
table { border-collapse:collapse; width:100%; font-size:13px; }
th, td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); }
th { position:sticky; top:0; background:var(--bg); cursor:default; }
.num { text-align:right; font-variant-numeric:tabular-nums; }
.bar-row { display:flex; align-items:center; gap:8px; margin:3px 0; }
.bar-label { width:340px; font-size:12.5px; text-align:right; color:var(--muted); flex-shrink:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bar-track { flex:1; display:flex; height:18px; border-radius:3px; overflow:hidden; background:#f0f0f0; }
.bar-seg { height:100%; }
.legend { display:flex; gap:16px; margin:8px 0 14px; font-size:12.5px; flex-wrap:wrap; }
.legend span::before { content:"■ "; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px 20px; margin:14px 0; }
.controls { display:flex; gap:10px; margin:10px 0; flex-wrap:wrap; }
input, select { font:inherit; padding:4px 8px; border:1px solid var(--line); border-radius:5px; }
.kchip { display:inline-block; background:#eef; border:1px solid #ccd; border-radius:4px; padding:0 5px; margin:1px; font-size:11.5px; }
.chip.platform { background:#e8f0fb; border-color:#4a7dbd; } .chip.limited { background:#efe9f8; border-color:#7a5fb5; }
.chip.abstained { background:#fbe9f2; border-color:#d689b4; } .chip.unexplained { background:#fdeaea; border-color:#d64545; }
.skipme { color:#d64545; } .conv-ok { color:#2e9e5b; } .conv-part { color:#e2a33d; }
td.idcell { font-family:ui-monospace, monospace; font-size:11.5px; }
.pct { color:var(--muted); font-size:11px; }
#ov { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.trow { display:flex; justify-content:space-between; gap:10px; padding:1px 0; border-bottom:1px dotted var(--line); font-size:12px; }
.tname { font-family:ui-monospace, monospace; }
</style></head><body>
<h1>MV3 migration — distribution of changes across the necessary migrations</h1>
<p class="muted">${rows.length} extensions · converter + agent (<code>saia/gemma-4-31b-it-fp8-256k</code>) · installed &amp; verified. Sources: pipeline ledger lines, transcript replay, verification report, two-sided call-site scan. Generated ${new Date().toISOString().slice(0, 10)}.</p>

<h2>Tag totals</h2>
<p class="muted" style="font-size:12px;line-height:1.7">▪ <b>applied (change.*)</b> — the migration was applied in the migrated output &nbsp;·&nbsp; ▪ <b>skipped</b> — needed but not applied &nbsp;·&nbsp; ▪ <b>spurious</b> — applied but never needed: the output contains the change, the MV2 original never required it &nbsp;·&nbsp; ▪ <b>repair</b> — fixes the agent made during the run's repair phase &nbsp;·&nbsp; ▪ <b>state.*</b> — mechanical converter output (manifest facts), not agent decisions &nbsp;·&nbsp; ▪ <b>surface.*</b> — UI surfaces the extension has &nbsp;·&nbsp; ▪ <b>source.*</b> — MV2 source properties (minified, webpack-bundled) &nbsp;·&nbsp; ▪ <b>MV2 API residuals</b> — MV2-only API calls left in the migrated output &nbsp;·&nbsp; ▪ <b>MV2 properties (extlens)</b> — the export's original tags describing the MV2 source</p>
<div id="ov"></div>

<h2>Change counts per necessary migration</h2>
<details><summary class="muted">What the categories mean</summary>
<div class="card">
<p><b>applied</b> — the migration is present in the migrated output. For the manifest-mechanical migrations this is a final-state observation (the converter applied them before the agent ran); for the rest it is agent-attributable work reconstructed from the transcript.</p>
<p><b>skipped</b> — needed but not applied: the MV2 extension had the feature, the migration did not convert it. The pipeline's own ledger records why: <span class="kchip chip platform">platform</span> impossible in MV3, <span class="kchip chip limited">limited</span> partially expressible, <span class="kchip chip abstained">abstained</span> the agent declined the capability, <span class="kchip chip unexplained">unexplained</span> needed but not applied with no reason on record — the failure mode.</p>
<p><b>spurious</b> — the mirror image of skipped: applied but <i>never needed</i>. The migrated output contains the change although the original extension never had the feature that requires it. Example: an offscreen document scaffolded for a background script that never touched DOM APIs, or a <code>host_permissions</code> block added when the source had no URL permissions to split. Over-application of a template without its trigger; usually harmless at verification time (skips drag verdicts down, spurious do not).</p>
<p><b>repair</b> — a separate event channel: fixes the LLM made during the run's repair phase, counted per extension, not attributed to a single migration.</p>
</div>
</details>
<p class="muted">Applied (green: final-state observation for manifest-mechanical, agent-attributable otherwise), skipped (red), spurious (orange).</p>
<div class="legend"><span style="color:#2e9e5b">applied</span><span style="color:#d64545">skipped</span><span style="color:#e2a33d">spurious</span></div>
<div id="mig"></div>

<h2>Verdict composition per migration</h2>
<p class="muted">100% stacked over extensions touched by each migration. Reading: does needing this migration predict the verdict?</p>
<div class="legend"><span style="color:#2e9e5b">working</span><span style="color:#b8b8b8">not testable</span><span style="color:#d64545">not working</span><span style="color:#e2a33d">partially working</span></div>
<div id="vd"></div>

<h2>Skip reasons per migration</h2>
<details open><summary class="muted">How a skip gets its reason</summary>
<div class="card">
<p class="muted">Every skip here is a change the ledger scored <code>needed && !applied</code> — the MV2 extension had the feature and the migration did not convert it. The reason is assigned once, in priority order (<code>skipReason</code> in <code>src/host/tags.ts</code>):</p>
<p><span class="kchip chip platform">platform</span> <b>MV3 removed the capability outright</b> — e.g. reading response bodies or running remotely hosted code. The only faithful migration is to leave it out, so the framework skips it on purpose; this is a fact about Chrome, not a failure. Each such tag carries the Chrome docs URL as evidence, so the claim is checkable.</p>
<p><span class="kchip chip abstained">abstained</span> <b>the agent declined, in writing</b> — it produced an <code>ABSTAIN.md</code> whose text names the capability (matched by per-change word patterns). The agent's own word outranks the support table: it is a claim with evidence attached, so it takes precedence over the two categories below. The ABSTAIN.md excerpt is kept on the tag.</p>
<p><span class="kchip chip limited">limited</span> <b>MV3 supports it only partly</b> — an equivalent exists that covers the common cases but not the rest, e.g. declarativeNetRequest expresses static block/redirect rules but cannot decide anything from the request at request time. Whether a given skip here is the platform's doing or the model's needs the evidence read before it is counted either way.</p>
<p><span class="kchip chip unexplained">unexplained</span> <b>needed but not applied, no reason on record</b> — MV3 has a full equivalent (e.g. <code>eval()</code> is always rewritable), so not applying it is a defect of the migration: the framework met this change and moved on. This is the failure mode a load-only verifier cannot see, and it dominates: 243 of 312 skips.</p>
<p class="muted">Priority order: platform → abstained → limited → unexplained. A skip of a full-support change is never the platform's; a partial-support skip without an abstention stays unattributed (limited) rather than being guessed.</p>
</div>
</details>
<div id="rs"></div>

<h2>Semi-trivial API rewrites — call-site conversion</h2>
<p class="muted">needed = MV2-only forms in the MV2 source; converted = needed − residual. The agent converts ~94–97% of call sites.</p>
<div id="api"></div>

<h2>Per-extension detail</h2>
<div class="controls">
  <input id="q" type="search" placeholder="filter by extension id…" size="24">
  <select id="fv"><option value="">verdict: all</option></select>
  <select id="fl"><option value="">label: all</option></select>
  <label><input type="checkbox" id="fr"> only with residual MV2 APIs</label>
</div>
<table id="ext"><thead><tr>
<th>extension</th><th>verdict</th><th>label</th><th>MV2 properties</th><th>surfaces</th><th>applied (state)</th><th>applied (change)</th><th>skipped</th><th>spurious</th><th class="num">repairs</th><th class="num">tool calls</th><th>API conversion (converted/needed)</th>
</tr></thead><tbody></tbody></table>
<p class="muted" id="extcount"></p>

<script>
const D = ${payload};
const h = (tag, attrs, children) => { const e = document.createElement(tag); for (const k in attrs) e.setAttribute(k, attrs[k]); (children ?? []).forEach(c => e.appendChild(c)); return e; };
const txt = s => document.createTextNode(s);

// 0. tag list — categories with per-tag counts
for (const cat of D.summary.tagList) {
    const card = h("div", { class: "card", style: "margin:0" });
    const hd = h("div", { style: "font-weight:600;margin-bottom:6px" });
    hd.textContent = cat.category + " — " + cat.total;
    card.appendChild(hd);
    for (const it of cat.items) {
        const row = h("div", { class: "trow" });
        const nm = h("span", { class: "tname" }); nm.textContent = it.tag;
        const c = h("span", { class: "muted num" }); c.textContent = it.count;
        row.appendChild(nm); row.appendChild(c); card.appendChild(row);
    }
    document.getElementById("ov").appendChild(card);
}

// 1. migration stacked bars
const maxM = Math.max(...D.migrations.map(m => m.applied + m.skipped + m.spurious), 1);
for (const m of D.migrations) {
    const total = m.applied + m.skipped + m.spurious;
    const row = h("div", { class: "bar-row", title: m.title + " — applied " + m.applied + ", skipped " + m.skipped + ", spurious " + m.spurious });
    const lab = h("div", { class: "bar-label" }); lab.textContent = m.title; row.appendChild(lab);
    const track = h("div", { class: "bar-track" });
    const seg = (n, color) => { const s = h("div", { class: "bar-seg" }); s.style.width = (100 * n / maxM) + "%"; s.style.background = color; return s; };
    if (m.applied) track.appendChild(seg(m.applied, "#2e9e5b"));
    if (m.skipped) track.appendChild(seg(m.skipped, "#d64545"));
    if (m.spurious) track.appendChild(seg(m.spurious, "#e2a33d"));
    const n = h("span", { class: "num pct", style: "width:110px;flex-shrink:0" }); n.textContent = total ? (m.applied + "✓ " + m.skipped + "✗ " + m.spurious + "?") : "never needed";
    row.appendChild(track); row.appendChild(n);
    document.getElementById("mig").appendChild(row);
}

// 2. verdict composition
function vdBar(container, label, vd, count, title) {
    const row = h("div", { class: "bar-row", title });
    const lab = h("div", { class: "bar-label" }); lab.textContent = label; row.appendChild(lab);
    const track = h("div", { class: "bar-track" });
    for (const v of D.verdicts) {
        if (!vd[v]) continue;
        const s = h("div", { class: "bar-seg" });
        s.style.width = (100 * vd[v] / count) + "%"; s.style.background = D.vdColor[v] || "#8a8a8a";
        row.title = title;
        track.appendChild(s);
    }
    const n = h("span", { class: "num pct", style: "width:110px;flex-shrink:0" }); n.textContent = count + " ext";
    row.appendChild(track); row.appendChild(n);
    container.appendChild(row);
}
for (const m of D.migrations) {
    const count = Object.values(m.verdicts).reduce((a, b) => a + b, 0);
    if (count) vdBar(document.getElementById("vd"), m.title, m.verdicts, count, m.title);
}
for (const a of D.apiStats) {
    if (a.exts) vdBar(document.getElementById("vd"), a.title + " (scan)", a.verdicts, a.exts, a.title);
}

// 3. skip reasons
for (const m of D.migrations) {
    const total = Object.values(m.reasons).reduce((a, b) => a + b, 0);
    if (!total) continue;
    const row = h("div", { class: "bar-row", title: m.title });
    const lab = h("div", { class: "bar-label" }); lab.textContent = m.title; row.appendChild(lab);
    const track = h("div", { class: "bar-track" });
    for (const [reason, count] of Object.entries(m.reasons)) {
        const s = h("div", { class: "bar-seg" });
        s.style.width = (100 * count / Math.max(...D.migrations.map(x => Object.values(x.reasons).reduce((a, b) => a + b, 0)), 1)) + "%";
        s.style.background = D.reasonColor[reason] || "#999";
        track.appendChild(s);
    }
    const detail = Object.entries(m.reasons).map(([k, v]) => k + " " + v).join(", ");
    const n = h("span", { class: "pct", style: "width:200px;flex-shrink:0;font-size:11px" }); n.textContent = detail;
    row.appendChild(track); row.appendChild(n);
    document.getElementById("rs").appendChild(row);
}

// 4. API conversion bars
const maxA = Math.max(...D.apiStats.map(a => a.needed), 1);
for (const a of D.apiStats) {
    const row = h("div", { class: "bar-row", title: a.title + " — " + a.converted + "/" + a.needed + " call sites converted" });
    const lab = h("div", { class: "bar-label" }); lab.textContent = a.title; row.appendChild(lab);
    const track = h("div", { class: "bar-track" });
    const ok = h("div", { class: "bar-seg" }); ok.style.width = (100 * a.converted / maxA) + "%"; ok.style.background = "#2e9e5b";
    const rest = h("div", { class: "bar-seg" }); rest.style.width = (100 * a.residual / maxA) + "%"; rest.style.background = "#d64545";
    if (a.converted) track.appendChild(ok);
    if (a.residual) track.appendChild(rest);
    const n = h("span", { class: "num pct", style: "width:160px;flex-shrink:0" });
    n.textContent = a.needed ? (a.converted + "/" + a.needed + " sites · " + a.exts + " ext") : "never needed";
    row.appendChild(track); row.appendChild(n);
    document.getElementById("api").appendChild(row);
}

// 5. per-extension table
const tbody = document.querySelector("#ext tbody");
const fv = document.getElementById("fv"), fl = document.getElementById("fl");
for (const v of [...new Set(D.rows.map(r => r.verdict))].sort()) fv.appendChild(h("option", { value: v }, [txt(v)]));
for (const l of [...new Set(D.rows.map(r => r.label).filter(Boolean))].sort()) fl.appendChild(h("option", { value: l }, [txt(l)]));

function chips(list, cls) {
    const td = h("td");
    if (!list.length) { td.textContent = "—"; td.className = "muted"; return td; }
    for (const item of list) {
        if (item && typeof item === "object") {
            const c = h("span", { class: "kchip chip " + (item.reason || "") });
            c.textContent = item.id + (item.reason && item.reason !== "unexplained" ? " (" + item.reason + ")" : "");
            td.appendChild(c);
        } else {
            const c = h("span", { class: "kchip" }); c.textContent = item; td.appendChild(c);
        }
    }
    return td;
}
function convCell(r) {
    const td = h("td", { class: "muted" });
    const parts = [];
    for (const f of ${JSON.stringify(API_FAMILIES.map(x => x.family))}) {
        const c = r.conv[f];
        if (!c) continue;
        const cls = c.residual === 0 ? "conv-ok" : (c.converted > 0 ? "conv-part" : "skipme");
        parts.push('<span class="' + cls + '">' + f + " " + c.converted + "/" + c.needed + "</span>");
    }
    if (!parts.length) { td.textContent = "—"; return td; }
    td.className = ""; td.innerHTML = parts.join(" ");
    return td;
}
function render() {
    const q = document.getElementById("q").value.toLowerCase();
    const v = fv.value, l = fl.value, onlyRes = document.getElementById("fr").checked;
    tbody.textContent = "";
    let shown = 0;
    for (const r of D.rows) {
        if (q && !r.id.includes(q)) continue;
        if (v && r.verdict !== v) continue;
        if (l && r.label !== l) continue;
        if (onlyRes && !Object.values(r.conv).some(c => c.residual > 0)) continue;
        shown++;
        const tr = h("tr");
        const idTd = h("td", { class: "idcell" }); idTd.textContent = r.id.slice(0, 12) + "…"; tr.appendChild(idTd);
        const vTd = h("td"); vTd.textContent = r.verdict; tr.appendChild(vTd);
        const lTd = h("td", { class: r.label ? "" : "muted" }); lTd.textContent = r.label || "—"; tr.appendChild(lTd);
        tr.appendChild(chips(r.legacy));
        tr.appendChild(chips(r.surfaces));
        tr.appendChild(chips(r.state));
        tr.appendChild(chips(r.change));
        tr.appendChild(chips(r.skipped));
        tr.appendChild(chips(r.spurious));
        const rep = h("td", { class: "num" }); rep.textContent = r.repairs || "—"; tr.appendChild(rep);
        const tc = h("td", { class: "num" }); tc.textContent = r.tools || "—"; tr.appendChild(tc);
        tr.appendChild(convCell(r));
        tbody.appendChild(tr);
    }
    document.getElementById("extcount").textContent = shown + " / " + D.rows.length + " extensions shown";
}
document.getElementById("q").addEventListener("input", render);
fv.addEventListener("change", render); fl.addEventListener("change", render);
document.getElementById("fr").addEventListener("change", render);
render();
</script>
</body></html>`;

    writeFileSync(outPath, html);
    console.log(`wrote ${outPath} (${Math.round(html.length / 1024)} KB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
