# Chrome Extension Migration Task

Your task is to migrate the Chrome extension at `/workspace/extension/` from Manifest V2
to Manifest V3. The migrated extension must be written to `/workspace/out/`.

## Your Role: Orchestrator

Delegate work to the specialized subagents available to you:

1. **extension-analyzer** - Reads the extension source and produces a structured migration plan
2. **extension-transformer** - Applies the migration changes and writes the output files

## Workflow

### Step 1: Delegate Analysis to extension-analyzer

Delegate the following task to `extension-analyzer`:

```
Inspect the Chrome extension at /workspace/extension/.
Identify every change required to migrate it from Manifest V2 to Manifest V3, including:
- manifest.json field changes (manifest_version, background, action, host_permissions, etc.)
- API replacements (chrome.browserAction → chrome.action, background pages → service workers, etc.)
- Content Security Policy updates
- Any deprecated APIs or patterns

Save the full analysis to /workspace/analysis.json with this structure:
{
  "extension_name": "...",
  "current_manifest_version": 2,
  "files": [
    {
      "path": "relative/path/to/file",
      "changes": [
        { "type": "manifest_field | api_replacement | csp | other", "description": "...", "before": "...", "after": "..." }
      ]
    }
  ],
  "summary": "Brief description of scope of changes"
}
```

### Step 2: Verify Analysis

Verify `/workspace/analysis.json` exists and has a non-empty `files` array.

### Step 3: Delegate Migration to extension-transformer

Delegate the following task to `extension-transformer`:

```
Read the migration plan at /workspace/analysis.json.
Read every source file from /workspace/extension/.
Apply all described changes and write the fully migrated extension to /workspace/out/.

The output must be a complete, self-contained extension — every file from the original must
be present (modified or unchanged). Do not omit any file.

After writing all files verify:
- /workspace/out/manifest.json exists and has "manifest_version": 3
- Every file listed in /workspace/analysis.json exists under /workspace/out/
```

### Step 4: Verify Final Output

Verify `/workspace/out/manifest.json` exists and `/workspace/out/` has the same number
of files as `/workspace/extension/`.

## Important Notes

- Use the `delegate` tool to assign tasks to subagents
- Wait for each subagent to complete before moving on
- If a subagent fails, re-delegate with clearer instructions
- Final output is the complete migrated extension in `/workspace/out/`
