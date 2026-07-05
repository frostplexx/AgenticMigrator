"""Drive the agent conversation: error surfacing, the output nudge loop, and the
verify -> fix loop. (The quality pass is the goal-completion loop in ``manager``.)"""

import os
import threading
import time

from openhands.sdk.event.conversation_error import ConversationErrorEvent

from . import test_harness, workspace_io

_MAX_NUDGES = 3
_MAX_TEST_ATTEMPTS = 3

# How often to print a "still working" heartbeat while a blocking conversation.run()
# is in flight. Delegation runs the subagent as a nested, server-side conversation whose
# events are NOT streamed to this client, so without a heartbeat a long delegation looks
# frozen (it can be many minutes on a slow/local model). Override with HEARTBEAT_INTERVAL=0
# to disable.
_HEARTBEAT_INTERVAL = int(os.environ.get("HEARTBEAT_INTERVAL", "30"))


def _token_summary(conversation) -> str:
    """Return a compact ``in N/out N · $cost`` token tally, or "" if unavailable.

    Best-effort: the heartbeat must never crash on a stats hiccup mid-run.
    """
    try:
        snap = conversation.conversation_stats.get_combined_metrics().get_snapshot()
        cost = getattr(snap, "accumulated_cost", 0.0) or 0.0
        usage = getattr(snap, "accumulated_token_usage", None)
        if usage is None:
            return f"${cost:.4f}"
        return f"in {usage.prompt_tokens:,}/out {usage.completion_tokens:,} · ${cost:.4f}"
    except Exception:
        return ""


def make_error_logger(logger):
    """Build a conversation callback that surfaces ``ConversationErrorEvent`` at ERROR level.

    The SDK's default visualizer silently skips these fatal server-side failures, and under
    ``--quiet`` (batch workers) there is no visualizer at all — this callback is then the
    only live signal that the run crashed, instead of a generic wrapper error at the end.
    The full event trace is persisted separately to ``conversation/events.jsonl``.
    """
    def error_logger(event):
        if isinstance(event, ConversationErrorEvent):
            logger.error(f"Remote conversation error [{event.code}]: {event.detail}")

    return error_logger


def run_with_heartbeat(conversation, logger, label: str, interval: int = _HEARTBEAT_INTERVAL) -> None:
    """Run ``conversation.run()`` while printing an elapsed-time heartbeat.

    ``conversation.run()`` blocks until the agent (and any subagents it delegates to)
    finish. Subagent steps run in a nested server-side conversation that is not streamed
    back here, so this heartbeat is the only liveness signal during a long delegation.
    """
    if interval <= 0:
        conversation.run()
        return

    stop = threading.Event()
    start = time.monotonic()

    def beat():
        while not stop.wait(interval):
            elapsed = int(time.monotonic() - start)
            tokens = _token_summary(conversation)
            suffix = f" · {tokens}" if tokens else ""
            logger.info(
                f"… {label} still running: {elapsed // 60}m{elapsed % 60:02d}s elapsed{suffix}"
            )

    ticker = threading.Thread(target=beat, name=f"heartbeat-{label}", daemon=True)
    ticker.start()
    try:
        conversation.run()
    finally:
        stop.set()
        ticker.join(timeout=1)
    logger.info(f"✓ {label} finished in {int(time.monotonic() - start)}s")


def run_nudge_loop(conversation, workspace, remote_output_dir: str, logger) -> int:
    """Nudge the agent if it finishes without writing any output files.

    Returns the number of nudges sent (0 if the agent produced output on its own).
    """
    nudges = 0
    for attempt in range(1, _MAX_NUDGES + 1):
        if workspace_io.remote_dir_has_files(workspace, remote_output_dir, logger):
            break

        nudges = attempt
        logger.warning(
            f"Agent finished but {remote_output_dir} is empty (nudge {attempt}/{_MAX_NUDGES})."
        )
        conversation.send_message(
            f"""
            You stopped without completing the task. The directory
            `{remote_output_dir}` is still empty, so nothing will be
            returned to the user.

            Continue the migration task you were given and produce the
            required files inside `{remote_output_dir}` now.

            VERY IMPORTANT — about HOW you reply:
            - Do NOT emit JSON like {{"type": "function", ...}} or
              {{"thought": ...}} as your message content. That is plain
              text and will be ignored — no file will be written.
            - Instead, invoke the tools the normal way (function /
              tool calls). The `file_editor` tool with
              `command="create"` is the right way to write
              `{remote_output_dir}/<name>`.
            - After the tool call succeeds, verify with the
              `terminal` tool (`ls -la {remote_output_dir}` and
              `cat <file>`) that the file is actually on disk with the
              intended contents.
            - Only stop once `{remote_output_dir}` contains the
              finished, migrated extension.
            """
        )
        run_with_heartbeat(conversation, logger, f"nudge {attempt}")
        logger.info(f"Agent status after nudge {attempt}: {conversation.state.execution_status}")
    else:
        logger.error(
            f"Agent never produced output in {remote_output_dir} after {_MAX_NUDGES} nudges; giving up."
        )
    return nudges


def run_test_fix_loop(
    conversation, workspace, remote_output_dir: str, remote_report_path: str, logger
) -> tuple[bool, dict, int]:
    """Verify the migrated extension and ask the agent to fix any errors.

    Returns ``(passed, report, attempts)`` where ``attempts`` is the number of verify
    runs performed and ``report`` is the last verification report.
    """
    passed = False
    report: dict = {}
    for attempt in range(1, _MAX_TEST_ATTEMPTS + 1):
        passed, report = test_harness.run_verify(
            workspace, remote_output_dir, remote_report_path, logger
        )
        if passed:
            logger.info("Migrated extension passed verification.")
            return passed, report, attempt

        if attempt == _MAX_TEST_ATTEMPTS:
            logger.error(
                f"Migrated extension still failing after {_MAX_TEST_ATTEMPTS} test attempts; giving up."
            )
            return passed, report, attempt

        errors = report.get("errors", [])
        error_text = "\n".join(
            f"- ({e.get('source', '?')}) {e.get('text', '')}" for e in errors
        ) or "The extension failed to load (no service worker registered)."

        logger.warning(
            f"Migrated extension failed verification "
            f"(attempt {attempt}/{_MAX_TEST_ATTEMPTS}). Asking agent to fix."
        )
        try:
            _send_fix_request(conversation, remote_output_dir, error_text, logger, attempt)
        except Exception as e:
            # The agent/conversation died mid-fix (server crash, unreachable LLM, …).
            # The verification result we already hold is still real — return it as a
            # verify failure instead of letting the crash erase it into a generic error.
            logger.error(
                f"Agent crashed during fix attempt {attempt}: {e}; "
                f"keeping the last verification result."
            )
            return passed, report, attempt

    return passed, report, _MAX_TEST_ATTEMPTS


def _send_fix_request(conversation, remote_output_dir: str, error_text: str, logger, attempt: int) -> None:
    """Send the verification errors to the agent and run it until it stops."""
    conversation.send_message(
        f"""
        The migrated extension in `{remote_output_dir}` was loaded into
        Chromium and FAILED verification. The following errors were
        captured at runtime:

        {error_text}

        Delegate to `extension-transformer` to fix the migrated files in
        `{remote_output_dir}` so these errors are resolved. Common causes:
        a service worker referencing APIs unavailable in MV3 (DOM/`window`,
        `XMLHttpRequest`), leftover MV2 API calls, an invalid `manifest.json`,
        or an invalid `declarativeNetRequest` `rules.json` (an `extension.load`
        error means Chrome rejected the extension at load time — fix the exact
        key it names).

        Apply the fixes and then stop. Do NOT run the verify script yourself —
        the harness re-verifies automatically and will send you any remaining
        errors. Just make the fixes.
        """
    )
    run_with_heartbeat(conversation, logger, f"fix attempt {attempt}")
    logger.info(f"Agent status after fix attempt {attempt}: {conversation.state.execution_status}")

