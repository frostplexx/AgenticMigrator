from importlib.metadata import version, PackageNotFoundError


def show_banner(model: str | None = None, server_image: str | None = None):
    banner = r"""
██████ ▄▄ ▄▄ ▄▄▄▄▄▄ █████▄  ▄▄▄ ▄▄▄▄▄▄ ▄▄▄▄▄ ▄▄▄▄  ██  ██ ████▄
██▄▄   ▀█▄█▀   ██   ██▄▄█▀ ██▀██  ██   ██▄▄  ██▄█▄ ██▄▄██  ▄██▀
██▄▄▄▄ ██ ██   ██   ██     ▀███▀  ██   ██▄▄▄ ██ ██  ▀██▀  ███▄▄
    """
    print(banner)

    try:
        openhands_version = version("openhands-sdk")
        print(f"OpenHands: {openhands_version}")
    except PackageNotFoundError:
        print("OpenHands Version: unknown")

    if model:
        print(f"Model: {model}")
    if server_image:
        print(f"Server Image: {server_image}")
    print()
