# AgenticTester

A multi-agent Chrome extension migration tool built on the [OpenHands SDK](https://github.com/All-Hands-AI/OpenHands). Pass it an unpacked Chrome extension directory and it migrates the extension from Manifest V2 to Manifest V3, with the work performed inside an isolated Docker workspace by a team of specialized subagents.

---

## How It Works

```
main.py <extension-path>
  └── MigrationManager (singleton)
        ├── Configures LLM from env vars
        ├── Spins up Docker workspace (OpenHands agent server)
        │     ├── VSCode Server  (host_port + 1)
        │     └── VNC Server     (host_port + 2)
        ├── Pre-pass: extension-manifest-converter (host) → partially-migrated extension
        ├── Static analysis (api_mappings.json) → writes analysis.json (the migration plan)
        ├── Assembles workspace (src/skills/ + analysis.json) → uploads to /workspace/
        ├── Uploads converted extension into /workspace/extension/
        ├── Installs verify-skill deps (playwright, websocket-client)
        ├── Creates a Conversation with MigratorAgent (+ verify skill, no browser tool)
        └── Sends prompt → runs conversation loop
              │
              ▼
        MigratorAgent (orchestrator)
              ├── Delegates to → extension-transformer
              │     Reads /workspace/analysis.json + every source file
              │     Applies all MV2→MV3 changes, writes migrated extension to /workspace/out/
              │
              └── Delegates to → extension-tester
                    Runs the `verify` skill (Playwright loads the extension in Chromium)
                    Captures runtime errors → /workspace/test_report.json
              │
              ▼
        MigrationManager runs the verify skill; on failure, feeds errors back
        to the agent to fix (up to 3 attempts), then downloads
        /workspace/out/ + analysis.json + test_report.json → local output/
```

### Step-by-step flow

1. **Setup** — `MigrationManager` reads LLM config from `.env`, initializes the LLM client, and starts a Docker container running the OpenHands agent server.

2. **Converter pre-pass** — On the host, the extension is run through GoogleChromeLabs' [extension-manifest-converter](https://github.com/GoogleChromeLabs/extension-manifest-converter) (vendored as a git submodule under `third_party/`, invoked by `src/utils/manifest_converter.py`). This applies the deterministic MV2→MV3 changes — `manifest_version`, `host_permissions`, background→service worker, browser/page action→action, `executeScript`/`insertCSS`→`scripting`, CSP, WAR — into a temp copy. The original is left untouched (kept for the diff); if the submodule is missing or the converter fails, the original is passed through unchanged.

3. **Static analysis** — `StaticAnalyzer` scans the *converted* extension against `api_mappings.json` and `build_analysis()` writes the migration plan (`analysis.json`) of the deprecated call sites that **remain** — there is **no LLM analyzer agent**. Anything static analysis can't see is handled by the transformer (using the `mv3-migration` skill) and caught at runtime by `verify`.

4. **Workspace prep** — There is no checked-in `src/workspace/`; the container workspace is **assembled at runtime** in a temp staging dir from the skills in `src/skills/` (copied to `.openhands/skills/`) and the generated `analysis.json`, then uploaded to `/workspace/`. The **converted** extension is uploaded to `/workspace/extension/`. An `out/` directory is pre-created for agent output.

5. **Verify provisioning** — The `verify` skill's Python deps (`playwright`, `websocket-client`) are installed in the container. It uses the Chromium that ships in the agent-server image (launched via Playwright), so no browser is downloaded. The browser version is fixed by the agent-server image tag (pin the tag, or build a custom image with `DockerDevWorkspace`, to control it). Chrome for Testing is intentionally **not** used: it has no native ARM64 Linux build and its amd64 build crashes under emulation on Apple Silicon.

6. **Orchestration** — A `Conversation` is started with `MigratorAgent`, which has access to `terminal`, `file_editor`, and `task` (sub-agent delegation) tools — **no browser tool**, so the agent cannot drive a browser directly; testing happens only through the `verify` skill. The MV2→MV3 migration knowledge (manifest fields, service-worker constraints, API replacements) lives in the `mv3-migration` skill rather than the system prompt, so it's pulled on demand. The initial prompt from `PromptGenerator` is sent, kicking off the workflow:
   - Delegate migration to `extension-transformer` (applies the pre-generated `analysis.json` plus all other MV2→MV3 changes)
   - Verify `/workspace/out/manifest.json` exists with `manifest_version: 3`
   - Delegate testing to `extension-tester`

7. **Subagents** — Each subagent is defined by a markdown file in `src/agents/subagents/` with frontmatter declaring its name, tools, and model. They run with the same LLM as the orchestrator (`model: inherit`).

8. **Test → fix loop** — After output is produced, the manager runs the `verify` skill (Playwright loads the migrated extension into Chromium, captures service-worker/console/page errors). If it fails, the captured errors are sent back to the agent to fix, then verification re-runs — up to 3 attempts. This is what catches anything the static plan missed.

9. **Nudging** — If the agent finishes without producing output files, the manager re-sends the task (up to 3 nudges) with explicit instructions to use tool calls rather than plain text.

10. **Output** — Once complete, `output/` on the host contains the migrated extension (`extension/`), the migration plan (`analysis.json`), the diff (`migration.patch`), and the runtime report (`test_report.json`). Activity logs are written to `agent_logs/`.

---

## Project Structure

```
.
├── main.py                         # Entrypoint
├── src/
│   ├── manager.py                  # MigrationManager — thin orchestrator of the migrate() flow
│   ├── agents/
│   │   ├── migrator.py             # MigratorAgent — orchestrator with task (delegation) tool
│   │   └── subagents/
│   │       ├── extension-transformer.md # Applies the migration, writes migrated files to out/
│   │       └── extension-tester.md      # Runs the verify skill, reports errors
│   ├── skills/                     # Skills, assembled into /workspace/.openhands/skills at runtime
│   │   ├── verify/                 # `verify` skill: Playwright extension test + exerciser
│   │   │   ├── SKILL.md
│   │   │   └── scripts/            # verify.py, browser_session.py, exerciser.py, …
│   │   └── mv3-migration/          # `mv3-migration` skill: MV2→MV3 knowledge (on demand)
│   │       └── SKILL.md
│   ├── utils/
│   │   ├── banner.py               # Startup banner
│   │   ├── docker.py               # Docker workspace factory
│   │   ├── llm_factory.py          # Builds the LLM from env vars
│   │   ├── manifest_converter.py   # Host-side extension-manifest-converter pre-pass
│   │   ├── static_analyzer.py      # Scans source for deprecated APIs + builds analysis.json
│   │   ├── prompt_generator.py     # Initial task prompt
│   │   ├── workspace_io.py         # Assemble / upload / download the container workspace
│   │   ├── conversation_loops.py   # Activity logger + nudge loop + verify→fix loop
│   │   ├── artifacts.py            # Download outputs + build migration.patch
│   │   └── test_harness.py         # Installs verify deps + runs the verify skill
├── third_party/
│   └── extension-manifest-converter/   # git submodule — GoogleChromeLabs MV2→MV3 converter
├── output/                         # Downloaded agent output (created at runtime)
│   ├── extension/                  #   the migrated extension
│   ├── analysis.json               #   migration plan (static analysis)
│   ├── migration.patch             #   unified diff (original → migrated)
│   └── test_report.json            #   runtime verification report
├── agent_logs/                     # Per-agent activity logs (created at runtime)
├── pyproject.toml
├── flake.nix
└── uv.lock
```

---

## Configuration

Copy `.env.example` to `.env` and fill in the values:

| Variable | Description |
|---|---|
| `LLM_MODEL` | Model identifier (e.g. `claude-sonnet-4-6`, `ollama/llama3`) |
| `LLM_API_KEY` | API key (not required for Ollama) |
| `LLM_BASE_URL` | Base URL (required for Ollama, e.g. `http://localhost:11434`) |
| `LLM_INPUT_COST_PER_TOKEN` | Optional — for cost tracking |
| `LLM_OUTPUT_COST_PER_TOKEN` | Optional — for cost tracking |
| `LLM_NUM_CTX` | Ollama only — context window size (default: 32768) |
| `LLM_KEEP_ALIVE` | Ollama only — keep-alive duration (default: `30m`) |

### Supported providers

- **Anthropic / OpenAI / any litellm-compatible API** — set `LLM_MODEL` and `LLM_API_KEY`
- **Ollama (local)** — prefix model with `ollama/`, set `LLM_BASE_URL`, no API key needed

---

## Running

First fetch the vendored converter submodule (once, after cloning):

```bash
git submodule update --init --recursive
```

Then run:

```bash
uv run python main.py /path/to/my-extension
```

Docker must be running. The agent server image is pulled automatically on first run:
- `ghcr.io/openhands/agent-server:latest-python` (or a SHA-pinned version in CI)

Once started, two URLs are printed:
- **VSCode Server** — browse the workspace filesystem live
- **VNC Server** — desktop view (`http://localhost:<port>/vnc.html?autoconnect=1`). Note: the `verify` skill runs Chromium with `--headless=new`, so the test browser does not appear here.

Output files are written to `output/` when the run completes.

---

## Adding or Modifying Tasks

**Change what the agent does** — edit `src/utils/prompt_generator.py`.

**Add a new subagent** — create a markdown file in `src/agents/subagents/` with this frontmatter:

```markdown
---
name: my-agent
description: >-
  One line the orchestrator uses to decide when to delegate here.
tools:
  - terminal
  - file_editor
model: inherit
max_iteration_per_run: 20
---

Agent system prompt here...
```

The orchestrator picks up subagents automatically at startup via `load_agents_from_dir`.
