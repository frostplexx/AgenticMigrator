import logging
import os
import shutil

from openhands.sdk import LLM, Conversation, RemoteConversation, get_logger

from .agents.migrator import MigratorAgent
from .utils import artifacts, conversation_loops, test_harness, workspace_io
from .utils.banner import show_banner
from .utils.docker import createDockerWorkspace
from .utils.llm_factory import build_llm
from .utils.prompt_generator import PromptGenerator
from .utils.static_analyzer import StaticAnalyzer, build_analysis

_logger = get_logger(__name__)


class MigrationManager:
    """Singleton that wires the LLM, Docker workspace, and migration conversation."""

    instance = None  # pyright: ignore[reportUnannotatedClassAttribute]
    llm: LLM | None = None
    _initialized: bool = False

    def __new__(cls):
        if cls.instance is None:
            cls.instance = super().__new__(cls)
        return cls.instance

    def __init__(self):
        if self._initialized:
            return
        self.llm = build_llm()
        show_banner(model=os.environ["LLM_MODEL"])
        self._initialized = True

    def migrate(self, extension: str) -> None:
        logging.getLogger("openhands").setLevel(logging.DEBUG)

        if self.llm is None:
            raise ValueError("MigrationManager is not properly initialized.")

        extension_path = os.path.abspath(extension)
        if not os.path.isdir(extension_path):
            raise ValueError(f"Extension path is not a directory: {extension_path}")

        # Produce the migration plan statically (no LLM analyzer agent) for speed.
        mappings_path = os.path.join(os.path.dirname(__file__), "utils", "api_mappings.json")
        findings = StaticAnalyzer(mappings_path).analyze(extension_path)
        _logger.info(f"Static analysis found {len(findings)} deprecated API usage(s)")
        analysis = build_analysis(findings, extension_path)

        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        local_output_root = os.path.join(project_root, "output")
        local_output_dir = os.path.join(local_output_root, "extension")

        staging_dir = workspace_io.assemble_workspace(analysis, _logger)

        with createDockerWorkspace(8081) as workspace:
            remote_root = workspace.working_dir.rstrip("/")
            remote_output_dir = f"{remote_root}/out"
            remote_report_path = f"{remote_root}/test_report.json"

            try:
                workspace_io.upload_directory(workspace, staging_dir, remote_root, _logger)
            finally:
                shutil.rmtree(staging_dir, ignore_errors=True)

            _logger.info(f"Uploading extension {extension_path} -> {remote_root}/extension")
            workspace_io.upload_directory(
                workspace, extension_path, f"{remote_root}/extension", _logger
            )

            # Pre-create the output dir so the agent can write to it without mkdir.
            mkdir_result = workspace.execute_command(f"mkdir -p {remote_output_dir}", timeout=30)
            if mkdir_result.exit_code != 0:
                _logger.error(
                    f"Failed to create remote output dir {remote_output_dir} "
                    f"(exit={mkdir_result.exit_code}): {mkdir_result.stderr}"
                )

            test_harness.install_verify_deps(workspace, _logger)

            agent_log_dir = os.path.join(project_root, "agent_logs")
            os.makedirs(agent_log_dir, exist_ok=True)

            conversation = Conversation(
                agent=MigratorAgent().get_agent(self.llm),
                workspace=workspace,
                callbacks=[conversation_loops.make_activity_logger(agent_log_dir)],
            )
            assert isinstance(conversation, RemoteConversation)

            try:
                conversation.send_message(PromptGenerator(findings).prompt)
                conversation.run()
                _logger.info(f"Agent status: {conversation.state.execution_status}")

                conversation_loops.run_nudge_loop(
                    conversation, workspace, remote_output_dir, _logger
                )
                conversation_loops.run_test_fix_loop(
                    conversation, workspace, remote_output_dir, remote_report_path, _logger
                )
            finally:
                artifacts.download_outputs(
                    workspace,
                    remote_output_dir=remote_output_dir,
                    local_output_dir=local_output_dir,
                    local_output_root=local_output_root,
                    remote_root=remote_root,
                    remote_report_path=remote_report_path,
                    extension_path=extension_path,
                    logger=_logger,
                )
                print("\n🧹 Cleaning up conversation...")
                conversation.close()
