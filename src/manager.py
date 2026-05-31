import os
import time
import platform
from openhands.sdk.agent import Agent
from pydantic import SecretStr

from .utils.prompt_generator import PromptGenerator
from .utils.static_analyzer import StaticAnalyzer
from .utils import test_harness

from .agents.migrator import MigratorAgent
from .utils.banner import show_banner
from openhands.sdk import (
    LLM,
    Conversation,
    RemoteConversation,
    get_logger,
)
from openhands.tools.preset.default import get_default_agent
from .utils.docker import createDockerWorkspace

class MigrationManager:
    instance = None  # pyright: ignore[reportUnannotatedClassAttribute]

    llm: LLM | None = None
    _initialized: bool = False



    def _transform_localhost_url(self, url: str | None) -> str | None:
        """
        Transform localhost URLs to be accessible from Docker containers.

        On macOS and Windows Docker Desktop, use 'host.docker.internal'.
        On Linux, use the Docker bridge gateway IP '172.17.0.1'.
        """
        if not url or 'localhost' not in url:
            return url

        system = platform.system().lower()

        # macOS and Windows Docker Desktop support host.docker.internal
        if system in ('darwin', 'windows'):
            transformed_url = url.replace('localhost', 'host.docker.internal')
        else:
            # Linux: use Docker bridge network gateway
            # Note: host.docker.internal is supported in Docker 20.10+ on Linux
            transformed_url = url.replace('localhost', 'host.docker.internal')

        print(f"ℹ️  Transformed localhost URL for Docker container access:")
        print(f"   {url} → {transformed_url}")
        return transformed_url
    


    def __new__(cls):
        if cls.instance is None:
            cls.instance = super().__new__(cls)
        return cls.instance


    def __init__(self):
        # Skip initialization if already initialized
        if self._initialized:
            return

        # Guard environment variables
        model = os.environ.get('LLM_MODEL', None)
        api_key = os.environ.get('LLM_API_KEY', None)
        base_url = os.environ.get('LLM_BASE_URL', None)

        _is_ollama_provider = model is not None and model.startswith('ollama/')


        if model is None:
            raise ValueError("LLM_MODEL environment variable is not set.")
        if api_key is None and not _is_ollama_provider:
            raise ValueError("LLM_API_KEY environment variable is not set.")
        if base_url is None and _is_ollama_provider:
            raise ValueError("LLM_BASE_URL environment variable is not set for Ollama provider.")

        # Transform localhost URLs to be accessible from Docker containers
        base_url = self._transform_localhost_url(base_url)

        # Ollama-specific parameters passed via litellm_extra_body.
        extra_body = {}
        if _is_ollama_provider:
            # Context window size (num_ctx). Default: 32768
            num_ctx_str = os.environ.get("LLM_NUM_CTX")
            num_ctx = int(num_ctx_str) if num_ctx_str else 32768
            extra_body["num_ctx"] = num_ctx

            # Keep-alive duration (how long to keep model in memory).
            # Default: 30m; override via LLM_KEEP_ALIVE env var.
            # Format: duration string like "5m", "30m", "1h", or "-1" for indefinite.
            keep_alive = os.environ.get("LLM_KEEP_ALIVE", "30m")
            extra_body["keep_alive"] = keep_alive

        # Cost tracking (optional) - set per-token costs for usage tracking.
        # For Ollama (local), these default to 0. For API providers, set via env vars.
        input_cost = None
        output_cost = None
        input_cost_str = os.environ.get("LLM_INPUT_COST_PER_TOKEN")
        output_cost_str = os.environ.get("LLM_OUTPUT_COST_PER_TOKEN")
        if input_cost_str:
            input_cost = float(input_cost_str)
        if output_cost_str:
            output_cost = float(output_cost_str)
        # Default to $0 for Ollama (local models)
        if _is_ollama_provider:
            input_cost = input_cost or 0.0
            output_cost = output_cost or 0.0

        self.llm = LLM(
            usage_id="agent",
            model=model,
            api_key=SecretStr(api_key) if api_key else None,
            base_url=base_url,
            # Reasoning models (OpenAI o-series, GPT-5, etc.) → highest effort.
            # Anthropic Claude uses extended_thinking_budget instead; the
            # SDK default (200k tokens) is already plenty, so we leave it.
            reasoning_effort="xhigh",
            litellm_extra_body=extra_body,
            input_cost_per_token=input_cost,
            output_cost_per_token=output_cost,
            # Disable native tool calling for models that don't support it properly.
            # When False, OpenHands will use prompt-based tool calling with XML format.
            native_tool_calling=False,
        )

        show_banner(model=model)
        self._initialized = True



    def migrate(self, extension: str):

        logger = get_logger(__name__)

        # Enable DEBUG logging to see more detailed agent activity
        import logging
        logging.getLogger("openhands").setLevel(logging.DEBUG)

        if self.llm is None:
            raise ValueError("MigrationManager is not properly initialized.")

        extension_path = os.path.abspath(extension)
        if not os.path.isdir(extension_path):
            raise ValueError(f"Extension path is not a directory: {extension_path}")

        mappings_path = os.path.join(os.path.dirname(__file__), "utils", "api_mappings.json")
        findings = StaticAnalyzer(mappings_path).analyze(extension_path)
        logger.info(f"Static analysis found {len(findings)} deprecated API usage(s)")

        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        local_input_dir = os.path.join(os.path.dirname(__file__), "workspace")
        local_output_root = os.path.join(project_root, "output")
        local_output_dir = os.path.join(local_output_root, "extension")

        with createDockerWorkspace(8081) as workspace:

            remote_root = workspace.working_dir.rstrip("/")
            remote_output_dir = f"{remote_root}/out"

            # Upload workspace scaffolding (AGENT.md etc.) to the container root.
            self._upload_directory(workspace, local_input_dir, remote_root, logger)

            # Upload the Chrome extension into /workspace/extension/.
            remote_extension_dir = f"{remote_root}/extension"
            logger.info(f"Uploading extension {extension_path} -> {remote_extension_dir}")
            self._upload_directory(workspace, extension_path, remote_extension_dir, logger)

            # Pre-create the output directory inside the container so the agent
            # can write to it without first having to mkdir.
            mkdir_result = workspace.execute_command(
                f"mkdir -p {remote_output_dir}", timeout=30
            )
            if mkdir_result.exit_code != 0:
                logger.error(
                    f"Failed to create remote output dir {remote_output_dir} "
                    f"(exit={mkdir_result.exit_code}): {mkdir_result.stderr}"
                )

            # Locate the bundled Chromium and install the Node test harness deps so both
            # the agent (via terminal) and the manager can run the smoke test.
            remote_report_path = f"{remote_root}/test_report.json"
            chrome_bin = test_harness.detect_chrome(workspace, logger)
            test_harness.install_harness_deps(workspace, logger)

            # Create a conversation with the agent and workspace, then run the migration instructions.
            # Add a callback to log agent activity to files for tmux monitoring
            agent_log_dir = os.path.join(project_root, "agent_logs")
            os.makedirs(agent_log_dir, exist_ok=True)

            def agent_activity_logger(event):
                """Log events to agent-specific files for tmux pane monitoring."""
                from openhands.sdk.event import ActionEvent, ObservationEvent, MessageEvent

                # Determine which agent this event is from (main or delegated)
                agent_name = "main"
                if isinstance(event, (ActionEvent, ObservationEvent)):
                    tool_name = getattr(event, 'tool_name', None)
                    if tool_name == 'delegate':
                        # This is a delegation event
                        agent_name = "delegation"
                    elif hasattr(event, 'tool_call_id'):
                        # Try to infer from context - this is simplified
                        # In practice, tracking delegation context is complex
                        pass

                log_file = os.path.join(agent_log_dir, f"{agent_name}.log")
                timestamp = time.strftime("%H:%M:%S")

                with open(log_file, "a") as f:
                    if isinstance(event, ActionEvent):
                        f.write(f"[{timestamp}] ACTION: {event.tool_name}\n")
                        if hasattr(event, 'summary'):
                            f.write(f"  Summary: {event.summary}\n")
                    elif isinstance(event, ObservationEvent):
                        f.write(f"[{timestamp}] RESULT: {event.tool_name}\n")
                        if hasattr(event, 'error') and event.error:
                            f.write(f"  Error: {event.error}\n")
                    elif isinstance(event, MessageEvent):
                        f.write(f"[{timestamp}] MESSAGE\n")
                    f.flush()

            conversation = Conversation(
                agent=MigratorAgent().get_agent(self.llm),
                workspace=workspace,
                callbacks=[agent_activity_logger],
            )
            assert isinstance(conversation, RemoteConversation)

            try:
                # Send the inital message to the agent to start the migration process, then run the conversation loop until completion.
                conversation.send_message(
                    PromptGenerator(findings, chrome_bin=chrome_bin).prompt
                )
                conversation.run()
                logger.info(f"Agent status: {conversation.state.execution_status}")

                # The agent sometimes "finishes" after only outlining a plan,
                # without actually writing any output files. Nudge it to finish
                # the work, up to a small number of attempts.
                max_nudges = 3
                for attempt in range(1, max_nudges + 1):
                    if self._remote_dir_has_files(workspace, remote_output_dir, logger):
                        break

                    logger.warning(
                        f"Agent finished but {remote_output_dir} is empty "
                        f"(nudge {attempt}/{max_nudges})."
                    )
                    conversation.send_message(
                        f"""
                        You stopped without completing the task. The directory
                        `{remote_output_dir}` is still empty, so nothing will be
                        returned to the user.

                        Continue the work described in `/workspace/AGENT.md` and
                        produce the required files inside `{remote_output_dir}`
                        now.

                        VERY IMPORTANT — about HOW you reply:
                        - Do NOT emit JSON like {{"type": "function", ...}} or
                          {{"thought": ...}} as your message content. That is plain
                          text and will be ignored — no file will be written.
                        - Instead, invoke the tools the normal way (function /
                          tool calls). The `file_editor` tool with
                          `command="create"` is the right way to write
                          `{remote_output_dir}/<name>`.
                        - After the tool call succeeds, verify with the
                          `terminal` tool (`ls -la {remote_output_dir}` and
                          `cat <file>`) that the file is actually on disk with the
                          intended contents.
                        - Only stop once `{remote_output_dir}` contains the
                          finished output for every instruction in AGENT.md.
                        """
                    )
                    conversation.run()
                    logger.info(
                        f"Agent status after nudge {attempt}: "
                        f"{conversation.state.execution_status}"
                    )
                else:
                    logger.error(
                        f"Agent never produced output in {remote_output_dir} "
                        f"after {max_nudges} nudges; giving up."
                    )

                # Authoritative test -> fix loop: run the migrated extension in Chrome
                # for Testing and feed any captured errors back to the agent to fix.
                max_test_attempts = 3
                for attempt in range(1, max_test_attempts + 1):
                    passed, report = test_harness.run_smoke_test(
                        workspace,
                        remote_output_dir,
                        chrome_bin,
                        remote_report_path,
                        logger,
                    )
                    if passed:
                        logger.info("Migrated extension passed the smoke test.")
                        break

                    if attempt == max_test_attempts:
                        logger.error(
                            f"Migrated extension still failing after "
                            f"{max_test_attempts} test attempts; giving up."
                        )
                        break

                    errors = report.get("errors", [])
                    error_text = "\n".join(
                        f"- ({e.get('source', '?')}) {e.get('text', '')}" for e in errors
                    ) or "The extension failed to load (no service worker registered)."

                    logger.warning(
                        f"Migrated extension failed the smoke test "
                        f"(attempt {attempt}/{max_test_attempts}). Asking agent to fix."
                    )
                    conversation.send_message(
                        f"""
                        The migrated extension in `{remote_output_dir}` was loaded into
                        Chromium and FAILED the smoke test. The following
                        errors were captured at runtime:

                        {error_text}

                        Delegate to `extension-transformer` to fix the migrated files in
                        `{remote_output_dir}` so these runtime errors are resolved. Common
                        causes: a service worker referencing APIs unavailable in MV3
                        (DOM/`window`, `XMLHttpRequest`), leftover MV2 API calls, or an
                        invalid `manifest.json`.

                        You may re-run the test yourself to verify:
                          `node {test_harness.HARNESS_SCRIPT} {remote_output_dir} {chrome_bin} {remote_report_path}`

                        Do not stop until the test passes (exit code 0).
                        """
                    )
                    conversation.run()
                    logger.info(
                        f"Agent status after fix attempt {attempt}: "
                        f"{conversation.state.execution_status}"
                    )
            finally:
                try:
                    self._download_directory(
                        workspace, remote_output_dir, local_output_dir, logger
                    )
                except Exception as e:
                    logger.error(f"Failed to download workspace output: {e}")

                # Download analysis.json and print it.
                remote_analysis = f"{remote_root}/analysis.json"
                local_analysis = os.path.join(local_output_root, "analysis.json")
                try:
                    os.makedirs(local_output_root, exist_ok=True)
                    result = workspace.file_download(
                        source_path=remote_analysis,
                        destination_path=local_analysis,
                    )
                    if result.error is None:
                        import json
                        with open(local_analysis) as f:
                            analysis = json.load(f)
                        print("\n--- Migration Analysis ---")
                        print(json.dumps(analysis, indent=2))
                        print("-------------------------\n")
                    else:
                        logger.warning(f"analysis.json not available: {result.error}")
                except Exception as e:
                    logger.error(f"Failed to download analysis.json: {e}")

                # Download the smoke-test report and print a pass/fail summary.
                local_report = os.path.join(local_output_root, "test_report.json")
                try:
                    os.makedirs(local_output_root, exist_ok=True)
                    result = workspace.file_download(
                        source_path=remote_report_path,
                        destination_path=local_report,
                    )
                    if result.error is None:
                        import json
                        with open(local_report) as f:
                            report = json.load(f)
                        n_errors = len(report.get("errors", []))
                        status = "PASSED" if report.get("loaded") and n_errors == 0 else "FAILED"
                        print(f"\n--- Extension Smoke Test: {status} ---")
                        print(
                            f"loaded={report.get('loaded')}, "
                            f"extensionId={report.get('extensionId')}, "
                            f"errors={n_errors}, "
                            f"warnings={len(report.get('warnings', []))}"
                        )
                        print("----------------------------------\n")
                    else:
                        logger.warning(f"test_report.json not available: {result.error}")
                except Exception as e:
                    logger.error(f"Failed to download test_report.json: {e}")

                # Generate a unified diff between the original extension and the migrated output.
                try:
                    patch_path = os.path.join(local_output_root, "migration.patch")
                    self._generate_patch(extension_path, local_output_dir, patch_path, logger)
                except Exception as e:
                    logger.error(f"Failed to generate patch: {e}")

                print("\n🧹 Cleaning up conversation...")
                conversation.close()


    def _generate_patch(self, original_dir: str, migrated_dir: str, patch_path: str, logger) -> None:
        """
        Write a unified diff between original_dir and migrated_dir to patch_path.
        Files that exist only in migrated_dir (e.g. analysis.json, migration.patch) and
        that have no counterpart in original_dir are included as new-file diffs unless
        they are non-extension artifacts (analysis.json, migration.patch).
        """
        import difflib

        # Artifacts written by the migration tooling itself — exclude from the diff.
        EXCLUDE = {"analysis.json", "migration.patch"}

        def collect_files(directory: str) -> set[str]:
            result = set()
            for root, _, files in os.walk(directory):
                for f in files:
                    rel = os.path.relpath(os.path.join(root, f), directory)
                    if rel not in EXCLUDE:
                        result.add(rel)
            return result

        original_files = collect_files(original_dir)
        migrated_files = collect_files(migrated_dir)
        all_files = sorted(original_files | migrated_files)

        patch_lines: list[str] = []

        for rel_path in all_files:
            orig_path = os.path.join(original_dir, rel_path)
            migr_path = os.path.join(migrated_dir, rel_path)

            orig_lines: list[str] = []
            migr_lines: list[str] = []

            if os.path.exists(orig_path):
                with open(orig_path, encoding='utf-8', errors='replace') as fh:
                    orig_lines = fh.readlines()

            if os.path.exists(migr_path):
                with open(migr_path, encoding='utf-8', errors='replace') as fh:
                    migr_lines = fh.readlines()

            diff = list(difflib.unified_diff(
                orig_lines,
                migr_lines,
                fromfile=f"a/{rel_path}",
                tofile=f"b/{rel_path}",
            ))

            if diff:
                patch_lines.extend(diff)

        os.makedirs(os.path.dirname(patch_path), exist_ok=True)
        with open(patch_path, 'w', encoding='utf-8') as fh:
            fh.writelines(patch_lines)

        changed = sum(1 for line in patch_lines if line.startswith('--- '))
        logger.info(f"Patch written to {patch_path} ({changed} file(s) changed)")
        print(f"\nPatch written to {patch_path} ({changed} file(s) changed)")


    def _upload_directory(self, workspace, local_dir: str, remote_dir: str, logger) -> None:
        """Recursively upload a local directory to the remote workspace, preserving structure."""
        if not os.path.isdir(local_dir):
            raise ValueError(f"Local input directory does not exist: {local_dir}")

        for root, _dirs, files in os.walk(local_dir):
            for file in files:
                local_path = os.path.join(root, file)
                relative_path = os.path.relpath(local_path, local_dir)
                # Normalize to POSIX separators for the remote (Linux) container
                remote_rel = relative_path.replace(os.sep, "/")
                destination_path = f"{remote_dir}/{remote_rel}"

                logger.info(f"Uploading {local_path} -> {destination_path}")
                result = workspace.file_upload(
                    source_path=local_path,
                    destination_path=destination_path,
                )
                if result.error is not None:
                    raise RuntimeError(
                        f"Failed to upload {local_path} -> {destination_path}: {result.error}"
                    )

    def _remote_dir_has_files(self, workspace, remote_dir: str, logger) -> bool:
        """Return True iff at least one regular file exists under remote_dir."""
        # `find ... -print -quit` exits after the first match, which is much
        # cheaper than enumerating the whole tree just to check emptiness.
        result = workspace.execute_command(
            f"find {remote_dir} -type f -print -quit", timeout=30
        )
        if result.exit_code != 0:
            logger.warning(
                f"Failed to probe {remote_dir} for files "
                f"(exit={result.exit_code}): {result.stderr}"
            )
            return False
        return bool((result.stdout or "").strip())


    def _download_directory(self, workspace, remote_dir: str, local_dir: str, logger) -> None:
        """Recursively download a remote workspace directory to a local directory, preserving structure."""
        # Enumerate every regular file under the remote workspace root.
        # Using -print0 to handle exotic filenames safely.
        list_cmd = f"find {remote_dir} -type f -print0"
        result = workspace.execute_command(list_cmd, timeout=120)
        if result.exit_code != 0:
            raise RuntimeError(
                f"Failed to list remote files (exit={result.exit_code}): {result.stderr}"
            )

        stdout = result.stdout or ""
        remote_files = [p for p in stdout.split("\0") if p]
        if not remote_files:
            logger.info(f"No files found under {remote_dir}; nothing to download.")
            return

        os.makedirs(local_dir, exist_ok=True)
        logger.info(f"Downloading {len(remote_files)} file(s) from {remote_dir} -> {local_dir}")

        for remote_path in remote_files:
            relative_path = os.path.relpath(remote_path, remote_dir)
            local_path = os.path.join(local_dir, relative_path)

            logger.info(f"Downloading {remote_path} -> {local_path}")
            download_result = workspace.file_download(
                source_path=remote_path,
                destination_path=local_path,
            )
            if download_result.error is not None:
                logger.error(
                    f"Failed to download {remote_path} -> {local_path}: {download_result.error}"
                )

