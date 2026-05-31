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
        ├── Uploads src/workspace/ (AGENT.md, harness/) into /workspace/
        ├── Uploads <extension-path>/ into /workspace/extension/
        ├── Detects bundled Chromium + installs harness deps (npm)
        ├── Creates a Conversation with MigratorAgent
        └── Sends prompt → runs conversation loop
              │
              ▼
        MigratorAgent (orchestrator)
              ├── Delegates to → extension-analyzer
              │     Reads /workspace/extension/, identifies all MV2→MV3 changes
              │     Saves structured plan to /workspace/analysis.json
              │
              ├── Delegates to → extension-transformer
              │     Reads analysis.json + every source file
              │     Applies all changes, writes migrated extension to /workspace/out/
              │
              └── Delegates to → extension-tester
                    Loads /workspace/out/ in Chromium
                    Captures runtime errors → /workspace/test_report.json
              │
              ▼
        MigrationManager runs the smoke test; on failure, feeds errors back
        to the agent to fix (up to 3 attempts), then downloads
        /workspace/out/ + analysis.json + test_report.json → local output/
```

### Step-by-step flow

1. **Setup** — `MigrationManager` reads LLM config from `.env`, initializes the LLM client, and starts a Docker container running the OpenHands agent server.

2. **Workspace prep** — `src/workspace/` (containing `AGENT.md` and the Node test `harness/`) is uploaded to `/workspace/` in the container. The extension directory passed on the CLI is uploaded to `/workspace/extension/`. An `out/` directory is pre-created for agent output.

3. **Browser provisioning** — The Chromium that ships in the agent-server image is located, and the harness's npm deps (`puppeteer-core`) are installed. The browser version is fixed by the agent-server image tag (pin the tag, or build a custom image with `DockerDevWorkspace`, to control it). Chrome for Testing is intentionally **not** used: it has no native ARM64 Linux build and its amd64 build crashes under emulation on Apple Silicon.

4. **Orchestration** — A `Conversation` is started with `MigratorAgent`, which has access to `terminal`, `file_editor`, `task` (sub-agent delegation), and `browser_tool_set` tools. The initial prompt from `PromptGenerator` is sent, kicking off the workflow:
   - Delegate analysis to `extension-analyzer`
   - Verify `/workspace/analysis.json` exists
   - Delegate migration to `extension-transformer`
   - Verify `/workspace/out/manifest.json` exists with `manifest_version: 3`
   - Delegate testing to `extension-tester`

5. **Subagents** — Each subagent is defined by a markdown file in `src/agents/subagents/` with frontmatter declaring its name, tools, and model. They run with the same LLM as the orchestrator (`model: inherit`).

6. **Test → fix loop** — After output is produced, the manager runs the smoke test (loads the migrated extension into Chromium, captures service-worker/console/page errors). If it fails, the captured errors are sent back to the agent to fix, then the test re-runs — up to 3 attempts.

7. **Nudging** — If the agent finishes without producing output files, the manager re-sends the task (up to 3 nudges) with explicit instructions to use tool calls rather than plain text.

8. **Output** — Once complete, `output/` on the host contains the migrated extension (`extension/`), the migration plan (`analysis.json`), the diff (`migration.patch`), and the runtime report (`test_report.json`). Activity logs are written to `agent_logs/`.

---

## Project Structure

```
.
├── main.py                         # Entrypoint
├── src/
│   ├── manager.py                  # MigrationManager — wires LLM, Docker, conversation
│   ├── agents/
│   │   ├── migrator.py             # MigratorAgent — orchestrator with task (delegation) tool
│   │   └── subagents/
│   │       ├── extension-analyzer.md    # Inspects extension, produces analysis.json
│   │       ├── extension-transformer.md # Applies changes, writes migrated files to out/
│   │       └── extension-tester.md      # Loads migrated extension in Chrome, reports errors
│   ├── utils/
│   │   ├── banner.py               # Startup banner
│   │   ├── docker.py               # Docker workspace factory
│   │   ├── static_analyzer.py      # Scans source for deprecated APIs (api_mappings.json)
│   │   ├── test_harness.py         # Detects bundled Chromium + runs the smoke test
│   │   └── prompt_generator.py     # Initial task prompt
│   └── workspace/                  # Files uploaded into the Docker container at startup
│       ├── AGENT.md                # Workflow instructions for the agent
│       └── harness/                # Node smoke-test harness (puppeteer-core)
├── output/                         # Downloaded agent output (created at runtime)
│   ├── extension/                  #   the migrated extension
│   ├── analysis.json               #   migration plan
│   ├── migration.patch             #   unified diff (original → migrated)
│   └── test_report.json            #   runtime smoke-test report
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

```bash
uv run python main.py /path/to/my-extension
```

Docker must be running. The agent server image is pulled automatically on first run:
- `ghcr.io/openhands/agent-server:latest-python` (or a SHA-pinned version in CI)

Once started, two URLs are printed:
- **VSCode Server** — browse the workspace filesystem live
- **VNC Server** — watch browser sessions the agent opens (`http://localhost:<port>/vnc.html?autoconnect=1`)

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
