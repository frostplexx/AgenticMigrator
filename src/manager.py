import os
import time
import platform
from openhands.sdk.agent import Agent
from pydantic import SecretStr

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

        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        local_input_dir = os.path.join(os.path.dirname(__file__), "workspace")
        local_output_dir = os.path.join(project_root, "output")

        with createDockerWorkspace(8081) as workspace:

            remote_root = workspace.working_dir.rstrip("/")
            remote_output_dir = f"{remote_root}/out"

            self._upload_directory(workspace, local_input_dir, remote_root, logger)

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

            # Print tmux monitoring command
            print(f"\n📊 Agent activity logs: {agent_log_dir}")
            print("To monitor in separate tmux panes:")
            print(f"  tmux split-window -h 'tail -f {agent_log_dir}/main.log'")
            print(f"  tmux split-window -v 'tail -f {agent_log_dir}/delegation.log'")
            print()

            try:
                # Send the inital message to the agent to start the migration process, then run the conversation loop until completion.
                conversation.send_message(
                    f"""
                    Read the AGENT.md file in the workspace and execute all instructions in it.
                    Make sure to follow all instructions carefully, including any setup steps and
                    how to use the browser tool to complete the tasks outlined in AGENT.md.

                    IMPORTANT: Write every file you generate as part of this task into the
                    directory `{remote_output_dir}`. Preserve any subdirectory structure you
                    need inside that directory. Do not place generated output anywhere else —
                    only the contents of `{remote_output_dir}` will be returned to the user.
                    """
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
            finally:
                try:
                    self._download_directory(
                        workspace, remote_output_dir, local_output_dir, logger
                    )
                except Exception as e:
                    logger.error(f"Failed to download workspace output: {e}")

                # Display cost and usage statistics
                self._print_usage_summary(conversation, logger)

                print("\n🧹 Cleaning up conversation...")
                conversation.close()


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


    def _print_usage_summary(self, conversation, logger) -> None:
        """Print token usage and cost summary for the conversation."""
        try:
            stats = conversation.state.stats
            if not stats:
                return

            # Get metrics from all LLMs used in the conversation
            print("\n" + "=" * 60)
            print("📊 Usage Summary")
            print("=" * 60)

            total_cost = 0.0
            total_input_tokens = 0
            total_output_tokens = 0
            total_cache_read = 0
            total_cache_write = 0

            for usage_id, llm_stats in stats.llm_stats.items():
                metrics = llm_stats.metrics
                if not metrics.accumulated_token_usage:
                    continue

                usage = metrics.accumulated_token_usage
                cost = metrics.accumulated_cost

                print(f"\n{usage_id} ({metrics.model_name}):")
                print(f"  Input tokens:  {usage.prompt_tokens:,}")
                print(f"  Output tokens: {usage.completion_tokens:,}")
                if usage.cache_read_tokens > 0:
                    print(f"  Cache read:    {usage.cache_read_tokens:,}")
                if usage.cache_write_tokens > 0:
                    print(f"  Cache write:   {usage.cache_write_tokens:,}")
                if usage.reasoning_tokens > 0:
                    print(f"  Reasoning:     {usage.reasoning_tokens:,}")
                if cost > 0:
                    print(f"  Cost:          ${cost:.4f}")

                total_cost += cost
                total_input_tokens += usage.prompt_tokens
                total_output_tokens += usage.completion_tokens
                total_cache_read += usage.cache_read_tokens
                total_cache_write += usage.cache_write_tokens

            # Print totals
            print("\n" + "-" * 60)
            print(f"Total Input:       {total_input_tokens:,} tokens")
            print(f"Total Output:      {total_output_tokens:,} tokens")
            if total_cache_read > 0:
                print(f"Total Cache Read:  {total_cache_read:,} tokens")
            if total_cache_write > 0:
                print(f"Total Cache Write: {total_cache_write:,} tokens")

            if total_cost > 0:
                print(f"\n💰 Total Cost: ${total_cost:.4f}")
            else:
                print(f"\n💰 Total Cost: $0.00 (local model)")
            print("=" * 60)

        except Exception as e:
            logger.warning(f"Failed to print usage summary: {e}")


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

