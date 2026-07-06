// Build the migration prompt. Port of src/utils/prompt_generator.py, adapted for pi's
// single-session model: pi edits files directly with its read/edit/write tools, so there is
// no orchestrator/subagent split — the agent IS the transformer. The mv3-migration skill is
// inlined (short) so a weak local model reliably sees the reference.
import type { Finding, Signal } from "../host/staticAnalyzer.js";
import { CATEGORIES } from "../host/staticAnalyzer.js";

const MAX_SITES = 12;

export function buildPrompt(opts: {
  findings: Finding[];
  signals: Signal[];
  skillMd: string;
  extDir: string;
  outDir: string;
}): string {
  const { findings, signals, skillMd, extDir, outDir } = opts;
  return `# Chrome Extension Migration Task

Migrate the Chrome extension at \`${extDir}\` from Manifest V2 to Manifest V3 and write the
COMPLETE migrated extension to \`${outDir}\`. It must load and run in Chrome with no errors.

The extension has already been run through an automated converter, so the manifest is likely
already MV3 and simple API swaps are done. Finish what the converter cannot: service-worker
code that used the DOM/window, blocking webRequest, and anything subtle. Then make it run.

## How to work
Every original file has ALREADY been copied to \`${outDir}\` for you. Edit the files IN
\`${outDir}\` — do not recreate the ones that don't change.
1. \`ls\` \`${outDir}\` and read the files that matter (manifest.json, background/service worker, any file in the findings below).
2. Edit \`${outDir}/manifest.json\` and the flagged source files to complete the MV3 migration.
3. Create new files where required (e.g. \`${outDir}/rules.json\` for declarativeNetRequest).
4. Apply the deprecated-API replacements below and every other MV2->MV3 change (see reference).
5. Confirm \`${outDir}/manifest.json\` has "manifest_version": 3.

${formatFindings(findings)}
${formatSignals(signals)}
## MV3 Migration Reference (mv3-migration skill)

${skillMd}

## Response style
Terse. Technical. Do the file edits with your tools; don't narrate at length. Code unchanged.`;
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
      lines.push(`- Line ${h.line}: \`${h.api}\` -> \`${h.replacement}\`  \n  \`${h.snippet}\``);
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
      lines.push(`- \`${where}\`  \n  \`${h.snippet}\``);
    }
    if (hits.length > MAX_SITES) lines.push(`- …and ${hits.length - MAX_SITES} more`);
    lines.push("");
  }
  return lines.join("\n");
}
