
import contextlib
import io
import os
import time
import platform
import httpx
from openhands.workspace import DockerWorkspace

from . import ui
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
    ui.note(f"Transformed localhost URL for container access: {url} → {transformed_url}")
    return transformed_url


def to_client_reachable_url(url: str | None) -> str | None:
    """Inverse of the container transform, for callers that run CLIENT-SIDE (on the host).

    The agent runs inside the container and reaches the host's Ollama via
    ``host.docker.internal``. A host-side caller — e.g. the goal-completion judge, which
    ``run_goal`` drives in this process — cannot resolve that name, so rewrite it back to
    ``localhost``. A no-op for any other URL (already-localhost, or a genuinely remote host
    reachable from both sides).
    """
    if not url or 'host.docker.internal' not in url:
        return url
    return url.replace('host.docker.internal', 'localhost')



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
    ui.note(f"VSCode: {vscode_url}")


def _print_vnc_host(workspace: DockerWorkspace):
    """Print the VNC Server URL"""
    vnc_port = (workspace.host_port or 8010) + 2
    ui.note(f"VNC: http://localhost:{vnc_port}/vnc.html?autoconnect=1&resize=remote")



def createDockerWorkspace(port: int, quiet: bool = False) -> DockerWorkspace:
    """Start an OpenHands agent-server container bound to ``port``.

    ``port`` is the base host port; the server also exposes VSCode at ``port + 1`` and
    VNC at ``port + 2``, so concurrent workspaces must be given port bases at least 3
    apart (the batch runner spaces them by 10). When ``quiet`` is True the VSCode/VNC
    URLs are not printed — used by bulk runs so the progress display stays clean.
    """
    # Transform localhost URLs to be accessible from Docker containers
    server_image = _get_server_image()

    # Enable VNC. Use setdefault so concurrent workers don't race on os.environ and an
    # explicit "OH_ENABLE_VNC=false" from the user is respected.
    os.environ.setdefault("OH_ENABLE_VNC", "true")

    def _start() -> DockerWorkspace:
        # The DockerWorkspace constructor blocks polling `docker inspect` for readiness and
        # echoes each command's stdout (the repeated "true", the full `docker version` dump).
        # Suppress that raw stdout so the only thing the user sees is the spinner/log line.
        with contextlib.redirect_stdout(io.StringIO()):
            return DockerWorkspace(
                server_image=server_image,
                platform=_detect_platform(),
                host_port=port,
                extra_ports=True,
                detach_logs=False,
                forward_env=["DEBUG", "OH_ENABLE_VNC"],  # Forward VNC enable flag to container
            )

    if quiet:
        ws = _start()
    else:
        with ui.spinner("Starting agent container…"):
            ws = _start()
        ui.ok("Agent container ready")
        _print_vscode_host(ws)
        _print_vnc_host(ws)

    return ws
