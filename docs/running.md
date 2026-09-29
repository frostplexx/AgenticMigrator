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
- `conversation/` — `events.jsonl` (the full agent trace) and `metrics.json` (cost and
  token usage, broken down per `usage_id`)

A `batch` run writes `runs/<timestamp>/`:

- `results.jsonl` — one `MigrationResult` per extension (status, verification, metrics),
  appended as each finishes
- `summary.csv` — the same data as a flat table for analysis
- `aggregate.json` — totals: success rate, total cost/tokens, mean wall time
- `run_config.json` — the model and settings used
- `extensions/<name>/` — the per-extension output described above, one directory each

> Note: the sections above describe the older Python CLI (`agentictester`) and are stale with
> respect to the current TypeScript `src/cli.ts`. The runs section below is current.

## Runs (several models, one corpus)

A **run** is one model's attempt at one corpus. Runs are created from extlens, live side by side, and
never share a directory — two runs sharing one would let the second skip what the first migrated and
delete what it failed.

### Serving a runs root

```bash
npm run cli -- --out ~/runs --source-dir ~/subset_expanded
# or, without the migrate CLI around it:
npx tsx src/extlens/index.ts --run ~/runs --source-dir ~/subset_expanded
```

`--out` (or `--run`) is the runs root: a directory *of* runs. It does not need to exist — the server
creates what it needs, and serves no runs until the client makes one. `--source-dir` is the corpus a
new run gets when it does not name one.

There is one layout and no flag for it. A directory of extension folders left over from before runs
existed is simply not a runs root: pointing at it shows zero runs rather than its old contents, and
nothing in it is touched.

### From the client

The top bar shows the model of the run on screen; clicking it opens **Runs**. From there:

- **New run** asks for a model, a source directory and an optional label. The model box completes from
  the provider's own list (`GET {LLM_BASE_URL}/models`, cached for ten minutes) but accepts anything:
  a bare id is qualified to `saia/<id>`, and a provider that will not list its models is a reason to
  type a name, not to be blocked. Creating starts the migration over the whole corpus immediately.
- **Open** re-points the host at a past run. The table, reports and transcripts all change with it, so
  the client drops its selection and returns to Browse — the same extension id exists in both runs,
  and showing one run's data under the other's name is a wrong answer that looks like a right one.
- **Delete** removes a run's migrations, reports and transcripts for good. The run being served cannot
  be deleted; open another first.

Switching, creating and deleting are all refused while a migration is running (`HOST_BUSY`):
re-pointing the root under a container writing into it would put two runs' output in one place.

### What a run looks like on disk

```
<root>/
  blobs/                                 content-addressed store, shared by every run
  20260929-143210-deepseek-v4-flash/     one run
    run.json                             model, corpus, label, settings (never the API key)
    <ext-id>/{out,report.json,transcript.jsonl,plan.json,migrate.jsonl,…}
    migrator.db                          this run's own index
```

The id is time-then-model so `ls` and the runs list agree on order. `run.json` records the resolved
environment minus the key, because "which model" does not explain a difference between two runs of the
*same* model and a context window or thinking level does.

### Disk usage

A run's `out/` trees are ~96% of its size, and most of those bytes — icons, vendored libraries,
images — are byte-identical across every run of the same corpus. So when an extension finishes, its
output is moved into `blobs/<sha256>` and hardlinked back. Identical content costs one copy however
many runs contain it, and nothing downstream notices: `out/` is still an ordinary directory, so Chrome
loads the extension from it and the file plane reads it as before.

Two properties worth knowing:

- Dedupe only ever touches a **finished** extension. A hardlink has no copy-on-write, and the agent
  edits files in place all through a migration — linking a live run would rewrite the same content
  inside every earlier run that shared it.
- Deleting a run is just deleting its directory. Its blobs survive while any other run still links
  them, and the unreferenced ones are collected afterwards by link count, which needs no index and
  cannot be wrong about a run someone removed by hand.

Files under 4KB are left as plain copies: below about a block there is nothing to win, and every link
is one more thing that must never be written through.
