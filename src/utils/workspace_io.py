"""Assemble, upload, and download the container workspace.

The container `/workspace` is assembled at runtime (skills + analysis.json) rather than
kept as a checked-in directory; these helpers also move files to/from the remote workspace.
"""

import json
import os
import shlex
import shutil
import tarfile
import tempfile
import uuid

# src/ directory (this file lives in src/utils/).
_SRC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Bulk transfers go through a single gzip tarball instead of one RPC per file: a workspace
# with many small files (the skills tree, a multi-file extension) otherwise pays a network
# round-trip per file, three times per migration. Packing once collapses that to ~3 RPCs.
_XFER_TIMEOUT = 300


def assemble_workspace(analysis: dict | None, logger, memory_text: str | None = None) -> str:
    """Assemble the container workspace contents in a temp staging dir.

    Combines the skills (``src/skills``), the statically produced migration plan, and
    (when the memory feature is on) the cross-run memory file into the layout uploaded
    to ``/workspace``. Returns the staging dir; the caller removes it.
    """
    staging = tempfile.mkdtemp(prefix="agentic-workspace-")

    # Cross-run memory -> /workspace/MEMORY.md (only when the feature is enabled).
    if memory_text is not None:
        with open(os.path.join(staging, "MEMORY.md"), "w", encoding="utf-8") as f:
            f.write(memory_text)

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
    """Upload a local directory to the remote workspace, preserving structure.

    Packs the tree into a single gzip tarball, uploads that one file, and unpacks it
    remotely — one RPC round-trip instead of one per file.
    """
    if not os.path.isdir(local_dir):
        raise ValueError(f"Local input directory does not exist: {local_dir}")

    fd, local_tar = tempfile.mkstemp(prefix="agentic-upload-", suffix=".tar.gz")
    os.close(fd)
    remote_tar = f"/tmp/agentic-upload-{uuid.uuid4().hex}.tar.gz"
    try:
        with tarfile.open(local_tar, "w:gz") as tar:
            tar.add(local_dir, arcname=".")  # contents land directly under remote_dir

        logger.info(f"Uploading {local_dir} -> {remote_dir} (single archive)")
        result = workspace.file_upload(source_path=local_tar, destination_path=remote_tar)
        if result.error is not None:
            raise RuntimeError(f"Failed to upload archive to {remote_tar}: {result.error}")

        rdir, rtar = shlex.quote(remote_dir), shlex.quote(remote_tar)
        extract = workspace.execute_command(
            f"mkdir -p {rdir} && tar -xzf {rtar} -C {rdir} && rm -f {rtar}",
            timeout=_XFER_TIMEOUT,
        )
        if extract.exit_code != 0:
            raise RuntimeError(
                f"Failed to unpack upload into {remote_dir} "
                f"(exit={extract.exit_code}): {extract.stderr}"
            )
    finally:
        if os.path.exists(local_tar):
            os.unlink(local_tar)


def download_directory(workspace, remote_dir: str, local_dir: str, logger) -> None:
    """Download a remote workspace directory, preserving structure.

    Packs the remote tree into a single tarball, downloads that one file, and unpacks it
    locally — one RPC round-trip instead of one per file.
    """
    remote_tar = f"/tmp/agentic-download-{uuid.uuid4().hex}.tar.gz"
    rdir, rtar = shlex.quote(remote_dir), shlex.quote(remote_tar)
    # `tar -C dir .` packs the directory contents; non-zero means the dir is missing/empty.
    pack = workspace.execute_command(
        f"tar -czf {rtar} -C {rdir} . 2>/dev/null", timeout=_XFER_TIMEOUT
    )
    if pack.exit_code != 0:
        logger.info(f"No files found under {remote_dir}; nothing to download.")
        return

    os.makedirs(local_dir, exist_ok=True)
    fd, local_tar = tempfile.mkstemp(prefix="agentic-download-", suffix=".tar.gz")
    os.close(fd)
    try:
        result = workspace.file_download(source_path=remote_tar, destination_path=local_tar)
        if result.error is not None:
            logger.error(f"Failed to download archive from {remote_tar}: {result.error}")
            return
        with tarfile.open(local_tar, "r:gz") as tar:
            tar.extractall(local_dir, filter="data")  # filter blocks path-traversal members
        # Empty-archive invariant: validate the extraction produced at least one file.
        # An archive can be structurally valid (tar.gz opens fine) but completely empty,
        # which silently leaves the target directory in its previous state — a no-op that
        # makes later stages fail confusingly (missing extension, empty migrated_dir).
        extracted_file_count = sum(
            len(files) for _, _, files in os.walk(local_dir)
        )
        if extracted_file_count == 0:
            logger.warning(
                f"Downloaded archive from {remote_dir} contained no files; "
                f"{local_dir} may be empty or stale."
            )
        logger.info(f"Downloaded {remote_dir} -> {local_dir} (single archive)")
    finally:
        if os.path.exists(local_tar):
            os.unlink(local_tar)
        workspace.execute_command(f"rm -f {rtar}", timeout=30)


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
