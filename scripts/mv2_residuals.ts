#!/usr/bin/env npx tsx
/**
 * MV2 API residual scanner.
 *
 * Callback→promise and the other semi-trivial API rewrites are agent work guided by
 * assets/skills/mv3-semi-trivial/SKILL.md. They are not a discrete "applied" event the ledger
 * could count, so the honest measure is the residue: MV2-only API forms from the skill's
 * replacement table that REMAIN in the migrated output. Every hit is kept verbatim (file, line
 * number, original line) under a per-family dotted tag.
 *
 * Standalone:  npx tsx scripts/mv2_residuals.ts [root] [--out data/mv2-residuals.json] [--group <substr>]
 * Integration: backfill_tags.ts merges the JSON automatically when it exists.
 *
 * The root may be local or remote: `PLAI_Server:/home/ra24mif/AgenticMigrator/run_test` (the
 * default) is pulled over ssh as a single tar stream containing only the scannable files
 * (js/mjs/cjs/html), extracted to a temp dir, scanned, and deleted.
 *
 * Layout understood: `<root>/<model-run>/<extensionId>/{out,...}` (run groups), as well as the
 * flat fixture layout `<root>/<extensionId>/...`. Children that are not 32-char extension ids
 * (e.g. content-addressed blobs/) are skipped. Multiple model runs containing the same
 * extension produce `<model-run>/<extensionId>` keys; pass `--group <substr>` to limit the scan
 * to one model run and avoid ambiguous merges.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export interface ResidualHit {
    file: string;
    line: number;
    snippet: string;
    /** The exact MV2 form matched, e.g. `chrome.extension.getURL`, `chrome.tabs.getSelected`. */
    api: string;
}

export type ResidualsByExt = Record<string, Partial<Record<ResidualFamily, ResidualHit[]>>>;

export type ResidualFamily = "extension" | "tabs" | "browser_action" | "page_action" | "runtime";

interface ResidualRule {
    family: ResidualFamily;
    title: string;
    /** Members of the family that are still legal in MV3 and must not be flagged. */
    allowed?: RegExp;
    regex: RegExp;
}

/**
 * From assets/skills/mv3-semi-trivial/SKILL.md ("API replacement table"), plus
 * chrome.runtime.onSuspend from the same skill's removed-API list. Deliberately excludes
 * tabs.executeScript / insertCSS (ledger-tracked via change.execute_script_api and the
 * converter's ExecuteScriptModifier).
 */
export const MV2_API_RULES: ResidualRule[] = [
    {
        // chrome.extension.<anything>, minus the members MV3 still allows
        family: "extension",
        title: "MV2-only chrome.extension.* calls remaining",
        allowed: /^(?:getViews|inIncognitoContext)\b/,
        regex: /\bchrome\.extension\.(\w+)/g,
    },
    {
        family: "tabs",
        title: "MV2-only chrome.tabs.* calls remaining",
        regex: /\bchrome\.tabs\.(?:getAllInWindow|getSelected|onActiveChanged|onHighlightChanged|onSelectionChanged|sendRequest)\b/g,
    },
    {
        family: "browser_action",
        title: "chrome.browserAction.* calls remaining (JS level)",
        regex: /\bchrome\.browserAction\./g,
    },
    {
        family: "page_action",
        title: "chrome.pageAction.* calls remaining (JS level)",
        regex: /\bchrome\.pageAction\./g,
    },
    {
        family: "runtime",
        title: "chrome.runtime.onSuspend remaining (removed in MV3)",
        regex: /\bchrome\.runtime\.onSuspend\b/g,
    },
];

/** Scan one file's text; returns verbatim hits (line kept exactly as written). */
export function scanText(text: string): { family: ResidualFamily; hits: ResidualHit[] }[] {
    const out: { family: ResidualFamily; hits: ResidualHit[] }[] = [];
    for (const rule of MV2_API_RULES) {
        const hits: ResidualHit[] = [];
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
            rule.regex.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = rule.regex.exec(lines[i])) !== null) {
                if (rule.allowed && m[1] && rule.allowed.test(m[1])) continue;
                hits.push({ file: "", line: i + 1, snippet: lines[i].trim().slice(0, 200), api: m[0] });
                break; // one hit per line per family is enough; the line is the evidence
            }
        }
        if (hits.length) out.push({ family: rule.family, hits });
    }
    return out;
}

const SCANNABLE = new Set([".js", ".mjs", ".cjs", ".html", ".htm"]);

function walkFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...walkFiles(p));
        else if (SCANNABLE.has(extname(entry))) out.push(p);
    }
    return out;
}

/** Scan one migrated extension directory; hits keyed by family, paths relative to the dir. */
export function scanDir(dir: string): Partial<Record<ResidualFamily, ResidualHit[]>> {
    const found: Partial<Record<ResidualFamily, ResidualHit[]>> = {};
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return found;
    for (const file of walkFiles(dir)) {
        let text: string;
        try {
            text = readFileSync(file, "utf8");
        } catch {
            continue;
        }
        for (const { family, hits } of scanText(text)) {
            const located = hits.map((h) => ({ ...h, file: relative(dir, file) }));
            found[family] = [...(found[family] ?? []), ...located];
        }
    }
    return found;
}

/** Chrome extension ids are 32 chars from a–p. Anything else (blobs/, model runs) is not one. */
const EXT_ID = /^[a-p]{32}$/;

/** The migrated output inside an extension dir: `out/` when the pipeline layout provides it. */
function migratedDir(extDir: string): string {
    const outDir = join(extDir, "out");
    return existsSync(outDir) ? outDir : extDir;
}

/**
 * Scan a run root. Handles both layouts:
 *   flat:    <root>/<extensionId>/...          → keyed by extensionId
 *   grouped: <root>/<model-run>/<extensionId>/ → keyed by `<model-run>/<extensionId>`
 * Non-extension children (blobs/, logs/, …) are skipped.
 */
export function scanRunRoot(root: string): ResidualsByExt {
    const result: ResidualsByExt = {};
    for (const entry of readdirSync(root)) {
        const dir = join(root, entry);
        if (!statSync(dir).isDirectory()) continue;
        if (EXT_ID.test(entry)) {
            result[entry] = scanDir(migratedDir(dir));
            continue;
        }
        for (const sub of readdirSync(dir)) {
            const subDir = join(dir, sub);
            if (!statSync(subDir).isDirectory() || !EXT_ID.test(sub)) continue;
            result[`${entry}/${sub}`] = scanDir(migratedDir(subDir));
        }
    }
    return result;
}

/** The tags one extension's residuals produce (family-level, evidence = first hits verbatim). */
export function residualTags(residuals: Partial<Record<ResidualFamily, ResidualHit[]>>): {
    tag: string;
    kind: "misc";
    title: string;
    provenance: "scan";
    evidence: { file: string; snippet: string }[];
}[] {
    const tags = [];
    for (const rule of MV2_API_RULES) {
        const hits = residuals[rule.family];
        if (!hits?.length) continue;
        tags.push({
            tag: `state.mv2_api_residual.${rule.family}`,
            kind: "misc" as const,
            title: `${rule.title} (${hits.length} hit${hits.length === 1 ? "" : "s"})`,
            provenance: "scan" as const,
            evidence: hits.slice(0, 3).map((h) => ({ file: `${h.file}:${h.line}`, snippet: h.snippet })),
        });
    }
    return tags;
}

function sshQuote(s: string): string {
    return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Pull a remote root over ssh as one tar stream of the scannable files only, extract into a
 * temp dir and return its path. Uses the system ssh/tar; nothing is installed. With
 * `group`, only top-level children whose name contains that substring are streamed (the corpus's
 * model run, not the other 5 GB of runs sitting next to it).
 */
export function pullRemoteRoot(root: string, group?: string): string {
    const sep = root.indexOf(":");
    const host = root.slice(0, sep);
    const path = root.slice(sep + 1);
    const tmp = mkdtempSync(join(process.cwd(), "data", ".mv2-residuals-"));
    let findPaths = ["."];
    if (group) {
        const ls = spawnSync("ssh", ["-o", "BatchMode=yes", host, `cd ${sshQuote(path)} && ls -d */ 2>/dev/null`], { encoding: "utf8" });
        if (ls.status !== 0) throw new Error(`cannot list ${root}: ${ls.stderr}`);
        findPaths = ls.stdout.split("\n").filter((d) => d.trim().endsWith("/") && d.trim().includes(group)).map((d) => `./${d.trim().replace(/\/$/, "")}`);
        if (!findPaths.length) throw new Error(`no children of ${root} match --group ${group}`);
        console.log(`  streaming only: ${findPaths.join(", ")}`);
    }
    // Stream only the file types scanDir reads. blob shards have no extension and transcripts
    // are .jsonl, so both are excluded by construction.
    const remote = `cd ${sshQuote(path)} && find ${findPaths.map(sshQuote).join(" ")} -type f \\( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.html' -o -name '*.htm' \\) -print0 | tar --null -cf - -T -`;
    const res = spawnSync("bash", ["-c", `set -o pipefail; ssh -o BatchMode=yes ${sshQuote(host)} ${sshQuote(remote)} | tar xf - -C ${sshQuote(tmp)}`], { stdio: "inherit" });
    if (res.status !== 0) {
        rmSync(tmp, { recursive: true, force: true });
        throw new Error(`ssh pull from ${root} failed (exit ${res.status})`);
    }
    return tmp;
}

function main(): void {
    const args = process.argv.slice(2);
    const value = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
    };
    const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1]?.startsWith("--") !== true);
    const root = positional[0] ?? "PLAI_Server:/home/ra24mif/AgenticMigrator/run_test";
    const outPath = value("--out") ?? join(process.cwd(), "data/mv2-residuals.json");
    const groupFilter = value("--group");

    console.log(`residual root: ${root}`);
    const remote = root.includes(":");
    const localRoot = remote ? pullRemoteRoot(root, groupFilter ?? undefined) : root;
    try {
        let byExt = scanRunRoot(localRoot);
        if (groupFilter) {
            byExt = Object.fromEntries(Object.entries(byExt).filter(([key]) => key.includes(groupFilter)));
        }
        const perModelRun = new Map<string, Set<string>>();
        for (const key of Object.keys(byExt)) {
            const model = key.includes("/") ? key.split("/")[0] : "(flat)";
            perModelRun.set(model, (perModelRun.get(model) ?? new Set()).add(key.split("/")[1] ?? key));
        }
        for (const [model, exts] of perModelRun) console.log(`  ${model}: ${exts.size} extension dirs`);
    const perFamily = new Map<ResidualFamily, { exts: number; hits: number }>();
    const worst: { id: string; hits: number }[] = [];
    for (const [id, fams] of Object.entries(byExt)) {
        let total = 0;
        for (const [fam, hits] of Object.entries(fams)) {
            const f = fam as ResidualFamily;
            const cur = perFamily.get(f) ?? { exts: 0, hits: 0 };
            cur.exts += 1;
            cur.hits += hits!.length;
            perFamily.set(f, cur);
            total += hits!.length;
        }
        if (total) worst.push({ id, hits: total });
    }

        console.log(`\nscanned ${Object.keys(byExt).length} extension dirs`);
        if (perModelRun.size > 1) console.log("  note: multiple model runs present — the export's model determines which applies; pass --group <substr> to scan a single one");
    for (const rule of MV2_API_RULES) {
        const cur = perFamily.get(rule.family);
        console.log(`  ${rule.family.padEnd(15)} ${cur ? `${cur.hits} hits in ${cur.exts} extensions` : "clean"}`);
    }
    worst.sort((a, b) => b.hits - a.hits);
    if (worst.length) {
        console.log(`\nmost residual MV2 API forms:`);
        for (const w of worst.slice(0, 10)) console.log(`  ${w.id.padEnd(40)} ${w.hits}`);
    }

        writeFileSync(outPath, JSON.stringify(byExt, null, 1));
        console.log(`\nwrote ${outPath}`);
    } finally {
        if (remote) rmSync(localRoot, { recursive: true, force: true });
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
