"""One shared console and a single visual language for all user-facing output.

Everything that talks to the user — the CLI, the Docker setup, the conversation visualizer
— goes through the one ``console`` here so styling is consistent and nothing fights over
stdout. The vocabulary is deliberately small:

    note(...)  ℹ  neutral info        ok(...)   ✓  something succeeded
    warn(...)  ⚠  recoverable problem  fail(...) ✗  hard failure
    spinner(...)  a dots spinner for a blocking wait (e.g. starting a container)

``spinner`` renders on **stderr** so a caller can suppress a noisy library's stdout
(``redirect_stdout``) without hiding the spinner.
"""

from contextlib import contextmanager
from collections.abc import Iterator

from rich.console import Console

# The single stdout console used everywhere. The stderr console is for transient status
# (spinners) so it stays visible even while stdout is being captured/suppressed.
console = Console()
_status_console = Console(stderr=True)


def note(msg: str) -> None:
    console.print(f"[cyan]ℹ[/] {msg}")


def ok(msg: str) -> None:
    console.print(f"[green]✓[/] {msg}")


def warn(msg: str) -> None:
    console.print(f"[yellow]⚠[/] {msg}")


def fail(msg: str) -> None:
    console.print(f"[red]✗[/] {msg}")


@contextmanager
def spinner(message: str) -> Iterator[None]:
    """Show a dots spinner with ``message`` until the block exits (renders on stderr)."""
    with _status_console.status(f"[bold]{message}", spinner="dots"):
        yield
