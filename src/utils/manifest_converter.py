"""Run the GoogleChromeLabs extension-manifest-converter over an extension before upload.

This is a host-side pre-pass: it applies the deterministic, search-and-replace MV2->MV3
conversions (manifest_version, host_permissions, background -> service worker,
browser/page action -> action, executeScript/insertCSS -> scripting, CSP, WAR) so the LLM
only has to finish what the converter can't do automatically. The converter is vendored as
a git submodule under ``third_party/``.
"""

import os
import shutil
import subprocess
import sys
import tempfile

from . import invariants

# repo_root/third_party/extension-manifest-converter (this file is src/utils/…).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_CONVERTER_DIR = os.path.join(_REPO_ROOT, "third_party", "extension-manifest-converter")
_CONVERT_TIMEOUT = 120


def convert(extension_path: str, logger) -> str:
    """Return a fresh temp directory holding the converted extension.

    The caller owns the returned directory and must remove it. If the converter submodule
    is missing or fails, the original extension is copied through unchanged so the pipeline
    still proceeds (the LLM + verify loop remain the safety net).
    """
    out_dir = tempfile.mkdtemp(prefix="emc-converted-")

    if not os.path.isfile(os.path.join(_CONVERTER_DIR, "emc.py")):
        logger.warning(
            f"extension-manifest-converter not found at {_CONVERTER_DIR}; uploading the "
            f"extension unconverted. Run `git submodule update --init --recursive`."
        )
        _replace_dir(out_dir, extension_path)
        return out_dir

    # emc writes its output to "<source>_delete" next to the source, so run it on a copy
    # inside a throwaway work dir to avoid touching the user's extension tree.
    work = tempfile.mkdtemp(prefix="emc-work-")
    try:
        src_copy = os.path.join(work, "extension")
        shutil.copytree(extension_path, src_copy)

        result = subprocess.run(
            [sys.executable, "emc.py", src_copy],
            cwd=_CONVERTER_DIR,
            capture_output=True,
            text=True,
            timeout=_CONVERT_TIMEOUT,
        )
        converted = src_copy + "_delete"

        # Converter-output invariant: exit code 0 is not proof the output is usable — the
        # converter can still emit a mangled or truncated manifest. Anything structurally
        # broken falls back to the original extension (the known-good state); the LLM +
        # verify loop then handle the conversion the pre-pass would have done.
        violations = (
            invariants.check_extension_input(converted) if result.returncode == 0 else []
        )

        if result.returncode == 0 and not violations:
            logger.info(
                "extension-manifest-converter applied:\n" + (result.stdout or "").strip()
            )
            # Move (rename) the converted tree into place rather than copying it: both dirs
            # live under the same temp filesystem, so this is an instant rename instead of a
            # full byte-for-byte copy of the extension.
            os.rmdir(out_dir)
            shutil.move(converted, out_dir)
        elif violations:
            logger.error(
                f"extension-manifest-converter produced a broken extension "
                f"({'; '.join(violations)}); uploading the original unconverted."
            )
            _replace_dir(out_dir, extension_path)
        else:
            logger.error(
                f"extension-manifest-converter failed (exit={result.returncode}): "
                f"{(result.stderr or result.stdout).strip()}; uploading extension unconverted."
            )
            _replace_dir(out_dir, extension_path)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    return out_dir


def _replace_dir(dst: str, src: str) -> None:
    """Copy src over dst (dst is an existing, possibly-empty directory)."""
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst)
