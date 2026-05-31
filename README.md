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
        ├── Uploads src/workspace/ (AGENT.md etc.) into /workspace/
        ├── Uploads <extension-path>/ into /workspace/extension/
        ├── Creates a Conversation with MigratorAgent
        └── Sends prompt → runs conversation loop
              │
              ▼
        MigratorAgent (orchestrator)
              ├── Delegates to → extension-analyzer
              │     Reads /workspace/extension/, identifies all MV2→MV3 changes
              │     Saves structured plan to /workspace/analysis.json
              │
              └── Delegates to → extension-transformer
                    Reads analysis.json + every source file
                    Applies all changes, writes migrated extension to /workspace/out/
              │
              ▼
        MigrationManager downloads /workspace/out/ → local output/
```

### Step-by-step flow

1. **Setup** — `MigrationManager` reads LLM config from `.env`, initializes the LLM client, and starts a Docker container running the OpenHands agent server.

2. **Workspace prep** — `src/workspace/` (containing `AGENT.md`) is uploaded to `/workspace/` in the container. The extension directory passed on the CLI is uploaded to `/workspace/extension/`. An `out/` directory is pre-created for agent output.

3. **Orchestration** — A `Conversation` is started with `MigratorAgent`, which has access to `terminal`, `file_editor`, `delegate`, and `browser_tool_set` tools. The initial prompt from `PromptGenerator` is sent, kicking off the 4-step workflow:
   - Delegate analysis to `extension-analyzer`
   - Verify `/workspace/analysis.json` exists
   - Delegate migration to `extension-transformer`
   - Verify `/workspace/out/manifest.json` exists with `manifest_version: 3`

4. **Subagents** — Each subagent is defined by a markdown file in `src/agents/subagents/` with frontmatter declaring its name, tools, and model. They run with the same LLM as the orchestrator (`model: inherit`).

5. **Nudging** — If the agent finishes without producing output files, the manager re-sends the task (up to 3 nudges) with explicit instructions to use tool calls rather than plain text.

6. **Output** — Once complete, `output/` on the host contains the migrated extension. Activity logs are written to `agent_logs/` for monitoring.

---

## Project Structure

```
.
├── main.py                         # Entrypoint
├── src/
│   ├── manager.py                  # MigrationManager — wires LLM, Docker, conversation
│   ├── agents/
│   │   ├── migrator.py             # MigratorAgent — orchestrator with delegate tool
│   │   └── subagents/
│   │       ├── extension-analyzer.md    # Inspects extension, produces analysis.json
│   │       └── extension-transformer.md # Applies changes, writes migrated files to out/
│   ├── utils/
│   │   ├── banner.py               # Startup banner
│   │   ├── docker.py               # Docker workspace factory
│   │   └── prompt_generator.py     # Initial task prompt
│   └── workspace/                  # Files uploaded into the Docker container at startup
├── output/                         # Downloaded agent output (created at runtime)
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
