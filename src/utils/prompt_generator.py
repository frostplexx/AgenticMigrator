from collections import defaultdict


class PromptGenerator:
    prompt: str

    def __init__(self, findings: list[dict]):
        self.prompt = f"""
# Chrome Extension Migration Task

Your task is to migrate the Chrome extension located at `/workspace/extension/` from
Manifest V2 to Manifest V3. The migrated extension must be written to `/workspace/out/`,
and it must load and run without errors in Chrome.

## Your Role: Orchestrator

You are the main coordinator. Delegate work to the specialized subagents available to you:

1. **extension-transformer** - Applies the migration and writes the output files

(Verification and quality scoring are run by the harness, not by you — do not call them.)

The extension at `/workspace/extension/` has ALREADY been run through an automated
converter (extension-manifest-converter), so the manifest is likely already MV3 and the
simple search-and-replace API swaps are done. Your job is to finish what the converter
cannot do automatically (e.g. service-worker code that used the DOM/`window`, blocking
`webRequest`, anything subtle) and make it actually run.

A static migration plan has already been produced for you at `/workspace/analysis.json`
(no analysis step is needed). It lists the deprecated API call sites that REMAIN and their
MV3 replacements. It does not cover everything — remaining manifest issues and anything
static analysis cannot see must still be applied using the `mv3-migration` skill (the
MV2->MV3 reference), and will be caught at runtime by the harness's verification step.

{_format_findings(findings)}

## Workflow

### Step 1: Delegate Migration to extension-transformer

Delegate the following task to the `extension-transformer` agent:

```
First read the mv3-migration skill (cat /workspace/.openhands/skills/mv3-migration/SKILL.md)
for the correct MV3 form of each manifest field and API. Then read the static migration plan
at /workspace/analysis.json and every source file from /workspace/extension/. Apply the
listed API replacements AND every other MV2->MV3 change required (manifest_version,
background -> service_worker, browser_action/page_action -> action, host_permissions, CSP,
web_accessible_resources, etc.), writing the fully migrated extension to /workspace/out/.

The output must be a complete, self-contained extension directory — every file from the
original must be present (modified or unchanged). Do not omit any file.

After writing all files, confirm /workspace/out/manifest.json exists with
"manifest_version": 3 and that /workspace/out/ has the same files as /workspace/extension/.
```

### Step 2: Verify Final Output

After extension-transformer finishes, verify:
- `/workspace/out/manifest.json` exists
- `/workspace/out/` contains the same number of files as `/workspace/extension/`

### Step 3: Finish — verification is automatic

Do NOT run the `verify` skill yourself. The harness runs verification automatically once
you finish, with a proper timeout. Running the verify script from the `terminal` tool
yourself launches Chromium and will hit the tool's soft timeout — wasting time and tokens —
so leave it to the harness.

Once `/workspace/out/` holds the complete migrated extension, stop. The harness loads it in
Chromium and, if anything fails to load or errors at runtime, sends you the exact error
messages (including extension load errors such as an invalid `rules.json`). Only then do you
delegate the specific fixes back to `extension-transformer`.

## Important Notes

- Use the `task` tool to delegate the migration (and any fixes) to subagents
- Do not test the extension yourself — the harness owns verification
- Wait for each subagent to complete before proceeding to the next step
- If a subagent fails, re-delegate with clearer or more specific instructions
- Your final output is the complete migrated extension in `/workspace/out/`

## Response Pattern

Terse like caveman. Technical substance exact. Only fluff die.
Drop: articles, filler (just/really/basically), pleasantries, hedging.
Fragments OK. Short synonyms. Code unchanged.
Pattern: [thing] [action] [reason]. [next step].
ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift.
Code/commits/PRs: normal. Off: "stop caveman" / "normal mode".

        """


def _format_findings(findings: list[dict]) -> str:
    if not findings:
        return "## Static Analysis\n\nNo deprecated API usages found in the extension source.\n"

    by_file: dict[str, list[dict]] = defaultdict(list)
    for f in findings:
        by_file[f["file"]].append(f)

    lines = ["## Static Analysis: Deprecated APIs Found\n"]
    lines.append(
        "The following deprecated APIs were detected by static analysis. "
        "These are the ground truth for which lines need changing.\n"
    )

    for filepath in sorted(by_file):
        lines.append(f"### {filepath}")
        for hit in sorted(by_file[filepath], key=lambda h: h["line"]):
            lines.append(
                f"- Line {hit['line']}: `{hit['api']}` → `{hit['replacement']}`"
                f"  \n  `{hit['snippet']}`"
            )
        lines.append("")

    return "\n".join(lines)
