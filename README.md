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
        ├── Static analysis (api_mappings.json) → writes analysis.json (the migration plan)
        ├── Assembles workspace (AGENT.md + src/skills/ + analysis.json) → uploads to /workspace/
        ├── Uploads <extension-path>/ into /workspace/extension/
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

2. **Static analysis** — `StaticAnalyzer` scans the extension's JS/HTML against `api_mappings.json` and `build_analysis()` writes the migration plan (`analysis.json`) directly — there is **no LLM analyzer agent**. This is fast and deterministic for known API call-site replacements; manifest-level changes and anything static analysis can't see are handled by the transformer (using the migration reference) and caught at runtime by `verify`.

3. **Workspace prep** — There is no checked-in `src/workspace/`; the container workspace is **assembled at runtime** in a temp staging dir from `src/AGENT.md`, the skills in `src/skills/` (copied to `.openhands/skills/`), and the generated `analysis.json`, then uploaded to `/workspace/`. The extension directory passed on the CLI is uploaded to `/workspace/extension/`. An `out/` directory is pre-created for agent output.

4. **Verify provisioning** — The `verify` skill's Python deps (`playwright`, `websocket-client`) are installed in the container. It uses the Chromium that ships in the agent-server image (launched via Playwright), so no browser is downloaded. The browser version is fixed by the agent-server image tag (pin the tag, or build a custom image with `DockerDevWorkspace`, to control it). Chrome for Testing is intentionally **not** used: it has no native ARM64 Linux build and its amd64 build crashes under emulation on Apple Silicon.

5. **Orchestration** — A `Conversation` is started with `MigratorAgent`, which has access to `terminal`, `file_editor`, and `task` (sub-agent delegation) tools — **no browser tool**, so the agent cannot drive a browser directly; testing happens only through the `verify` skill. Its **system prompt** carries the MV2→MV3 migration reference (`src/utils/migration_reference.py`) so the agent always knows what must change (manifest fields, service-worker constraints, API replacements). The initial prompt from `PromptGenerator` is sent, kicking off the workflow:
   - Delegate migration to `extension-transformer` (applies the pre-generated `analysis.json` plus all other MV2→MV3 changes)
   - Verify `/workspace/out/manifest.json` exists with `manifest_version: 3`
   - Delegate testing to `extension-tester`

6. **Subagents** — Each subagent is defined by a markdown file in `src/agents/subagents/` with frontmatter declaring its name, tools, and model. They run with the same LLM as the orchestrator (`model: inherit`).

7. **Test → fix loop** — After output is produced, the manager runs the `verify` skill (Playwright loads the migrated extension into Chromium, captures service-worker/console/page errors). If it fails, the captured errors are sent back to the agent to fix, then verification re-runs — up to 3 attempts. This is what catches anything the static plan missed.

8. **Nudging** — If the agent finishes without producing output files, the manager re-sends the task (up to 3 nudges) with explicit instructions to use tool calls rather than plain text.

9. **Output** — Once complete, `output/` on the host contains the migrated extension (`extension/`), the migration plan (`analysis.json`), the diff (`migration.patch`), and the runtime report (`test_report.json`). Activity logs are written to `agent_logs/`.

---

## Project Structure

```
.
├── main.py                         # Entrypoint
├── src/
│   ├── manager.py                  # MigrationManager — wires LLM, Docker, conversation
│   ├── AGENT.md                    # Workflow doc, assembled into /workspace at runtime
│   ├── agents/
│   │   ├── migrator.py             # MigratorAgent — orchestrator with task (delegation) tool
│   │   └── subagents/
│   │       ├── extension-transformer.md # Applies the migration, writes migrated files to out/
│   │       └── extension-tester.md      # Runs the verify skill, reports errors
│   ├── skills/                     # Skills, assembled into /workspace/.openhands/skills at runtime
│   │   └── verify/                 # `verify` skill: Playwright extension test
│   │       ├── SKILL.md
│   │       └── scripts/verify.py
│   ├── utils/
│   │   ├── banner.py               # Startup banner
│   │   ├── docker.py               # Docker workspace factory
│   │   ├── static_analyzer.py      # Scans source for deprecated APIs + builds analysis.json
│   │   ├── migration_reference.py  # MV2→MV3 knowledge baked into the agent system prompt
│   │   ├── test_harness.py         # Installs verify deps + runs the verify skill
│   │   └── prompt_generator.py     # Initial task prompt
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
