"""Assemble, upload, and download the container workspace.

The container `/workspace` is assembled at runtime (skills + analysis.json) rather than
kept as a checked-in directory; these helpers also move files to/from the remote workspace.
"""

import json
import os
import shutil
import tempfile

# src/ directory (this file lives in src/utils/).
_SRC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def assemble_workspace(analysis: dict | None, logger) -> str:
    """Assemble the container workspace contents in a temp staging dir.

    Combines the skills (``src/skills``) and the statically produced migration plan into
    the layout uploaded to ``/workspace``. Returns the staging dir; the caller removes it.
    """
    staging = tempfile.mkdtemp(prefix="agentic-workspace-")

    # src/skills/* -> /workspace/.openhands/skills/* (skipping pycache/dotfiles)
    skills_src = os.path.join(_SRC_DIR, "skills")
    if os.path.isdir(skills_src):
        shutil.copytree(
            skills_src,
            os.path.join(staging, ".openhands", "skills"),
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )

    # Static migration plan -> /workspace/analysis.json (no LLM analyzer agent).
    if analysis is not None:
        with open(os.path.join(staging, "analysis.json"), "w") as f:
            json.dump(analysis, f, indent=2)

    logger.info(f"Assembled workspace scaffolding in {staging}")
    return staging


def upload_directory(workspace, local_dir: str, remote_dir: str, logger) -> None:
    """Recursively upload a local directory to the remote workspace, preserving structure."""
    if not os.path.isdir(local_dir):
        raise ValueError(f"Local input directory does not exist: {local_dir}")

    for root, _dirs, files in os.walk(local_dir):
        for file in files:
            local_path = os.path.join(root, file)
            relative_path = os.path.relpath(local_path, local_dir)
            # Normalize to POSIX separators for the remote (Linux) container.
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


def download_directory(workspace, remote_dir: str, local_dir: str, logger) -> None:
    """Recursively download a remote workspace directory, preserving structure."""
    # Enumerate every regular file under remote_dir (-print0 handles exotic filenames).
    result = workspace.execute_command(f"find {remote_dir} -type f -print0", timeout=120)
    if result.exit_code != 0:
        raise RuntimeError(
            f"Failed to list remote files (exit={result.exit_code}): {result.stderr}"
        )

    remote_files = [p for p in (result.stdout or "").split("\0") if p]
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


def remote_dir_has_files(workspace, remote_dir: str, logger) -> bool:
    """Return True iff at least one regular file exists under remote_dir."""
    # `find ... -print -quit` exits after the first match — cheaper than enumerating all.
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
