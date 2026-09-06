// Post-migration static validation of the MIGRATED extension (OUT), complementing the
// browser load in verify.ts.
//
// Why this exists: loading in Chrome is pass/fail and tells you almost nothing when it fails
// ("no MV3 service worker registered"). Chrome also stops at the FIRST fatal manifest problem,
// so a run burns a fix round per issue. These checks are cheap, need no browser, run every
// round, and return file+line+fix for many problems at once — so the agent can fix a batch per
// turn instead of playing twenty questions with the browser.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Severity = "error" | "warn";

export interface Issue {
    /** Stable slug, e.g. "manifest-version". Used to dedupe and to keep messages greppable. */
    id: string;
    severity: Severity;
    /** What is wrong, in one line. */
    message: string;
    /** How to fix it — the part the model actually acts on. */
    fix: string;
    file?: string;
    line?: number;
}

// Mirrors staticAnalyzer.ts: a "line" this long is minified/vendored code. Scanning it produces
// unactionable noise and bloats the prompt.
const MINIFIED_LINE = 2000;
const SNIPPET_MAX = 160;
const SCANNABLE = new Set([".js", ".mjs", ".cjs", ".ts"]);
/** Max issues of one kind reported per file before they are summarised. */
const PER_FILE_CAP = 3;

const clip = (s: string) => (s.trim().length > SNIPPET_MAX ? s.trim().slice(0, SNIPPET_MAX) + " …" : s.trim());

/** Every file under dir, as paths relative to dir. */
function walk(dir: string, base = dir): string[] {
    let out: string[] = [];
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return out; }
    for (const e of entries) {
        const full = join(dir, e);
        let s;
        try { s = statSync(full); } catch { continue; }
        if (s.isDirectory()) out = out.concat(walk(full, base));
        else out.push(relative(base, full));
    }
    return out;
}

/** Scan one file line-by-line, skipping minified lines. */
function scanLines(outDir: string, rel: string, fn: (line: string, n: number) => void): void {
    let text: string;
    try { text = readFileSync(join(outDir, rel), "utf8"); } catch { return; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > MINIFIED_LINE) continue;
        fn(lines[i], i + 1);
    }
}

/** Files the service worker actually pulls in (one level of importScripts), plus the SW itself. */
function serviceWorkerFiles(outDir: string, manifest: any): string[] {
    const sw = manifest?.background?.service_worker;
    if (typeof sw !== "string") return [];
    const files = [sw];
    scanLines(outDir, sw, (line) => {
        const m = line.match(/importScripts\s*\(([^)]*)\)/);
        if (!m) return;
        for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
            if (!/^https?:/.test(q[1])) files.push(q[1].replace(/^\.?\//, ""));
        }
    });
    return files;
}

/** Collect every path the manifest claims exists, for existence checking. */
function referencedFiles(manifest: any): string[] {
    const refs: string[] = [];
    const push = (v: unknown) => { if (typeof v === "string" && !/^(https?:)?\/\//.test(v)) refs.push(v.split("?")[0].replace(/^\.?\//, "")); };

    // Icon-ish keys are EITHER a {size: path} map or a bare path string. Object.values() on a
    // string yields its characters, which turns one icon into a dozen bogus "missing file" issues.
    const pushPathOrMap = (v: unknown) => {
        if (typeof v === "string") push(v);
        else if (v && typeof v === "object") for (const inner of Object.values(v)) push(inner);
    };

    push(manifest?.background?.service_worker);
    push(manifest?.action?.default_popup);
    push(manifest?.options_page);
    push(manifest?.options_ui?.page);
    push(manifest?.devtools_page);
    pushPathOrMap(manifest?.icons);
    pushPathOrMap(manifest?.action?.default_icon);
    pushPathOrMap(manifest?.chrome_url_overrides);
    for (const cs of manifest?.content_scripts ?? []) {
        for (const j of cs?.js ?? []) push(j);
        for (const c of cs?.css ?? []) push(c);
    }
    for (const rs of manifest?.declarative_net_request?.rule_resources ?? []) push(rs?.path);
    return refs;
}

/**
 * Validate the migrated extension. Returns issues ordered errors-first; an empty list means
 * nothing statically detectable is wrong (the browser load still has the final say).
 */
export function checkExtension(outDir: string): Issue[] {
    const issues: Issue[] = [];
    const add = (i: Issue) => issues.push(i);
    const manifestPath = join(outDir, "manifest.json");

    if (!existsSync(manifestPath)) {
        return [{
            id: "manifest-missing", severity: "error", file: "manifest.json",
            message: "manifest.json does not exist in the output",
            fix: "Write a complete MV3 manifest.json at the extension root.",
        }];
    }

    let manifest: any;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e: any) {
        return [{
            id: "manifest-unparseable", severity: "error", file: "manifest.json",
            message: `manifest.json is not valid JSON: ${e.message}`,
            fix: "Fix the JSON syntax. Chrome refuses to load the extension at all until it parses (no trailing commas, no comments).",
        }];
    }

    checkManifest(manifest, outDir, add);
    checkReferencedFiles(manifest, outDir, add);
    checkDnr(manifest, outDir, add);
    checkCode(manifest, outDir, add);

    const rank = (s: Severity) => (s === "error" ? 0 : 1);
    // Cap repeats of the same check in the same file. A vendored bundle can trip
    // sw-banned-global hundreds of times, drowning every other finding and blowing the prompt.
    const seen = new Map<string, number>();
    const capped: Issue[] = [];
    for (const i of issues) {
        const key = `${i.id}:${i.file ?? ""}`;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n <= PER_FILE_CAP) capped.push(i);
        else if (n === PER_FILE_CAP + 1) {
            capped.push({
                ...i, line: undefined,
                message: `${i.file}: more occurrences of the same problem beyond the first ${PER_FILE_CAP}`,
                fix: `Search ${i.file} for every occurrence and fix them all, not just the ones listed. ${i.fix}`,
            });
        }
    }
    return capped.sort((a, b) => rank(a.severity) - rank(b.severity));
}

function checkManifest(manifest: any, outDir: string, add: (i: Issue) => void): void {
    const F = "manifest.json";

    if (manifest.manifest_version !== 3) {
        add({
            id: "manifest-version", severity: "error", file: F,
            message: `"manifest_version" is ${JSON.stringify(manifest.manifest_version)}, not 3`,
            fix: 'Set "manifest_version": 3. Chrome will not install the extension otherwise.',
        });
    }

    const bg = manifest.background;
    if (bg && typeof bg === "object") {
        if (bg.scripts) {
            add({
                id: "background-scripts", severity: "error", file: F,
                message: '"background.scripts" is MV2 and is ignored in MV3',
                fix: `Replace with "background": {"service_worker": "${(bg.scripts?.[0] ?? "background.js")}"}. ` +
                     "If there were several scripts, load the rest with importScripts() from the worker or merge them.",
            });
        }
        if (bg.page) {
            add({
                id: "background-page", severity: "error", file: F,
                message: '"background.page" is MV2 and is ignored in MV3',
                fix: 'Replace the background page with "service_worker" and move its DOM work to an offscreen document.',
            });
        }
        if ("persistent" in bg) {
            add({
                id: "background-persistent", severity: "warn", file: F,
                message: '"background.persistent" is meaningless in MV3 and is a leftover MV2 key',
                fix: 'Delete "persistent" from the background object. MV3 workers are always non-persistent.',
            });
        }
    }

    for (const key of ["browser_action", "page_action"]) {
        if (manifest[key]) {
            add({
                id: "legacy-action-key", severity: "error", file: F,
                message: `"${key}" was removed in MV3`,
                fix: `Rename "${key}" to "action" (a single unified key). Update chrome.${key === "browser_action" ? "browserAction" : "pageAction"}.* calls to chrome.action.* too.`,
            });
        }
    }

    const perms: unknown[] = manifest.permissions ?? [];
    const urlPerms = perms.filter((p) => typeof p === "string" && /^(\*|https?:|file:|ftp:)/.test(p));
    if (urlPerms.length) {
        add({
            id: "url-in-permissions", severity: "error", file: F,
            message: `URL match patterns must not stay in "permissions": ${urlPerms.slice(0, 5).join(", ")}`,
            fix: 'Move every URL pattern from "permissions" into "host_permissions". Leave only API permissions (e.g. "tabs", "storage") behind.',
        });
    }
    if (perms.includes("webRequestBlocking")) {
        add({
            id: "removed-permission", severity: "error", file: F,
            message: '"webRequestBlocking" does not exist in MV3',
            fix: 'Drop the permission and re-express the blocking rules with declarativeNetRequest ("declarative_net_request" + a rules JSON file).',
        });
    }
    const optUrls = (manifest.optional_permissions ?? []).filter((p: unknown) => typeof p === "string" && /^(\*|https?:)/.test(p));
    if (optUrls.length) {
        add({
            id: "optional-url-permissions", severity: "warn", file: F,
            message: `URL patterns in "optional_permissions": ${optUrls.slice(0, 3).join(", ")}`,
            fix: 'Move them to "optional_host_permissions".',
        });
    }

    const csp = manifest.content_security_policy;
    if (typeof csp === "string") {
        add({
            id: "csp-string", severity: "error", file: F,
            message: '"content_security_policy" must be an object in MV3, not a string',
            fix: 'Use {"extension_pages": "<policy>"}. Remove any "unsafe-eval" and remote script sources — MV3 forbids them.',
        });
    } else if (csp && typeof csp === "object") {
        for (const [k, v] of Object.entries(csp)) {
            if (typeof v === "string" && /unsafe-eval|https?:\/\//.test(v)) {
                add({
                    id: "csp-remote-or-eval", severity: "error", file: F,
                    message: `content_security_policy.${k} allows remote code or unsafe-eval, which MV3 rejects`,
                    fix: "Remove remote script origins and 'unsafe-eval' from the policy; bundle the code locally instead.",
                });
            }
        }
    }

    const war = manifest.web_accessible_resources;
    if (Array.isArray(war) && war.some((w) => typeof w === "string")) {
        add({
            id: "war-flat-array", severity: "error", file: F,
            message: '"web_accessible_resources" uses the MV2 flat string array',
            fix: 'Use the MV3 object form: [{"resources": ["file.js"], "matches": ["<all_urls>"]}].',
        });
    } else if (Array.isArray(war)) {
        for (const w of war) {
            if (w && typeof w === "object" && !w.matches && !w.extension_ids) {
                add({
                    id: "war-missing-matches", severity: "error", file: F,
                    message: 'a "web_accessible_resources" entry has no "matches"',
                    fix: 'Every entry needs "matches" (or "extension_ids"), e.g. "matches": ["<all_urls>"]. Chrome rejects the manifest otherwise.',
                });
            }
        }
    }

    for (const [i, cs] of (manifest.content_scripts ?? []).entries()) {
        if (!cs?.matches?.length) {
            add({
                id: "content-script-no-matches", severity: "error", file: F,
                message: `content_scripts[${i}] has no "matches"`,
                fix: 'Add a "matches" array. Chrome rejects a content script entry without one.',
            });
        }
    }

    if (manifest.background?.service_worker && manifest.background?.type && manifest.background.type !== "module") {
        add({
            id: "background-type", severity: "warn", file: F,
            message: `background.type is "${manifest.background.type}"; only "module" is valid`,
            fix: 'Use "type": "module" (only if the worker uses ESM import statements), or remove the key.',
        });
    }
}

function checkReferencedFiles(manifest: any, outDir: string, add: (i: Issue) => void): void {
    for (const ref of referencedFiles(manifest)) {
        if (!existsSync(join(outDir, ref))) {
            add({
                id: "missing-file", severity: "error", file: "manifest.json",
                message: `manifest references "${ref}", which does not exist in the output`,
                fix: `Create ${ref}, or correct the path. A manifest pointing at a missing file fails to load. ` +
                     "If the file existed in the MV2 source, copy it across rather than deleting the reference.",
            });
        }
    }
}

function checkDnr(manifest: any, outDir: string, add: (i: Issue) => void): void {
    const resources = manifest?.declarative_net_request?.rule_resources;
    if (!resources) return;
    if (!Array.isArray(resources)) {
        add({
            id: "dnr-rule-resources-shape", severity: "error", file: "manifest.json",
            message: '"declarative_net_request.rule_resources" must be an array',
            fix: 'Use [{"id": "ruleset_1", "enabled": true, "path": "rules.json"}].',
        });
        return;
    }
    for (const [i, rs] of resources.entries()) {
        const missing = ["id", "enabled", "path"].filter((k) => !(rs && typeof rs === "object" && k in rs));
        if (missing.length) {
            add({
                id: "dnr-ruleset-keys", severity: "error", file: "manifest.json",
                message: `rule_resources[${i}] is missing required key(s): ${missing.join(", ")}`,
                fix: 'Each ruleset needs ALL THREE of id, enabled and path: {"id": "ruleset_1", "enabled": true, "path": "rules.json"}. Omitting any one fails extension load.',
            });
            // Fall through rather than skipping: if a path is present we still validate the
            // rules themselves, so both layers get fixed in the same round.
            if (typeof rs?.path !== "string") continue;
        }
        const rulesPath = String(rs.path).replace(/^\.?\//, "");
        if (!existsSync(join(outDir, rulesPath))) continue; // reported by checkReferencedFiles
        let rules: any;
        try {
            rules = JSON.parse(readFileSync(join(outDir, rulesPath), "utf8"));
        } catch (e: any) {
            add({
                id: "dnr-rules-unparseable", severity: "error", file: rulesPath,
                message: `${rulesPath} is not valid JSON: ${e.message}`,
                fix: "Fix the JSON. An unparseable rules file makes the whole extension fail to load.",
            });
            continue;
        }
        if (!Array.isArray(rules)) {
            add({
                id: "dnr-rules-not-array", severity: "error", file: rulesPath,
                message: `${rulesPath} must contain a top-level ARRAY of rules`,
                fix: 'Wrap the rules in an array: [{"id": 1, "priority": 1, "action": {...}, "condition": {...}}].',
            });
            continue;
        }
        for (const [j, r] of rules.entries()) {
            const missingKeys = ["id", "action", "condition"].filter((k) => !(r && typeof r === "object" && k in r));
            if (missingKeys.length) {
                add({
                    id: "dnr-rule-keys", severity: "error", file: rulesPath,
                    message: `rule ${j} is missing: ${missingKeys.join(", ")}`,
                    fix: 'Every rule needs id (integer), action and condition, e.g. {"id": 1, "priority": 1, "action": {"type": "block"}, "condition": {"urlFilter": "example.com", "resourceTypes": ["main_frame"]}}.',
                });
                continue;
            }
            if (!Number.isInteger(r.id)) {
                add({
                    id: "dnr-rule-id", severity: "error", file: rulesPath,
                    message: `rule ${j} has a non-integer id (${JSON.stringify(r.id)})`,
                    fix: "Rule ids must be integers, unique within the file, starting at 1.",
                });
            }
            if (r.action?.type === "redirect" && !r.action?.redirect?.url && !r.action?.redirect?.regexSubstitution && !r.action?.redirect?.extensionPath) {
                add({
                    id: "dnr-redirect-shape", severity: "error", file: rulesPath,
                    message: `rule ${j} is a redirect but has no action.redirect.url`,
                    fix: 'A redirect target goes in action.redirect.url (there is no "redirectUrl" or "detail" field): {"type": "redirect", "redirect": {"url": "https://…"}}.',
                });
            }
            if (r.condition && !r.condition.urlFilter && !r.condition.regexFilter && !r.condition.requestDomains) {
                add({
                    id: "dnr-condition-empty", severity: "warn", file: rulesPath,
                    message: `rule ${j} has a condition with no urlFilter/regexFilter/requestDomains, so it matches everything`,
                    fix: "Add a urlFilter or regexFilter so the rule only matches the intended requests.",
                });
            }
        }
    }
}

/** Deprecated APIs that are simple renames — flagged anywhere in the extension. */
const DEPRECATED: [RegExp, string, string][] = [
    [/chrome\.extension\.(getURL|sendMessage|onMessage|onRequest|sendRequest)\b/, "chrome.extension.* was removed",
     "Use the chrome.runtime.* equivalent (getURL/sendMessage/onMessage)."],
    [/chrome\.browserAction\.\w+/, "chrome.browserAction.* was removed", "Use chrome.action.* instead."],
    [/chrome\.pageAction\.\w+/, "chrome.pageAction.* was removed", "Use chrome.action.* instead."],
    [/chrome\.tabs\.executeScript\b/, "chrome.tabs.executeScript was removed",
     'Use chrome.scripting.executeScript({target: {tabId}, files: ["x.js"]}) and add the "scripting" permission.'],
    [/chrome\.tabs\.insertCSS\b/, "chrome.tabs.insertCSS was removed",
     "Use chrome.scripting.insertCSS({target: {tabId}, files: [...]})."],
    [/chrome\.(runtime|extension)\.getBackgroundPage\b/, "getBackgroundPage was removed",
     "There is no background page in MV3. Use chrome.runtime messaging or chrome.storage."],
];

/** Globals that simply do not exist inside a service worker. */
const SW_BANNED: [RegExp, string][] = [
    [/\bdocument\s*\./, "document"],
    [/\bwindow\s*\./, "window"],
    [/\blocalStorage\b/, "localStorage"],
    [/\bsessionStorage\b/, "sessionStorage"],
    [/\bnew\s+XMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bnew\s+Audio\b/, "Audio"],
    [/\bDOMParser\b/, "DOMParser"],
    [/\balert\s*\(/, "alert"],
];

function checkCode(manifest: any, outDir: string, add: (i: Issue) => void): void {
    const swFiles = new Set(serviceWorkerFiles(outDir, manifest));
    const files = walk(outDir).filter((f) => SCANNABLE.has(f.slice(f.lastIndexOf("."))));

    for (const rel of files) {
        scanLines(outDir, rel, (line, n) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // don't flag comments

            for (const [re, message, fix] of DEPRECATED) {
                if (re.test(line)) add({ id: "deprecated-api", severity: "error", file: rel, line: n, message: `${message} — ${clip(line)}`, fix });
            }
            if (/chrome\.webRequest\.\w+\.addListener/.test(line)) {
                add({
                    id: "blocking-webrequest", severity: "warn", file: rel, line: n,
                    message: `webRequest listener remains — ${clip(line)}`,
                    fix: "Non-blocking webRequest still works for observation. If this listener returned {cancel/redirectUrl/requestHeaders}, it is BLOCKING and must become a declarativeNetRequest rule.",
                });
            }
            if (/executeScript\s*\(\s*\{[^}]*\bcode\s*:/.test(line)) {
                add({
                    id: "executescript-code", severity: "error", file: rel, line: n,
                    message: `executeScript with a "code" string is forbidden in MV3 — ${clip(line)}`,
                    fix: "Move the code into a file and use files: [...], or pass a real function via func: () => {...}.",
                });
            }

            if (swFiles.has(rel)) {
                for (const [re, name] of SW_BANNED) {
                    if (re.test(line)) {
                        add({
                            id: "sw-banned-global", severity: "error", file: rel, line: n,
                            message: `service worker uses "${name}", which does not exist in a worker — ${clip(line)}`,
                            fix: name === "localStorage" || name === "sessionStorage"
                                ? "Use chrome.storage.local (async) instead."
                                : name === "XMLHttpRequest"
                                ? "Use fetch() instead."
                                : "Move this DOM/Web-API work to an offscreen document, or drop it. The worker throws on load otherwise.",
                        });
                    }
                }
                if (/\b(eval\s*\(|new\s+Function\s*\()/.test(line)) {
                    add({
                        id: "sw-eval", severity: "error", file: rel, line: n,
                        message: `service worker evaluates code at runtime — ${clip(line)}`,
                        fix: "MV3 forbids eval/new Function in extension pages and workers. Inline the logic instead.",
                    });
                }
                if (/importScripts\s*\(\s*['"]https?:/.test(line)) {
                    add({
                        id: "sw-remote-import", severity: "error", file: rel, line: n,
                        message: `service worker importScripts() a remote URL — ${clip(line)}`,
                        fix: "MV3 forbids remotely-hosted code. Vendor the script into the extension and import it by relative path.",
                    });
                }
            }
        });
    }

    // Only HTML the manifest loads as an EXTENSION page is subject to MV3's CSP. Extensions
    // often bundle saved sample/test pages full of third-party script tags; flagging those is
    // noise the agent would waste rounds "fixing".
    const extensionPages = new Set(
        referencedFiles(manifest).filter((f) => /\.html?$/i.test(f)),
    );
    for (const rel of walk(outDir).filter((f) => extensionPages.has(f))) {
        scanLines(outDir, rel, (line, n) => {
            if (/<script[^>]*\bsrc\s*=\s*['"](?:https?:)?\/\//i.test(line)) {
                add({
                    id: "remote-script", severity: "error", file: rel, line: n,
                    message: `remotely-hosted script tag — ${clip(line)}`,
                    fix: "MV3 forbids remote code. Download the script into the extension and reference it by relative path.",
                });
            }
        });
    }
}

/** Render issues as the block sent to the model. Errors first, capped so one noisy file cannot flood the prompt. */
export function formatIssues(issues: Issue[], max = 25): string {
    if (!issues.length || max <= 0) return "";
    const shown = issues.slice(0, max);
    const lines = shown.map((i) => {
        const loc = i.file ? `${i.file}${i.line ? `:${i.line}` : ""}` : "manifest.json";
        return `- [${i.severity}] ${loc} — ${i.message}\n  FIX: ${i.fix}`;
    });
    const omitted = issues.length - shown.length;
    return lines.join("\n") + (omitted > 0 ? `\n- …and ${omitted} more issue(s) of the same kinds.` : "");
}
