import json
import os
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Pattern


def build_analysis(findings: list[dict], extension_path: str) -> dict:
    """Turn static-analysis findings into the analysis.json migration plan.

    This replaces the former LLM analyzer agent: the plan is produced statically (fast and
    deterministic) for known API call-site replacements. Manifest-level changes and
    anything static analysis cannot see are handled by the transformer (using the migration
    reference) and surfaced at runtime by the verify skill.
    """
    extension_name = None
    try:
        with open(os.path.join(extension_path, "manifest.json")) as f:
            extension_name = json.load(f).get("name")
    except Exception:
        pass

    by_file: dict[str, list[dict]] = defaultdict(list)
    for f in findings:
        by_file[f["file"]].append(
            {
                "type": "api_replacement",
                "line": f["line"],
                "api": f["api"],
                "replacement": f["replacement"],
                "snippet": f["snippet"],
            }
        )

    files = [
        {"path": path, "changes": sorted(changes, key=lambda c: c["line"])}
        for path, changes in sorted(by_file.items())
    ]

    return {
        "extension_name": extension_name,
        "source": "static-analysis",
        "files": files,
        "note": (
            "Static analysis lists known deprecated API call sites and their MV3 "
            "replacements. Manifest changes (manifest_version, background/service_worker, "
            "action, host_permissions, CSP, web_accessible_resources) and anything not "
            "listed here must still be applied using the migration reference, and are "
            "verified at runtime by the verify skill."
        ),
    }


# --- non-mechanical migration signals -------------------------------------------------
#
# Unlike the API-rename findings above (which the extension-manifest-converter applies
# mechanically), these signals flag the work that has no deterministic fix and would
# otherwise stay invisible until the runtime verify step fails. Each maps to the skill that
# explains the fix and carries a short headline + ordering for the prompt.

CATEGORIES: dict[str, dict] = {
    "blocking_webrequest": {
        "order": 0,
        "skill": "mv3-non-trivial",
        "title": "Blocking webRequest -> declarativeNetRequest (DNR)",
        "hint": (
            "MV3 removes blocking webRequest. Re-express these block/redirect/modify rules "
            "declaratively in a rules.json (see the mv3-non-trivial skill) and drop the "
            '"webRequestBlocking" permission.'
        ),
    },
    "background_dom": {
        "order": 1,
        "skill": "mv3-non-trivial",
        "title": "Background-context DOM / Web API -> offscreen document",
        "hint": (
            "The service worker has no DOM/window/localStorage/audio. Move this work to an "
            "offscreen document (or chrome.storage / fetch where possible) per the "
            "mv3-non-trivial skill."
        ),
    },
    "remote_code": {
        "order": 2,
        "skill": "mv3-non-trivial",
        "title": "Remotely-hosted or eval'd code (forbidden in MV3)",
        "hint": (
            "MV3 forbids remote code and most eval. Bundle the code locally; use a sandbox "
            "page only where runtime evaluation is genuinely required."
        ),
    },
    "background_page_access": {
        "order": 3,
        "skill": "mv3-semi-trivial",
        "title": "getBackgroundPage removed",
        "hint": (
            "chrome.{runtime,extension}.getBackgroundPage is gone in MV3. Communicate via "
            "chrome.runtime messaging or chrome.storage instead."
        ),
    },
}

# DOM / Web APIs unavailable in a service worker (only flagged inside background files).
_BACKGROUND_DOM: Pattern[str] = re.compile(
    r"\b("
    r"document\.|window\.|localStorage\b|sessionStorage\b|XMLHttpRequest\b|"
    r"new\s+Audio\b|AudioContext\b|webkitAudioContext\b|DOMParser\b|"
    r"navigator\.clipboard\b|navigator\.geolocation\b|"
    r"alert\s*\(|confirm\s*\(|prompt\s*\("
    r")"
)
_REMOTE_EVAL: Pattern[str] = re.compile(
    r"\b(eval\s*\(|new\s+Function\s*\(|importScripts\s*\(\s*['\"]https?:)"
)
_REMOTE_SCRIPT_SRC: Pattern[str] = re.compile(
    r"""<script[^>]*\bsrc\s*=\s*['"](?:https?:)?//""", re.IGNORECASE
)
_GET_BACKGROUND_PAGE: Pattern[str] = re.compile(
    r"chrome\.(?:runtime|extension)\.getBackgroundPage\b"
)
_WEBREQUEST_LISTENER: Pattern[str] = re.compile(r"chrome\.webRequest\.\w+\.addListener")
_BLOCKING_RESPONSE: Pattern[str] = re.compile(
    r"['\"]blocking['\"]|\b(?:cancel|redirectUrl|requestHeaders|responseHeaders)\s*:"
)


@dataclass
class ScanResult:
    """Everything one static pass over an extension produces.

    ``findings`` are the mechanical deprecated-API call sites (consumed by
    :func:`build_analysis` and listed verbatim for the agent). ``signals`` are the
    non-mechanical migration signals (blocking webRequest, background DOM use, remote code,
    getBackgroundPage) that route the agent to the right non-trivial skill.
    """

    findings: list[dict] = field(default_factory=list)
    signals: list[dict] = field(default_factory=list)


def group_signals_by_category(signals: list[dict]) -> dict[str, list[dict]]:
    """Group signals by category, ordered by ``CATEGORIES[...]['order']``."""
    grouped: dict[str, list[dict]] = defaultdict(list)
    for s in signals:
        grouped[s["category"]].append(s)
    return {
        cat: sorted(grouped[cat], key=lambda s: (s["file"], s["line"]))
        for cat in sorted(grouped, key=lambda c: CATEGORIES[c]["order"])
    }


class StaticAnalyzer:
    def __init__(self, mappings_path: str):
        with open(mappings_path) as f:
            data = json.load(f)
        self._build_api_map(data["mappings"])

    def _extract_api(self, body: str) -> str | None:
        m = re.search(r'(chrome(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)', body)
        return m.group(1) if m else None

    def _build_api_map(self, mappings: list) -> None:
        self.api_map: dict[str, str] = {}
        for mapping in mappings:
            source_api = self._extract_api(mapping["source"]["body"])
            target_api = self._extract_api(mapping["target"]["body"])
            if source_api and target_api and source_api not in self.api_map:
                self.api_map[source_api] = target_api

        # Compile a single regex that matches any known deprecated API.
        # Sort longest first so the alternation always prefers the most-specific match
        # (e.g. chrome.browserAction.setTitle over chrome.browserAction).
        sorted_apis = sorted(self.api_map, key=len, reverse=True)
        pattern = "|".join(re.escape(a) for a in sorted_apis)
        self._api_re: Pattern[str] = re.compile(pattern) if pattern else re.compile(r"(?!)")

    # --- manifest-derived context -----------------------------------------------------

    def _load_manifest(self, extension_path: str) -> dict:
        try:
            with open(os.path.join(extension_path, "manifest.json")) as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return {}

    def _background_files(self, manifest: dict) -> set[str]:
        """Background/service-worker source files declared in the manifest.

        Covers both the post-convert MV3 shape (``background.service_worker``) and the MV2
        shape (``background.scripts``) so detection works whether or not the converter ran.
        Returned relative to the extension root, matching ``rel_path``.
        """
        bg = manifest.get("background") or {}
        files: set[str] = set()
        if isinstance(bg, dict):
            if isinstance(bg.get("service_worker"), str):
                files.add(bg["service_worker"])
            if isinstance(bg.get("scripts"), list):
                files.update(s for s in bg["scripts"] if isinstance(s, str))
        return {f.lstrip("/").replace("\\", "/") for f in files}

    # --- scanning ---------------------------------------------------------------------

    def scan(self, extension_path: str) -> ScanResult:
        """Single pass over the extension producing API findings and migration signals."""
        result = ScanResult()
        manifest = self._load_manifest(extension_path)
        bg_files = self._background_files(manifest)

        perms = manifest.get("permissions")
        if isinstance(perms, list) and "webRequestBlocking" in perms:
            self._add_signal(
                result, "blocking_webrequest", "manifest.json", 0,
                '"permissions": [..., "webRequestBlocking"]',
            )

        scannable = ('.js', '.ts', '.mjs', '.html', '.htm')
        for root, _, files in os.walk(extension_path):
            for filename in sorted(files):
                if not filename.endswith(scannable):
                    continue
                filepath = os.path.join(root, filename)
                rel_path = os.path.relpath(filepath, extension_path)

                with open(filepath, encoding='utf-8', errors='ignore') as f:
                    lines = f.readlines()

                is_html = filename.endswith(('.html', '.htm'))
                is_background = rel_path.replace(os.sep, "/") in bg_files
                file_has_webrequest = any("chrome.webRequest" in ln for ln in lines)

                for lineno, line in enumerate(lines, 1):
                    self._scan_api_findings(result, rel_path, lineno, line)
                    self._scan_signals(
                        result, rel_path, lineno, line,
                        is_html=is_html,
                        is_background=is_background,
                        file_has_webrequest=file_has_webrequest,
                    )

        return result

    def analyze(self, extension_path: str) -> list[dict]:
        """Deprecated-API call sites only (back-compat wrapper over :meth:`scan`)."""
        return self.scan(extension_path).findings

    def detect_signals(self, extension_path: str) -> list[dict]:
        """Non-mechanical migration signals only (convenience wrapper over :meth:`scan`)."""
        return self.scan(extension_path).signals

    def _scan_api_findings(
        self, result: ScanResult, rel_path: str, lineno: int, line: str
    ) -> None:
        # Single-pass: collect all non-overlapping matches; the regex is already sorted
        # longest-first so shorter prefixes are never reported when a longer match exists
        # on the same line.
        seen: set[str] = set()
        for m in self._api_re.finditer(line):
            api = m.group(0)
            if api not in seen:
                seen.add(api)
                result.findings.append({
                    "api": api,
                    "replacement": self.api_map[api],
                    "file": rel_path,
                    "line": lineno,
                    "snippet": line.strip(),
                })

    def _scan_signals(
        self, result: ScanResult, rel_path: str, lineno: int, line: str,
        *, is_html: bool, is_background: bool, file_has_webrequest: bool,
    ) -> None:
        if is_html:
            if _REMOTE_SCRIPT_SRC.search(line):
                self._add_signal(result, "remote_code", rel_path, lineno, line)
            return

        # Blocking webRequest: the addListener anchor, or a blocking-response key on a line
        # in a file that references webRequest at all.
        if _WEBREQUEST_LISTENER.search(line) or (
            file_has_webrequest and _BLOCKING_RESPONSE.search(line)
        ):
            self._add_signal(result, "blocking_webrequest", rel_path, lineno, line)

        if _REMOTE_EVAL.search(line):
            self._add_signal(result, "remote_code", rel_path, lineno, line)

        if _GET_BACKGROUND_PAGE.search(line):
            self._add_signal(result, "background_page_access", rel_path, lineno, line)

        # DOM/Web API use only matters in the background service worker; the same calls in a
        # popup/options page are fine.
        if is_background and _BACKGROUND_DOM.search(line):
            self._add_signal(result, "background_dom", rel_path, lineno, line)

    @staticmethod
    def _add_signal(
        result: ScanResult, category: str, file: str, line: int, raw: str
    ) -> None:
        result.signals.append({
            "category": category,
            "skill": CATEGORIES[category]["skill"],
            "file": file,
            "line": line,
            "snippet": raw.strip(),
        })
