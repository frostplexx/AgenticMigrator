
import os
import time
import platform
import httpx
from openhands.workspace import DockerWorkspace
from openhands import workspace
from openhands.sdk import (
    LLM,
    Conversation,
    RemoteConversation,
    RemoteWorkspace,
    get_logger,
)

def _detect_platform():
    """Detects the correct Docker platform string."""
    machine = platform.machine().lower()
    if "arm" in machine or "aarch64" in machine:
        return "linux/arm64"
    return "linux/amd64"



def _transform_localhost_url(url: str | None) -> str | None:
    """Transform localhost URLs to be accessible from Docker containers via host.docker.internal."""
    if not url or 'localhost' not in url:
        return url
    transformed_url = url.replace('localhost', 'host.docker.internal')
    print(f"ℹ️  Transformed localhost URL for Docker container access:")
    print(f"   {url} → {transformed_url}")
    return transformed_url



def _get_server_image():
    """Get the server image tag, using PR-specific image in CI."""
    arch = "arm64" if "arm64" in _detect_platform() else "amd64"
    github_sha = os.getenv("GITHUB_SHA")
    if github_sha:
        return f"ghcr.io/openhands/agent-server:{github_sha[:7]}-python-{arch}"
    return "ghcr.io/openhands/agent-server:latest-python"


def _print_vscode_host(workspace: DockerWorkspace):
    """Print the VSCode Server URL, with authentication string"""
    vscode_port = (workspace.host_port or 8010) + 1
    try:
        response = httpx.get(
            f"{workspace.host}/api/vscode/url",
            params={"workspace_dir": workspace.working_dir},
        )
        vscode_data = response.json()
        vscode_url = vscode_data.get("url", "").replace(
            "localhost:8001", f"localhost:{vscode_port}"
        )
    except Exception:
        # Fallback if server route not available
        folder = (
            f"/{workspace.working_dir}"
            if not str(workspace.working_dir).startswith("/")
            else str(workspace.working_dir)
        )
        vscode_url = f"http://localhost:{vscode_port}/?folder={folder}"
    print(f"ℹ️  VSCode Server URL: {vscode_url}")


def _print_vnc_host(workspace: DockerWorkspace):
    """Print the VNC Server URL"""
    vnc_port = (workspace.host_port or 8010) + 2
    print(f"ℹ️  VNC Server URL: http://localhost:{vnc_port}/vnc.html?autoconnect=1&resize=remote")



def createDockerWorkspace(port: int) -> DockerWorkspace:
    # Transform localhost URLs to be accessible from Docker containers
    server_image = _get_server_image()

    # Enable VNC by setting the environment variable
    os.environ["OH_ENABLE_VNC"] = "true"

    ws = DockerWorkspace(
        server_image=server_image,
        platform=_detect_platform(),
        host_port=port,
        extra_ports=True,
        detach_logs=False,
        forward_env=["DEBUG", "OH_ENABLE_VNC"]  # Forward VNC enable flag to container
    )

    _print_vscode_host(ws)
    _print_vnc_host(ws)

    return ws
