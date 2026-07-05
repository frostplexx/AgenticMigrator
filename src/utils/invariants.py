"""Invariant checks and conservative repairs for the migration pipeline.

The pipeline crosses several trust boundaries — user-supplied extension paths, the
vendored converter, an LLM agent in a remote container, tar transfers, and append-only
result files that a crash can truncate mid-line. Each boundary can hand back an invalid
or broken state, and each check here names the invariant that must hold on the way
through.

Checkers return a list of human-readable violations (empty means the invariant holds)
so each caller can pick the right recovery: fail fast at the start of a run, fall back
to a known-good input, or downgrade an over-optimistic result. ``reconcile_result``
is the repair step: it makes a ``MigrationResult`` self-consistent before it is
serialized, always erring toward reporting *less* success rather than more.
"""

import json
import os

VALID_STATUSES = ("success", "verify_failed", "error")


def manifest_violations(directory: str, *, require_v3: bool = False) -> list[str]:
    """Violations of "``directory`` holds a structurally loadable extension".

    Checks that the directory exists and contains a ``manifest.json`` that parses to a
    JSON object; with ``require_v3`` it must also declare ``manifest_version: 3``.
    """
    if not os.path.isdir(directory):
        return [f"not a directory: {directory}"]
    manifest_path = os.path.join(directory, "manifest.json")
    if not os.path.isfile(manifest_path):
        return [f"manifest.json missing from {directory}"]
    try:
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
    except (OSError, ValueError) as e:
        return [f"manifest.json in {directory} is not valid JSON: {e}"]
    if not isinstance(manifest, dict):
        return [f"manifest.json in {directory} is not a JSON object"]
    if require_v3 and manifest.get("manifest_version") != 3:
        return [
            f"manifest_version must be 3, got {manifest.get('manifest_version')!r} "
            f"in {directory}"
        ]
    return []


def check_extension_input(path: str) -> list[str]:
    """Input invariant: the extension to migrate must be a directory with a parseable
    manifest.json — anything else fails every later stage in a confusing way, so it is
    rejected up front with the concrete reason."""
    return manifest_violations(path)


def check_migrated_output(path: str) -> list[str]:
    """Output invariant: a migration reported as successful must be backed by a local
    MV3 extension (manifest.json present, parseable, ``manifest_version: 3``). Remote
    verification passing is not enough — the artifact also has to survive the download."""
    return manifest_violations(path, require_v3=True)


def reconcile_result(result, logger) -> None:
    """Make a ``MigrationResult`` self-consistent before it is serialized.

    Cross-field invariants:

    - ``status`` is one of ``VALID_STATUSES``;
    - ``status == "success"``  ⇒  ``verify_passed`` is True;
    - ``status == "error"``    ⇒  ``error`` carries a message.

    Repairs are conservative — a contradiction always downgrades toward failure, never
    upgrades toward success — and every repair is logged as an invariant violation so
    the underlying bug stays visible.
    """
    if result.status not in VALID_STATUSES:
        logger.error(
            f"[{result.extension_name}] invariant repair: unknown status "
            f"{result.status!r} -> 'error'"
        )
        result.error = result.error or f"internal: unknown result status {result.status!r}"
        result.status = "error"

    if result.status == "success" and not result.verify_passed:
        logger.error(
            f"[{result.extension_name}] invariant repair: status 'success' without a "
            f"passing verification -> 'verify_failed'"
        )
        result.status = "verify_failed"

    if result.status == "error" and not result.error:
        result.error = "unknown error (no exception message was captured)"
