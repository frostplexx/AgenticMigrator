"""A compact, migration-aware conversation visualizer.

The SDK's ``DefaultConversationVisualizer`` renders every event as a full Rich panel.
For this project that is noisy and, worse, it *silently skips* ``ConversationErrorEvent``
(a fatal server-side failure) — the same blind spot the activity logger works around in
``conversation_loops.make_activity_logger``.

``MigrationVisualizer`` is tuned to what the orchestrator actually does: it delegates to
subagents through the ``task`` tool and otherwise pokes at the workspace with
``terminal`` / ``file_editor``. It surfaces the agent's actual *text* — its reasoning
(``thought``), its messages, and the text a delegated subagent returns — plus a running
token/cost line, while keeping tool plumbing terse and fatal errors loud.

Note on scope: for a ``RemoteConversation`` the subagent runs as a nested, server-side
conversation whose *streaming* events are NOT relayed to this client (see
``conversation_loops``). So this visualizer shows the orchestrator's own thoughts/messages
and the subagent's *returned* text (which comes back in the delegation observation), but not
the subagent's intermediate steps — those are covered by the heartbeat.
"""

from openhands.sdk.event import ActionEvent, MessageEvent, ObservationEvent
from openhands.sdk.event.base import Event
from openhands.sdk.event.conversation_error import ConversationErrorEvent
from openhands.sdk.conversation.visualizer import ConversationVisualizerBase

from . import ui

# The orchestrator delegates through the `task` tool; mirror conversation_loops so the two
# stay in sync on what counts as a delegation.
_DELEGATION_TOOLS = {"task", "task_tool_set"}


class MigrationVisualizer(ConversationVisualizerBase):
    """Delegation-aware stdout view that prints the agent's text plus a token/cost tally."""

    def __init__(self, name: str = "Orchestrator"):
        super().__init__()
        self._name = name
        self._console = ui.console
        self._step = 0

    def on_event(self, event: Event) -> None:
        if isinstance(event, ActionEvent):
            self._on_action(event)
        elif isinstance(event, ObservationEvent):
            self._on_observation(event)
        elif isinstance(event, MessageEvent):
            self._on_message(event)
        elif isinstance(event, ConversationErrorEvent):
            # The default visualizer drops these; a fatal crash would otherwise be invisible.
            self._console.print(
                f"[bold red]✗ {self._name} error [{event.code}]:[/] {event.detail}"
            )

    def _on_action(self, event: ActionEvent) -> None:
        self._step += 1
        tool = event.tool_name or "?"
        if tool in _DELEGATION_TOOLS:
            target = getattr(getattr(event, "action", None), "subagent_type", None) or "subagent"
            self._console.print(f"[dim]{self._step:>3}[/] [bold cyan]→ delegate {target}[/]")
        else:
            self._console.print(f"[dim]{self._step:>3}[/] [yellow]{tool}[/]")
        # The agent's reasoning for this action — the "LLM text" worth seeing.
        thought = _content_text(getattr(event, "thought", None))
        if thought:
            self._console.print(f"[italic grey62]{thought}[/]")

    def _on_observation(self, event: ObservationEvent) -> None:
        tool = event.tool_name or "?"
        if tool in _DELEGATION_TOOLS:
            # A delegation returned — show what the subagent actually produced.
            text = getattr(getattr(event, "observation", None), "text", None)
            self._console.print("    [green]← subagent returned[/]")
            if isinstance(text, str) and text.strip():
                self._console.print(_block(_cap(text.strip())))
        # One dim token/cost line per completed step so the tally is always visible.
        self._print_stats()

    def _on_message(self, event: MessageEvent) -> None:
        text = _content_text(getattr(getattr(event, "llm_message", None), "content", None))
        if not text:
            return
        src = str(getattr(event, "source", "") or "")
        label = self._name if src == "agent" else (src or "message")
        self._console.print(f"[bold]{label}:[/] {text}")

    def _print_stats(self) -> None:
        stats = self.conversation_stats
        if stats is None:
            return
        try:
            snap = stats.get_combined_metrics().get_snapshot()
        except Exception:
            return
        cost = getattr(snap, "accumulated_cost", 0.0) or 0.0
        usage = getattr(snap, "accumulated_token_usage", None)
        if usage is None:
            self._console.print(f"[dim]    ${cost:.4f}[/]")
        else:
            self._console.print(
                f"[dim]    tokens: in {usage.prompt_tokens:,} / out "
                f"{usage.completion_tokens:,} · ${cost:.4f}[/]"
            )


def _content_text(items) -> str:
    """Join the ``.text`` of a sequence of content items (a thought or a message body)."""
    if not items:
        return ""
    return "\n".join(c.text for c in items if getattr(c, "text", None)).strip()


def _cap(text: str, limit: int = 2000) -> str:
    """Cap a long block (e.g. a verbose subagent result) so it can't flood the terminal."""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _block(text: str) -> str:
    """Indent a multi-line block two spaces so it reads as nested under its step."""
    return "\n".join(f"      {line}" for line in text.splitlines())
