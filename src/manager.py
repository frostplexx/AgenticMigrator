import os
import time
import platform
from pydantic import SecretStr
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

        self.llm = LLM(
            usage_id="agent",
            model=model,
            api_key=SecretStr(api_key) if api_key else None,
            base_url=base_url
        )

        show_banner(model=model)



    def migrate(self, extension: str):

        logger = get_logger(__name__)

        if self.llm is None:
            raise ValueError("MigrationManager is not properly initialized.")

        with createDockerWorkspace(8081) as workspace:


            def event_callback(event) -> None:  # pyright: ignore[reportUnknownParameterType]
                event_type = type(event).__name__  # pyright: ignore[reportUnknownArgumentType]
                logger.info(f"🔔 Callback received event: {event_type}\n{event}")
                received_events.append(event)  # pyright: ignore[reportUnknownArgumentType]
                last_event_time["ts"] = time.time()



            agent = get_default_agent(
                llm=self.llm,
                cli_mode=False, # CLI mode = False will enable browser tools
            )

            # Set up callback collection
            received_events = []
            last_event_time = {"ts": time.time()}

            # Wait for VNC server to initialize
            logger.info("Waiting for VNC server to start...")

            # First, let's see what processes are actually running
            ps_result = workspace.execute_command("ps aux | grep -E '(vnc|novnc)' | grep -v grep")
            logger.info(f"VNC-related processes:\n{ps_result.stdout}")

            # Check if noVNC files exist
            novnc_check = workspace.execute_command("ls -la /opt/novnc* /usr/share/novnc* 2>&1 || echo 'noVNC directories not found'")
            logger.info(f"noVNC installation check:\n{novnc_check.stdout}")

            vnc_ready = False
            for attempt in range(10):
                result = workspace.execute_command("pgrep -f novnc > /dev/null 2>&1 && echo true || echo false")
                logger.info(f"VNC check attempt {attempt + 1}: stdout='{result.stdout.strip()}', exit_code={result.exit_code}")
                if result.stdout.strip() == "true":
                    vnc_ready = True
                    logger.info("✓ VNC server is running")
                    break
                time.sleep(1)

            if not vnc_ready:
                logger.warning(
                    "VNC server process not detected in workspace after 10 seconds. "
                    "VNC access may not work as expected. Continuing anyway..."
                )



            conversation = Conversation(
                agent=agent,
                workspace=workspace,
                callbacks=[event_callback],
            )
            assert isinstance(conversation, RemoteConversation)

            try:
                logger.info(f"\n📋 Conversation ID: {conversation.state.id}")

                logger.info("📝 Sending first message...")

            

                conversation.send_message(
                    """
                    Could you go to https://lmu.de/ find the Newsroom and 
                    summarize the key points of the 5 latest news articles?
                    """
                )
                conversation.run()

                logger.info(f"Agent status: {conversation.state.execution_status}")

                if os.getenv("CI"):
                    logger.info(
                        "CI environment detected; skipping interactive prompt and closing workspace."  # noqa: E501
                    )
                    conversation.close()
                else:
                    # Wait for user confirm to exit when running locally
                    y = None
                    while y != "y":
                        y = input(
                            "Because you've enabled extra_ports=True in DockerDevWorkspace, "
                            "you can open a browser tab to see the *actual* browser OpenHands "
                            "is interacting with via VNC.\n\n"
                            "Link: http://localhost:8012/vnc.html?autoconnect=1&resize=remote\n\n"
                            "Press 'y' and Enter to exit and terminate the workspace.\n"
                            ">> "
                        )
            finally:
                print("\n🧹 Cleaning up conversation...")
                conversation.close()
        
