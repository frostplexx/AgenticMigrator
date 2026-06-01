# Architecture

A run takes an unpacked MV2 extension, applies an automated converter on the host, then
hands the result to an LLM agent running in a Docker container to finish the migration and
check that it works.

```
main.py <extension-path>
  └── MigrationManager (singleton)
        ├── Builds the LLM from env vars
        ├── Starts a Docker workspace (OpenHands agent server)
        │     ├── VSCode Server  (host_port + 1)
        │     └── VNC Server     (host_port + 2)
        ├── Pre-pass: extension-manifest-converter (host) → partially migrated extension
        ├── Static analysis (api_mappings.json) → writes analysis.json
        ├── Assembles /workspace from src/skills/ + analysis.json, uploads it
        ├── Uploads the converted extension to /workspace/extension/
        ├── Installs the verify skill deps (playwright, websocket-client)
        └── Starts a Conversation with MigratorAgent, sends the prompt
              │
              ▼
        MigratorAgent (orchestrator)
              ├── Delegates to extension-transformer
              │     Reads /workspace/analysis.json and the source files,
              │     writes the migrated extension to /workspace/out/
              └── Delegates to extension-tester
                    Runs the verify skill; errors go to /workspace/test_report.json
              │
              ▼
        Manager runs verify; on failure it feeds the errors back (up to 3 times),
        then downloads /workspace/out/, analysis.json, and test_report.json to output/
```

## Run flow

1. Setup. `MigrationManager` reads the LLM config from `.env`, builds the LLM client, and
   starts a Docker container running the OpenHands agent server.

2. Converter pre-pass. The extension is run through GoogleChromeLabs'
   [extension-manifest-converter](https://github.com/GoogleChromeLabs/extension-manifest-converter)
   (vendored as a submodule under `third_party/`, called from `src/utils/manifest_converter.py`).
   It applies the mechanical MV2→MV3 changes: `manifest_version`, `host_permissions`,
   background to service worker, browser/page action to action, `executeScript`/`insertCSS`
   to `scripting`, the content security policy, and web-accessible resources. It works on a
   temp copy and leaves the original alone. If the submodule is missing or the converter
   errors out, the original extension is used unchanged.

3. Static analysis. `StaticAnalyzer` scans the converted extension against
   `api_mappings.json` and writes `analysis.json`, listing the deprecated call sites that
   are still present. There is no LLM analysis step. Whatever static analysis misses is
   left to the transformer and caught later by verification.

4. Workspace prep. There is no checked-in `src/workspace/`. The container's `/workspace`
   is built at runtime in a temp directory from the skills in `src/skills/` (copied to
   `.openhands/skills/`) plus `analysis.json`, then uploaded. The converted extension goes
   to `/workspace/extension/`, and an empty `out/` is created for the result.

5. Verify provisioning. The verify skill's Python dependencies (`playwright`,
   `websocket-client`) are installed in the container. Verification uses the Chromium that
   ships in the agent-server image, launched through Playwright, so no browser download is
   needed. The browser version is whatever the image ships; pin the image tag (or build a
   custom image) to control it. Chrome for Testing is deliberately avoided: it has no ARM64
   Linux build, and the amd64 build crashes under emulation on Apple Silicon.

6. Orchestration. A conversation starts with `MigratorAgent`. It has the `terminal`,
   `file_editor`, and `task` (delegation) tools, and no browser tool, so it cannot drive a
   browser directly; testing only happens through the verify skill. The MV2→MV3 reference
   lives in the `mv3-migration` skill rather than the system prompt, so the agent pulls it
   on demand. The opening prompt comes from `PromptGenerator` and lays out the steps:
   delegate the migration to `extension-transformer`, confirm `/workspace/out/manifest.json`
   has `manifest_version: 3`, then delegate testing to `extension-tester`.

7. Subagents. Each subagent is a markdown file in `src/agents/subagents/` whose frontmatter
   sets its name, tools, and model. They run on the same LLM as the orchestrator
   (`model: inherit`).

8. Test and fix loop. Once output exists, the manager runs the verify skill: Playwright
   loads the migrated extension in Chromium and records service-worker, console, and page
   errors. On failure the errors go back to the agent, which fixes the files, and
   verification runs again, up to three times.

9. Nudging. If the agent stops without writing any output, the manager re-sends the task
   (up to three times) with explicit instructions to use real tool calls instead of
   describing the work in text.

10. Output. When the run finishes, `output/` holds the migrated extension (`extension/`),
    the plan (`analysis.json`), a unified diff against the original (`migration.patch`), and
    the verification report (`test_report.json`). Per-agent logs go to `agent_logs/`.

## Design notes

- Static analysis replaces an LLM analyzer agent. It is faster, deterministic, and cheaper
  for the call-site replacements it can find.
- The agent has no browser tool. The only way it can test the extension is the verify
  skill, which keeps verification reproducible and stops the agent from "passing" a test it
  never ran.
- The verify skill also checks API coverage: a `chrome.*` namespace that was used in the
  original but is gone from the output, with no MV3 replacement present (in JS or the
  manifest), is reported as an error. This catches the case where functionality is deleted
  to make verification pass.
