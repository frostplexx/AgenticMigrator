"""Locate the agent-server image's bundled Chromium and run the extension smoke-test
harness inside the remote Docker workspace.

All work happens in the container via ``workspace.execute_command``. The Node harness
itself lives in ``src/workspace/harness/`` and is uploaded with the rest of the workspace
scaffolding, so it is available at ``/workspace/harness/`` at runtime.

We use the Chromium that ships in the agent-server image rather than downloading Chrome
for Testing: Chrome for Testing has no native ARM64 Linux build, and the amd64 build
crashes during CDP automation under emulation on Apple Silicon. The bundled Chromium is
native to the container and stable; pin its version by pinning the agent-server image tag.
"""

import json

HARNESS_DIR = "/workspace/harness"
HARNESS_SCRIPT = f"{HARNESS_DIR}/test_extension.mjs"

_NPM_INSTALL_TIMEOUT = 600
_SMOKE_TEST_TIMEOUT = 180

# Candidate locations for the bundled Chromium binary (CHROME_BIN is set in the image).
_CHROME_CANDIDATES = (
    "$CHROME_BIN",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
)


def detect_chrome(workspace, logger) -> str:
    """Return the path to the Chromium/Chrome binary bundled in the container image."""
    probe = " || ".join(f"command -v {c}" for c in _CHROME_CANDIDATES)
    result = workspace.execute_command(probe, timeout=30)
    chrome_bin = (result.stdout or "").strip().splitlines()[0].strip() if result.stdout else ""

    if result.exit_code != 0 or not chrome_bin:
        raise RuntimeError(
            "No Chromium/Chrome binary found in the container image "
            f"(checked: {', '.join(_CHROME_CANDIDATES)})."
        )

    version = workspace.execute_command(f"{chrome_bin} --version", timeout=30)
    logger.info(
        f"Using bundled browser at {chrome_bin} ({(version.stdout or '').strip()})"
    )
    return chrome_bin


def install_harness_deps(workspace, logger) -> None:
    """Install the Node harness dependencies (puppeteer-core) inside the container."""
    logger.info("Installing test-harness dependencies (npm install)...")
    result = workspace.execute_command(
        f"cd {HARNESS_DIR} && PUPPETEER_SKIP_DOWNLOAD=1 npm install --no-audit --no-fund",
        timeout=_NPM_INSTALL_TIMEOUT,
    )
    if result.exit_code != 0:
        raise RuntimeError(
            f"Failed to install harness dependencies "
            f"(exit={result.exit_code}): {result.stderr}"
        )


def run_smoke_test(
    workspace, extension_dir: str, chrome_bin: str, report_path: str, logger
) -> tuple[bool, dict]:
    """Run the smoke-test harness against ``extension_dir``.

    Returns ``(passed, report)`` where ``report`` is the parsed JSON report (empty dict
    if it could not be read). ``passed`` is True only when the harness exits 0.
    """
    logger.info(f"Running extension smoke test against {extension_dir}...")
    result = workspace.execute_command(
        f"node {HARNESS_SCRIPT} {extension_dir} {chrome_bin} {report_path}",
        timeout=_SMOKE_TEST_TIMEOUT,
    )
    passed = result.exit_code == 0
    logger.info(
        f"Smoke test exit={result.exit_code}\n{(result.stdout or '').strip()}"
    )

    report: dict = {}
    cat = workspace.execute_command(f"cat {report_path}", timeout=30)
    if cat.exit_code == 0 and (cat.stdout or "").strip():
        try:
            report = json.loads(cat.stdout)
        except json.JSONDecodeError as e:
            logger.warning(f"Could not parse test report JSON: {e}")
    else:
        logger.warning(f"Test report not found at {report_path}")

    return passed, report
