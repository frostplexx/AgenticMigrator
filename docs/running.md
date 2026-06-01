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

```bash
uv run python main.py /path/to/unpacked-extension
```

The argument is a directory containing the unpacked MV2 extension (the one with
`manifest.json` at its root).

## While it runs

Two URLs are printed at startup:

- VSCode Server: browse the container's filesystem.
- VNC Server: `http://localhost:<port>/vnc.html?autoconnect=1`. The verify skill runs
  Chromium with `--headless=new`, so the test browser does not show up here.

## Output

When the run finishes, `output/` contains:

- `extension/` — the migrated extension
- `analysis.json` — the migration plan from static analysis
- `migration.patch` — a unified diff from the original extension to the migrated one
- `test_report.json` — the verification report (load status, errors, warnings)

Per-agent activity logs are written to `agent_logs/`.
