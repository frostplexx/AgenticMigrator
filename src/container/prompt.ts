// Build the migration prompt. Port of src/utils/prompt_generator.py, adapted for pi's
// single-session model: pi edits files directly with its read/edit/write tools, so there is
// no orchestrator/subagent split — the agent IS the transformer. The mv3-migration skill is
// inlined (short) so a weak local model reliably sees the reference.
import type { Finding, Signal } from "../host/staticAnalyzer.js";
import { CATEGORIES } from "../host/staticAnalyzer.js";

const MAX_SITES = 12;
const SNIPPET_MAX = 200;
/** Defensive snippet cap: keeps one long/minified line from bloating the prompt ~10x. */
const clip = (s: string): string => (s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX) + " …" : s);

export function buildPrompt(opts: {
    findings: Finding[];
    signals: Signal[];
    skillMd: string;
    extDir: string;
    outDir: string;
    /** Files that need migration changes (from static analysis) */
    relevantFiles?: string[];
}): string {
    const { findings, signals, skillMd, extDir, outDir } = opts;

    // Files referenced in findings that need migration attention
    const relevantFiles = opts.relevantFiles ?? [];
    if (!relevantFiles.length) {
        const seen = new Set<string>();
        for (const f of findings) if (!seen.has(f.file)) { seen.add(f.file); relevantFiles.push(f.file); }
        relevantFiles.sort();
    }

    const howToWork = `## How to work
Every original file has ALREADY been copied to \`${outDir}\`. You have two ways to change files
and should pick based on the SIZE of the work:

- **Edit directly** with your \`edit\`/\`write\` tools for small, localized changes — a manifest
  tweak, a one-line API swap, a single short file.
- **Delegate to \`extension_transformer\`** for bigger work — a substantial file rewrite (e.g. a
  service worker that used the DOM/window, or blocking \`webRequest\` → \`declarativeNetRequest\`),
  or when several independent files need changes. Pass a \`tasks\` array with one entry PER FILE;
  the sub-agents run IN PARALLEL. Give each task its own \`files\` list and a precise \`task\`.
  Two tasks must NEVER list the same file. **Prefer this whenever the work is large or spans
  multiple files** — it is faster and keeps each change focused.
  IMPORTANT: put ALL independent files that need delegating into ONE \`extension_transformer\`
  call (one \`tasks\` entry each) so they run at the same time — do NOT make a separate call per
  file, which would run them one after another and waste the parallelism.

Steps:
1. \`ls\` \`${outDir}\` and read manifest.json plus the flagged files below.
2. Make the MV3 changes: edit small stuff yourself; delegate big rewrites / multiple files to
   \`extension_transformer\` as a parallel batch. Apply the deprecated-API replacements below and
   every other MV2->MV3 change (manifest_version, service_worker, action, host_permissions,
   declarativeNetRequest — see reference).
3. Create new files where required (e.g. \`${outDir}/rules.json\` for declarativeNetRequest).
4. Confirm \`${outDir}/manifest.json\` has "manifest_version": 3.

## Critical: Do NOT touch data files

Some extensions bundle large data files (dictionaries, translation tables, databases in HTML/JSON/CSV
format). These are NOT code and do NOT need MV3 migration. Do NOT read or edit them. They will be
automatically preserved from the original extension after you finish.

The only files that matter for migration are:
- \`${outDir}/manifest.json\`
- ${relevantFiles.length ? relevantFiles.map((f) => `\`${outDir}/${f}\``).join("\n- ") : "the JS/HTML files listed in the findings below"}`;

    return `# Chrome Extension Migration Task

Migrate the Chrome extension at \`${extDir}\` from Manifest V2 to Manifest V3 and write the
COMPLETE migrated extension to \`${outDir}\`. It must load and run in Chrome with no errors.

The extension has already been run through an automated converter, so the manifest is likely
already MV3 and simple API swaps are done. Finish what the converter cannot: service-worker
code that used the DOM/window, blocking webRequest, and anything subtle. Then make it run.

${howToWork}

## Do NOT verify — the harness does that
Do NOT run any verification, test, or browser script yourself (no verify.py, no Playwright, no
launching Chrome). After the edits are applied, STOP. The harness automatically loads the
migrated extension in Chrome and, if it fails, will send you the concrete runtime errors to fix.

${formatFindings(findings)}
${formatSignals(signals)}
## MV3 Migration Reference (mv3-migration skill)

${skillMd}

## Response style
Terse. Technical. Edit small things yourself; delegate big/multi-file work to a parallel
\`extension_transformer\` batch. Don't narrate at length. Code unchanged.`;
}

function formatFindings(findings: Finding[]): string {
    if (!findings.length) return "## Static Analysis\n\nNo deprecated API usages found.\n";
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) {
        if (!byFile.has(f.file)) byFile.set(f.file, []);
        byFile.get(f.file)!.push(f);
    }
    const lines = [
        "## Static Analysis: Deprecated APIs Found",
        "",
        "Ground truth for which lines need changing.",
        "",
    ];
    for (const file of [...byFile.keys()].sort()) {
        lines.push(`### ${file}`);
        for (const h of byFile.get(file)!.sort((a, b) => a.line - b.line))
            lines.push(`- Line ${h.line}: \`${h.api}\` -> \`${h.replacement}\`  \n  \`${clip(h.snippet)}\``);
        lines.push("");
    }
    return lines.join("\n");
}

function formatSignals(signals: Signal[]): string {
    if (!signals.length) return "";
    const grouped = new Map<string, Signal[]>();
    for (const s of signals) {
        if (!grouped.has(s.category)) grouped.set(s.category, []);
        grouped.get(s.category)!.push(s);
    }
    const cats = [...grouped.keys()].sort((a, b) => CATEGORIES[a].order - CATEGORIES[b].order);
    const lines = [
        "## Migration Signals: Non-Mechanical Work Detected",
        "",
        "These need a real rewrite — the converter cannot fix them and they fail at load/runtime if ignored.",
        "",
    ];
    for (const cat of cats) {
        const meta = CATEGORIES[cat];
        const hits = grouped.get(cat)!;
        lines.push(`### ${meta.title}  (skill: \`${meta.skill}\`)`, meta.hint, "");
        for (const h of hits.slice(0, MAX_SITES)) {
            const where = h.line === 0 ? h.file : `${h.file}:${h.line}`;
            lines.push(`- \`${where}\`  \n  \`${clip(h.snippet)}\``);
        }
        if (hits.length > MAX_SITES) lines.push(`- …and ${hits.length - MAX_SITES} more`);
        lines.push("");
    }
    return lines.join("\n");
}
