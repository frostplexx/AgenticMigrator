# agentic-migrator-ts

TypeScript rewrite of AgenticMigrator on the [pi](https://pi.dev) SDK (Path B). Migrates a
Chrome extension MV2 → MV3 using an LLM agent that runs, with a headed-Chromium verifier, in
a **self-rolled container** — no OpenHands agent-server.

## Architecture

```
HOST (nix: node + python3 + docker)                CONTAINER (self-rolled image)
  cli.ts                                             entrypoint.sh: tini → Xvfb (→ VNC)
   ├─ convert.ts   → emc.py (Python subprocess)      runMigration.ts
   ├─ staticAnalyzer.ts → plan.json / analysis.json   ├─ model.ts  (pi custom OpenAI provider)
   └─ docker run  ── mounts: extension:ro, run/ ──▶   ├─ pi agent session (read/edit/write/bash)
                                                      │    prompt.ts (findings + signals + mv3 skill)
   ◀── run/out (migrated ext) + run/report.json ──    └─ verify.ts (headed Chromium on Xvfb) + fix loop
```

Faithful ports of the Python originals: `staticAnalyzer` (findings + non-mechanical
signals), `prompt` generator, `verify` (Chrome `--log-file` load-error extraction). The
orchestrator/subagent split collapses into one pi session (pi edits files with native tools).
Retry + compaction come from pi's `SettingsManager` (the rate-limit + condenser lessons).

## Run

```sh
nix develop            # node + python3
npm install && npm run build
docker build -t agentic-migrator-ts:latest .
node dist/cli.js /path/to/mv2-extension --out ./run
# → ./run/out (migrated extension), ./run/report.json
```

Model via env (`LLM_MODEL`, `LLM_BASE_URL`), pi custom OpenAI-completions provider. Default
`ollama/gemma4:31b-cloud` over `host.docker.internal:11434`.

## Proven end-to-end (RESULTS.txt)

Migrating `tmp/extension_mv2` with **gemma4:31b-cloud** (local Ollama):

```
[cli] converting (extension-manifest-converter)...  → manifest_version 3, service_worker, action, host_permissions
[cli] static analysis: 2 deprecated API site(s), 4 signal(s)
[migrate] model: gemma4:31b-cloud ... 7 turns
[migrate] verify #1: PASS
[cli] SUCCESS ✅ — service worker: chrome-extension://ccoifhcpnedp…/service_worker.js
```

The agent produced a valid MV3 manifest **and** a correct declarativeNetRequest `rules.json`
(`action.redirect.url`), and the extension loaded headed under Xvfb with its service worker
registering. Chrome emitted `_metadata/` (indexed rulesets) — it accepts the DNR ruleset.

## Deferred (vs. the Python original)

Cross-run memory, the goal-completion judge loop, the per-run critic, batch mode, and full
metrics/cost capture. All straightforward additions on this foundation.
