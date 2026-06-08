# AgenticTester

Migrates an unpacked Chrome extension from Manifest V2 to Manifest V3. It first runs the
extension through GoogleChromeLabs' [extension-manifest-converter](https://github.com/GoogleChromeLabs/extension-manifest-converter)
on the host, then drives an LLM agent (built on the [OpenHands SDK](https://github.com/All-Hands-AI/OpenHands))
inside a Docker container to finish the parts the converter can't do and verify the result
in a real browser.

## Quick start

```bash
git submodule update --init --recursive   # fetch the vendored converter
cp .env.example .env                       # then set LLM_MODEL, etc.
uv sync                                     # install deps + the `agentictester` CLI

# migrate one extension
uv run agentictester migrate /path/to/unpacked-extension

# bulk-migrate a whole corpus (for research): parallel, resumable, with metrics
uv run agentictester batch /path/to/corpus --workers 4
```

Docker must be running. After a single `migrate`, the migrated extension and artifacts
are in `output/`; a `batch` run writes per-extension output plus `results.jsonl`,
`summary.csv`, and `aggregate.json` (cost, tokens, success rate) under `runs/<timestamp>/`.
See [running](docs/running.md) for all options.

## Documentation

- [Architecture](docs/architecture.md) — how a run flows from start to finish
- [Project structure](docs/project-structure.md) — what lives where
- [Configuration](docs/configuration.md) — environment variables and providers
- [Running](docs/running.md) — prerequisites, output, and the live VSCode/VNC views
- [Extending](docs/extending.md) — changing the prompt, adding a subagent or skill
