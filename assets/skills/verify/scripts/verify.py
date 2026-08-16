#!/usr/bin/env python3
"""Verify a migrated Manifest V3 Chrome extension.

Loads the extension in Chromium, actively exercises it along the surface
declared in its manifest (content scripts, popup/options pages, web-accessible resources)
so use-time errors surface, and captures runtime errors from the service worker and pages.
It also runs a static API-coverage check so the migration cannot pass by deleting
functionality.

Usage:
    verify.py <migrated-dir> [report-path] [original-dir]

`original-dir` defaults to the sibling `extension/` directory of the migrated dir
(i.e. /workspace/extension when verifying /workspace/out). If it does not exist, the
coverage check is skipped.

Writes a JSON report and exits non-zero if the extension failed to load or any errors
were captured.
"""

import json
import os
import sys

from browser_session import BrowserSession, capture_load_errors
from exerciser import exercise
from report import Report

COLLECT_S = 5


def preflight_manifest(migrated_dir: str, report: Report) -> bool:
    """Cheap checks before launching Chrome. Returns False (and records an error) if the
    extension is obviously unloadable — a missing/invalid manifest.json can make Chrome
    refuse to start, which would otherwise crash the browser launch. Catching it here keeps
    verification fast and always returns a usable report."""
    manifest_path = os.path.join(migrated_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        report.error("manifest", "manifest.json is missing from the extension output.")
        return False
    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        report.error("manifest", f"manifest.json is not valid JSON: {e}")
        return False
    if manifest.get("manifest_version") != 3:
        report.error(
            "manifest",
            f"manifest_version must be 3, got {manifest.get('manifest_version')!r}.",
        )
        return False
    return True


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: verify.py <migrated-dir> [report-path] [original-dir]", file=sys.stderr)
        return 2

    migrated_dir = os.path.abspath(sys.argv[1])
    report_path = (
        os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else "/workspace/test_report.json"
    )

    report = Report()

    # --- Pre-flight: a broken manifest can make Chrome refuse to start, so check it
    # before launching the browser. If it's unloadable, skip the browser entirely. ---
    if preflight_manifest(migrated_dir, report):
        # --- Runtime check: load, exercise, capture errors. Never let a browser launch
        # failure crash the script — we must always write a report. ---
        try:
            with BrowserSession(migrated_dir, report) as session:
                session.wait_for_service_worker()
                if report.extension_id:
                    exercise(session, migrated_dir, report.extension_id)
                session.drain_service_worker(COLLECT_S)
        except Exception as e:
            # Chrome failed to launch or crashed (often a bad manifest). Pull any reason
            # Chrome managed to log, and record the failure rather than crashing.
            capture_load_errors(report)
            report.error("verify", f"Chrome failed to launch or crashed during verification: {e}")

    if not report.loaded and not report.errors:
        # Fallback only when nothing more specific was captured.
        report.error(
            "verify",
            "Extension service worker never registered — the extension failed to load. "
            "Check manifest.json (manifest_version, background.service_worker) and look "
            "for top-level errors in the service worker.",
        )

    with open(report_path, "w") as f:
        json.dump(report.to_dict(), f, indent=2)

    print(
        f"Extension verify {'PASSED' if report.passed else 'FAILED'} — "
        f"loaded={report.loaded}, errors={len(report.errors)}, "
        f"warnings={len(report.warnings)}"
    )
    for e in report.errors:
        print(f"  [error] ({e['source']}) {e['text']}")
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
