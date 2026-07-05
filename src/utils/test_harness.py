"""Run the extension verification skill inside the remote Docker workspace.

The verification logic lives in the `verify` skill at
``/workspace/.openhands/skills/verify/scripts/verify.py`` (uploaded with the workspace
scaffolding). It launches the container's bundled Chromium via Playwright, loads the
migrated extension, and reports runtime errors. This module installs the skill's Python
dependencies and runs it for the manager-side authoritative gate.

Chrome for Testing is intentionally not used: it has no native ARM64 Linux build, and the
amd64 build crashes during automation under emulation on Apple Silicon. The bundled
Chromium is native and stable; pin its version by pinning the agent-server image tag.
"""

import json
import shlex

VERIFY_SCRIPT = "/workspace/.openhands/skills/verify/scripts/verify.py"

_PIP_INSTALL_TIMEOUT = 600
_VERIFY_TIMEOUT = 180


def install_verify_deps(workspace, logger) -> None:
    """Install the verify skill's Python dependencies (Playwright + websocket-client).

    We rely on the Chromium already bundled in the image, so Playwright's own browser
    download is skipped (the script launches Chromium via ``executable_path``).
    """
    logger.info("Installing verify-skill dependencies (playwright, websocket-client)...")
    result = workspace.execute_command(
        "pip install --quiet --break-system-packages playwright websocket-client",
        timeout=_PIP_INSTALL_TIMEOUT,
    )
    if result.exit_code != 0:
        raise RuntimeError(
            f"Failed to install verify dependencies "
            f"(exit={result.exit_code}): {result.stderr}"
        )


def run_verify(
    workspace, extension_dir: str, report_path: str, logger
) -> tuple[bool, dict]:
    """Run the verify skill against ``extension_dir``.

    Returns ``(passed, report)`` where ``report`` is the parsed JSON report. ``passed``
    requires both the script exiting 0 *and* a report that backs the pass up (loaded,
    zero errors) — an exit code alone can lie when the run breaks mid-way.
    """
    logger.info(f"Verifying migrated extension in {extension_dir}...")
    # Fresh-report invariant: the report we read must come from *this* verify run. If a
    # previous attempt's report survived and this run crashes before writing its own,
    # the stale file would be read as current — reporting errors already fixed, or worse,
    # a pass that never happened.
    workspace.execute_command(f"rm -f {shlex.quote(report_path)}", timeout=30)

    result = workspace.execute_command(
        f"python {VERIFY_SCRIPT} {shlex.quote(extension_dir)} {shlex.quote(report_path)}",
        timeout=_VERIFY_TIMEOUT,
    )
    logger.info(f"Verify exit={result.exit_code}\n{(result.stdout or '').strip()}")

    report: dict = {}
    cat = workspace.execute_command(f"cat {shlex.quote(report_path)}", timeout=30)
    if cat.exit_code == 0 and (cat.stdout or "").strip():
        try:
            parsed = json.loads(cat.stdout)
            if isinstance(parsed, dict):
                report = parsed
            else:
                logger.warning(f"Verify report is not a JSON object: {type(parsed).__name__}")
        except json.JSONDecodeError as e:
            logger.warning(f"Could not parse verify report JSON: {e}")
    else:
        logger.warning(f"Verify report not found at {report_path}")

    passed = result.exit_code == 0
    # Pass/report consistency invariant: a pass claim must be corroborated by a report
    # saying the extension loaded with zero errors. Exit 0 with a missing or
    # contradicting report means the verify run itself broke — treat it as a failure
    # with an actionable error instead of a silent false positive.
    if passed and not (report.get("loaded") and not report.get("errors")):
        logger.error(
            "Verify exited 0 but the report is missing or contradicts the pass; "
            "treating the run as failed."
        )
        passed = False
        if not report.get("errors"):
            report.setdefault("errors", []).append(
                {
                    "source": "harness",
                    "text": "verification produced no usable report — the verify run "
                    "itself failed, so the extension cannot be considered verified",
                }
            )

    return passed, report
