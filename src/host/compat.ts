// MDN browser-compat-data validation, via `browser-extension-compat-data`.
//
// Why this exists alongside staticAnalyzer.ts / checks.ts: those two encode OUR hand-written
// knowledge of the MV2->MV3 delta (assets/api_mappings.json plus a regex table). That table is
// small, hand-maintained, and silently stale the moment Chrome moves. This module instead reads
// the extension's manifest + referenced sources and checks every field, permission and
// `chrome.*`/`browser.*` call site against MDN's compat data, which is re-synced upstream daily.
//
// It is used at both ends of a run:
//   - BEFORE migration, over the converted MV2 input: every finding whose key has no MV3
//     equivalent is a HARD blocker, and the share of the corpus with a HARD blocker is the
//     ceiling on how much of it can be migrated at all (M_hi).
//   - AFTER migration, over the agent's output: a deterministic check that the migrated code
//     only calls APIs that exist in MV3 Chrome. Catches hallucinated/removed APIs for the price
//     of a JSON lookup, instead of a Chromium launch that would not even notice them (an
//     extension calling a nonexistent API loads fine and throws on a cold path).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeExtension, getIndex, type Browser, type Reason, type UnsupportedItem } from "browser-extension-compat-data";

/**
 * HARD  — the platform has no MV3 equivalent; no implementation preserves the behaviour.
 * SOFT  — an equivalent exists but the code must be restructured to reach it.
 * INFO  — partial/flagged support, or MDN has no data. Not evidence of anything on its own.
 */
export type CompatSeverity = "HARD" | "SOFT" | "INFO";

export interface CompatFinding {
    kind: "manifest" | "permission" | "api";
    /**
     * `bcd` — MDN says the target browser does not have this.
     * `mv3` — our MV3 rule overlay (see MV3_REMOVED): the browser HAS the feature, but MV3
     * extensions may not use it, which MDN's per-browser data cannot express.
     */
    source: "bcd" | "mv3";
    /** Dotted BCD key, e.g. `webRequest.onBeforeRequest` or `webRequestBlocking`. */
    key: string;
    reason: Reason;
    severity: CompatSeverity;
    /** MDN url — the citable constraint for a HARD finding. */
    mdnUrl?: string;
    message?: string;
    file?: string;
    line?: number;
    column?: number;
}

export interface CompatReport {
    /** Upstream MDN browser-compat-data version the index was built from (provenance). */
    bcdVersion?: string;
    browser: Browser;
    version: string;
    findings: CompatFinding[];
    /** Files the analyzer resolved from the manifest and scanned. */
    scannedFiles: string[];
    /** True when at least one HARD blocker was found: no MV3 port can preserve behaviour. */
    hasHardBlocker: boolean;
}

/**
 * The Chrome we grade against. Defaults to the Chrome-for-Testing build verify.ts loads the
 * extension into, so a "supported" verdict here and a successful load there mean the same thing.
 */
export const TARGET_BROWSER: Browser = "chrome";
export function targetVersion(): string {
    const raw = process.env.COMPAT_CHROME_VERSION ?? process.env.CHROME_FOR_TESTING_VERSION ?? "131";
    return String(raw).split(".")[0]; // "131.0.6778.204" -> "131"
}

/**
 * Keys with no MV3 equivalent at all. BCD tells us a feature is gone; it cannot tell us whether
 * something else covers the use case. declarativeNetRequest covers most of what blocking
 * webRequest did, so removal alone is not proof of impossibility — but these specific capabilities
 * (reading/rewriting a request from JS at decision time, running code that is not in the package)
 * have no declarative replacement, and each is documented as such by Chrome.
 */
const HARD_KEYS = new Set<string>([
    "webRequest.filterResponseData",
    "webRequest.onAuthRequired.BlockingResponse",
]);

/**
 * The MV3 overlay BCD cannot express.
 *
 * MDN's data is keyed by browser, not by manifest version: Chrome still supports
 * `webRequestBlocking` and `background.scripts`, so BCD reports them as supported even though an
 * MV3 extension may not use them. These entries encode the manifest-version dimension, each with
 * the Chrome documentation that states the constraint — the citable evidence an IMPOSSIBLE
 * verdict needs.
 *
 * HARD here means "no MV3 equivalent preserves the behaviour", not merely "moved":
 * webRequestBlocking is HARD because declarativeNetRequest cannot express a decision computed
 * from request contents at request time, while browser_action is SOFT because `action` is a
 * straight rename.
 */
const MV3_REMOVED: Record<string, { kind: "manifest" | "permission"; severity: CompatSeverity; url: string; message: string }> = {
    webRequestBlocking: {
        kind: "permission",
        severity: "HARD",
        url: "https://developer.chrome.com/docs/extensions/develop/migrate/known-issues",
        message:
            "MV3 removes blocking webRequest for non-enterprise extensions. Static block/redirect " +
            "rules port to declarativeNetRequest; a BlockingResponse computed from the request at " +
            "request time has no MV3 equivalent.",
    },
    "background.scripts": {
        kind: "manifest",
        severity: "SOFT",
        url: "https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers",
        message: "MV3 replaces background pages/scripts with a single service worker.",
    },
    "background.persistent": {
        kind: "manifest",
        severity: "SOFT",
        url: "https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers",
        message: "MV3 service workers are non-persistent; the key is invalid and state must survive termination.",
    },
    browser_action: {
        kind: "manifest",
        severity: "SOFT",
        url: "https://developer.chrome.com/docs/extensions/develop/migrate/api-calls",
        message: "MV3 merges browser_action and page_action into action.",
    },
    page_action: {
        kind: "manifest",
        severity: "SOFT",
        url: "https://developer.chrome.com/docs/extensions/develop/migrate/api-calls",
        message: "MV3 merges browser_action and page_action into action.",
    },
    content_security_policy: {
        kind: "manifest",
        severity: "SOFT",
        url: "https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy",
        message:
            "In MV3 this is an object (extension_pages/sandbox), not a string, and it may not relax " +
            "the policy — 'unsafe-eval' and remote script sources are rejected.",
    },
};

/** Manifest/permission findings MDN's per-browser data structurally cannot produce. */
function mv3Overlay(extPath: string): CompatFinding[] {
    let manifest: any;
    try {
        manifest = JSON.parse(readFileSync(join(extPath, "manifest.json"), "utf8"));
    } catch {
        return [];
    }
    const out: CompatFinding[] = [];
    const add = (key: string, extra?: Partial<CompatFinding>) => {
        const rule = MV3_REMOVED[key];
        if (!rule) return;
        out.push({
            kind: rule.kind,
            source: "mv3",
            key,
            reason: "manifest-version",
            severity: rule.severity,
            mdnUrl: rule.url,
            message: rule.message,
            file: "manifest.json",
            ...extra,
        });
    };

    const perms: unknown[] = [
        ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
        ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
    ];
    for (const p of perms) if (typeof p === "string" && MV3_REMOVED[p]) add(p);

    if (manifest.browser_action) add("browser_action");
    if (manifest.page_action) add("page_action");
    if (manifest.background && typeof manifest.background === "object") {
        if (Array.isArray(manifest.background.scripts)) add("background.scripts");
        if ("persistent" in manifest.background) add("background.persistent");
    }
    // Only the MV2 string form is a violation; the MV3 object form is correct and stays quiet.
    if (typeof manifest.content_security_policy === "string") add("content_security_policy");
    return out;
}

/** HARD when MDN says the key is gone AND nothing in MV3 covers it. */
function classify(item: UnsupportedItem): CompatSeverity {
    switch (item.reason) {
        case "removed":
        case "not-supported":
        case "manifest-version":
            return HARD_KEYS.has(item.key) ? "HARD" : "SOFT";
        default:
            return "INFO"; // partial | flag | no-compat-data — never load-bearing evidence
    }
}

/**
 * Analyze one extension directory against MV3 Chrome. Never throws: a directory the analyzer
 * cannot read (no manifest, unparseable sources) yields an empty report rather than killing a
 * run, because the browser load in verify.ts is still the authority on whether it works.
 */
export async function analyzeCompat(extPath: string): Promise<CompatReport> {
    const version = targetVersion();
    const base: CompatReport = {
        browser: TARGET_BROWSER,
        version,
        findings: [],
        scannedFiles: [],
        hasHardBlocker: false,
    };
    try {
        base.bcdVersion = getIndex().v;
    } catch { }

    let report;
    try {
        report = await analyzeExtension(extPath, [{ browser: TARGET_BROWSER, version }]);
    } catch {
        return base;
    }

    const findings: CompatFinding[] = [];
    for (const { findings: items } of report.targets) {
        for (const item of items) {
            findings.push({
                kind: item.kind,
                source: "bcd",
                key: item.key,
                reason: item.reason,
                severity: classify(item),
                mdnUrl: item.mdnUrl,
                message: item.message,
                file: item.file,
                line: item.loc?.line,
                column: item.loc?.column,
            });
        }
    }
    findings.push(...mv3Overlay(extPath));

    // Stable order: worst first, then by location, so diffs between runs are readable.
    const rank: Record<CompatSeverity, number> = { HARD: 0, SOFT: 1, INFO: 2 };
    findings.sort(
        (a, b) =>
            rank[a.severity] - rank[b.severity] ||
            (a.file ?? "").localeCompare(b.file ?? "") ||
            (a.line ?? 0) - (b.line ?? 0) ||
            a.key.localeCompare(b.key),
    );

    return {
        ...base,
        scannedFiles: report.scannedFiles ?? [],
        findings,
        hasHardBlocker: findings.some((f) => f.severity === "HARD"),
    };
}

/** `file:line:column` for a finding, or the manifest/permission it came from. */
export function where(f: CompatFinding): string {
    if (!f.file) return f.kind === "api" ? f.key : "manifest.json";
    return f.line ? `${f.file}:${f.line}:${f.column ?? 0}` : f.file;
}

/** Compact markdown for the migration prompt / fix prompt. INFO findings are dropped as noise. */
export function formatCompat(report: CompatReport, max = 20): string {
    const items = report.findings.filter((f) => f.severity !== "INFO");
    if (!items.length) return "";
    const lines = [
        `## Browser Compatibility (MDN compat data, chrome ${report.version})`,
        "",
        "Every entry is a manifest field, permission or API call that does NOT exist in the target " +
        "Chrome. HARD entries have no MV3 replacement — do not fake one; leave the capability out " +
        "and keep the rest of the extension working. SOFT entries have a replacement you must apply.",
        "",
    ];
    for (const f of items.slice(0, max)) {
        lines.push(
            `- **${f.severity}** \`${f.kind}: ${f.key}\` (${f.reason}) — ${where(f)}` +
            (f.mdnUrl ? `  \n  ${f.mdnUrl}` : "") +
            (f.message ? `  \n  ${f.message}` : ""),
        );
    }
    if (items.length > max) lines.push(`- …and ${items.length - max} more`);
    lines.push("");
    return lines.join("\n");
}
