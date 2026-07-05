"""Command-line interface for AgenticTester.

Two roles, two commands:

- ``migrate <extension>`` — migrate a single unpacked extension; prints a clean summary
  and leaves the ready-to-load MV3 extension in the output directory.
- ``batch <input>`` — migrate many extensions (for research): bounded-parallel,
  resumable, and emits per-extension metrics/traces plus an aggregate report.
"""

import logging
import os
import uuid

import typer
from dotenv import load_dotenv
from rich.logging import RichHandler
from rich.panel import Panel
from rich.table import Table

from .manager import DEFAULT_PORT_BASE, MigrationResult, RunConfig, run_migration
from .utils import memory
from .utils.banner import show_banner
from .utils.llm_factory import build_llm
from .utils.ui import console

# Load .env at import time so option defaults that read environment variables (e.g.
# --port via DOCKER_PORT_BASE) see them — Typer resolves envvar defaults during command
# parsing, before the command body (and its _bootstrap() load_dotenv) runs. Idempotent:
# _bootstrap() calls load_dotenv() again, and it never overrides already-set vars.
load_dotenv()

app = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    help="Migrate Chrome extensions from Manifest V2 to V3 with an LLM agent.",
)

# Stable namespace so a given extension path always maps to the same conversation id
# (useful for correlating reruns / resumed batches).
_CONV_NAMESPACE = uuid.UUID("a6f1e2c4-0000-4000-8000-6167656e7469")


def conversation_id_for(extension_path: str) -> uuid.UUID:
    """Deterministic conversation id derived from the extension's absolute path."""
    return uuid.uuid5(_CONV_NAMESPACE, os.path.abspath(extension_path))


def _bootstrap(verbose: bool, *, banner: bool = True) -> None:
    """Load configuration and set process-wide logging/env once, before any run."""
    load_dotenv()
    if not os.environ.get("LLM_MODEL"):
        console.print(
            "[red]LLM_MODEL is not set.[/red] Copy .env.example to .env and configure it."
        )
        raise typer.Exit(2)

    # Set logging once here (not per-run) so concurrent batch workers don't race on it.
    # The SDK's "openhands" logger is very chatty at INFO (every docker command, the
    # container readiness polling, the full `docker version` dump, …); keep it at WARNING
    # unless --verbose so normal runs stay readable. The project's own ``src.*`` loggers
    # keep emitting at INFO via the root handler, so real progress lines still show.
    logging.getLogger("openhands").setLevel(logging.DEBUG if verbose else logging.WARNING)

    # Unify the look of the remaining log lines with the rest of the UI: in a normal run
    # drop the timestamp / module:line gutter so progress reads as clean prose; keep the
    # full diagnostic gutter under --verbose where it is actually useful.
    for handler in logging.getLogger().handlers:
        if isinstance(handler, RichHandler):
            handler._log_render.show_time = verbose
            handler._log_render.show_path = verbose
            handler._log_render.show_level = verbose
    # Keep VNC opt-out honored; enabled by default in the docker factory.
    if banner:
        show_banner(model=os.environ["LLM_MODEL"])


def render_result(result: MigrationResult) -> None:
    """Print a single migration's outcome as a Rich panel."""
    color = {"success": "green", "verify_failed": "yellow", "error": "red"}.get(
        result.status, "white"
    )
    total_tokens = (
        result.prompt_tokens
        + result.completion_tokens
        + result.cache_read_tokens
        + result.reasoning_tokens
    )

    table = Table.grid(padding=(0, 2))
    table.add_column(justify="right", style="bold")
    table.add_column()
    table.add_row("Status", f"[{color}]{result.status.upper()}[/{color}]")
    table.add_row("Verify", "PASSED" if result.verify_passed else f"FAILED ({len(result.verify_errors)} error(s))")
    table.add_row("API sites", str(result.num_findings))
    if result.goal_status is not None:
        score = f"{result.goal_score:.2f}" if result.goal_score is not None else "n/a"
        table.add_row(
            "Goal",
            f"{result.goal_status} · judge {score} ({result.goal_iterations} round(s))",
        )
    table.add_row("Cost", f"${result.accumulated_cost:.4f}")
    table.add_row("Tokens", f"{total_tokens:,} (in {result.prompt_tokens:,} / out {result.completion_tokens:,})")
    table.add_row("Time", f"{result.wall_time_s:.1f}s")
    if result.error:
        table.add_row("Error", f"[red]{result.error}[/red]")
    table.add_row("Output", result.migrated_dir or result.output_dir)

    console.print(Panel(table, title=f"Migration · {result.extension_name}", border_style=color))


@app.command()
def migrate(
    extension: str = typer.Argument(..., help="Path to the unpacked extension directory"),
    output: str = typer.Option("output", "--output", "-o", help="Output directory"),
    keep_workspace: bool = typer.Option(
        False, "--keep-workspace", help="Keep the remote Docker conversation after the run"
    ),
    port: int = typer.Option(
        DEFAULT_PORT_BASE, "--port", envvar="DOCKER_PORT_BASE",
        help="Base host port for the Docker workspace (also settable via DOCKER_PORT_BASE)",
    ),
    temperature: float = typer.Option(
        None, "--temperature", "-t", help="LLM sampling temperature (overrides LLM_TEMPERATURE)"
    ),
    goal: bool = typer.Option(
        True, "--goal/--no-goal", envvar="GOAL",
        help="Run the goal-completion loop after verification: an independent judge LLM "
             "audits the transcript for proof the migration is complete and re-prompts the "
             "agent with what is still missing (on by default; GOAL=0 or --no-goal to skip)",
    ),
    goal_iterations: int = typer.Option(
        3, "--goal-iterations", envvar="GOAL_MAX_ITERATIONS",
        help="Max judge audit rounds before the goal loop gives up",
    ),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose (DEBUG) logging"),
) -> None:
    """Migrate a single extension and leave the result in OUTPUT."""
    _bootstrap(verbose)
    llm = build_llm(temperature=temperature)

    config = RunConfig(
        extension_path=os.path.abspath(extension),
        output_dir=os.path.abspath(output),
        docker_port_base=port,
        conversation_id=conversation_id_for(extension),
        keep_workspace=keep_workspace,
        quiet=False,
        goal_max_iterations=goal_iterations if goal else 0,
    )
    result = run_migration(config, llm)
    memory.commit_if_configured(config.memory, logging.getLogger(__name__))
    render_result(result)
    raise typer.Exit(0 if result.status == "success" else 1)


@app.command()
def batch(
    input: str = typer.Argument(None, help="Directory of extension subdirs (omit if using --from-file)"),
    workers: int = typer.Option(2, "--workers", "-w", help="Number of extensions to migrate in parallel"),
    output: str = typer.Option(None, "--output", "-o", help="Run directory (default runs/<timestamp>)"),
    resume: bool = typer.Option(False, "--resume", help="Skip extensions already in results.jsonl in OUTPUT"),
    limit: int = typer.Option(None, "--limit", help="Migrate at most N extensions"),
    from_file: str = typer.Option(None, "--from-file", help="File with one extension path per line"),
    port: int = typer.Option(
        DEFAULT_PORT_BASE, "--port", envvar="DOCKER_PORT_BASE",
        help="Base host port, worker i uses port + i*10 (also settable via DOCKER_PORT_BASE)",
    ),
    temperature: float = typer.Option(
        None, "--temperature", "-t", help="LLM sampling temperature (overrides LLM_TEMPERATURE)"
    ),
    goal: bool = typer.Option(
        True, "--goal/--no-goal", envvar="GOAL",
        help="Run the goal-completion loop after verification: an independent judge LLM "
             "audits the transcript for proof the migration is complete and re-prompts the "
             "agent with what is still missing (on by default; GOAL=0 or --no-goal to skip)",
    ),
    goal_iterations: int = typer.Option(
        3, "--goal-iterations", envvar="GOAL_MAX_ITERATIONS",
        help="Max judge audit rounds before the goal loop gives up, per extension",
    ),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose (DEBUG) logging"),
) -> None:
    """Bulk-migrate many extensions, saving metrics and traces for research."""
    if not input and not from_file:
        console.print("[red]Provide an input directory or --from-file.[/red]")
        raise typer.Exit(2)

    # Quieter by default so the progress display stays readable; --verbose overrides.
    _bootstrap(verbose, banner=True)
    if not verbose:
        logging.getLogger("openhands").setLevel(logging.WARNING)

    # Imported here to keep the single-migrate path lightweight.
    from .batch import BatchConfig, run_batch

    cfg = BatchConfig(
        input_dir=os.path.abspath(input) if input else None,
        from_file=os.path.abspath(from_file) if from_file else None,
        output_root=os.path.abspath(output) if output else None,
        workers=workers,
        resume=resume,
        limit=limit,
        port_base=port,
        temperature=temperature,
        goal_max_iterations=goal_iterations if goal else 0,
    )
    summary = run_batch(cfg, console)
    raise typer.Exit(0 if summary.get("errors", 0) == 0 and summary.get("total", 0) > 0 else 1)


if __name__ == "__main__":
    app()
