"""Drive the agent conversation: activity logging, the output nudge loop, and the
verify -> fix loop."""

import os
import time

from openhands.sdk.event import ActionEvent, ObservationEvent, MessageEvent

from . import test_harness, workspace_io

_MAX_NUDGES = 3
_MAX_TEST_ATTEMPTS = 3


def make_activity_logger(agent_log_dir: str):
    """Build a conversation callback that logs agent activity to files (tmux monitoring)."""
    def agent_activity_logger(event):
        agent_name = "main"
        if isinstance(event, (ActionEvent, ObservationEvent)):
            if getattr(event, "tool_name", None) == "delegate":
                agent_name = "delegation"

        log_file = os.path.join(agent_log_dir, f"{agent_name}.log")
        timestamp = time.strftime("%H:%M:%S")
        with open(log_file, "a") as f:
            if isinstance(event, ActionEvent):
                f.write(f"[{timestamp}] ACTION: {event.tool_name}\n")
                if hasattr(event, "summary"):
                    f.write(f"  Summary: {event.summary}\n")
            elif isinstance(event, ObservationEvent):
                f.write(f"[{timestamp}] RESULT: {event.tool_name}\n")
            elif isinstance(event, MessageEvent):
                f.write(f"[{timestamp}] MESSAGE\n")
            f.flush()

    return agent_activity_logger


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
        conversation.run()
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
        conversation.send_message(
            f"""
            The migrated extension in `{remote_output_dir}` was loaded into
            Chromium and FAILED verification. The following errors were
            captured at runtime:

            {error_text}

            Delegate to `extension-transformer` to fix the migrated files in
            `{remote_output_dir}` so these runtime errors are resolved. Common
            causes: a service worker referencing APIs unavailable in MV3
            (DOM/`window`, `XMLHttpRequest`), leftover MV2 API calls, or an
            invalid `manifest.json`.

            Re-run the `verify` skill to confirm the fix:
              `python {test_harness.VERIFY_SCRIPT} {remote_output_dir} {remote_report_path}`

            Do not stop until verification passes (exit code 0).
            """
        )
        conversation.run()
        logger.info(f"Agent status after fix attempt {attempt}: {conversation.state.execution_status}")

    return passed, report, _MAX_TEST_ATTEMPTS
