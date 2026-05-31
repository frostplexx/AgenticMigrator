class PromptGenerator:
    prompt: str
    def __init__(self):

        self.prompt = """
# Chrome Extension Migration Task

Your task is to migrate the Chrome extension located at `/workspace/extension/` from
Manifest V2 to Manifest V3. The migrated extension must be written to `/workspace/out/`.

## Your Role: Orchestrator

You are the main coordinator. Delegate work to the specialized subagents available to you:

1. **extension-analyzer** - Reads the extension source and produces a structured migration plan
2. **extension-transformer** - Applies the migration changes and writes the output files

## Workflow

### Step 1: Delegate Analysis to extension-analyzer

Delegate the following task to the `extension-analyzer` agent:

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

After extension-analyzer finishes, verify `/workspace/analysis.json` exists and contains
a `files` array with at least one entry.

### Step 3: Delegate Migration to extension-transformer

Delegate the following task to the `extension-transformer` agent:

```
Read the migration plan at /workspace/analysis.json.
Read every source file from /workspace/extension/.
Apply all described changes and write the fully migrated extension to /workspace/out/.

The output must be a complete, self-contained extension directory — every file from the
original must be present (modified or unchanged). Do not omit any file.

After writing all files, run a final check:
- /workspace/out/manifest.json must exist and have "manifest_version": 3
- Every file listed in /workspace/analysis.json must exist under /workspace/out/
```

### Step 4: Verify Final Output

After extension-transformer finishes, verify:
- `/workspace/out/manifest.json` exists
- `/workspace/out/` contains the same number of files as `/workspace/extension/`

## Important Notes

- Use the `delegate` tool to assign tasks to subagents
- Wait for each subagent to complete before proceeding to the next step
- If a subagent fails, re-delegate with clearer or more specific instructions
- Your final output is the complete migrated extension in `/workspace/out/`
        """;
