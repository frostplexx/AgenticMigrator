/**
 * The change ledger: for every MV2→MV3 change, was it NEEDED and was it APPLIED.
 *
 * Counting what the framework did is the easy half and the less useful one. Knowing that it
 * injected an offscreen document eleven times says nothing without knowing how many extensions
 * needed one — a migration that applies a change in half the cases that call for it and a
 * migration that applies it everywhere it is needed produce the same "11" in a results table.
 *
 * So every change is detected twice, against different trees: `needed` from the ORIGINAL MV2
 * source (what the platform demands), `applied` from the migrated output (what actually happened).
 * The interesting cell is needed && !applied — a silently skipped change, which is exactly the
 * failure mode a load-only verifier cannot see.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

export type ChangeId =
    | "manifest_version"
    | "background_service_worker"
    | "background_persistent_removed"
    | "action_rename"
    | "host_permissions_split"
    | "webrequest_to_dnr"
    | "offscreen_document"
    | "execute_script_api"
    | "remote_code_removed"
    | "web_accessible_resources_v3"
    | "csp_object_form"
    | "commands_execute_action"
    | "storage_over_dom_state";

export interface ChangeRecord {
    id: ChangeId;
    /** Short description, used as the tag's human text. */
    title: string;
    /** The original demanded it: counted from the MV2 source. */
    needed: boolean;
    /** The output has it: counted from the migrated tree. */
    applied: boolean;
    /** Where the need was seen, so a skipped change is checkable rather than asserted. */
    evidence: { file: string; line?: number; snippet?: string }[];
}

/** Files worth reading for API evidence. Data files are skipped — see the prompt's warning. */
const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".html", ".htm"]);

/** One long minified line can dwarf the rest of a scan; keep evidence readable. */
const SNIPPET_MAX = 160;

interface SourceFile {
    path: string;
    text: string;
}

function readCode(dir: string, limitBytes = 2_000_000): SourceFile[] {
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
            if (!CODE_EXT.has(extname(entry).toLowerCase())) continue;
            if (stat.size > limitBytes) continue;
            try {
                out.push({ path: relative(dir, full), text: readFileSync(full, "utf8") });
            } catch {
                /* unreadable file: not evidence either way */
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

/** First match of `pattern` across the tree, as evidence. */
function find(files: SourceFile[], pattern: RegExp): { file: string; line: number; snippet: string }[] {
    const hits: { file: string; line: number; snippet: string }[] = [];
    for (const file of files) {
        const lines = file.text.split("\n");
        for (let i = 0; i < lines.length; i++) {
            if (!pattern.test(lines[i])) continue;
            hits.push({
                file: file.path,
                line: i + 1,
                snippet: lines[i].trim().slice(0, SNIPPET_MAX),
            });
            break; // one hit per file is enough to establish the need
        }
        if (hits.length >= 5) break;
    }
    return hits;
}

const URL_PATTERN = /^(\*|https?|file|ftp):\/\/|^<all_urls>$/;

/** Background code only: where a service worker's missing DOM actually bites. */
function backgroundFiles(manifest: Record<string, any>, files: SourceFile[]): SourceFile[] {
    const background = manifest.background ?? {};
    const declared: string[] = [
        ...(Array.isArray(background.scripts) ? background.scripts : []),
        ...(typeof background.service_worker === "string" ? [background.service_worker] : []),
        ...(typeof background.page === "string" ? [background.page] : []),
    ].map((p) => p.replace(/^\.?\//, ""));
    if (declared.length === 0) return [];
    return files.filter((f) => declared.includes(f.path));
}

/**
 * Build the ledger for one migration.
 *
 * `inputDir` is the original MV2 extension and `outputDir` the migrated result. Both are needed:
 * "applied" is only meaningful relative to what the original looked like.
 */
export function buildChangeLedger(inputDir: string, outputDir: string): ChangeRecord[] {
    const inManifest = readManifest(inputDir);
    const outManifest = readManifest(outputDir);
    const inFiles = readCode(inputDir);
    const outFiles = readCode(outputDir);
    const inBackground = backgroundFiles(inManifest, inFiles);
    const outBackground = backgroundFiles(outManifest, outFiles);

    const records: ChangeRecord[] = [];
    const add = (
        id: ChangeId,
        title: string,
        needed: boolean,
        applied: boolean,
        evidence: ChangeRecord["evidence"] = [],
    ): void => {
        records.push({ id, title, needed, applied, evidence });
    };

    add(
        "manifest_version",
        "manifest_version bumped to 3",
        inManifest.manifest_version === 2,
        outManifest.manifest_version === 3,
        [{ file: "manifest.json", snippet: `manifest_version: ${inManifest.manifest_version}` }],
    );

    const inBg = inManifest.background ?? null;
    add(
        "background_service_worker",
        "background page/scripts → service worker",
        Boolean(inBg && (inBg.page || Array.isArray(inBg.scripts))),
        Boolean(outManifest.background?.service_worker),
        inBg ? [{ file: "manifest.json", snippet: `background: ${JSON.stringify(inBg).slice(0, SNIPPET_MAX)}` }] : [],
    );

    add(
        "background_persistent_removed",
        "background.persistent removed",
        inBg ? inBg.persistent !== undefined : false,
        outManifest.background ? outManifest.background.persistent === undefined : true,
    );

    add(
        "action_rename",
        "browser_action/page_action → action",
        Boolean(inManifest.browser_action || inManifest.page_action),
        Boolean(outManifest.action) && !outManifest.browser_action && !outManifest.page_action,
    );

    const inPermissions: string[] = Array.isArray(inManifest.permissions) ? inManifest.permissions : [];
    const hostLike = inPermissions.filter((p) => typeof p === "string" && URL_PATTERN.test(p));
    add(
        "host_permissions_split",
        "URL permissions → host_permissions",
        hostLike.length > 0,
        Array.isArray(outManifest.host_permissions) && outManifest.host_permissions.length > 0,
        hostLike.length ? [{ file: "manifest.json", snippet: `permissions: ${hostLike.join(", ")}` }] : [],
    );

    // Blocking webRequest is the change most likely to be skipped, and the one whose skip matters
    // most: an extension that silently stops blocking looks identical to one that works.
    const blockingEvidence = find(inFiles, /webRequest\.\w+\.addListener[\s\S]{0,400}?["']blocking["']|["']blocking["']/);
    const usesBlocking =
        inPermissions.includes("webRequestBlocking") ||
        (inPermissions.includes("webRequest") && blockingEvidence.length > 0);
    add(
        "webrequest_to_dnr",
        "blocking webRequest → declarativeNetRequest",
        usesBlocking,
        Boolean(
            (Array.isArray(outManifest.permissions) &&
                outManifest.permissions.some((p: string) => String(p).startsWith("declarativeNetRequest"))) ||
                outManifest.declarative_net_request,
        ),
        blockingEvidence,
    );

    // A service worker has no DOM. Background code that used one needs an offscreen document — the
    // change whose "should have happened" count the issue specifically asks for.
    const domEvidence = find(
        inBackground,
        /\bdocument\.(createElement|body|querySelector)|\bnew\s+(Audio|Image|DOMParser|XMLHttpRequest)\b|\bwindow\.(open|alert)\b|\bnavigator\.clipboard\b/,
    );
    add(
        "offscreen_document",
        "DOM use in background → offscreen document",
        domEvidence.length > 0,
        Boolean(
            (Array.isArray(outManifest.permissions) && outManifest.permissions.includes("offscreen")) ||
                find(outFiles, /chrome\.offscreen\.createDocument/).length > 0,
        ),
        domEvidence,
    );

    const execEvidence = find(inFiles, /tabs\.executeScript\s*\(|tabs\.insertCSS\s*\(/);
    add(
        "execute_script_api",
        "tabs.executeScript → scripting.executeScript",
        execEvidence.length > 0,
        find(outFiles, /scripting\.(executeScript|insertCSS)\s*\(/).length > 0,
        execEvidence,
    );

    const remoteEvidence = find(inFiles, /<script[^>]+src=["']https?:\/\/|importScripts\s*\(\s*["']https?:\/\//);
    add(
        "remote_code_removed",
        "remotely hosted code removed or bundled",
        remoteEvidence.length > 0,
        remoteEvidence.length > 0 &&
            find(outFiles, /<script[^>]+src=["']https?:\/\/|importScripts\s*\(\s*["']https?:\/\//).length === 0,
        remoteEvidence,
    );

    add(
        "web_accessible_resources_v3",
        "web_accessible_resources → MV3 object form",
        Array.isArray(inManifest.web_accessible_resources) &&
            inManifest.web_accessible_resources.some((r: unknown) => typeof r === "string"),
        Array.isArray(outManifest.web_accessible_resources) &&
            outManifest.web_accessible_resources.every((r: unknown) => typeof r === "object" && r !== null),
    );

    add(
        "csp_object_form",
        "content_security_policy → object form",
        typeof inManifest.content_security_policy === "string",
        outManifest.content_security_policy === undefined ||
            typeof outManifest.content_security_policy === "object",
    );

    const inCommands = inManifest.commands ?? {};
    add(
        "commands_execute_action",
        "_execute_browser_action → _execute_action",
        Object.prototype.hasOwnProperty.call(inCommands, "_execute_browser_action"),
        Object.prototype.hasOwnProperty.call(outManifest.commands ?? {}, "_execute_action"),
    );

    // A worker is evicted between events, so module-level state has to move into storage.
    const stateEvidence = find(inBackground, /^\s*(var|let|const)\s+\w+\s*=\s*(\{|\[|new\s+Map|new\s+Set|0|""|'')/m);
    add(
        "storage_over_dom_state",
        "module-level background state → chrome.storage",
        stateEvidence.length > 0,
        find(outBackground, /chrome\.storage\.(local|session|sync)\.(set|get)/).length > 0,
        stateEvidence,
    );

    return records;
}

/** Counts for a results table: applied, skipped (needed but not applied), and not applicable. */
export function summarizeLedger(records: ChangeRecord[]): {
    needed: number;
    applied: number;
    skipped: number;
    appliedUnneeded: number;
} {
    let needed = 0;
    let applied = 0;
    let skipped = 0;
    let appliedUnneeded = 0;
    for (const record of records) {
        if (record.needed) needed++;
        if (record.needed && record.applied) applied++;
        if (record.needed && !record.applied) skipped++;
        if (!record.needed && record.applied) appliedUnneeded++;
    }
    return { needed, applied, skipped, appliedUnneeded };
}
