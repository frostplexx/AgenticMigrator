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

    Returns ``(passed, report)`` where ``report`` is the parsed JSON report (empty dict
    if it could not be read). ``passed`` is True only when the script exits 0.
    """
    logger.info(f"Verifying migrated extension in {extension_dir}...")
    result = workspace.execute_command(
        f"python {VERIFY_SCRIPT} {extension_dir} {report_path}",
        timeout=_VERIFY_TIMEOUT,
    )
    passed = result.exit_code == 0
    logger.info(f"Verify exit={result.exit_code}\n{(result.stdout or '').strip()}")

    report: dict = {}
    cat = workspace.execute_command(f"cat {report_path}", timeout=30)
    if cat.exit_code == 0 and (cat.stdout or "").strip():
        try:
            report = json.loads(cat.stdout)
        except json.JSONDecodeError as e:
            logger.warning(f"Could not parse verify report JSON: {e}")
    else:
        logger.warning(f"Verify report not found at {report_path}")

    return passed, report
