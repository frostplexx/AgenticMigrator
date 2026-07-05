"""Cross-run agent memory: one curated markdown file carried from run to run.

The memory file (default ``memory/MEMORY.md``, tracked in git so pushing the repo backs
it up to GitHub) is uploaded into every run's workspace at ``/workspace/MEMORY.md``. The
orchestrator is told to read it before starting and — in read-write mode — to fold new
*generalizable* learnings back into it before finishing. After the run the harness
collects the container copy and, if it passes validation, replaces the host file so the
next run starts from the updated memory.

Modes (all env-driven, like the LLM/critic config):

- ``MEMORY`` unset/0 — feature off entirely; runs are byte-identical to pre-memory
  behavior, which keeps experiment baselines clean.
- ``MEMORY=1`` — read-write: memory is uploaded, and the post-run copy is collected.
- ``MEMORY=1 MEMORY_READONLY=1`` — knowledge base: memory is uploaded, but the post-run
  copy is *never* collected. Enforced host-side, so a misbehaving agent (or prompt
  injection from extension source) cannot corrupt the knowledge base.

Unbounded growth is prevented host-side, not by trust: an update larger than
``MEMORY_MAX_CHARS`` is discarded wholesale (the previous memory is kept) and the prompt
tells the agent so — the only way to add under a full budget is to curate: merge,
rewrite, or drop existing entries.

Concurrency: batch workers are threads in one process; ``_WRITE_LOCK`` serializes
write-backs. Updates are last-writer-wins per completed run — acceptable for a research
feature and documented in docs/configuration.md.
"""

import os
import shutil
import subprocess
import tempfile
import threading

from .llm_factory import _bool_env

# repo_root/memory/MEMORY.md (this file lives in src/utils/).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_MEMORY_FILE = os.path.join(_REPO_ROOT, "memory", "MEMORY.md")
DEFAULT_MAX_CHARS = 10_000

# Name of the memory file inside the container workspace.
REMOTE_NAME = "MEMORY.md"

_WRITE_LOCK = threading.Lock()

_SEED = """\
# Migration Memory

Distilled, generalizable learnings from previous MV2->MV3 migration runs. Uploaded into
every run's workspace at /workspace/MEMORY.md.

<!-- RULES for updating this file:
- HARD BUDGET: stay under the character limit given in the task prompt. Oversized
  updates are DISCARDED ENTIRELY by the harness - curating is the only way to add when
  the budget is tight: merge similar entries, rewrite verbose ones, drop the least
  valuable one.
- Only generalizable knowledge: API pitfalls, verification-failure patterns and their
  fixes, Chrome/MV3 behaviors. NEVER run-specific details (extension ids, file paths,
  timestamps, one-off bugs).
- Keep entries as terse single bullets under the one heading below.
-->

## Learnings

(none yet)
"""


class MemoryConfig:
    """Resolved memory settings for one run (immutable after construction)."""

    def __init__(
        self,
        enabled: bool = False,
        readonly: bool = False,
        path: str = DEFAULT_MEMORY_FILE,
        max_chars: int = DEFAULT_MAX_CHARS,
    ) -> None:
        self.enabled = enabled
        self.readonly = readonly
        self.path = path
        self.max_chars = max_chars

    @classmethod
    def from_env(cls) -> "MemoryConfig":
        """Build from env: MEMORY, MEMORY_READONLY, MEMORY_FILE, MEMORY_MAX_CHARS."""
        return cls(
            enabled=_bool_env("MEMORY", default=False),
            readonly=_bool_env("MEMORY_READONLY", default=False),
            path=os.path.abspath(os.environ.get("MEMORY_FILE") or DEFAULT_MEMORY_FILE),
            max_chars=int(os.environ.get("MEMORY_MAX_CHARS") or DEFAULT_MAX_CHARS),
        )


def load(config: MemoryConfig, logger) -> str | None:
    """Return the current memory text, or None when the feature is disabled.

    A missing file is seeded with the template (and the seed written to disk in
    read-write mode, so the file exists for git to track).
    """
    if not config.enabled:
        return None
    try:
        with open(config.path, encoding="utf-8") as fh:
            return fh.read()
    except FileNotFoundError:
        logger.info(f"Memory file {config.path} missing; starting from the seed template.")
        if not config.readonly:
            _atomic_write(config.path, _SEED)
        return _SEED


def collect_update(config: MemoryConfig, workspace, remote_root: str, logger) -> bool:
    """Pull /workspace/MEMORY.md back from the container and persist it if valid.

    Returns True iff the host memory file was updated. No-op in disabled or read-only
    mode. An update is rejected (previous memory kept) when the container copy is
    missing, empty, unchanged, or over the ``max_chars`` budget.
    """
    if not config.enabled or config.readonly:
        return False

    fd, local_tmp = tempfile.mkstemp(prefix="agentic-memory-", suffix=".md")
    os.close(fd)
    try:
        result = workspace.file_download(
            source_path=f"{remote_root.rstrip('/')}/{REMOTE_NAME}",
            destination_path=local_tmp,
        )
        if result.error is not None:
            logger.warning(f"Memory: could not download container copy: {result.error}")
            return False
        with open(local_tmp, encoding="utf-8") as fh:
            updated = fh.read()
    finally:
        os.unlink(local_tmp)

    if not updated.strip():
        logger.warning("Memory: container copy is empty; keeping previous memory.")
        return False
    # Content invariant: the memory must start with the known header. An agent that blanks
    # the file to a single space or writes random content has corrupted the structure — do
    # not replace the host copy. (The seed template always starts with "# Migration Memory".)
    if not updated.lstrip().startswith("# Migration Memory"):
        logger.warning(
            "Memory: container copy no longer starts with '# Migration Memory' header; "
            "keeping previous memory to avoid losing structured knowledge."
        )
        return False
    if len(updated) > config.max_chars:
        logger.warning(
            f"Memory: update is {len(updated)} chars (budget {config.max_chars}); "
            f"discarding it entirely — the agent must curate, not append."
        )
        return False

    with _WRITE_LOCK:
        previous = load(config, logger)
        if updated == previous:
            return False
        _atomic_write(config.path, updated)
    logger.info(f"Memory: updated {config.path} ({len(updated)}/{config.max_chars} chars).")
    return True


def snapshot(config: MemoryConfig, output_dir: str, logger) -> None:
    """Copy the current host memory into the run's output dir for experiment provenance."""
    if not config.enabled or not os.path.isfile(config.path):
        return
    try:
        shutil.copyfile(config.path, os.path.join(output_dir, "memory.md"))
    except OSError as e:
        logger.warning(f"Memory: could not snapshot into {output_dir}: {e}")


def commit_if_configured(config: MemoryConfig, logger) -> None:
    """Commit the memory file when MEMORY_GIT_COMMIT=1 and it has uncommitted changes.

    Commit only — pushing (the actual GitHub backup) stays a deliberate user action.
    """
    if not config.enabled or config.readonly:
        return
    if not _bool_env("MEMORY_GIT_COMMIT", default=False):
        return
    repo_dir = os.path.dirname(config.path)
    try:
        status = subprocess.run(
            ["git", "-C", repo_dir, "status", "--porcelain", "--", config.path],
            capture_output=True, text=True, timeout=30,
        )
        if status.returncode != 0 or not status.stdout.strip():
            return  # not a git repo, or nothing changed
        subprocess.run(
            ["git", "-C", repo_dir, "add", "--", config.path],
            check=True, capture_output=True, timeout=30,
        )
        subprocess.run(
            ["git", "-C", repo_dir, "commit", "-m", "chore: update migration memory",
             "--", config.path],
            check=True, capture_output=True, timeout=30,
        )
        logger.info("Memory: committed updated memory file to git.")
    except (subprocess.SubprocessError, OSError) as e:
        logger.warning(f"Memory: git commit failed: {e}")


def prompt_section(config: MemoryConfig, memory_text: str) -> str:
    """The prompt block describing /workspace/MEMORY.md to the orchestrator."""
    header = (
        "## Persistent Memory\n\n"
        "`/workspace/MEMORY.md` holds distilled learnings from previous migration runs. "
        "Read it FIRST and apply anything relevant (pass the relevant learnings along "
        "when delegating).\n"
    )
    if config.readonly:
        return header + (
            "\nThe memory is READ-ONLY this run: do not edit `/workspace/MEMORY.md`; "
            "any changes to it are discarded.\n"
        )
    return header + (
        f"\nAfter the migration is complete (before you stop), fold any NEW, "
        f"generalizable learnings from this run back into `/workspace/MEMORY.md`, "
        f"following the RULES comment inside it. Hard budget: {config.max_chars} "
        f"characters (currently {len(memory_text)}). If an update would exceed the "
        f"budget the harness discards it ENTIRELY, so curate: merge, rewrite, or drop "
        f"entries — never blindly append. Skip the update if this run taught nothing "
        f"new.\n"
    )


def _atomic_write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
