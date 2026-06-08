"""Capture a finished conversation's metrics and event history for offline analysis.

The agent runs in a remote (Docker) workspace, so the SDK's on-disk ``persistence_dir``
mechanism is unavailable — ``Conversation(...)`` rejects ``persistence_dir`` for a
``RemoteConversation``. Instead we pull the metrics from ``conversation.conversation_stats``
and serialize the event stream client-side, before ``conversation.close()`` tears the
remote conversation down. This is what makes per-extension cost/token data and full
agent traces available for the bulk research runs.
"""

import json
import os

# Token fields tracked by openhands.sdk.llm.utils.metrics.TokenUsage.
_TOKEN_FIELDS = (
    "prompt_tokens",
    "completion_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
)


def _metrics_to_dict(metrics) -> dict:
    """Flatten an openhands ``Metrics`` object into a plain JSON-able dict."""
    snapshot = metrics.get_snapshot()
    usage = snapshot.accumulated_token_usage
    result = {"accumulated_cost": snapshot.accumulated_cost}
    for field in _TOKEN_FIELDS:
        result[field] = getattr(usage, field, 0) if usage is not None else 0
    return result


def collect_metrics(conversation) -> tuple[dict, dict[str, dict]]:
    """Return ``(combined, per_usage)`` metrics dicts for a conversation.

    ``combined`` aggregates every LLM used in the run; ``per_usage`` breaks the same
    numbers down by ``usage_id`` (e.g. ``"agent"`` vs ``"condenser"``).
    """
    stats = conversation.conversation_stats
    combined = _metrics_to_dict(stats.get_combined_metrics())
    per_usage = {usage_id: _metrics_to_dict(m) for usage_id, m in stats.usage_to_metrics.items()}
    return combined, per_usage


def persist_conversation(
    conversation, conversation_dir: str, combined: dict, per_usage: dict[str, dict], logger
) -> None:
    """Write ``events.jsonl`` and ``metrics.json`` for ``conversation`` to ``conversation_dir``.

    Failures here are non-fatal: a migration result is still useful without its trace.
    """
    os.makedirs(conversation_dir, exist_ok=True)

    try:
        events = list(conversation.state.events)
        events_path = os.path.join(conversation_dir, "events.jsonl")
        with open(events_path, "w", encoding="utf-8") as fh:
            for event in events:
                fh.write(event.model_dump_json() + "\n")
        logger.info(f"Persisted {len(events)} conversation event(s) to {events_path}")
    except Exception as e:
        logger.warning(f"Could not persist conversation events: {e}")

    try:
        metrics_path = os.path.join(conversation_dir, "metrics.json")
        with open(metrics_path, "w", encoding="utf-8") as fh:
            json.dump({"combined": combined, "per_usage": per_usage}, fh, indent=2)
    except Exception as e:
        logger.warning(f"Could not persist conversation metrics: {e}")
