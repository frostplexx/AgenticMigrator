#!/usr/bin/env python3
"""Reconstruct agentUsage from transcripts that were recorded before the report carried it.

`report.json` gained `agentUsage` (which skills the agent opened, which tools it called) only
recently, so every run completed before that has the facts but not the field: `transcript.jsonl`
records every tool call the agent made, including the `read` that opens a SKILL.md. This walks a
run root and rebuilds the counts, so a finished corpus can answer the question without re-running
anything.

The question it exists for: a model that never opens a skill is working from strictly less
information than one that does, on an identical promptRef — only `mv3-migration` is inlined in the
prompt, so `mv3-trivial`, `mv3-semi-trivial`, `mv3-non-trivial` and `manifest-csp` are reachable no
other way. That is a mundane explanation for a weak model's results and it is invisible in a score.

Usage:
    python3 scripts/agent_usage.py <run-root> [--json]

Stdlib only, so it runs wherever the run directories are (including over ssh on the host).
"""

import argparse
import collections
import json
import pathlib
import re
import sys

SKILL_RE = re.compile(r"/skills/([A-Za-z0-9._-]+)/SKILL\.md")


def scan(transcript: pathlib.Path) -> dict:
    """Tool counts and skill reads for one run. Malformed lines are skipped, not fatal: a truncated
    transcript still carries most of the record, and losing the run entirely is the worse trade."""
    tools: collections.Counter = collections.Counter()
    skills: set = set()
    model = None
    for line in transcript.open(encoding="utf-8", errors="replace"):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") == "model_change":
            model = entry.get("modelId")
        if entry.get("type") != "message":
            continue
        for block in entry.get("message", {}).get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "toolCall":
                continue
            tools[block.get("name") or "?"] += 1
            # Match the whole argument blob: `read` takes a path, but a model may also reach a
            # skill with `bash cat`, and both count as having consulted it.
            skills.update(SKILL_RE.findall(json.dumps(block.get("arguments") or {})))
    return {
        "model": model,
        "skillsRead": sorted(skills),
        "toolCalls": dict(sorted(tools.items())),
        "toolCallCount": sum(tools.values()),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run_root", type=pathlib.Path, help="a run directory, or a directory of them")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    args = parser.parse_args(argv)

    transcripts = sorted(args.run_root.glob("*/transcript.jsonl"))
    if not transcripts and (args.run_root / "transcript.jsonl").exists():
        transcripts = [args.run_root / "transcript.jsonl"]
    if not transcripts:
        print(f"no transcript.jsonl under {args.run_root}", file=sys.stderr)
        return 1

    rows = {t.parent.name: scan(t) for t in transcripts}
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0

    width = max(len(name) for name in rows)
    print(f"{'extension':<{width}}  {'tools':>5}  skills read")
    print("-" * (width + 22))
    for name, row in rows.items():
        # "none" spelled out: a blank cell reads as missing data, and "opened no reference
        # document" is the finding, not an absence of one.
        print(f"{name:<{width}}  {row['toolCallCount']:>5}  {', '.join(row['skillsRead']) or 'none'}")

    read_any = sum(1 for r in rows.values() if r["skillsRead"])
    print(f"\n{read_any}/{len(rows)} runs opened at least one skill")
    per_skill: collections.Counter = collections.Counter()
    for row in rows.values():
        per_skill.update(row["skillsRead"])
    for skill, count in per_skill.most_common():
        print(f"  {skill:<20} {count}")
    if not per_skill:
        print("  (no skill was opened in any run — every run worked from the inlined prompt alone)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
