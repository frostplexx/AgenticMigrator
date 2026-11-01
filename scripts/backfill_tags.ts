/**
 * Backfill thorough migration tags onto an extlens reports export.
 *
 * The export carries only the 12 legacy SCREAMING_CASE tags; the real vocabulary (change.* /
 * skipped.* / spurious.* / repair / surface.*) was computed at run time on a machine whose trees
 * are gone. Two local sources survive, joined by extension id:
 *
 *   1. data/migrator.db `runs.tail` — the pipeline's own final log lines, which itemize
 *      skipped (with reason), spurious and repair tags verbatim for 495/499 runs. These lines are
 *      copied through untouched; the dotted tags are derived FROM the verbatim lines.
 *   2. the export's transcripts — edit/write tool calls (with oldText/newText/content) from which
 *      applied changes are reconstructed, plus the agent's ABSTAIN.md for the 4 truncated tails.
 *   3. data/mv2-residuals.json, produced by scripts/mv2_residuals.ts from the rsynced migrated
 *      trees — MV2-only API forms (the semi-trivial rewrites) that remain in the output.
 *
 * Output: the export file is updated in place, each report gaining a `tagsBackfill` block. The
 * original `tags` array is never touched; nothing verbatim is discarded.
 *
 * Usage: npx tsx scripts/backfill_tags.ts [--stats] [export.json] [migrator.db] [residuals.json]
 */
import Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { residualTags, type ResidualFamily, type ResidualHit, type ResidualsByExt } from "./mv2_residuals.js";
import { CHANGE_TITLES, type ChangeId } from "../src/host/changes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EXPORT = join(ROOT, "data/extlens-reports-2026-10-12.json");
const DEFAULT_DB = join(ROOT, "data/migrator.db");
const DEFAULT_RESIDUALS = join(ROOT, "data/mv2-residuals.json");

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

type TagKind = "applied" | "skipped" | "repair" | "spurious" | "misc";
type SkipReason = "platform" | "abstained" | "limited" | "unexplained";

export interface BackfillTag {
    tag: string;
    kind: TagKind;
    title: string;
    provenance: "db" | "transcript" | "legacy" | "report" | "scan";
    reason?: SkipReason;
    evidence?: { file: string; snippet?: string }[];
}

export interface TagsBackfill {
    source: "migrator.db runs.tail" | "transcript" | "both" | "none";
    /** Verbatim per-tag log lines, exactly as captured. The source of truth for derived tags. */
    tailTagLines: string[];
    summaryLine: string | null;
    counts: { applied: number; needed: number; skipped: number; misc: number } | null;
    runMeta: { label: string | null; abstained: boolean; hasHardBlocker: number | null; runDir: string | null } | null;
    /** Needed-signals read from the task prompt's embedded static analysis (best effort). */
    neededSignals: Record<string, string> | null;
    warnings: string[];
    tags: BackfillTag[];
}

export interface TranscriptEntry {
    kind: string;
    role: string | null;
    callId: string | null;
    isError?: boolean | null;
    blocks: { type: string; text?: string; name?: string; arguments?: string; callId?: string }[];
}

// ---------------------------------------------------------------------------------------------
// Title → ChangeId: the backfill's contract with the ledger
// ---------------------------------------------------------------------------------------------

const TITLE_TO_ID = new Map<string, ChangeId>(Object.entries(CHANGE_TITLES).map(([id, title]) => [title, id as ChangeId]));

/** The generic abstention tag `buildTags` emits, which is not a ChangeId. */
const ABSTAINED_TITLE = "agent declined to migrate a capability";

const REPAIR_ROLE_TAGS: [RegExp, string][] = [
    [/^LLM repair edited the manifest$/, "repair.manifest_edited"],
    [/^LLM repair edited the background \/ service worker$/, "repair.background_edited"],
    [/^LLM repair edited a content script$/, "repair.content_script_edited"],
    [/^LLM repair edited a UI page$/, "repair.ui_page_edited"],
    [/^LLM repair edited \d+ file\(s\)$/, "repair.files_edited"],
];

/** Ported from tags.ts ABSTAIN_WORDS: free-text ABSTAIN.md → which change was declined. */
const ABSTAIN_WORDS: [ChangeId, RegExp][] = [
    ["webrequest_to_dnr", /webRequest|declarativeNetRequest|\bDNR\b|\bblock|\bredirect/i],
    ["webrequest_header_modification", /header|webRequest/i],
    ["webrequest_response_inspection", /filterResponseData|response body|onAuthRequired|webRequest/i],
    ["remote_code_removed", /remote(ly)?[ -]hosted|remote code|external script|CDN/i],
    ["eval_removed", /\beval\b|new Function|string evaluation|CSP/i],
    ["offscreen_document", /offscreen|DOM/i],
    ["storage_over_dom_state", /global|module-level|state|storage/i],
];

/** Legacy SCREAMING_CASE tags with a dotted equivalent; the rest stay verbatim in `tags`. */
const LEGACY_MAP: [string, string, TagKind, string][] = [
    ["MINIFIED_CODE", "source.minified", "misc", "minified source"],
    ["WEBPACK_BUNDLED", "source.bundled", "misc", "bundler output"],
    ["HAS_BROWSER_POPUP", "surface.popup", "misc", "exposes popup"],
    ["HAS_BACKGROUND_PAGE", "surface.background", "misc", "exposes background"],
    ["HAS_SERVICE_WORKER", "surface.background", "misc", "exposes background"],
    ["HAS_CONTENT_SCRIPTS", "surface.page_interaction", "misc", "exposes page interaction"],
    ["NEW_TAB_OVERRIDE", "surface.new_tab", "misc", "exposes new tab"],
];

// ---------------------------------------------------------------------------------------------
// Tier 1: db tail parser
// ---------------------------------------------------------------------------------------------

export interface ParsedTail {
    tagLines: string[];
    summaryLine: string | null;
    counts: { applied: number; needed: number; skipped: number; misc: number } | null;
    runDir: string | null;
    tags: BackfillTag[];
    unmappedTitles: string[];
    skipLineCount: number;
}

const SKIP_RE = /migrate │ skipped \((platform|limited|abstained|unexplained)\): (.+)$/;
const SPURIOUS_RE = /migrate │ spurious: (.+)$/;
const REPAIR_RE = /migrate │ repair: (.+)$/;
const SUMMARY_RE =
    /migrate │ (changes: (\d+)\/(\d+) applied, (\d+) skipped · tags: \d+ applied, \d+ skipped \((\d+) platform, (\d+) limited, (\d+) abstained, (\d+) unexplained\), (\d+) repair, (\d+) spurious, (\d+) misc)$/;
const RUNDIR_RE = /Migrated extension in (\S+)/;

/** Split "<change title> — <suffix>" and map the title part; the suffix restates the kind. */
function titleOf(line: string): { title: string; suffix: string } | null {
    const cut = line.indexOf(" — ");
    return cut === -1 ? null : { title: line.slice(0, cut), suffix: line.slice(cut + 3) };
}

export function parseTail(tail: string): ParsedTail {
    const result: ParsedTail = { tagLines: [], summaryLine: null, counts: null, runDir: null, tags: [], unmappedTitles: [], skipLineCount: 0 };
    for (const raw of tail.split("\n")) {
        const line = raw.trimEnd();
        const runDir = RUNDIR_RE.exec(line);
        if (runDir) result.runDir = runDir[1];

        const summary = SUMMARY_RE.exec(line);
        if (summary) {
            result.summaryLine = summary[1];
            result.counts = {
                applied: Number(summary[2]),
                needed: Number(summary[3]),
                skipped: Number(summary[4]),
                misc: Number(summary[11]),
            };
            continue;
        }

        let m: RegExpExecArray | null;
        if ((m = SKIP_RE.exec(line))) {
            result.tagLines.push(line);
            result.skipLineCount++;
            const { title } = titleOf(m[2]) ?? { title: m[2] };
            if (title === ABSTAINED_TITLE) {
                result.tags.push({ tag: "skipped.agent_abstained", kind: "skipped", reason: "abstained", title, provenance: "db" });
            } else if (TITLE_TO_ID.has(title)) {
                result.tags.push({ tag: `skipped.${TITLE_TO_ID.get(title)}`, kind: "skipped", reason: m[1] as SkipReason, title, provenance: "db" });
            } else {
                result.unmappedTitles.push(line);
            }
            continue;
        }
        if ((m = SPURIOUS_RE.exec(line))) {
            result.tagLines.push(line);
            const { title } = titleOf(m[1]) ?? { title: m[1] };
            const id = TITLE_TO_ID.get(title);
            if (id) result.tags.push({ tag: `spurious.${id}`, kind: "spurious", title, provenance: "db" });
            else result.unmappedTitles.push(line);
            continue;
        }
        if ((m = REPAIR_RE.exec(line))) {
            result.tagLines.push(line);
            const text = m[1];
            const role = REPAIR_ROLE_TAGS.find(([re]) => re.test(text));
            if (role) {
                result.tags.push({ tag: role[1], kind: "repair", title: text, provenance: "db" });
            } else if (text.endsWith(" — applied during LLM repair")) {
                const changeTitle = text.slice(0, -" — applied during LLM repair".length);
                const id = TITLE_TO_ID.get(changeTitle);
                if (id) result.tags.push({ tag: `repair.${id}`, kind: "repair", title: text, provenance: "db" });
                else result.unmappedTitles.push(line);
            } else {
                result.unmappedTitles.push(line);
            }
        }
    }
    return result;
}

// ---------------------------------------------------------------------------------------------
// Tier 2: transcript extraction
// ---------------------------------------------------------------------------------------------

export interface ToolEvent {
    name: string;
    args: any;
    result: string | null;
    isError: boolean;
}

function textOf(entry: TranscriptEntry): string {
    return entry.blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");
}

/** Ordered tool_call → tool-result stream, joined by callId. */
export function toolEvents(entries: TranscriptEntry[]): ToolEvent[] {
    const results = new Map<string, { text: string; isError: boolean }>();
    for (const entry of entries) {
        if (entry.kind === "message" && entry.role === "tool") {
            const text = textOf(entry);
            const call = entry.callId ?? entry.blocks.find((b) => b.callId)?.callId;
            if (call) results.set(call, { text, isError: entry.isError });
        }
    }
    const events: ToolEvent[] = [];
    for (const entry of entries) {
        if (entry.kind !== "message") continue;
        for (const block of entry.blocks) {
            if (block.type !== "tool_call" || !block.name || !block.callId) continue;
            let args: any;
            try {
                args = JSON.parse(block.arguments ?? "{}");
            } catch {
                args = {};
            }
            const result = results.get(block.callId);
            events.push({ name: block.name, args, result: result?.text ?? null, isError: result?.isError ?? false });
        }
    }
    return events;
}

export function findTaskText(entries: TranscriptEntry[]): string | null {
    for (const entry of entries) {
        if (entry.kind === "message" && entry.role === "user") {
            const text = textOf(entry);
            if (text.includes("Chrome Extension Migration Task")) return text;
        }
    }
    return null;
}

/** Needed-signals from the prompt's embedded static analysis; each carries the line it came from. */
export function neededSignals(taskText: string): Record<string, string> {
    const signals: Record<string, string> = {};
    const add = (key: string, line: string | null): void => {
        if (line) signals[key] = line.trim().slice(0, 160);
    };
    for (const line of taskText.split("\n")) {
        const l = line.toLowerCase();
        if (/blocking\s+[`']?webrequest/.test(l)) add("webrequest_to_dnr", line);
        if (/onbeforesendheaders|onheadersreceived/.test(l)) add("webrequest_header_modification", line);
        if (/filterresponsedata|onauthrequired/.test(l)) add("webrequest_response_inspection", line);
        if (/remotely-hosted or eval|remote code/.test(l)) add("remote_code_removed", line);
        if (/\beval\b|new function/.test(l)) add("eval_removed", line);
        if (/dom in background|used the dom|offscreen/.test(l)) add("offscreen_document", line);
        if (/global variable|module-level state|storage/.test(l)) add("storage_over_dom_state", line);
    }
    return signals;
}

/**
 * Replay one file's edit/write history: seed from the first `read` result of that exact path,
 * then apply the agent's edits in transcript order.
 */
export function replayFile(path: string, events: ToolEvent[]): { content: string | null; warnings: string[] } {
    // Seed from the first `read` of the path; an agent that never read the file but wrote it
    // wholesale leaves the write as the seed.
    const seedIdx = events.findIndex((e) => e.args?.path === path && ((e.name === "read" && e.result && !e.isError) || (e.name === "write" && typeof e.args?.content === "string")));
    if (seedIdx === -1) return { content: null, warnings: [`no read or write of ${path} to seed the replay`] };
    const seed = events[seedIdx];
    let content = seed.name === "write" ? seed.args.content : seed.result!;
    const warnings: string[] = [];
    for (const event of events.slice(seedIdx + 1)) {
        if (event.isError) continue; // the agent's own failed attempts never touched the file
        if (event.name === "write" && event.args?.path === path) {
            content = typeof event.args.content === "string" ? event.args.content : content;
            continue;
        }
        if (event.name !== "edit" || event.args?.path !== path) continue;
        for (const edit of Array.isArray(event.args.edits) ? event.args.edits : []) {
            if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") continue;
            if (content.includes(edit.oldText)) content = content.replace(edit.oldText, edit.newText);
            else warnings.push(`edit to ${path} did not replay (oldText not found)`);
        }
    }
    return { content, warnings };
}

interface ManifestDerived {
    tags: BackfillTag[];
    warnings: string[];
}

/**
 * Mechanical manifest changes the converter is specified to do (mv3-trivial) before the agent
 * ever runs. A transcript can never attribute them to anybody — the replay only observes their
 * final state — so they are tagged `state.*` (a property of the migration output), not
 * `change.*`, which would claim a change nobody saw happen.
 */
const MECHANICAL_STATE_TITLES: Partial<Record<ChangeId, string>> = {
    manifest_version: "final manifest is MV3",
    background_service_worker: "background declared as service worker",
    background_persistent_removed: "no background.persistent in final manifest",
    action_rename: "action key in final manifest",
    host_permissions_split: "host_permissions in final manifest",
    web_accessible_resources_v3: "web_accessible_resources in MV3 object form",
    csp_object_form: "content_security_policy in object form",
    commands_execute_action: "commands use _execute_action",
};

/** Final-state observations of the migrated manifest, from the replayed transcript. */
export function manifestTags(events: ToolEvent[]): ManifestDerived {
    const paths = new Map<string, number>();
    for (const e of events) {
        const p = e.args?.path;
        if (typeof p === "string" && p.endsWith("manifest.json") && (e.name === "edit" || e.name === "write")) {
            paths.set(p, (paths.get(p) ?? 0) + 1);
        }
    }
    // The converter output is /work/run/out; prefer the path the agent actually edited.
    const path = [...paths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!path) return { tags: [], warnings: [] };

    const { content, warnings } = replayFile(path, events);
    if (!content) return { tags: [], warnings };
    let m: Record<string, any>;
    try {
        m = JSON.parse(content);
    } catch {
        return { tags: [], warnings: [...warnings, `replayed manifest at ${path} is not JSON`] };
    }

    const tags: BackfillTag[] = [];
    const push = (id: ChangeId, evidence: string): void => {
        tags.push({ tag: `state.${id}`, kind: "misc", title: MECHANICAL_STATE_TITLES[id] ?? CHANGE_TITLES[id], provenance: "transcript", evidence: [{ file: path, snippet: evidence.slice(0, 160) }] });
    };
    if (m.manifest_version === 3) push("manifest_version", `manifest_version: ${m.manifest_version}`);
    if (m.background?.service_worker) push("background_service_worker", `service_worker: ${m.background.service_worker}`);
    if (m.action && !m.browser_action && !m.page_action) push("action_rename", `action: ${JSON.stringify(m.action).slice(0, 100)}`);
    if (Array.isArray(m.host_permissions) && m.host_permissions.length) push("host_permissions_split", `host_permissions: ${m.host_permissions.slice(0, 3).join(", ")}`);
    const war = m.web_accessible_resources;
    if (Array.isArray(war) && war.length > 0 && war.every((r) => typeof r === "object" && r !== null)) push("web_accessible_resources_v3", "web_accessible_resources in MV3 object form");
    if (m.content_security_policy && typeof m.content_security_policy === "object") push("csp_object_form", "content_security_policy in object form");
    return { tags, warnings };
}

interface CodeDerived {
    tags: BackfillTag[];
    surfaces: BackfillTag[];
    warnings: string[];
}

/** Applied code-level changes and surface API usage, from edit/write arguments. */
export function codeTags(events: ToolEvent[], needed: Record<string, string>): CodeDerived {
    const tags: BackfillTag[] = [];
    const surfaces = new Map<string, BackfillTag>();
    const warnings: string[] = [];
    const seen = new Set<ChangeId>();
    const surfaceApi: [RegExp, string, string][] = [
        [/contextMenus\.create\s*\(/, "surface.context_menu", "contextMenus.create()"],
        [/notifications\.create\s*\(|new\s+Notification\s*\(/, "surface.notifications", "notifications.create()"],
        [/commands\.onCommand\b/, "surface.keyboard_shortcuts", "commands.onCommand"],
        [/\bchrome\.omnibox\b/, "surface.omnibox", "omnibox API"],
        [/\bchrome\.sidePanel\b/, "surface.side_panel", "sidePanel API"],
    ];
    const pushChange = (id: ChangeId, evidence: { file: string; snippet?: string }): void => {
        if (seen.has(id)) return;
        seen.add(id);
        tags.push({ tag: `change.${id}`, kind: "applied", title: CHANGE_TITLES[id], provenance: "transcript", evidence: [evidence] });
    };

    for (const event of events) {
        const path = typeof event.args?.path === "string" ? event.args.path : "";
        const pieces: string[] = [];
        if (event.name === "edit" && Array.isArray(event.args?.edits)) {
            for (const e of event.args.edits) {
                if (typeof e?.oldText === "string") pieces.push(e.oldText, typeof e?.newText === "string" ? e.newText : "");
            }
        }
        if (event.name === "write" && typeof event.args?.content === "string") pieces.push(event.args.content);
        const content = pieces.join("\n");
        if (!content && !path) continue;

        if (event.name === "write" && /offscreen\.(html|js)$/.test(path)) {
            pushChange("offscreen_document", { file: path, snippet: "wrote offscreen document" });
        }
        if (/chrome\.offscreen\.createDocument/.test(content)) {
            pushChange("offscreen_document", { file: path, snippet: "chrome.offscreen.createDocument" });
        }
        if (/declarativeNetRequest/.test(content) || (event.name === "write" && /rules.*\.json$/.test(path))) {
            pushChange("webrequest_to_dnr", { file: path, snippet: "declarativeNetRequest / rules.json" });
        }
        if (event.name === "edit" && Array.isArray(event.args?.edits)) {
            for (const e of event.args.edits) {
                if (
                    typeof e?.oldText === "string" &&
                    typeof e?.newText === "string" &&
                    /tabs\.(executeScript|insertCSS)/.test(e.oldText) &&
                    /scripting\.(executeScript|insertCSS)/.test(e.newText)
                ) {
                    pushChange("execute_script_api", { file: path, snippet: e.oldText.slice(0, 100) });
                }
                if (
                    typeof e?.oldText === "string" &&
                    typeof e?.newText === "string" &&
                    /\beval\s*\(|new\s+Function\s*\(/.test(e.oldText) &&
                    !/\beval\s*\(|new\s+Function\s*\(/.test(e.newText)
                ) {
                    pushChange("eval_removed", { file: path, snippet: e.oldText.slice(0, 100) });
                }
            }
        }
        // Helper scripts the agent writes to strip evals in bulk (uneval.py, deeval.py, …).
        if (/uneval|deeval|remove[_-]?evals?/.test(path)) {
            pushChange("eval_removed", { file: path, snippet: "eval-stripping helper script" });
        }
        for (const [re, tag, label] of surfaceApi) {
            if (re.test(content) && !surfaces.has(tag)) {
                surfaces.set(tag, { tag, kind: "misc", title: `exposes ${label}`, provenance: "transcript", evidence: [{ file: path, snippet: label }] });
            }
        }
    }
    // `webrequest_to_dnr` from a stray "declarativeNetRequest" mention is weak evidence unless the
    // prompt said the extension actually blocked requests.
    const dnr = tags.find((t) => t.tag === "change.webrequest_to_dnr");
    if (dnr && !needed.webrequest_to_dnr) {
        tags.splice(tags.indexOf(dnr), 1);
        seen.delete("webrequest_to_dnr");
        warnings.push("dropped change.webrequest_to_dnr: declarativeNetRequest mentioned but the prompt shows no blocking webRequest");
    }
    return { tags, surfaces: [...surfaces.values()], warnings };
}

/** For the truncated-tail runs: an ABSTAIN.md write stands in for the missing skip lines. */
export function abstainTags(events: ToolEvent[]): BackfillTag[] {
    for (const event of events) {
        const path = typeof event.args?.path === "string" ? event.args.path : "";
        const text = event.name === "write" ? String(event.args?.content ?? "") : event.name === "edit" ? JSON.stringify(event.args?.edits ?? []) : "";
        if (!/ABSTAIN\.md$/.test(path) || !text) continue;
        const tags: BackfillTag[] = [
            { tag: "skipped.agent_abstained", kind: "skipped", reason: "abstained", title: ABSTAINED_TITLE, provenance: "transcript", evidence: [{ file: "ABSTAIN.md", snippet: text.slice(0, 160) }] },
        ];
        for (const [id, re] of ABSTAIN_WORDS) {
            if (re.test(text)) {
                tags.push({ tag: `skipped.${id}`, kind: "skipped", reason: "abstained", title: CHANGE_TITLES[id], provenance: "transcript", evidence: [{ file: "ABSTAIN.md", snippet: text.slice(0, 160) }] });
            }
        }
        return tags;
    }
    return [];
}

// ---------------------------------------------------------------------------------------------
// Per-report assembly
// ---------------------------------------------------------------------------------------------

export function backfillReport(report: any, tail: string | null, runMeta: TagsBackfill["runMeta"]): TagsBackfill {
    const warnings: string[] = [];
    const tags: BackfillTag[] = [];

    const parsed = tail ? parseTail(tail) : null;
    if (parsed) {
        tags.push(...parsed.tags);
        warnings.push(...parsed.unmappedTitles.map((line) => `unmapped tail line: ${line}`));
        if (parsed.summaryLine && parsed.skipLineCount !== countSkips(parsed.summaryLine)) {
            // The summary counts ledger skips only; the generic agent_abstained tag is emitted by
            // buildTags outside the ledger and is legitimately absent from the count.
            const ledgerSkips = parsed.skipLineCount - parsed.tags.filter((t) => t.tag === "skipped.agent_abstained" && t.provenance === "db").length;
            if (ledgerSkips !== countSkips(parsed.summaryLine)) {
                warnings.push(`summary says ${countSkips(parsed.summaryLine)} skipped but ${ledgerSkips} ledger skip lines present`);
            }
        }
    }

    const entries: TranscriptEntry[] = report.transcript?.entries ?? [];
    const events = toolEvents(entries);
    const taskText = findTaskText(entries);
    const needed = taskText ? neededSignals(taskText) : {};
    if (!taskText) warnings.push("task message not found; needed-signals unknown");

    const manifest = manifestTags(events);
    const code = codeTags(events, needed);
    warnings.push(...manifest.warnings, ...code.warnings);
    tags.push(...manifest.tags, ...code.tags);

    // Surfaces the extension exposes, from the report's own surface inventory.
    for (const { surface } of report.report?.surfaces ?? []) {
        tags.push({ tag: `surface.${surface}`, kind: "misc", title: `exposes ${String(surface).replace(/_/g, " ")}`, provenance: "report" });
    }
    tags.push(...code.surfaces);

    // Legacy facts, carried into the dotted vocabulary.
    for (const legacy of report.tags ?? []) {
        const mapped = LEGACY_MAP.find(([name]) => name === legacy);
        if (mapped) tags.push({ tag: mapped[1], kind: mapped[2], title: mapped[3], provenance: "legacy" });
    }

    // The truncated-tail runs: recover skips from the agent's ABSTAIN.md. A run whose summary
    // reports zero skips/repairs/spurious needs no recovery.
    let hasTailTags = Boolean(parsed && parsed.tagLines.length);
    if (!hasTailTags) {
        const abstain = abstainTags(events);
        if (abstain.length) {
            tags.push(...abstain);
        } else if (!parsed?.summaryLine || (parsed.counts && (parsed.counts.skipped > 0))) {
            warnings.push(parsed?.summaryLine ? "summary reports skips but no skip lines survived the tail" : "tail truncated before the tag block; only transcript-derived tags available");
        }
    }

    // Several families collide by design (HAS_BACKGROUND_PAGE and HAS_SERVICE_WORKER both map to
    // surface.background; the report's surface inventory may name it too). One tag is one fact:
    // keep the first occurrence, which is the highest-fidelity source in assembly order.
    const seenTags = new Set<string>();
    const deduped = tags.filter((t) => (seenTags.has(t.tag) ? false : (seenTags.add(t.tag), true)));

    const hasApplied = tags.some((t) => t.kind === "applied");
    const source: TagsBackfill["source"] = hasTailTags && hasApplied ? "both" : hasTailTags ? "migrator.db runs.tail" : hasApplied ? "transcript" : "none";
    return {
        source,
        tailTagLines: parsed?.tagLines ?? [],
        summaryLine: parsed?.summaryLine ?? null,
        counts: parsed?.counts ?? null,
        runMeta,
        neededSignals: taskText ? needed : null,
        warnings,
        tags: deduped,
    };
}

function countSkips(summaryLine: string): number {
    const m = /changes: \d+\/\d+ applied, (\d+) skipped/.exec(summaryLine);
    return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export function main(): void {
    const args = process.argv.slice(2);
    const statsOnly = args.includes("--stats");
    const positional = args.filter((a) => !a.startsWith("--"));
    const exportPath = resolve(positional[0] ?? DEFAULT_EXPORT);
    const dbPath = resolve(positional[1] ?? DEFAULT_DB);

    const data = JSON.parse(readFileSync(exportPath, "utf8"));
    const db = new Database(dbPath, { readonly: true });
    const runs = db.prepare("SELECT id, tail FROM runs").all() as { id: string; tail: string | null }[];
    const outcomes = db.prepare("SELECT extension, label, abstained, has_hard_blocker, run_id FROM outcomes").all() as any[];
    const outcomeByExt = new Map(outcomes.map((o) => [o.extension, o]));
    const runById = new Map(runs.map((r) => [r.id, r]));
    db.close();

    let unmapped = 0;
    let withTail = 0;
    let residualExts = 0;
    // Merged automatically when the scanner has produced it: `npx tsx scripts/mv2_residuals.ts <run_test_dir>`
    const residualsPath = resolve(positional[2] ?? DEFAULT_RESIDUALS);
    const residuals: ResidualsByExt = existsSync(residualsPath)
        ? JSON.parse(readFileSync(residualsPath, "utf8"))
        : {};
    if (existsSync(residualsPath)) console.log(`residual scan: ${Object.keys(residuals).length} extension dirs from ${residualsPath}`);
    // Keys are either "<extensionId>" or "<model-run>/<extensionId>". Resolve by exact id, then by
    // suffix; a suffix used by more than one model run is ambiguous and dropped (rerun the scanner
    // with --group to pin one model run).
    const residualByExt = new Map<string, Partial<Record<ResidualFamily, ResidualHit[]>>>();
    const ambiguous = new Set<string>();
    for (const [key, fams] of Object.entries(residuals)) {
        const id = key.includes("/") ? key.split("/")[1] : key;
        if (!residualByExt.has(id)) residualByExt.set(id, fams);
        else ambiguous.add(id);
    }
    for (const id of ambiguous) residualByExt.delete(id);
    if (ambiguous.size) console.log(`residual scan: ${ambiguous.size} extension ids ambiguous across model runs — dropped (use --group)`);
    const tagCounts = new Map<string, number>();
    const kindCounts = new Map<string, number>();
    const reasonCounts = new Map<string, number>();
    const provenance = new Map<string, number>();

    for (const report of data.reports) {
        const extensionId: string = report.report?.extensionId;
        const run = runById.get(extensionId);
        const outcome = outcomeByExt.get(extensionId);
        const runMeta = run
            ? {
                  label: outcome?.label ?? null,
                  abstained: Boolean(outcome?.abstained),
                  hasHardBlocker: outcome?.has_hard_blocker ?? null,
                  runDir: parseTail(run.tail ?? "").runDir,
              }
            : null;
        const backfill = backfillReport(report, run?.tail ?? null, runMeta);
        const extResiduals = residualByExt.get(extensionId);
        if (extResiduals && Object.keys(extResiduals).length) {
            residualExts++;
            backfill.tags.push(...residualTags(extResiduals));
        }
        if (backfill.tailTagLines.length) withTail++;
        unmapped += backfill.warnings.filter((w) => w.startsWith("unmapped tail line")).length;
        for (const tag of backfill.tags) {
            tagCounts.set(tag.tag, (tagCounts.get(tag.tag) ?? 0) + 1);
            kindCounts.set(tag.kind, (kindCounts.get(tag.kind) ?? 0) + 1);
            if (tag.reason) reasonCounts.set(tag.reason, (reasonCounts.get(tag.reason) ?? 0) + 1);
            provenance.set(tag.provenance, (provenance.get(tag.provenance) ?? 0) + 1);
        }
        report.tagsBackfill = backfill;
    }

    if (!statsOnly) {
        writeFileSync(exportPath, JSON.stringify(data, null, 2));
    }

    const pct = (n: number): string => `${((100 * n) / data.reports.length).toFixed(1)}%`;
    const dist = (m: Map<string, number>, label: string): void => {
        console.log(`\n${label}:`);
        for (const [key, n] of [...m.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${key}: ${n}`);
    };
    console.log(`reports: ${data.reports.length} | runs in db: ${runs.length} | with tail tags: ${withTail} (${pct(withTail)}) | unmapped tail titles: ${unmapped} | residual scans: ${residualExts} (${pct(residualExts)})`);
    dist(kindCounts, "Tags by kind");
    dist(reasonCounts, "Skips by reason");
    dist(provenance, "Tags by provenance");
    dist(tagCounts, "Tags");
    if (!statsOnly) console.log(`\nupdated ${exportPath} in place`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
