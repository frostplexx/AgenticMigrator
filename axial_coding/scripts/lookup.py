#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Context-safe lookups into corpus/segments.jsonl (never read that file directly).

Usage:
  uv run scripts/lookup.py R01-037 [R01-039 ...]   # print segments in full (clipped at --max-chars)
  uv run scripts/lookup.py --timeline R01          # one line per segment: id, role, tool, flags, opening text
  uv run scripts/lookup.py --flagged [R01]         # only flagged segments (output cap, errors, compaction, ...)
  uv run scripts/lookup.py --grep "ABSTAIN" [R01]  # segments whose text contains a string (case-insensitive)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def line(s: dict, width: int) -> str:
    text = " ".join(s["text"].split())[:width]
    flags = f" [{','.join(s['flags'])}]" if s["flags"] else ""
    tool = f"·{s['tool_name']}" if s["tool_name"] else ""
    return f"{s['segment_id']} {s['role']}{tool}{flags} | {text}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="*", help="segment ids, or a report id (RXX) to scope --flagged/--grep")
    ap.add_argument("--timeline", metavar="RXX")
    ap.add_argument("--flagged", action="store_true")
    ap.add_argument("--grep", metavar="TEXT")
    ap.add_argument("--width", type=int, default=140, help="chars of text per line in list modes")
    ap.add_argument("--max-chars", type=int, default=6000, help="max chars per segment in full mode")
    ap.add_argument("--segments", default="corpus/segments.jsonl")
    args = ap.parse_args()

    segs = [json.loads(l) for l in Path(args.segments).read_text(encoding="utf-8").splitlines() if l.strip()]
    scope = next((i for i in args.ids if len(i) == 3 and i.startswith("R")), None)

    if args.timeline:
        rows = [s for s in segs if s["report_idx"] == args.timeline]
        print(f"{args.timeline}: {len(rows)} segments · verdict={rows[0]['verdict'] if rows else '?'}")
        for s in rows:
            print(line(s, args.width))
        return 0
    if args.flagged or args.grep:
        rows = [s for s in segs if not scope or s["report_idx"] == scope]
        if args.flagged:
            rows = [s for s in rows if s["flags"]]
        if args.grep:
            needle = args.grep.lower()
            rows = [s for s in rows if needle in s["text"].lower()]
        for s in rows[:200]:
            print(line(s, args.width))
        print(f"({len(rows)} segments{', first 200 shown' if len(rows) > 200 else ''})")
        return 0

    by_id = {s["segment_id"]: s for s in segs}
    for sid in args.ids:
        s = by_id.get(sid)
        if not s:
            print(f"{sid}: not found")
            continue
        text = s["text"]
        if len(text) > args.max_chars:
            text = text[: args.max_chars] + f" …[+{len(text) - args.max_chars} chars; raise --max-chars]"
        meta = f"role={s['role']} tool={s['tool_name'] or '-'} stop={s['stop_reason'] or '-'} out={s['output_tokens']} flags={','.join(s['flags']) or '-'}"
        print(f"===== {sid} · {s['report_idx']} {s['verdict']} · {meta}\n{text}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
