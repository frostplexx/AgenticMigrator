#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Check that every file an LLM coder is asked to read fits the 128k-token context budget.

Per-file limits (estimated tokens) and the worst-case single job
(instructions + codebook + largest packet + previous-packet memo) are checked.
Exit code 1 if anything is over budget.

Usage:
  uv run scripts/budget.py
"""
from __future__ import annotations

import sys
from pathlib import Path

from extract_transcripts import est_tokens

CONTEXT = 128_000
JOB_CEILING = 64_000  # max input loaded for one job; the rest is reasoning, tool output, and writing acts

LIMITS = [  # (glob, max tokens per file)
    ("INSTRUCTIONS.md", 6_000),
    ("coding/codebook.json", 12_000),
    ("corpus/reports.csv", 6_000),
    ("corpus/packets/*.md", 35_000),
    ("coding/memos/*.md", 400),
    ("coding/trouble/*.md", 800),
    ("coding/.ctx/*.md", 20_000),
    ("coding/axial-input.md", 15_000),
    ("coding/axial-coding.md", 15_000),
    ("coding/findings.md", 12_000),
]


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    over = 0
    sizes: dict[str, int] = {}
    for pattern, limit in LIMITS:
        files = sorted(root.glob(pattern))
        if not files:
            print(f"  -      {pattern:28} (not present yet)")
            continue
        worst = max(files, key=lambda f: est_tokens(f.read_text(encoding="utf-8")))
        t = est_tokens(worst.read_text(encoding="utf-8"))
        sizes[pattern] = t
        status = "OK " if t <= limit else "OVER"
        over += t > limit
        label = pattern if len(files) == 1 else f"{pattern} (max of {len(files)}: {worst.name})"
        print(f"  {status} {t:>7,} / {limit:>6,}  {label}")

    # files that grow during the work (codebook, memos) are counted at their limit, not their current size
    limit_of = dict(LIMITS)
    job = (sizes.get("INSTRUCTIONS.md", limit_of["INSTRUCTIONS.md"]) + limit_of["coding/codebook.json"]
           + sizes.get("corpus/packets/*.md", limit_of["corpus/packets/*.md"]) + limit_of["coding/memos/*.md"])
    status = "OK " if job <= JOB_CEILING else "OVER"
    over += job > JOB_CEILING
    print(f"\n  {status} worst-case coding job ≈ {job:,} tokens of input "
          f"(ceiling {JOB_CEILING:,}; leaves ≈ {CONTEXT - job:,} of {CONTEXT:,} for reasoning and output)")
    print("\nbudget OK" if not over else f"\n{over} item(s) over budget")
    return 1 if over else 0


if __name__ == "__main__":
    sys.exit(main())
