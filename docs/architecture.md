# Architecture

A run takes an unpacked MV2 extension, applies an automated converter on the host, then
hands the result to an LLM agent running in a Docker container to finish the migration and
check that it works.

The same per-extension flow backs both the single-extension `migrate` command and the
bulk `batch` runner; `batch` just calls it for many extensions in parallel (see
[running](running.md)).

```
agentictester migrate <extension-path>
  └── run_migration(config, llm) -> MigrationResult
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
              ├── Delegates to extension-tester
              │     Runs the verify skill; errors go to /workspace/test_report.json
              └── Delegates to extension-critic  (refinement; --no-refine to skip)
                    Scores the migration; the critique goes to /workspace/critique.json
              │
              ▼
        run_migration runs verify; on failure it feeds the errors back (up to 3 times).
        Once it verifies, run_migration runs the refinement loop (critique → improve →
        re-score until the threshold or iteration budget; --no-refine skips), re-verifies. It
        then captures metrics + the conversation trace and downloads /workspace/out/,
        analysis.json, and test_report.json to the run's output directory
```

## Run flow

1. Setup. The CLI (`src/cli.py`) reads the LLM config from `.env` and builds the LLM
   client; `run_migration` (`src/manager.py`) starts a Docker container running the
   OpenHands agent server. `run_migration` never raises — any failure is returned as a
   `MigrationResult` with `status="error"`, so a bulk run is never aborted by one bad
   extension.

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

10. Iterative refinement (on by default; `--no-refine` to skip). Verification only proves
    the extension works, not that the migration is good. When refinement is enabled and
    verification passed, `run_refine_loop` (`src/utils/conversation_loops.py`) delegates to
    `extension-critic`, which scores the migration 0–100 across correctness, completeness,
    code quality, and MV3 best practices and writes `critique.json`. If the average is below
    the threshold, the critique is fed back to `extension-transformer`, and the migration is
    re-scored — up to the iteration budget. The output is re-verified afterwards, so a
    refinement that breaks correctness is reported honestly rather than hidden. The final
    score and pass count land in the `MigrationResult`. This is the OpenHands
    [iterative-refinement](https://docs.openhands.dev/sdk/guides/iterative-refinement)
    pattern (a separate critic scoring the worker's output in a loop), gated behind the
    objective verification step.

11. Metrics and trace capture. Before the conversation is closed, `run_migration` reads
    `conversation.conversation_stats` (cost and token usage, per `usage_id`) and serializes
    the event stream. These go into the result and into `conversation/metrics.json` +
    `conversation/events.jsonl`. The remote conversation cannot use the SDK's on-disk
    `persistence_dir`, so the trace is pulled client-side (`src/utils/persistence.py`).

12. Output. When the run finishes, the output directory holds the migrated extension
    (`extension/`), the plan (`analysis.json`), a unified diff against the original
    (`migration.patch`), the verification report (`test_report.json`), the quality critique
    (`critique.json`, when refinement ran), per-agent logs (`agent_log/`), and the metrics +
    trace (`conversation/`). `run_migration` returns a `MigrationResult` summarizing all of
    this.

## Bulk runs

`src/batch.py` calls `run_migration` for many extensions through a
`ThreadPoolExecutor(max_workers=N)`. A queue of worker slots hands each task a disjoint
Docker port block (`port_base + slot*10`) so the VSCode/VNC sidecar ports never collide,
and results stream to `results.jsonl` as they finish so a run is resumable (`--resume`
skips extensions already recorded). Each migration builds a fresh LLM so per-extension
cost/token metrics stay isolated. When the run drains, `summary.csv` and `aggregate.json`
are written for evaluation.

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
