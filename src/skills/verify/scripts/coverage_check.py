"""Static API-coverage check.

Compares the chrome.* namespaces used in the original extension against the migrated
output so the migration cannot "pass" by simply deleting functionality. A namespace that
disappears with no MV3 replacement present — in JS *or* the manifest — is reported.

The manifest evidence matters for cases like blocking ``chrome.webRequest`` -> declarative
``chrome.declarativeNetRequest``: a correct migration is usually declarative (a manifest
key + a rules JSON) and leaves no chrome.* call in JS, so without checking the manifest a
correct migration and an outright deletion look identical.
"""

import json
import os
import re

# Acceptable evidence that a dropped MV2 namespace was migrated rather than deleted.
# Tokens: "js:<ns>" = chrome.<ns> appears in the migrated JS/HTML;
#         "manifest:<key>" = key present in the migrated manifest (top-level or permission).
# Namespaces not listed here have no known MV3 replacement, so dropping them at all is flagged.
_NAMESPACE_REPLACEMENTS = {
    "browserAction": ["js:action", "manifest:action"],
    "pageAction": ["js:action", "manifest:action"],
    "extension": ["js:runtime", "js:scripting", "js:action"],
    "webRequest": [
        "js:declarativeNetRequest",
        "manifest:declarative_net_request",
        "manifest:declarativeNetRequest",
    ],
    "tabs": ["js:tabs", "js:scripting"],
}

_SCANNABLE = (".js", ".ts", ".html", ".htm")
_CHROME_NS = re.compile(r"chrome\.([A-Za-z_][A-Za-z0-9_]*)")


def _scan_chrome_namespaces(directory: str) -> dict[str, tuple[str, int, str]]:
    """Map each first-level chrome.<ns> used under `directory` to its first occurrence."""
    found: dict[str, tuple[str, int, str]] = {}
    for root, _, files in os.walk(directory):
        for fn in sorted(files):
            if not fn.endswith(_SCANNABLE):
                continue
            path = os.path.join(root, fn)
            rel = os.path.relpath(path, directory)
            try:
                with open(path, encoding="utf-8", errors="ignore") as f:
                    for lineno, line in enumerate(f, 1):
                        for m in _CHROME_NS.finditer(line):
                            found.setdefault(m.group(1), (rel, lineno, line.strip()))
            except OSError:
                continue
    return found


def _migrated_evidence(migrated_dir: str) -> set[str]:
    """Collect evidence tokens from the migrated output (JS namespaces + manifest keys)."""
    evidence = {f"js:{ns}" for ns in _scan_chrome_namespaces(migrated_dir)}
    try:
        with open(os.path.join(migrated_dir, "manifest.json")) as f:
            manifest = json.load(f)
        for key in manifest:
            evidence.add(f"manifest:{key}")
        for perm in manifest.get("permissions", []):
            evidence.add(f"manifest:{perm}")
    except Exception:
        pass
    return evidence


def check_namespace_coverage(original_dir: str, migrated_dir: str) -> list[dict]:
    """Return dropped chrome.* namespaces (used originally, gone from the migrated output
    with no MV3 replacement present). Each entry: {namespace, file, line, snippet}."""
    original = _scan_chrome_namespaces(original_dir)
    migrated = set(_scan_chrome_namespaces(migrated_dir))
    evidence = _migrated_evidence(migrated_dir)

    dropped = []
    for ns, (rel, lineno, snippet) in sorted(original.items()):
        if ns in migrated:
            continue  # still used directly
        repls = _NAMESPACE_REPLACEMENTS.get(ns)
        if repls and any(tok in evidence for tok in repls):
            continue  # migrated to a recognized replacement (JS or manifest/declarative)
        dropped.append(
            {"namespace": ns, "file": rel, "line": lineno, "snippet": snippet}
        )
    return dropped
