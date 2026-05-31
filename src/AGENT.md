# Chrome Extension Migration Task

Your task is to migrate the Chrome extension at `/workspace/extension/` from Manifest V2
to Manifest V3. The migrated extension must be written to `/workspace/out/`.

## Your Role: Orchestrator

Delegate work to the specialized subagents available to you:

1. **extension-transformer** - Applies the migration and writes the output files
2. **extension-tester** - Loads the migrated extension in Chromium and reports runtime errors

A static migration plan is already at `/workspace/analysis.json` (no analysis step needed).
It lists known deprecated API call sites and their MV3 replacements, but is not exhaustive —
manifest changes and anything else must still be applied, and `verify` catches what it missed.

## Workflow

### Step 1: Delegate Migration to extension-transformer

Delegate the following task to `extension-transformer`:

```
Read the static migration plan at /workspace/analysis.json and read every source file from
/workspace/extension/. Apply the listed API replacements AND every other MV2->MV3 change
(manifest_version, background -> service_worker, browser_action/page_action -> action,
host_permissions, CSP, web_accessible_resources, etc.), writing the fully migrated
extension to /workspace/out/.

The output must be a complete, self-contained extension — every file from the original must
be present (modified or unchanged). Do not omit any file.

After writing all files verify /workspace/out/manifest.json exists with
"manifest_version": 3 and /workspace/out/ has the same files as /workspace/extension/.
```

### Step 2: Verify Final Output

Verify `/workspace/out/manifest.json` exists and `/workspace/out/` has the same number
of files as `/workspace/extension/`.

### Step 3: Verify the Migrated Extension

Delegate to `extension-tester` (or use the `verify` skill directly). You have no browser
tool — the `verify` skill is the only way to test:

```
python /workspace/.openhands/skills/verify/scripts/verify.py /workspace/out /workspace/test_report.json
```

It loads the migrated extension into Chromium and writes `/workspace/test_report.json`
(`loaded`, `errors`, `warnings`). It exits non-zero on failure.

If errors are reported, delegate back to `extension-transformer` with the exact error
messages to fix the files in `/workspace/out/`, then verify again. Do not finish while
`loaded` is false or `errors` is non-empty.

## Important Notes

- Use the `task` tool to delegate work to subagents
- Wait for each subagent to complete before moving on
- If a subagent fails, re-delegate with clearer instructions
- Final output is the complete migrated extension in `/workspace/out/`, and it must pass
  verification (exit code 0)
