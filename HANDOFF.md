# Handoff: Invariant Hardening for AgenticMigrator

**Goal:** Make the migrator robust against invalid and broken states at every boundary.
**Status:** ~80% complete. Core invariants are in, some are wired up, a few remain.

---

## What was done

### New file: `src/utils/invariants.py`
Three functions used throughout the pipeline:
- `check_extension_input(path)` — validates a directory is a loadable extension (dir exists, manifest.json present and valid JSON)
- `check_migrated_output(path)` — same + requires `manifest_version: 3`
- `reconcile_result(result, logger)` — final repair step before serialization; ensures `status ∈ VALID_STATUSES`, `success ⇒ verify_passed`, `error ⇒ error message`. Always downgrades, never upgrades.

### `src/manager.py`
1. **Input invariant** — calls `invariants.check_extension_input` before touching anything; raises `ValueError` with the concrete reason instead of failing mysteriously downstream.
2. **Fresh-run invariant** — calls `artifacts.clear_stale_outputs()` so reruns to the same output dir never blend two runs' artifacts.
3. **Workspace sanity** — `mkdir -p <remote_output_dir>` failure now raises `RuntimeError` (broken workspace) instead of logging and continuing, which would waste the entire agent run.
4. **Output invariant** — after `status == "success"`, calls `invariants.check_migrated_output(config.migrated_dir)`; if the downloaded artifact is broken/missing, downgrades to `status="error"`.
5. **Safe close** — `conversation.close()` is inside its own try/except so a close hiccup can't flip a completed migration to "error".
6. **reconcile_result** — called unconditionally before `return result`.

### `src/utils/test_harness.py`
1. **Fresh-report invariant** — `rm -f <report_path>` before each verify run so stale reports from a crashed previous run can't be misread as the current result.
2. **Pass/report consistency invariant** — after exit code 0, checks `report.get("loaded") and not report.get("errors")`; if contradicted or report is absent, marks as failed with a `harness` error entry.
3. **Shell quoting** — `shlex.quote` on paths passed to `execute_command`.

### `src/utils/conversation_loops.py`
1. **Fix-crash recovery** — the `run_test_fix_loop` now catches exceptions from `_send_fix_request` (agent/conversation crash mid-fix) and returns the last known verification result as `verify_failed` instead of letting the exception bubble up and erase the result into a generic "error".
2. **Extracted `_send_fix_request`** — cleaner separation; fix message + `run_with_heartbeat` in its own function.

### `src/utils/manifest_converter.py`
1. **Converter-output invariant** — after `emc.py` exits 0, validates the output with `invariants.check_extension_input(converted)`; if broken, falls back to the original extension instead of uploading a corrupt tree.

### `src/utils/artifacts.py`
1. **`clear_stale_outputs(output_root, migrated_dir, conversation_dir, logger)`** — removes `migrated_dir/`, `conversation_dir/`, and the known per-run owned files (`analysis.json`, `migration.patch`, `critique.json`, `memory.md`) before each run. Only pipeline-owned files are touched.

### `src/batch.py`
1. **Uniqueness invariant** — `discover_extensions` now checks for duplicate basenames (output paths key on basename, so duplicates silently overwrite each other); raises `ValueError` listing all offenders.
2. **Malformed-line tolerance in `_write_summary`** — skips broken/truncated JSON lines in `results.jsonl` (from a kill mid-append), counts them in `malformed_result_lines`, never aborts the summary.
3. **Robust status access** — changed `r["status"]` to `r.get("status")` in aggregate counts.
4. **Worker invariant** — `worker()` now has a top-level `except Exception` that returns a `MigrationResult(status="error")` instead of raising. Without this, a port-exhaustion error (for example) would surface as an unhandled exception from `future.result()` and kill the whole batch.
5. **Interrupt-safe executor** — `as_completed` loop wrapped in `try/except BaseException`; on interrupt, calls `executor.shutdown(wait=False, cancel_futures=True)` to let in-flight containers clean up, then calls `_write_summary` before re-raising so `results.jsonl` → `summary.csv`/`aggregate.json` stays consistent for `--resume`.
6. **`results_fh` in context manager** — moved `open(results_path)` into `with results_fh, progress:` so it closes on exception too.

---

## What still needs to be done

### `src/utils/docker.py` — retry on workspace start failure
The `DockerWorkspace()` constructor can fail transiently (the Docker daemon is briefly busy, a port race after the probe). A simple retry-with-backoff (2–3 attempts) would avoid losing an extension to a flaky startup. Sketch:
```python
import time

def createDockerWorkspace(port, quiet=False, *, _retries=2, _delay=5):
    for attempt in range(1, _retries + 2):
        try:
            return _create_once(port, quiet)
        except Exception as e:
            if attempt > _retries:
                raise
            logger.warning(f"Docker workspace start failed (attempt {attempt}): {e}; retrying in {_delay}s")
            time.sleep(_delay)
```

### `src/utils/workspace_io.py` — tar path-traversal note
`tar.extractall(local_dir, filter="data")` is already in place (safe). Consider validating that the archive contains at least one file after extraction (empty archive = silent no-op that leaves the extension dir empty).

### `src/utils/memory.py` — content invariant on write-back
`collect_update` currently validates size (`len(updated) > max_chars`) but not structure — an agent that blanks the file to a single space passes the `updated.strip()` check. Consider checking that the updated memory still starts with `# Migration Memory` (or at least has non-trivial content) before replacing.

### Write unit tests
Currently `just test` just echoes "not implemented yet". Target for each invariant:
- `test_check_extension_input`: missing dir, missing manifest, bad JSON, valid → 0 violations.
- `test_check_migrated_output`: v2 manifest, valid v3 → violations / empty.
- `test_reconcile_result`: bad status, success+no verify, error+no message.
- `test_write_summary_malformed`: inject a truncated line into results.jsonl → summary still produced.
- `test_verify_stale_report`: mock `execute_command` to not write the report; assert pass is False.
- `test_worker_never_raises`: pass a bad extension path; assert the returned result has status="error" not an exception.

### Docs
Update `docs/architecture.md` to mention the invariant layer (`src/utils/invariants.py`) in the run flow.

---

## Key files
| File | Role |
|------|------|
| `src/utils/invariants.py` | All invariant checks and the result reconciler |
| `src/manager.py` | Wires invariants into the single-run flow |
| `src/batch.py` | Batch worker hardening, interrupt safety, duplicate detection |
| `src/utils/test_harness.py` | Fresh-report + pass/report consistency invariants |
| `src/utils/manifest_converter.py` | Converter-output invariant |
| `src/utils/artifacts.py` | `clear_stale_outputs` for the fresh-run invariant |
| `src/utils/conversation_loops.py` | Fix-crash recovery in the test-fix loop |
