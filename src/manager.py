"""The migration unit of work.

``run_migration(config, llm)`` migrates a single extension and returns a
``MigrationResult`` describing the outcome (status, verification, token/cost metrics,
artifact locations). It is deliberately:

- **parameterized** — all output paths and the Docker port come from ``RunConfig``, so a
  bulk runner can point many migrations at distinct directories/ports, and
- **non-raising** — any failure is captured into ``MigrationResult(status="error")``
  instead of propagating, so one bad extension never aborts a 1000-extension batch.

The single-extension CLI and the bulk runner both call ``run_migration``; the only
difference is how they build the ``RunConfig`` and present the result.
"""

import dataclasses
import os
import shutil
import time
import traceback
from dataclasses import dataclass, field
from uuid import UUID

from openhands.sdk import LLM, Conversation, RemoteConversation, get_logger

from .agents.migrator import MigratorAgent
from .utils import (
    artifacts,
    conversation_loops,
    manifest_converter,
    persistence,
    test_harness,
    workspace_io,
)
from .utils.docker import createDockerWorkspace
from .utils.prompt_generator import PromptGenerator
from .utils.static_analyzer import StaticAnalyzer, build_analysis

_logger = get_logger(__name__)

# Default Docker host port base. The server also exposes VSCode at +1 and VNC at +2.
DEFAULT_PORT_BASE = 8081


@dataclass(frozen=True)
class RunConfig:
    """Everything ``run_migration`` needs to migrate one extension.

    ``output_dir`` is the per-extension directory that receives the migrated extension,
    the analysis/report/patch, the agent activity log, and the conversation trace.
    """

    extension_path: str
    output_dir: str
    docker_port_base: int = DEFAULT_PORT_BASE
    conversation_id: UUID | None = None
    keep_workspace: bool = False
    quiet: bool = False
    # Iterative quality refinement (OFF by default): 0 disables it. It is the most
    # expensive optional phase — each pass delegates a full critic run plus a transformer
    # run and re-verifies, roughly a third of total LLM cost — so it is opt-in via
    # ``--refine``. When > 0, after a passing verification the critic scores the migration
    # and the transformer improves it until the score reaches ``refine_threshold`` (0-100)
    # or ``refine_max_iterations`` passes are used.
    refine_max_iterations: int = 0
    refine_threshold: float = 80.0

    @property
    def migrated_dir(self) -> str:
        return os.path.join(self.output_dir, "extension")

    @property
    def agent_log_dir(self) -> str:
        return os.path.join(self.output_dir, "agent_log")

    @property
    def conversation_dir(self) -> str:
        return os.path.join(self.output_dir, "conversation")


@dataclass
class MigrationResult:
    """Outcome of a single migration, suitable for JSON/CSV serialization."""

    extension_name: str
    output_dir: str
    status: str = "error"  # "success" | "verify_failed" | "error"
    verify_passed: bool = False
    verify_errors: list[dict] = field(default_factory=list)
    num_findings: int = 0
    nudge_attempts: int = 0
    test_attempts: int = 0
    quality_score: float | None = None
    refine_iterations: int = 0
    accumulated_cost: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    per_usage_metrics: dict[str, dict] = field(default_factory=dict)
    wall_time_s: float = 0.0
    conversation_id: str | None = None
    migrated_dir: str | None = None
    error: str | None = None
    traceback: str | None = None

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


def run_migration(config: RunConfig, llm: LLM) -> MigrationResult:
    """Migrate the extension described by ``config`` and return a ``MigrationResult``.

    Never raises: a failure before/after the agent runs is recorded as
    ``status="error"`` with the traceback so callers (especially the batch runner) can
    keep going.
    """
    start = time.monotonic()
    name = os.path.basename(config.extension_path.rstrip("/")) or "extension"
    result = MigrationResult(
        extension_name=name,
        output_dir=config.output_dir,
        conversation_id=str(config.conversation_id) if config.conversation_id else None,
    )

    converted_dir: str | None = None
    remote_error: str | None = None
    try:
        extension_path = os.path.abspath(config.extension_path)
        if not os.path.isdir(extension_path):
            raise ValueError(f"Extension path is not a directory: {extension_path}")

        os.makedirs(config.output_dir, exist_ok=True)
        os.makedirs(config.agent_log_dir, exist_ok=True)

        # Host-side pre-pass: run the extension through extension-manifest-converter so the
        # deterministic MV2->MV3 changes are applied before upload; the LLM finishes the
        # rest. `converted_dir` is what gets uploaded/analyzed; `extension_path` (the
        # original) is kept for the migration diff.
        converted_dir = manifest_converter.convert(extension_path, _logger)

        # Produce the migration plan statically (no LLM analyzer agent) for speed. One pass
        # yields both the mechanical API call-site findings and the non-mechanical signals
        # (blocking webRequest, background DOM, remote code) that route the agent to the
        # right non-trivial skill.
        mappings_path = os.path.join(os.path.dirname(__file__), "utils", "api_mappings.json")
        scan = StaticAnalyzer(mappings_path).scan(converted_dir)
        findings, signals = scan.findings, scan.signals
        result.num_findings = len(findings)
        _logger.info(
            f"[{name}] Static analysis found {len(findings)} deprecated API usage(s) "
            f"and {len(signals)} non-mechanical migration signal(s)"
        )
        analysis = build_analysis(findings, converted_dir)

        staging_dir = workspace_io.assemble_workspace(analysis, _logger)

        with createDockerWorkspace(config.docker_port_base, quiet=config.quiet) as workspace:
            remote_root = workspace.working_dir.rstrip("/")
            remote_output_dir = f"{remote_root}/out"
            remote_report_path = f"{remote_root}/test_report.json"
            remote_critique_path = f"{remote_root}/critique.json"

            try:
                workspace_io.upload_directory(workspace, staging_dir, remote_root, _logger)
            finally:
                shutil.rmtree(staging_dir, ignore_errors=True)

            _logger.info(f"[{name}] Uploading converted extension -> {remote_root}/extension")
            workspace_io.upload_directory(
                workspace, converted_dir, f"{remote_root}/extension", _logger
            )

            # Pre-create the output dir so the agent can write to it without mkdir.
            mkdir_result = workspace.execute_command(f"mkdir -p {remote_output_dir}", timeout=30)
            if mkdir_result.exit_code != 0:
                _logger.error(
                    f"[{name}] Failed to create remote output dir {remote_output_dir} "
                    f"(exit={mkdir_result.exit_code}): {mkdir_result.stderr}"
                )

            test_harness.install_verify_deps(workspace, _logger)

            conversation = Conversation(
                agent=MigratorAgent().get_agent(llm),
                workspace=workspace,
                callbacks=[conversation_loops.make_activity_logger(config.agent_log_dir, _logger)],
                conversation_id=config.conversation_id,
                delete_on_close=not config.keep_workspace,
            )
            assert isinstance(conversation, RemoteConversation)
            result.conversation_id = str(conversation.id)

            try:
                conversation.send_message(PromptGenerator(findings, signals).prompt)
                conversation_loops.run_with_heartbeat(conversation, _logger, f"migration [{name}]")
                _logger.info(f"[{name}] Agent status: {conversation.state.execution_status}")

                result.nudge_attempts = conversation_loops.run_nudge_loop(
                    conversation, workspace, remote_output_dir, _logger
                )
                passed, report, test_attempts = conversation_loops.run_test_fix_loop(
                    conversation, workspace, remote_output_dir, remote_report_path, _logger
                )
                result.verify_passed = passed
                result.test_attempts = test_attempts
                result.verify_errors = report.get("errors", [])
                result.status = "success" if passed else "verify_failed"

                # Iterative refinement (quality pass). Only refine a migration that already
                # verifies — there is no point polishing a broken one.
                if config.refine_max_iterations > 0 and passed:
                    score, refine_iters = conversation_loops.run_refine_loop(
                        conversation,
                        workspace,
                        remote_output_dir,
                        remote_critique_path,
                        config.refine_threshold,
                        config.refine_max_iterations,
                        _logger,
                    )
                    result.quality_score = score
                    result.refine_iterations = refine_iters
                    # Refinement edited files; re-verify so we never report a refined-but-
                    # broken extension. (Honest signal: a regression flips it to FAILED.)
                    if refine_iters > 0:
                        passed, report = test_harness.run_verify(
                            workspace, remote_output_dir, remote_report_path, _logger
                        )
                        result.verify_passed = passed
                        result.verify_errors = report.get("errors", [])
                        result.status = "success" if passed else "verify_failed"
                        if not passed:
                            _logger.warning(f"[{name}] Refinement regressed verification.")
            finally:
                # Capture metrics + the conversation trace before the remote conversation
                # is torn down, then download the artifacts.
                try:
                    combined, per_usage = persistence.collect_metrics(conversation)
                    result.accumulated_cost = combined["accumulated_cost"]
                    result.prompt_tokens = combined["prompt_tokens"]
                    result.completion_tokens = combined["completion_tokens"]
                    result.cache_read_tokens = combined["cache_read_tokens"]
                    result.cache_write_tokens = combined["cache_write_tokens"]
                    result.reasoning_tokens = combined["reasoning_tokens"]
                    result.per_usage_metrics = per_usage
                    persistence.persist_conversation(
                        conversation, config.conversation_dir, combined, per_usage, _logger
                    )
                except Exception as e:
                    _logger.warning(f"[{name}] Could not capture metrics/trace: {e}")

                # Pull the real cause out of the event stream before the remote
                # conversation is closed; conversation.run() only raises a generic
                # "Remote conversation ended with error".
                remote_error = persistence.extract_remote_error(conversation)

                artifacts.download_outputs(
                    workspace,
                    remote_output_dir=remote_output_dir,
                    local_output_dir=config.migrated_dir,
                    local_output_root=config.output_dir,
                    remote_root=remote_root,
                    remote_report_path=remote_report_path,
                    extension_path=extension_path,
                    logger=_logger,
                    remote_critique_path=remote_critique_path
                    if config.refine_max_iterations > 0
                    else None,
                )
                result.migrated_dir = config.migrated_dir
                conversation.close()
    except Exception as e:
        result.status = "error"
        # Surface the remote agent's actual error (e.g. an unreachable LLM endpoint)
        # rather than the opaque "Remote conversation ended with error" wrapper.
        message = f"{e}"
        if remote_error and remote_error not in message:
            message = f"{message} — remote agent error: {remote_error}"
        result.error = message
        result.traceback = traceback.format_exc()
        _logger.error(f"[{name}] Migration failed: {message}")
    finally:
        if converted_dir:
            shutil.rmtree(converted_dir, ignore_errors=True)
        result.wall_time_s = round(time.monotonic() - start, 2)

    return result
