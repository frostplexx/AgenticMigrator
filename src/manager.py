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
from openhands.sdk.conversation.goal import run_goal

from .agents.migrator import MigratorAgent
from .utils import (
    artifacts,
    conversation_loops,
    manifest_converter,
    persistence,
    test_harness,
    workspace_io,
)
from .utils.visualizer import MigrationVisualizer
from .utils.docker import createDockerWorkspace, to_client_reachable_url
from .utils.prompt_generator import PromptGenerator
from .utils.static_analyzer import StaticAnalyzer, build_analysis

_logger = get_logger(__name__)

# Default Docker host port base. The server also exposes VSCode at +1 and VNC at +2.
DEFAULT_PORT_BASE = 8081

# Objective the goal-completion loop audits against. Phrased as a *finishing* objective
# (the conversation already contains a completed, verified migration when this runs) so the
# agent confirms/finishes rather than restarting from scratch. The judge LLM only marks it
# complete on transcript evidence — including the harness's own runtime-error reports, which
# are already part of the conversation history.
_GOAL_OBJECTIVE = (
    "Ensure the Chrome extension migration is fully complete. The migrated MV3 extension "
    "in /workspace/out must be self-contained (manifest_version 3, every original file from "
    "/workspace/extension present), load and run in Chrome with no load-time or runtime "
    "errors, and preserve the original functionality with nothing stubbed out or removed. "
    "If anything is missing or incomplete, finish it by delegating to extension-transformer; "
    "otherwise confirm it is done."
)


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
    # Goal completion loop (ON by default; 0 disables it via --no-goal / GOAL=0). After
    # verification, an independent judge LLM audits the conversation transcript for proof the
    # overall migration objective is *provably* complete; while it is not, the orchestrator is
    # re-prompted with what is still ``missing`` and runs again, up to ``goal_max_iterations``.
    # This replaces the older critic-based refinement pass as the quality gate.
    goal_max_iterations: int = 3

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
    goal_status: str | None = None  # "complete" | "capped" (None when the loop is off)
    goal_score: float | None = None  # judge's final completion probability (0.0–1.0)
    goal_iterations: int = 0  # judge audit rounds performed
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
                # Compact orchestrator view for an interactive `migrate`; under --quiet
                # (e.g. parallel batch workers) stay silent and rely on the per-agent log
                # files instead of interleaving Rich output across workers.
                visualizer=None if config.quiet else MigrationVisualizer(),
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

                # Goal completion loop (replaces the old critic-refinement pass). An
                # independent judge LLM audits the conversation transcript for proof the
                # overall objective is provably complete; while it is not, the orchestrator is
                # re-prompted with what is still ``missing`` and runs again, up to the cap.
                if config.goal_max_iterations > 0:
                    # The judge runs CLIENT-SIDE (run_goal drives it in this host process),
                    # unlike the agent which runs inside the Docker container. The agent's
                    # base_url points at host.docker.internal (so the container can reach the
                    # host's Ollama) — a name the host itself can't resolve — so rewrite it
                    # back to localhost for the judge. A distinct usage_id also keeps its cost
                    # separate and avoids an LLMRegistry duplicate.
                    judge_llm = llm.model_copy(
                        update={
                            "usage_id": "goal-judge",
                            "base_url": to_client_reachable_url(llm.base_url),
                        }
                    )
                    try:
                        outcome = run_goal(
                            conversation,
                            _GOAL_OBJECTIVE,
                            judge_llm,
                            max_iterations=config.goal_max_iterations,
                        )
                        result.goal_status = outcome.status
                        result.goal_score = outcome.verdict.score
                        result.goal_iterations = outcome.iterations
                        missing = f"; missing: {outcome.verdict.missing}" if outcome.verdict.missing else ""
                        _logger.info(
                            f"[{name}] Goal loop: {outcome.status} after {outcome.iterations} "
                            f"round(s), judge score {outcome.verdict.score:.2f}{missing}"
                        )
                    except Exception as e:
                        # A judge/transport failure must not sink an otherwise-good migration.
                        _logger.warning(f"[{name}] Goal loop failed: {e}")
                    # The goal loop re-prompts the agent, which may edit files; re-verify so a
                    # goal-driven change can never leave us reporting a broken extension.
                    passed, report = test_harness.run_verify(
                        workspace, remote_output_dir, remote_report_path, _logger
                    )
                    result.verify_passed = passed
                    result.verify_errors = report.get("errors", [])
                    result.status = "success" if passed else "verify_failed"
                    if not passed:
                        _logger.warning(f"[{name}] Goal loop regressed verification.")
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
