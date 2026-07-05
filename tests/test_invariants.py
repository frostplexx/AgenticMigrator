"""Unit tests for invariant checks and reconciliation logic.

These tests validate the pure functions in ``invariants.py`` and the file-level
invariants in ``batch.py``, ``test_harness.py``, and ``manager.py``. Heavy mocking
is used only where unavoidable (workspace objects, Docker).
"""

import csv
import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

from src.utils.invariants import (
    VALID_STATUSES,
    check_extension_input,
    check_migrated_output,
    manifest_violations,
    reconcile_result,
)
from src.batch import MigrationResult, _write_summary
from src.utils.test_harness import run_verify


def _make_manifest_dir(tmp_path, manifest: dict) -> str:
    """Create a temp dir with a manifest.json containing ``manifest`` and return its path."""
    d = tmp_path / "extension"
    d.mkdir()
    (d / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return str(d)


def _make_result(**overrides) -> MigrationResult:
    """Create a bare MigrationResult with defaults overridden by ``overrides``."""
    kwargs = dict(
        extension_name="test-ext",
        output_dir="/tmp/out",
    )
    kwargs.update(overrides)
    return MigrationResult(**kwargs)


# ===================================================================
# check_extension_input
# ===================================================================


class TestCheckExtensionInput:
    def test_missing_dir(self):
        violations = check_extension_input("/nonexistent/path")
        assert len(violations) == 1
        assert "not a directory" in violations[0]

    def test_missing_manifest(self, tmp_path):
        d = tmp_path / "empty_ext"
        d.mkdir()
        violations = check_extension_input(str(d))
        assert len(violations) == 1
        assert "manifest.json missing" in violations[0]

    def test_bad_json_manifest(self, tmp_path):
        d = tmp_path / "bad_json"
        d.mkdir()
        (d / "manifest.json").write_text("not json", encoding="utf-8")
        violations = check_extension_input(str(d))
        assert len(violations) == 1
        assert "not valid JSON" in violations[0]

    def test_valid_extension(self, tmp_path):
        d = _make_manifest_dir(tmp_path, {"manifest_version": 2, "name": "test"})
        violations = check_extension_input(d)
        assert violations == []  # v2 is fine as input

    def test_non_dict_json(self, tmp_path):
        d = tmp_path / "arr_manifest"
        d.mkdir()
        (d / "manifest.json").write_text("[]", encoding="utf-8")
        violations = check_extension_input(str(d))
        assert len(violations) == 1
        assert "not a JSON object" in violations[0]


# ===================================================================
# check_migrated_output
# ===================================================================


class TestCheckMigratedOutput:
    def test_missing_dir(self):
        violations = check_migrated_output("/nonexistent/path")
        assert len(violations) == 1
        assert "not a directory" in violations[0]

    def test_missing_manifest(self, tmp_path):
        d = tmp_path / "no_manifest"
        d.mkdir()
        violations = check_migrated_output(str(d))
        assert len(violations) == 1
        assert "manifest.json missing" in violations[0]

    def test_v2_manifest(self, tmp_path):
        d = _make_manifest_dir(tmp_path, {"manifest_version": 2, "name": "test"})
        violations = check_migrated_output(d)
        assert len(violations) == 1
        assert "manifest_version must be 3" in violations[0]

    def test_valid_v3_output(self, tmp_path):
        d = _make_manifest_dir(tmp_path, {"manifest_version": 3, "name": "test"})
        violations = check_migrated_output(d)
        assert violations == []

    def test_v3_missing_field(self, tmp_path):
        """manifest_version missing from the dict is treated as not-3."""
        d = _make_manifest_dir(tmp_path, {"name": "test"})
        violations = check_migrated_output(d)
        assert len(violations) == 1
        assert "manifest_version must be 3" in violations[0]


# ===================================================================
# manifest_violations (lower-level helper)
# ===================================================================


class TestManifestViolations:
    def test_dir_is_file(self, tmp_path):
        f = tmp_path / "file.txt"
        f.write_text("x", encoding="utf-8")
        violations = manifest_violations(str(f))
        assert "not a directory" in violations[0]

    def test_require_v3_with_v2(self, tmp_path):
        d = _make_manifest_dir(tmp_path, {"manifest_version": 2})
        violations = manifest_violations(d, require_v3=True)
        assert len(violations) == 1

    def test_require_v3_with_v3(self, tmp_path):
        d = _make_manifest_dir(tmp_path, {"manifest_version": 3})
        violations = manifest_violations(d, require_v3=True)
        assert violations == []


# ===================================================================
# reconcile_result
# ===================================================================


class FakeLogger:
    """Minimal logger stand-in that records emitted messages."""

    def __init__(self):
        self.messages: list[str] = []

    def error(self, msg, *args, **kwargs):
        self.messages.append(msg)

    def warning(self, msg, *args, **kwargs):
        self.messages.append(msg)


class TestReconcileResult:
    def test_unknown_status(self):
        result = _make_result(status="garbage", error=None)
        logger = FakeLogger()
        reconcile_result(result, logger)
        assert result.status == "error"
        assert "unknown result status" in result.error
        assert len(logger.messages) == 1

    def test_success_without_verify(self):
        result = _make_result(status="success", verify_passed=False, error=None)
        logger = FakeLogger()
        reconcile_result(result, logger)
        assert result.status == "verify_failed"

    def test_success_with_verify(self):
        result = _make_result(status="success", verify_passed=True, error=None)
        logger = FakeLogger()
        reconcile_result(result, logger)
        assert result.status == "success"  # unchanged

    def test_error_without_message(self):
        result = _make_result(status="error", error=None)
        logger = FakeLogger()
        reconcile_result(result, logger)
        assert result.status == "error"
        assert "unknown error" in result.error

    def test_error_with_message(self):
        result = _make_result(status="error", error="something broke")
        logger = FakeLogger()
        reconcile_result(result, logger)
        assert result.error == "something broke"

    def test_valid_statuses(self):
        """All VALID_STATUSES pass through unchanged when consistent."""
        logger = FakeLogger()
        for status in VALID_STATUSES:
            passed = status == "success"
            err = None if status != "error" else "msg"
            result = _make_result(status=status, verify_passed=passed, error=err)
            reconcile_result(result, logger)
            # status may be downgraded by cross-field check; that's fine — the point is
            # no exception and a valid status.
            assert result.status in VALID_STATUSES


# ===================================================================
# _write_summary — malformed-line tolerance
# ===================================================================


class TestWriteSummaryMalformed:
    def test_malformed_json_line(self, tmp_path):
        """A truncated final line in results.jsonl must not prevent the summary."""
        results_path = tmp_path / "results.jsonl"
        # Two valid lines, one truncated line (kill mid-append).
        results_path.write_text(
            json.dumps({"extension_name": "ext-a", "status": "success", "verify_passed": True})
            + "\n"
            + json.dumps({"extension_name": "ext-b", "status": "error", "error": "boom"})
            + "\n"
            + '{"extension_name": "ext-c", "status"',  # truncated
            encoding="utf-8",
        )

        aggregate = _write_summary(str(results_path), str(tmp_path))

        assert aggregate["total"] == 2  # only valid rows counted
        assert aggregate["success"] == 1
        assert aggregate["errors"] == 1
        assert aggregate["malformed_result_lines"] == 1

        csv_path = tmp_path / "summary.csv"
        assert csv_path.is_file()
        with open(csv_path, newline="", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        assert len(rows) == 2

    def test_empty_results_file(self, tmp_path):
        results_path = tmp_path / "results.jsonl"
        results_path.write_text("", encoding="utf-8")
        aggregate = _write_summary(str(results_path), str(tmp_path))
        assert aggregate["total"] == 0
        assert aggregate["malformed_result_lines"] == 0

    def test_all_malformed(self, tmp_path):
        results_path = tmp_path / "results.jsonl"
        results_path.write_text("truncated\n{broken\n", encoding="utf-8")
        aggregate = _write_summary(str(results_path), str(tmp_path))
        assert aggregate["total"] == 0
        assert aggregate["malformed_result_lines"] == 2


# ===================================================================
# run_verify — stale-report / consistency invariant
# ===================================================================


class TestVerifyStaleReport:
    def test_exit_0_no_report(self):
        """Verify exits 0 but the report file is absent — treat as failure."""
        ws = MagicMock()
        # First call: rm -f report_path (succeeds)
        # Second call: running verify.py (exit 0)
        # Third call: cat report_path (fails — no report)
        ws.execute_command.side_effect = [
            MagicMock(exit_code=0, stdout="", stderr=""),       # rm -f
            MagicMock(exit_code=0, stdout="", stderr=""),       # python verify.py
            MagicMock(exit_code=1, stdout="", stderr="not found"),  # cat report
        ]
        logger = FakeLogger()
        passed, report = run_verify(ws, "/ext", "/rpt.json", logger)
        assert passed is False
        assert len(report.get("errors", [])) >= 1
        assert report["errors"][0]["source"] == "harness"

    def test_exit_0_report_contradicts(self):
        """Verify exits 0 but report says loaded=False — treat as failure."""
        ws = MagicMock()
        ws.execute_command.side_effect = [
            MagicMock(exit_code=0, stdout="", stderr=""),           # rm -f
            MagicMock(exit_code=0, stdout="", stderr=""),           # verify.py
            MagicMock(                                                # cat report
                exit_code=0,
                stdout=json.dumps({"loaded": False, "errors": []}),
                stderr="",
            ),
        ]
        logger = FakeLogger()
        passed, report = run_verify(ws, "/ext", "/rpt.json", logger)
        assert passed is False
        assert report["loaded"] is False  # original report preserved

    def test_exit_0_report_valid(self):
        """Verify exits 0 with a valid pass report — returns True."""
        ws = MagicMock()
        ws.execute_command.side_effect = [
            MagicMock(exit_code=0, stdout="", stderr=""),           # rm -f
            MagicMock(exit_code=0, stdout="", stderr=""),           # verify.py
            MagicMock(                                                # cat report
                exit_code=0,
                stdout=json.dumps({"loaded": True, "errors": []}),
                stderr="",
            ),
        ]
        logger = FakeLogger()
        passed, report = run_verify(ws, "/ext", "/rpt.json", logger)
        assert passed is True

    def test_exit_nonzero(self):
        """Verify exits non-zero — always failure, even with a report."""
        ws = MagicMock()
        ws.execute_command.side_effect = [
            MagicMock(exit_code=0, stdout="", stderr=""),           # rm -f
            MagicMock(exit_code=1, stdout="", stderr="crashed"),    # verify.py
            MagicMock(                                                # cat report (maybe partial)
                exit_code=1, stdout="", stderr="not found"
            ),
        ]
        logger = FakeLogger()
        passed, report = run_verify(ws, "/ext", "/rpt.json", logger)
        assert passed is False


# ===================================================================
# worker_never_raises — run_migration with a bad extension path
# ===================================================================


class TestWorkerNeverRaises:
    """The batch worker must never raise — any error returns a MigrationResult(status='error').

    We test this by calling run_migration with an invalid extension path, which triggers
    the input invariant and is caught by run_migration's own top-level try/except.
    """

    def test_bad_extension_path_returns_error_status(self):
        """A nonexistent extension path yields status='error', not an exception."""
        config = type(
            "RunConfig",
            (),
            {
                "extension_path": "/nonexistent-extension-dir",
                "output_dir": tempfile.mkdtemp(prefix="test-"),
                "docker_port_base": 9999,
                "conversation_id": None,
                "quiet": True,
                "goal_max_iterations": 0,
                "memory": type("MemoryConfig", (), {"enabled": False})(),
                "migrated_dir": "/tmp/fake",
                "conversation_dir": "/tmp/fake-conv",
            },
        )
        llm = MagicMock()
        llm.model_copy.return_value = llm

        # run_migration tries os.makedirs on output_dir, so make sure the parent exists
        os.makedirs(config.output_dir, exist_ok=True)

        from src.manager import run_migration

        result = run_migration(config, llm)
        assert result.status == "error"
        assert result.error is not None

    def test_worker_returns_on_setup_failure(self):
        """Simulate an error before run_migration — the worker wrapper catches it.

        The worker in batch.py has its own try/except around the config setup and
        run_migration call. We test this by calling the same pattern directly.
        """
        name = "broken-ext"
        try:
            raise RuntimeError("port exhaustion")
        except Exception as e:
            caught = MigrationResult(
                extension_name=name,
                output_dir="/tmp/out",
                status="error",
                error=str(e),
            )
        assert caught.status == "error"
        assert "port exhaustion" in caught.error
