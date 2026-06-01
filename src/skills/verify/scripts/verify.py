#!/usr/bin/env python3
"""Verify a migrated Manifest V3 Chrome extension.

Loads the extension in a real (headed) Chromium, actively exercises it along the surface
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

Module layout (same directory):
    report.py          - the Report model (errors/warnings/logs + pass/fail)
    browser_session.py - headed Chromium launch + service-worker/page error capture
    exerciser.py       - Tier A manifest-driven exercising
    coverage_check.py  - static chrome.* namespace coverage diff
"""

import json
import os
import sys

from browser_session import BrowserSession
from coverage_check import check_namespace_coverage
from exerciser import exercise
from report import Report

COLLECT_S = 5


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: verify.py <migrated-dir> [report-path] [original-dir]", file=sys.stderr)
        return 2

    migrated_dir = os.path.abspath(sys.argv[1])
    report_path = (
        os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else "/workspace/test_report.json"
    )
    # The original (pre-migration) extension, for the coverage check. Defaults to the
    # sibling `extension/` dir (e.g. /workspace/extension when verifying /workspace/out).
    if len(sys.argv) > 3:
        original_dir = os.path.abspath(sys.argv[3])
    else:
        original_dir = os.path.join(os.path.dirname(migrated_dir.rstrip("/")), "extension")

    report = Report()

    # --- Runtime check: load, exercise, capture errors ---
    with BrowserSession(migrated_dir, report) as session:
        session.wait_for_service_worker()
        if report.extension_id:
            exercise(session, migrated_dir, report.extension_id)
        session.drain_service_worker(COLLECT_S)

    if not report.loaded:
        report.error(
            "verify",
            "Extension service worker never registered — the extension failed to load. "
            "Check manifest.json (manifest_version, background.service_worker) and look "
            "for top-level errors in the service worker.",
        )

    # --- Static coverage check: did the migration drop functionality? ---
    if os.path.isdir(original_dir) and os.path.abspath(original_dir) != migrated_dir:
        dropped = check_namespace_coverage(original_dir, migrated_dir)
        report.dropped_namespaces = dropped
        for d in dropped:
            report.error(
                "coverage",
                f"`chrome.{d['namespace']}` was used in the original "
                f"({d['file']}:{d['line']}: {d['snippet']}) but is gone from the migrated "
                f"extension and no MV3 replacement is present. Migrate this functionality "
                f"instead of deleting it (e.g. blocking chrome.webRequest -> "
                f"chrome.declarativeNetRequest rules in the manifest).",
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
