"""Download migration artifacts from the workspace and build the diff patch."""

import difflib
import json
import os

from . import workspace_io

# Files that live in the output root but are not part of the extension diff.
_PATCH_EXCLUDE = {"analysis.json", "migration.patch", "critique.json"}


def download_outputs(
    workspace,
    *,
    remote_output_dir: str,
    local_output_dir: str,
    local_output_root: str,
    remote_root: str,
    remote_report_path: str,
    extension_path: str,
    logger,
    remote_critique_path: str | None = None,
) -> None:
    """Download the migrated extension and analysis.json (and the critique report when
    refinement ran), print summaries, and generate the migration patch. The verification
    report is summarized to the console but not saved as an artifact."""
    try:
        workspace_io.download_directory(workspace, remote_output_dir, local_output_dir, logger)
    except Exception as e:
        logger.error(f"Failed to download workspace output: {e}")

    os.makedirs(local_output_root, exist_ok=True)

    _download_and_print_analysis(workspace, remote_root, local_output_root, logger)
    _print_report_summary(workspace, remote_report_path, logger)
    if remote_critique_path:
        _download_critique(workspace, remote_critique_path, local_output_root, logger)

    try:
        patch_path = os.path.join(local_output_root, "migration.patch")
        generate_patch(extension_path, local_output_dir, patch_path, logger)
    except Exception as e:
        logger.error(f"Failed to generate patch: {e}")


def _download_and_print_analysis(workspace, remote_root, local_output_root, logger) -> None:
    local_analysis = os.path.join(local_output_root, "analysis.json")
    try:
        result = workspace.file_download(
            source_path=f"{remote_root}/analysis.json",
            destination_path=local_analysis,
        )
        if result.error is not None:
            logger.warning(f"analysis.json not available: {result.error}")
            return
        with open(local_analysis) as f:
            analysis = json.load(f)
        print("\n--- Migration Analysis ---")
        print(json.dumps(analysis, indent=2))
        print("-------------------------\n")
    except Exception as e:
        logger.error(f"Failed to download analysis.json: {e}")


def _print_report_summary(workspace, remote_report_path, logger) -> None:
    """Print the verification summary. The report is read in-memory and not saved as an
    output artifact (the result is already captured in MigrationResult)."""
    try:
        cat = workspace.execute_command(f"cat {remote_report_path}", timeout=30)
        if cat.exit_code != 0 or not (cat.stdout or "").strip():
            logger.warning("test_report.json not available")
            return
        report = json.loads(cat.stdout)
        n_errors = len(report.get("errors", []))
        status = "PASSED" if report.get("loaded") and n_errors == 0 else "FAILED"
        print(f"\n--- Extension Verification: {status} ---")
        print(
            f"loaded={report.get('loaded')}, "
            f"extensionId={report.get('extensionId')}, "
            f"errors={n_errors}, "
            f"warnings={len(report.get('warnings', []))}"
        )
        print("----------------------------------\n")
    except Exception as e:
        logger.error(f"Failed to read test report: {e}")


def _download_critique(workspace, remote_critique_path, local_output_root, logger) -> None:
    local_critique = os.path.join(local_output_root, "critique.json")
    try:
        result = workspace.file_download(
            source_path=remote_critique_path,
            destination_path=local_critique,
        )
        if result.error is not None:
            logger.info(f"critique.json not available: {result.error}")
            return
        with open(local_critique) as f:
            critique = json.load(f)
        print(
            f"\n--- Quality Critique: average {critique.get('average_score')}/100 ---\n"
            f"{critique.get('summary', '')}\n----------------------------------\n"
        )
    except Exception as e:
        logger.warning(f"Failed to download critique.json: {e}")


def generate_patch(original_dir: str, migrated_dir: str, patch_path: str, logger) -> None:
    """Write a unified diff between original_dir and migrated_dir to patch_path."""
    def collect_files(directory: str) -> set[str]:
        result = set()
        for root, _, files in os.walk(directory):
            for f in files:
                rel = os.path.relpath(os.path.join(root, f), directory)
                if rel not in _PATCH_EXCLUDE:
                    result.add(rel)
        return result

    all_files = sorted(collect_files(original_dir) | collect_files(migrated_dir))
    patch_lines: list[str] = []

    for rel_path in all_files:
        orig_path = os.path.join(original_dir, rel_path)
        migr_path = os.path.join(migrated_dir, rel_path)
        orig_lines = _read_lines(orig_path)
        migr_lines = _read_lines(migr_path)

        diff = list(
            difflib.unified_diff(
                orig_lines, migr_lines, fromfile=f"a/{rel_path}", tofile=f"b/{rel_path}"
            )
        )
        if diff:
            patch_lines.extend(diff)

    os.makedirs(os.path.dirname(patch_path), exist_ok=True)
    with open(patch_path, "w", encoding="utf-8") as fh:
        fh.writelines(patch_lines)

    changed = sum(1 for line in patch_lines if line.startswith("--- "))
    logger.info(f"Patch written to {patch_path} ({changed} file(s) changed)")
    print(f"\nPatch written to {patch_path} ({changed} file(s) changed)")


def _read_lines(path: str) -> list[str]:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.readlines()
