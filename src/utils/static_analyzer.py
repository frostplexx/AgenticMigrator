import json
import os
import re
from collections import defaultdict


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

    def analyze(self, extension_path: str) -> list[dict]:
        """
        Scan JS/HTML files in extension_path for deprecated API usage.
        Returns list of {api, replacement, file, line, snippet} dicts.
        """
        findings = []
        scannable = ('.js', '.ts', '.html', '.htm')

        for root, _, files in os.walk(extension_path):
            for filename in sorted(files):
                if not filename.endswith(scannable):
                    continue
                filepath = os.path.join(root, filename)
                rel_path = os.path.relpath(filepath, extension_path)

                with open(filepath, encoding='utf-8', errors='ignore') as f:
                    lines = f.readlines()

                for lineno, line in enumerate(lines, 1):
                    matched = [api for api in self.api_map if api in line]
                    # Drop any match that is a strict prefix of a longer match on the same line,
                    # e.g. don't report chrome.browserAction when chrome.browserAction.setTitle also matched.
                    matched = [
                        api for api in matched
                        if not any(other != api and other.startswith(api) for other in matched)
                    ]
                    for api in matched:
                        findings.append({
                            "api": api,
                            "replacement": self.api_map[api],
                            "file": rel_path,
                            "line": lineno,
                            "snippet": line.strip(),
                        })

        return findings
