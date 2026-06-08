"""Drive the agent conversation: activity logging, the output nudge loop, the
verify -> fix loop, and the iterative quality-refinement loop."""

import json
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


def _read_critique_score(workspace, remote_critique_path: str, logger) -> tuple[float | None, dict]:
    """Read the critic's JSON report and return ``(average_score, critique)``.

    Returns ``(None, {})`` if the report is missing or unparseable.
    """
    cat = workspace.execute_command(f"cat {remote_critique_path}", timeout=30)
    if cat.exit_code != 0 or not (cat.stdout or "").strip():
        logger.warning(f"Critique report not found at {remote_critique_path}")
        return None, {}
    try:
        critique = json.loads(cat.stdout)
    except json.JSONDecodeError as e:
        logger.warning(f"Could not parse critique JSON: {e}")
        return None, {}
    score = critique.get("average_score")
    if not isinstance(score, (int, float)):
        logger.warning("Critique JSON has no numeric 'average_score'.")
        return None, critique
    return float(score), critique


def run_refine_loop(
    conversation,
    workspace,
    remote_output_dir: str,
    remote_critique_path: str,
    threshold: float,
    max_iterations: int,
    logger,
) -> tuple[float | None, int]:
    """Iteratively critique and improve the migrated extension (quality refinement).

    Each pass delegates to ``extension-critic`` to score ``remote_output_dir`` and write a
    JSON critique to ``remote_critique_path``. While the average score is below
    ``threshold`` and passes remain, the critique is fed back to ``extension-transformer``
    to address. Returns ``(final_score, edit_iterations)`` where ``edit_iterations`` is the
    number of improvement passes the transformer was asked to make.
    """
    score: float | None = None
    edits = 0
    for attempt in range(1, max_iterations + 1):
        conversation.send_message(
            f"""
            Delegate to the `extension-critic` agent to evaluate the QUALITY of the
            migrated extension in `{remote_output_dir}` against the original in
            `/workspace/extension`.

            It must score correctness, completeness, code quality, and MV3 best practices
            (0-100 each) and write a STRICT JSON critique to `{remote_critique_path}` with
            an integer `average_score` and an actionable `issues` list. After it finishes,
            confirm the file exists: `cat {remote_critique_path}`.
            """
        )
        conversation.run()
        score, critique = _read_critique_score(workspace, remote_critique_path, logger)
        logger.info(
            f"Critique pass {attempt}/{max_iterations}: score={score} (threshold {threshold})"
        )

        if score is None:
            logger.warning("No usable critique score; stopping refinement.")
            break
        if score >= threshold:
            logger.info(f"Quality threshold met (score {score} >= {threshold}).")
            break
        if attempt == max_iterations:
            logger.info(f"Reached max refine iterations ({max_iterations}); final score {score}.")
            break

        issues = critique.get("issues", [])
        issue_text = "\n".join(
            f"- [{i.get('severity', '?')}] {i.get('file', '')}: {i.get('problem', '')} "
            f"-> {i.get('fix', '')}"
            for i in issues
        ) or "See the critique report for details."
        logger.info(f"Refining (score {score} < {threshold}); delegating fixes to transformer.")
        conversation.send_message(
            f"""
            The migrated extension scored {score}/100 on quality review (below the target
            of {threshold}). The full critique is at `{remote_critique_path}`. The issues:

            {issue_text}

            Delegate to `extension-transformer` to address these issues in
            `{remote_output_dir}`. Critical constraints:
            - Do NOT drop or disable any functionality to raise the score.
            - Keep the extension a valid, loadable MV3 extension (it currently passes
              verification — do not regress that).
            - Only change what the critique calls out.
            """
        )
        conversation.run()
        edits += 1

    return score, edits
