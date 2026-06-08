# Running

## Prerequisites

- Docker, running. The agent-server image is pulled on first use
  (`ghcr.io/openhands/agent-server:latest-python`, or a SHA-pinned tag in CI).
- The converter submodule, fetched once after cloning:

  ```bash
  git submodule update --init --recursive
  ```

- A `.env` file. See [configuration](configuration.md).

## Run

The CLI has two commands, `migrate` (one extension) and `batch` (many). After `uv sync`
it is available as `agentictester`:

```bash
uv run agentictester migrate /path/to/unpacked-extension
```

The argument is a directory containing the unpacked MV2 extension (the one with
`manifest.json` at its root). Useful options: `--output/-o DIR` (default `output`),
`--keep-workspace`, `--verbose/-v`.

### Bulk migration (research)

```bash
uv run agentictester batch /path/to/corpus --workers 4
```

`batch` discovers every immediate subdirectory of the input that contains a
`manifest.json` (or takes an explicit list with `--from-file paths.txt`), migrates them
with bounded parallelism, and writes a timestamped run directory under `runs/`. Key
options:

- `--workers/-w N` — extensions migrated in parallel. Each worker runs its own Docker
  container, so keep this modest. Worker `i` uses Docker port base `--port + i*10`.
- `--output/-o DIR` — run directory (default `runs/<timestamp>`).
- `--resume` — skip extensions already recorded in that run's `results.jsonl`, so a long
  run can span sessions or recover from a crash.
- `--limit N`, `--from-file FILE`.

## While it runs

For a single `migrate`, two URLs are printed at startup:

- VSCode Server: browse the container's filesystem.
- VNC Server: `http://localhost:<port>/vnc.html?autoconnect=1`. The verify skill runs
  Chromium with `--headless=new`, so the test browser does not show up here.

`batch` suppresses these per-extension URLs and shows a single live progress bar with
running success/failure counts and total cost instead.

## Output

A single `migrate` writes into the `--output` directory (default `output/`):

- `extension/` — the migrated extension
- `analysis.json` — the migration plan from static analysis
- `migration.patch` — a unified diff from the original extension to the migrated one
- `test_report.json` — the verification report (load status, errors, warnings)
- `agent_log/` — per-agent activity logs
- `conversation/` — `events.jsonl` (the full agent trace) and `metrics.json` (cost and
  token usage, broken down per `usage_id`)

A `batch` run writes `runs/<timestamp>/`:

- `results.jsonl` — one `MigrationResult` per extension (status, verification, metrics),
  appended as each finishes
- `summary.csv` — the same data as a flat table for analysis
- `aggregate.json` — totals: success rate, total cost/tokens, mean wall time
- `run_config.json` — the model and settings used
- `extensions/<name>/` — the per-extension output described above, one directory each
