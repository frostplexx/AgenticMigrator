"""Bulk migration runner for research-scale runs (hundreds of extensions).

Design notes:

- **Bounded parallelism.** Each migration spins up its own Docker container running
  Chromium, so concurrency is capped by ``--workers``. A port-block allocator hands each
  task a disjoint 10-port Docker block starting at ``port_base``, probing that the ports
  are actually free on the host so the VSCode/VNC sidecar ports never collide — with each
  other or with unrelated services already listening.
- **Streaming + resumable.** Each ``MigrationResult`` is appended to ``results.jsonl`` as
  it finishes (under a lock). ``--resume`` against an existing run directory skips any
  extension already present there, so a 1000-extension run can span sessions or recover
  from a crash.
- **Aggregation.** When the run drains, ``summary.csv`` (flat per-extension table) and
  ``aggregate.json`` (success rate, total cost/tokens, mean wall time) are written for
  evaluation.
"""

import csv
import json
import logging
import os
import socket
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
)

from .manager import DEFAULT_PORT_BASE, MigrationResult, RunConfig, run_migration
from .utils import memory
from .utils.llm_factory import build_llm

_CSV_FIELDS = [
    "extension_name",
    "status",
    "verify_passed",
    "num_findings",
    "nudge_attempts",
    "test_attempts",
    "goal_status",
    "goal_score",
    "goal_iterations",
    "accumulated_cost",
    "prompt_tokens",
    "completion_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "wall_time_s",
    "conversation_id",
    "error",
]


@dataclass
class BatchConfig:
    input_dir: str | None = None
    from_file: str | None = None
    output_root: str | None = None
    workers: int = 2
    resume: bool = False
    limit: int | None = None
    port_base: int = DEFAULT_PORT_BASE
    temperature: float | None = None
    goal_max_iterations: int = 3


def discover_extensions(config: BatchConfig) -> list[str]:
    """Return the list of extension directories to migrate (deterministically ordered)."""
    paths: list[str] = []
    if config.from_file:
        with open(config.from_file, encoding="utf-8") as fh:
            paths = [line.strip() for line in fh if line.strip() and not line.startswith("#")]
        paths = [os.path.abspath(p) for p in paths]
    elif config.input_dir:
        for entry in sorted(os.listdir(config.input_dir)):
            candidate = os.path.join(config.input_dir, entry)
            if os.path.isdir(candidate) and os.path.isfile(os.path.join(candidate, "manifest.json")):
                paths.append(os.path.abspath(candidate))
    else:
        raise ValueError("batch requires either an input directory or --from-file")

    if config.limit is not None:
        paths = paths[: config.limit]

    # Uniqueness invariant: results.jsonl keys runs by basename and each run writes to
    # extensions/<basename>/, so two paths sharing a basename would silently overwrite
    # each other's output and poison --resume. Refuse up front with the offenders named.
    by_name: dict[str, str] = {}
    duplicates: list[str] = []
    for p in paths:
        base = os.path.basename(p.rstrip("/")) or p
        if base in by_name:
            duplicates.append(f"{base!r}: {by_name[base]} and {p}")
        else:
            by_name[base] = p
    if duplicates:
        raise ValueError(
            "Duplicate extension names in the batch (outputs would collide): "
            + "; ".join(duplicates)
        )
    return paths


class _PortBlockAllocator:
    """Hand out disjoint 10-port Docker blocks (server, +1 VSCode, +2 VNC) that are
    verifiably free on the host.

    A worker's block used to be a fixed ``port_base + slot*10``. If anything else was
    already listening on one of those ports (an unrelated service, a leftover container
    from a killed run), every task routed through that slot failed instantly — and since
    the poisoned slot freed up immediately while healthy slots stayed busy for minutes,
    it drained the entire pending queue. Probing at acquire time skips occupied blocks
    instead.
    """

    _SPAN = 10

    def __init__(self, base: int) -> None:
        self._base = base
        self._in_use: set[int] = set()
        self._lock = threading.Lock()

    def acquire(self) -> int:
        with self._lock:
            candidate = self._base
            while candidate in self._in_use or not self._block_is_free(candidate):
                candidate += self._SPAN
                if candidate + 2 > 65535:
                    raise RuntimeError(
                        f"No free port block found between {self._base} and 65535."
                    )
            self._in_use.add(candidate)
            return candidate

    def release(self, base: int) -> None:
        with self._lock:
            self._in_use.discard(base)

    @staticmethod
    def _block_is_free(base: int) -> bool:
        # Plain bind() without SO_REUSEADDR: ports in TIME_WAIT count as busy, which is
        # what we want — Docker is about to bind them for real.
        for port in (base, base + 1, base + 2):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                try:
                    sock.bind(("0.0.0.0", port))
                except OSError:
                    return False
        return True


def _already_done(results_path: str) -> set[str]:
    """Extension names already recorded in a prior run's results.jsonl."""
    done: set[str] = set()
    if not os.path.isfile(results_path):
        return done
    with open(results_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                done.add(json.loads(line)["extension_name"])
            except (json.JSONDecodeError, KeyError):
                continue
    return done


def _write_summary(results_path: str, output_root: str) -> dict:
    """Read results.jsonl and write summary.csv + aggregate.json. Returns the aggregate.

    Tolerates broken state in results.jsonl: a run killed mid-append leaves a truncated
    final line, and hand-edited files happen. Malformed lines are skipped (and counted in
    the aggregate) instead of sinking the summary of every valid result around them.
    """
    results: list[dict] = []
    malformed = 0
    with open(results_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                malformed += 1
                continue
            if isinstance(row, dict) and row.get("extension_name"):
                results.append(row)
            else:
                malformed += 1

    csv_path = os.path.join(output_root, "summary.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=_CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for row in results:
            writer.writerow(row)

    total = len(results)
    successes = sum(1 for r in results if r.get("status") == "success")
    verify_failed = sum(1 for r in results if r.get("status") == "verify_failed")
    errors = sum(1 for r in results if r.get("status") == "error")
    scored = [r["goal_score"] for r in results if r.get("goal_score") is not None]
    goal_complete = sum(1 for r in results if r.get("goal_status") == "complete")
    aggregate = {
        "total": total,
        "success": successes,
        "verify_failed": verify_failed,
        "errors": errors,
        "success_rate": round(successes / total, 4) if total else 0.0,
        "total_cost": round(sum(r.get("accumulated_cost", 0.0) for r in results), 6),
        "total_prompt_tokens": sum(r.get("prompt_tokens", 0) for r in results),
        "total_completion_tokens": sum(r.get("completion_tokens", 0) for r in results),
        "total_reasoning_tokens": sum(r.get("reasoning_tokens", 0) for r in results),
        "mean_wall_time_s": round(sum(r.get("wall_time_s", 0.0) for r in results) / total, 2)
        if total
        else 0.0,
        "goal_complete": goal_complete if scored else None,
        "mean_goal_score": round(sum(scored) / len(scored), 3) if scored else None,
        "malformed_result_lines": malformed,
    }
    with open(os.path.join(output_root, "aggregate.json"), "w", encoding="utf-8") as fh:
        json.dump(aggregate, fh, indent=2)
    return aggregate


def run_batch(config: BatchConfig, console: Console) -> dict:
    """Run the bulk migration and return the aggregate summary dict."""
    output_root = config.output_root or os.path.abspath(
        os.path.join("runs", time.strftime("%Y%m%d-%H%M%S"))
    )
    os.makedirs(output_root, exist_ok=True)
    results_path = os.path.join(output_root, "results.jsonl")

    extensions = discover_extensions(config)
    done = _already_done(results_path) if config.resume else set()
    pending = [p for p in extensions if os.path.basename(p.rstrip("/")) not in done]

    # Persist the run configuration for reproducibility.
    with open(os.path.join(output_root, "run_config.json"), "w", encoding="utf-8") as fh:
        json.dump(
            {
                "model": os.environ.get("LLM_MODEL"),
                "temperature": config.temperature
                if config.temperature is not None
                else os.environ.get("LLM_TEMPERATURE"),
                "workers": config.workers,
                "port_base": config.port_base,
                "goal_max_iterations": config.goal_max_iterations,
                "input_dir": config.input_dir,
                "from_file": config.from_file,
                "total_discovered": len(extensions),
                "skipped_resumed": len(extensions) - len(pending),
            },
            fh,
            indent=2,
        )

    console.print(
        f"[bold]Batch:[/bold] {len(pending)} to migrate "
        f"({len(extensions) - len(pending)} skipped) · {config.workers} worker(s) · {output_root}"
    )
    if not pending:
        return _write_summary(results_path, output_root) if os.path.isfile(results_path) else {"total": 0, "errors": 0}

    ports = _PortBlockAllocator(config.port_base)

    write_lock = threading.Lock()
    results_fh = open(results_path, "a", encoding="utf-8")
    running = {"cost": 0.0, "success": 0, "verify_failed": 0, "error": 0}

    def worker(ext_path: str) -> MigrationResult:
        name = os.path.basename(ext_path.rstrip("/")) or "extension"
        output_dir = os.path.join(output_root, "extensions", name)
        port_base: int | None = None
        try:
            port_base = ports.acquire()
            from .cli import conversation_id_for  # local import avoids a cycle at import time

            cfg = RunConfig(
                extension_path=ext_path,
                output_dir=output_dir,
                docker_port_base=port_base,
                conversation_id=conversation_id_for(ext_path),
                quiet=True,
                goal_max_iterations=config.goal_max_iterations,
            )
            # Fresh LLM per run so llm.metrics stay isolated per extension.
            return run_migration(cfg, build_llm(temperature=config.temperature))
        except Exception as e:
            # Worker invariant: never raise. run_migration doesn't, but the setup around
            # it can (port exhaustion, a bad LLM config) — and a raise here would kill
            # the whole batch at future.result(), taking every pending extension with it.
            return MigrationResult(
                extension_name=name,
                output_dir=output_dir,
                status="error",
                error=str(e),
                traceback=traceback.format_exc(),
            )
        finally:
            if port_base is not None:
                ports.release(port_base)

    progress = Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        console=console,
    )
    try:
        with results_fh, progress:
            task_id = progress.add_task("migrating", total=len(pending))
            with ThreadPoolExecutor(max_workers=config.workers) as executor:
                futures = {executor.submit(worker, p): p for p in pending}
                try:
                    for future in as_completed(futures):
                        result = future.result()  # worker never raises (guaranteed above)
                        with write_lock:
                            results_fh.write(json.dumps(result.to_dict()) + "\n")
                            results_fh.flush()
                            running["cost"] += result.accumulated_cost
                            running[result.status if result.status in running else "error"] += 1
                        progress.update(
                            task_id,
                            advance=1,
                            description=(
                                f"✓{running['success']} "
                                f"~{running['verify_failed']} "
                                f"✗{running['error']} "
                                f"${running['cost']:.2f}"
                            ),
                        )
                except BaseException:
                    # Interrupted/crashed mid-run: drop the queued extensions (they stay
                    # pending for --resume) but let in-flight migrations finish so their
                    # containers tear down cleanly instead of leaking.
                    executor.shutdown(wait=False, cancel_futures=True)
                    raise
    except BaseException:
        # Leave a consistent run directory behind even on an interrupt: summarize what
        # completed (best-effort) so summary.csv/aggregate.json match results.jsonl and
        # the run can be picked up with --resume.
        try:
            _write_summary(results_path, output_root)
        except Exception:
            pass
        raise

    aggregate = _write_summary(results_path, output_root)

    # One commit for the whole batch (not one per extension) when MEMORY_GIT_COMMIT=1.
    memory.commit_if_configured(memory.MemoryConfig.from_env(), logging.getLogger(__name__))

    console.print(
        f"[bold]Done.[/bold] {aggregate['success']}/{aggregate['total']} succeeded · "
        f"${aggregate['total_cost']:.2f} · summary: {os.path.join(output_root, 'summary.csv')}"
    )
    return aggregate
