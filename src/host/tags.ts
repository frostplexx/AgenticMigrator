/**
 * Tags: a flat, countable vocabulary describing what happened to one extension.
 *
 * The old signals recorded only what the framework changed, which answers "how often did we
 * rewrite webRequest" but not "how often did we meet a webRequest we could not rewrite". Those
 * are the two halves of the same results table, and only one of them was being collected.
 *
 * Five kinds, because they answer different questions:
 *   applied — the framework made this change. What the pipeline does.
 *   skipped — the change was needed and did not happen. Where the pipeline stops — and each skip
 *             carries a `reason`, because "stopped on purpose because MV3 cannot express it" and
 *             "stopped without saying why" support opposite conclusions about the model.
 *   repair  — an LLM repair round made the change, or edited the file. What repair is worth.
 *   spurious— the change was made and was never needed. What the pipeline invents.
 *   misc    — a property of the extension, not of the migration: the UI surfaces it exposes,
 *             whether it is minified, bundled or obfuscated. What the sample is made of.
 */
import { CHANGE_SUPPORT, buildChangeLedger, type ChangeId, type ChangeRecord } from "./changes.js";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

export type TagKind = "applied" | "skipped" | "repair" | "spurious" | "misc";

/**
 * Why a needed change did not happen.
 *
 *   platform    — MV3 cannot express it at all; the framework purposely leaves it. The evidence
 *                 carries the citable constraint.
 *   abstained   — the agent said so in ABSTAIN.md and named this capability.
 *   limited     — MV3 expresses only part of it (a static header rewrite ports, a computed one
 *                 does not). The skip may be the platform's or the model's; the evidence decides,
 *                 and the tag refuses to decide for it.
 *   unexplained — nothing accounts for it. The cell that counts against the model.
 */
export type SkipReason = "platform" | "abstained" | "limited" | "unexplained";

export interface Tag {
    /** Dotted identifier, stable enough to group by in a results table. */
    tag: string;
    kind: TagKind;
    /** Human wording for a summary line. */
    title: string;
    /** Skipped tags only. */
    reason?: SkipReason;
    evidence?: { file: string; line?: number; snippet?: string }[];
}

/** Longest line before a file reads as minified rather than merely dense. */
const MINIFIED_LINE = 500;
/** Total JS above which the extension reads as a large codebase rather than a script or two. */
const LARGE_SOURCE_BYTES = 1_000_000;

interface SourceFile {
    path: string;
    text: string;
}

function codeFiles(dir: string, extensions = new Set([".js", ".mjs"])): SourceFile[] {
    const out: SourceFile[] = [];
    const walk = (current: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(current);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry === "node_modules" || entry.startsWith(".")) continue;
            const full = join(current, entry);
            let stat;
            try {
                stat = statSync(full);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                walk(full);
                continue;
            }
            if (!extensions.has(extname(entry).toLowerCase())) continue;
            if (stat.size > 4_000_000) continue;
            try {
                out.push({ path: relative(dir, full), text: readFileSync(full, "utf8") });
            } catch {
                /* unreadable: no evidence either way */
            }
        }
    };
    walk(dir);
    return out;
}

function readManifest(dir: string): Record<string, any> {
    try {
        return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, any>;
    } catch {
        return {};
    }
}

function hasFile(dir: string, pattern: RegExp): string | null {
    let found: string | null = null;
    const walk = (current: string): void => {
        if (found) return;
        let entries: string[];
        try {
            entries = readdirSync(current);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (found) return;
            if (entry === "node_modules" || entry.startsWith(".")) continue;
            const full = join(current, entry);
            let isDir = false;
            try {
                isDir = statSync(full).isDirectory();
            } catch {
                continue;
            }
            if (isDir) walk(full);
            else if (pattern.test(entry)) found = relative(dir, full);
        }
    };
    walk(dir);
    return found;
}

// ---------------------------------------------------------------------------------------------
// misc: what the sample is made of
// ---------------------------------------------------------------------------------------------

/**
 * The UI surfaces an extension exposes, in the vocabulary extlens's analyzer uses so the two
 * agree in a results table. Detected here rather than imported because the container image
 * carries only production dependencies and the analyzer is a host-side devDependency.
 */
export type UiSurface =
    | "popup"
    | "toolbar_action"
    | "options_page"
    | "new_tab"
    | "side_panel"
    | "devtools"
    | "context_menu"
    | "notifications"
    | "keyboard_shortcuts"
    | "omnibox"
    | "page_interaction"
    | "background";

const SURFACE_API: { surface: UiSurface; pattern: RegExp; evidence: string }[] = [
    { surface: "popup", pattern: /\b(chrome|browser)\.(action|browserAction|pageAction)\.setPopup\s*\(/, evidence: "action.setPopup()" },
    { surface: "toolbar_action", pattern: /\b(chrome|browser)\.(action|browserAction|pageAction)\.onClicked\b/, evidence: "action.onClicked" },
    { surface: "context_menu", pattern: /\b(chrome|browser)\.contextMenus\.create\s*\(/, evidence: "contextMenus.create()" },
    { surface: "notifications", pattern: /\b(chrome|browser)\.notifications\.create\s*\(|new\s+Notification\s*\(/, evidence: "notifications.create()" },
    { surface: "keyboard_shortcuts", pattern: /\b(chrome|browser)\.commands\.onCommand\b/, evidence: "commands.onCommand" },
    { surface: "omnibox", pattern: /\b(chrome|browser)\.omnibox\b/, evidence: "omnibox API" },
    { surface: "side_panel", pattern: /\b(chrome|browser)\.sidePanel\b/, evidence: "sidePanel API" },
];

/** Surfaces declared in the manifest or reached for in code, each with where it was seen. */
export function detectSurfaces(dir: string): { surface: UiSurface; evidence: string }[] {
    const manifest = readManifest(dir);
    const seen = new Map<UiSurface, string>();
    const add = (surface: UiSurface, evidence: string): void => {
        if (!seen.has(surface)) seen.set(surface, evidence);
    };
    const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

    const actionKey = manifest.action ? "action" : manifest.browser_action ? "browser_action" : manifest.page_action ? "page_action" : null;
    const action = actionKey ? obj(manifest[actionKey]) : {};
    const popup = str(action.default_popup);
    if (popup) add("popup", `${actionKey}.default_popup: ${popup}`);
    else if (actionKey) add("toolbar_action", `${actionKey} without a popup`);
    const options = str(manifest.options_page) ?? str(obj(manifest.options_ui).page);
    if (options) add("options_page", `options page: ${options}`);
    const newtab = str(obj(manifest.chrome_url_overrides).newtab);
    if (newtab) add("new_tab", `chrome_url_overrides.newtab: ${newtab}`);
    const sidePanel = str(obj(manifest.side_panel).default_path);
    if (sidePanel) add("side_panel", `side_panel.default_path: ${sidePanel}`);
    const devtools = str(manifest.devtools_page);
    if (devtools) add("devtools", `devtools_page: ${devtools}`);
    const omnibox = str(obj(manifest.omnibox).keyword);
    if (omnibox) add("omnibox", `omnibox.keyword: ${omnibox}`);
    const commands = Object.keys(obj(manifest.commands)).filter((k) => !k.startsWith("_execute"));
    if (commands.length) add("keyboard_shortcuts", `commands: ${commands.join(", ")}`);
    const permissions: unknown[] = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    if (permissions.includes("contextMenus")) add("context_menu", "permission: contextMenus");
    if (permissions.includes("notifications")) add("notifications", "permission: notifications");
    if (Array.isArray(manifest.content_scripts) && manifest.content_scripts.length) {
        const matches = manifest.content_scripts.flatMap((cs: any) => (Array.isArray(cs?.matches) ? cs.matches : []));
        add("page_interaction", `content_scripts on ${matches.slice(0, 3).join(", ") || "declared pages"}`);
    }
    if (manifest.background) add("background", "background script");

    for (const file of codeFiles(dir)) {
        for (const { surface, pattern, evidence } of SURFACE_API) {
            if (!seen.has(surface) && pattern.test(file.text)) add(surface, `${file.path}: ${evidence}`);
        }
    }
    return [...seen].map(([surface, evidence]) => ({ surface, evidence }));
}

/**
 * Properties of the extension itself, which decide whether a failure says anything about the
 * model. A migration that fails on a 2MB minified webpack bundle is a different observation from
 * one that fails on 40 lines of readable source.
 */
export function miscTags(inputDir: string, surfaces: string[] = []): Tag[] {
    const tags: Tag[] = [];
    const files = codeFiles(inputDir);
    const misc = (tag: string, title: string, evidence?: Tag["evidence"]): void => {
        tags.push({ tag, kind: "misc", title, ...(evidence ? { evidence } : {}) });
    };

    const minified = files.find((f) => f.text.split("\n").some((line) => line.length > MINIFIED_LINE));
    if (minified) misc("source.minified", "minified source", [{ file: minified.path, snippet: `line longer than ${MINIFIED_LINE} chars` }]);

    const bundled = files.find((f) => /webpackJsonp|__webpack_require__|\bparcelRequire\b|System\.register|\bdefine\.amd\b/.test(f.text));
    if (bundled) misc("source.bundled", "bundler output", [{ file: bundled.path, snippet: "webpack/parcel/AMD runtime" }]);

    // Hex-escaped identifier soup: obfuscation rather than ordinary minification.
    const obfuscated = files.find((f) => /_0x[0-9a-f]{4,}/.test(f.text));
    if (obfuscated) misc("source.obfuscated", "obfuscated identifiers", [{ file: obfuscated.path, snippet: "_0x… identifiers" }]);

    const totalBytes = files.reduce((n, f) => n + Buffer.byteLength(f.text), 0);
    if (totalBytes > LARGE_SOURCE_BYTES) {
        misc("source.large", "large codebase", [{ file: ".", snippet: `${(totalBytes / 1_000_000).toFixed(1)} MB of JS across ${files.length} files` }]);
    }

    // A framework in the tree means the migration is editing generated or library code, which
    // the model can neither read in full nor safely rewrite.
    const framework = files
        .map((f) => ({
            file: f.path,
            name: /\breact(-dom)?\b.*production|__REACT_DEVTOOLS_GLOBAL_HOOK__|\bReact\.createElement\b/.test(f.text)
                ? "react"
                : /\bVue\.(component|createApp)\b|__vue__|\bvue\.runtime\b/.test(f.text)
                  ? "vue"
                  : /\bangular\.module\s*\(|\bplatformBrowserDynamic\b/.test(f.text)
                    ? "angular"
                    : /\bjQuery\b[\s\S]{0,200}\bfn\.jquery\b|\bjQuery\.fn\.jquery\b/.test(f.text)
                      ? "jquery"
                      : null,
        }))
        .find((f) => f.name);
    if (framework) misc("source.framework", `ships a framework (${framework.name})`, [{ file: framework.file, snippet: framework.name! }]);

    const wasm = hasFile(inputDir, /\.wasm$/i);
    if (wasm) misc("source.wasm", "ships WebAssembly", [{ file: wasm }]);

    const seenSurfaces = new Set<string>();
    for (const surface of surfaces) {
        if (seenSurfaces.has(surface)) continue;
        seenSurfaces.add(surface);
        misc(`surface.${surface}`, `exposes ${surface.replace(/_/g, " ")}`);
    }

    return tags;
}

// ---------------------------------------------------------------------------------------------
// applied / skipped / spurious: the ledger, with reasons for the skips
// ---------------------------------------------------------------------------------------------

/**
 * Words an abstention would use for each change. ABSTAIN.md is free text; this is how a skip gets
 * attributed to it without asking the model to emit a change id it has never seen.
 */
const ABSTAIN_WORDS: Partial<Record<ChangeId, RegExp>> = {
    webrequest_to_dnr: /webRequest|declarativeNetRequest|\bDNR\b|\bblock|\bredirect/i,
    webrequest_header_modification: /header|webRequest/i,
    webrequest_response_inspection: /filterResponseData|response body|onAuthRequired|webRequest/i,
    remote_code_removed: /remote(ly)?[ -]hosted|remote code|external script|CDN/i,
    eval_removed: /\beval\b|new Function|string evaluation|CSP/i,
    offscreen_document: /offscreen|DOM/i,
    storage_over_dom_state: /global|module-level|state|storage/i,
};

/** A skipped change, explained: platform-limited first, then the agent's word, else nothing. */
function skipReason(record: ChangeRecord, abstainReason: string | null | undefined): { reason: SkipReason; evidence: Tag["evidence"] } {
    const support = CHANGE_SUPPORT[record.id];
    const evidence = [...record.evidence];
    if (support.url) evidence.push({ file: support.url, snippet: support.limitation });
    if (support.support === "none") return { reason: "platform", evidence };
    // The agent's word outranks "limited": an abstention naming the capability is a claim with
    // evidence attached, which is more than a support table can say about one extension.
    if (abstainReason && ABSTAIN_WORDS[record.id]?.test(abstainReason)) {
        evidence.push({ file: "ABSTAIN.md", snippet: abstainReason.slice(0, 160) });
        return { reason: "abstained", evidence };
    }
    if (support.support === "partial") return { reason: "limited", evidence };
    return { reason: "unexplained", evidence };
}

const REASON_TITLE: Record<SkipReason, string> = {
    platform: "left out: MV3 cannot express it",
    abstained: "left out: the agent abstained",
    limited: "not applied: MV3 supports it only partly",
    unexplained: "needed but not applied",
};

/** Applied/skipped/spurious tags implied by a change ledger. */
export function ledgerTags(records: ChangeRecord[], abstainReason?: string | null): Tag[] {
    const tags: Tag[] = [];
    for (const record of records) {
        if (record.needed && record.applied) {
            tags.push({ tag: `change.${record.id}`, kind: "applied", title: record.title });
        } else if (!record.needed && record.applied) {
            /*
             * Applied without being needed.
             *
             * Measured, not hypothetical: the harness used to require a service worker of every
             * migration, so a content-script-only extension could not pass, and the model added a
             * background.js whose own comment said "No background work is required, but an MV3
             * extension must register a service worker". Code the original never had, in the
             * output, because of how we asked. A pipeline that invents changes needs that counted
             * as carefully as one that skips them.
             */
            tags.push({
                tag: `spurious.${record.id}`,
                kind: "spurious",
                title: `${record.title} — applied but never needed`,
            });
        } else if (record.needed && !record.applied) {
            // The one the old tagging could not express: the framework met this and moved on. With
            // the reason, because a skip the platform forces is a fact about Chrome and a skip
            // nothing explains is a fact about the model.
            const { reason, evidence } = skipReason(record, abstainReason);
            tags.push({
                tag: `skipped.${record.id}`,
                kind: "skipped",
                reason,
                title: `${record.title} — ${REASON_TITLE[reason]}`,
                evidence,
            });
        }
    }
    return tags;
}

/** A HARD compat finding from the host pre-pass, the part the tag layer needs. */
export interface HardBlocker {
    key: string;
    file?: string;
    line?: number;
    mdnUrl?: string;
    message?: string;
}

/** Ledger changes that already account for a HARD compat key, so it is not tagged twice. */
const BLOCKER_COVERED_BY: Record<string, ChangeId> = {
    webRequestBlocking: "webrequest_to_dnr",
    "webRequest.filterResponseData": "webrequest_response_inspection",
    "webRequest.onAuthRequired.BlockingResponse": "webrequest_response_inspection",
};

/**
 * Platform skips the ledger has no change for: a HARD compat finding is by definition a
 * capability the framework purposely leaves out, and it deserves a countable tag whether or not
 * the ledger happens to model it.
 */
export function blockerTags(blockers: HardBlocker[], records: ChangeRecord[]): Tag[] {
    const modelled = new Set(records.filter((r) => r.needed).map((r) => r.id));
    const tags: Tag[] = [];
    const seen = new Set<string>();
    for (const blocker of blockers) {
        const covering = BLOCKER_COVERED_BY[blocker.key];
        if (covering && modelled.has(covering)) continue;
        const id = blocker.key.replace(/[^A-Za-z0-9]+/g, "_");
        if (seen.has(id)) continue;
        seen.add(id);
        tags.push({
            tag: `skipped.${id}`,
            kind: "skipped",
            reason: "platform",
            title: `${blocker.key} — left out: no MV3 equivalent`,
            evidence: [
                ...(blocker.file ? [{ file: blocker.file, ...(blocker.line ? { line: blocker.line } : {}) }] : []),
                ...(blocker.mdnUrl ? [{ file: blocker.mdnUrl, snippet: blocker.message }] : []),
            ],
        });
    }
    return tags;
}

// ---------------------------------------------------------------------------------------------
// repair: what the LLM changed after the first pass
// ---------------------------------------------------------------------------------------------

/** Content hash of every file under a tree, keyed by relative path. */
export type TreeSnapshot = Map<string, string>;

export function snapshotTree(dir: string): TreeSnapshot {
    const snapshot: TreeSnapshot = new Map();
    const walk = (current: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(current);
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(current, entry);
            let stat;
            try {
                stat = statSync(full);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                walk(full);
                continue;
            }
            try {
                snapshot.set(relative(dir, full), createHash("sha1").update(readFileSync(full)).digest("hex"));
            } catch {
                /* unreadable: treat as absent */
            }
        }
    };
    walk(dir);
    return snapshot;
}

/** Paths that differ between two snapshots: added, removed or rewritten. */
export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): string[] {
    const changed = new Set<string>();
    for (const [path, hash] of after) if (before.get(path) !== hash) changed.add(path);
    for (const path of before.keys()) if (!after.has(path)) changed.add(path);
    return [...changed].sort();
}

/** Which role a file plays in the extension, from the manifest: what repair had to touch. */
type FileRole = "manifest" | "background" | "content_script" | "ui_page" | "other";

function fileRoles(manifest: Record<string, any>): Map<string, FileRole> {
    const roles = new Map<string, FileRole>();
    const norm = (p: unknown): string | null => (typeof p === "string" ? p.replace(/^\.?\//, "") : null);
    const assign = (p: unknown, role: FileRole): void => {
        const n = norm(p);
        if (n && !roles.has(n)) roles.set(n, role);
    };
    roles.set("manifest.json", "manifest");
    const bg = manifest.background ?? {};
    assign(bg.service_worker, "background");
    assign(bg.page, "background");
    for (const s of Array.isArray(bg.scripts) ? bg.scripts : []) assign(s, "background");
    for (const cs of Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []) {
        for (const f of [...(cs?.js ?? []), ...(cs?.css ?? [])]) assign(f, "content_script");
    }
    const action = manifest.action ?? manifest.browser_action ?? manifest.page_action ?? {};
    assign(action.default_popup, "ui_page");
    assign(manifest.options_page, "ui_page");
    assign(manifest.options_ui?.page, "ui_page");
    assign(manifest.chrome_url_overrides?.newtab, "ui_page");
    assign(manifest.side_panel?.default_path, "ui_page");
    assign(manifest.devtools_page, "ui_page");
    return roles;
}

/**
 * A page's script is part of the page: a popup.js edited to fix popup.html is a UI repair. The
 * role of a sibling script follows the HTML that would load it, by name, which is the convention
 * the corpus overwhelmingly follows.
 */
function roleOf(path: string, roles: Map<string, FileRole>): FileRole {
    const direct = roles.get(path);
    if (direct) return direct;
    const stem = path.replace(/\.(js|mjs|css)$/i, "");
    for (const ext of [".html", ".htm"]) {
        const page = roles.get(stem + ext);
        if (page) return page;
    }
    return "other";
}

/**
 * Changes that only became applied after a repair round, plus what repair touched.
 *
 * The ledger diff attributes a CHANGE to repair; the tree diff attributes an EDIT. Both are
 * needed: a repair that fixes a global-variable bug in the worker flips no ledger bit, and a
 * results table asking "what does repair do" cannot count what it cannot see.
 */
export function repairTags(
    before: ChangeRecord[],
    after: ChangeRecord[],
    trees?: { before: TreeSnapshot; after: TreeSnapshot; manifest?: Record<string, any> },
): Tag[] {
    const wasApplied = new Map(before.map((r) => [r.id, r.applied]));
    const tags: Tag[] = after
        .filter((record) => record.applied && wasApplied.get(record.id) === false)
        .map((record) => ({
            tag: `repair.${record.id}`,
            kind: "repair" as const,
            title: `${record.title} — applied during LLM repair`,
        }));

    if (!trees) return tags;
    const changed = diffSnapshots(trees.before, trees.after);
    if (changed.length === 0) return tags;
    tags.push({
        tag: "repair.files_edited",
        kind: "repair",
        title: `LLM repair edited ${changed.length} file(s)`,
        evidence: changed.slice(0, 20).map((file) => ({ file })),
    });
    const roles = fileRoles(trees.manifest ?? {});
    const byRole = new Map<FileRole, string[]>();
    for (const path of changed) {
        const role = roleOf(path, roles);
        if (role === "other") continue;
        byRole.set(role, [...(byRole.get(role) ?? []), path]);
    }
    const titles: Record<Exclude<FileRole, "other">, string> = {
        manifest: "LLM repair edited the manifest",
        background: "LLM repair edited the background / service worker",
        content_script: "LLM repair edited a content script",
        ui_page: "LLM repair edited a UI page",
    };
    for (const role of ["manifest", "background", "content_script", "ui_page"] as const) {
        const files = byRole.get(role);
        if (!files) continue;
        tags.push({ tag: `repair.${role}_edited`, kind: "repair", title: titles[role], evidence: files.slice(0, 10).map((file) => ({ file })) });
    }
    return tags;
}

// ---------------------------------------------------------------------------------------------

/** Everything known about one migration, as tags. */
export function buildTags(opts: {
    /** The ORIGINAL MV2 tree, not the converter's output: `needed` is a property of the original. */
    inputDir: string;
    outputDir: string;
    /** Ledger snapshot taken before any repair round, when there was one. */
    beforeRepair?: ChangeRecord[];
    /** Tree snapshot taken at the same moment, so repair edits can be attributed as well. */
    treeBeforeRepair?: TreeSnapshot;
    /** Surfaces, when the caller already knows them; detected from inputDir otherwise. */
    surfaces?: string[];
    /** HARD compat findings over the original, from the host pre-pass. */
    hardBlockers?: HardBlocker[];
    /** The agent declined to migrate a capability; recorded as a skip with its reason. */
    abstainReason?: string | null;
}): { tags: Tag[]; changes: ChangeRecord[] } {
    const changes = buildChangeLedger(opts.inputDir, opts.outputDir);
    const surfaces = opts.surfaces ?? detectSurfaces(opts.inputDir).map((s) => s.surface);
    const tags = [
        ...ledgerTags(changes, opts.abstainReason),
        ...blockerTags(opts.hardBlockers ?? [], changes),
        ...(opts.beforeRepair
            ? repairTags(
                  opts.beforeRepair,
                  changes,
                  opts.treeBeforeRepair
                      ? { before: opts.treeBeforeRepair, after: snapshotTree(opts.outputDir), manifest: readManifest(opts.outputDir) }
                      : undefined,
              )
            : []),
        ...miscTags(opts.inputDir, surfaces),
    ];
    if (opts.abstainReason) {
        tags.push({
            tag: "skipped.agent_abstained",
            kind: "skipped",
            reason: "abstained",
            title: "agent declined to migrate a capability",
            evidence: [{ file: "ABSTAIN.md", snippet: opts.abstainReason.slice(0, 160) }],
        });
    }
    return { tags, changes };
}

/** Counts per kind, for a one-line summary. */
export function countByKind(tags: Tag[]): Record<TagKind, number> {
    const counts: Record<TagKind, number> = { applied: 0, skipped: 0, repair: 0, spurious: 0, misc: 0 };
    for (const tag of tags) counts[tag.kind]++;
    return counts;
}

/** Skips by reason: the split a pass rate needs before it can say anything about the model. */
export function countSkipsByReason(tags: Tag[]): Record<SkipReason, number> {
    const counts: Record<SkipReason, number> = { platform: 0, abstained: 0, limited: 0, unexplained: 0 };
    for (const tag of tags) if (tag.kind === "skipped" && tag.reason) counts[tag.reason]++;
    return counts;
}
