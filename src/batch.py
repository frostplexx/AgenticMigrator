"""Bulk migration runner for research-scale runs (hundreds of extensions).

Design notes:

- **Bounded parallelism.** Each migration spins up its own Docker container running
  Chromium, so concurrency is capped by ``--workers``. A queue of worker *slots*
  (0..workers-1) hands each task a disjoint Docker port block (``port_base + slot*10``)
  so the VSCode/VNC sidecar ports never collide, no matter how many extensions there are.
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
import os
import queue
import threading
import time
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
from .utils.llm_factory import build_llm

_CSV_FIELDS = [
    "extension_name",
    "status",
    "verify_passed",
    "num_findings",
    "nudge_attempts",
    "test_attempts",
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
    return paths


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
    """Read results.jsonl and write summary.csv + aggregate.json. Returns the aggregate."""
    results: list[dict] = []
    with open(results_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                results.append(json.loads(line))

    csv_path = os.path.join(output_root, "summary.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=_CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for row in results:
            writer.writerow(row)

    total = len(results)
    successes = sum(1 for r in results if r["status"] == "success")
    verify_failed = sum(1 for r in results if r["status"] == "verify_failed")
    errors = sum(1 for r in results if r["status"] == "error")
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

    # One slot per worker; each slot owns a disjoint Docker port block.
    slots: queue.Queue[int] = queue.Queue()
    for i in range(config.workers):
        slots.put(i)

    write_lock = threading.Lock()
    results_fh = open(results_path, "a", encoding="utf-8")
    running = {"cost": 0.0, "success": 0, "verify_failed": 0, "error": 0}

    def worker(ext_path: str) -> MigrationResult:
        slot = slots.get()
        try:
            name = os.path.basename(ext_path.rstrip("/"))
            from .cli import conversation_id_for  # local import avoids a cycle at import time

            cfg = RunConfig(
                extension_path=ext_path,
                output_dir=os.path.join(output_root, "extensions", name),
                docker_port_base=config.port_base + slot * 10,
                conversation_id=conversation_id_for(ext_path),
                quiet=True,
            )
            # Fresh LLM per run so llm.metrics stay isolated per extension.
            return run_migration(cfg, build_llm(temperature=config.temperature))
        finally:
            slots.put(slot)

    progress = Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        console=console,
    )
    with progress:
        task_id = progress.add_task("migrating", total=len(pending))
        with ThreadPoolExecutor(max_workers=config.workers) as executor:
            futures = {executor.submit(worker, p): p for p in pending}
            for future in as_completed(futures):
                result = future.result()  # worker → run_migration never raises
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
    results_fh.close()

    aggregate = _write_summary(results_path, output_root)
    console.print(
        f"[bold]Done.[/bold] {aggregate['success']}/{aggregate['total']} succeeded · "
        f"${aggregate['total_cost']:.2f} · summary: {os.path.join(output_root, 'summary.csv')}"
    )
    return aggregate
