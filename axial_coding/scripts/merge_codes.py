#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Merge per-packet coding acts into coding/open-codes.jsonl.

- Reads every coding/acts/*.jsonl
- Renames codes via the "aliases" map in coding/codebook.json ({"old-name": "new-name"})
- Joins report_idx / verdict / role / flags from corpus/segments.jsonl
- Dedups on (segment_id, code) after renaming, keeping the first occurrence
- Lists codes that are not (yet) in the codebook, with their proposed definitions

Usage:
  uv run scripts/merge_codes.py [--acts coding/acts] [--codebook coding/codebook.json]
                         [--segments corpus/segments.jsonl] [--out coding/open-codes.jsonl]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--acts", default="coding/acts")
    ap.add_argument("--codebook", default="coding/codebook.json")
    ap.add_argument("--segments", default="corpus/segments.jsonl")
    ap.add_argument("--out", default="coding/open-codes.jsonl")
    args = ap.parse_args()

    cb = json.loads(Path(args.codebook).read_text(encoding="utf-8"))
    aliases = cb.get("aliases") or {}
    known = {c["code"] for c in cb.get("codes", [])}

    segments = {}
    for line in Path(args.segments).read_text(encoding="utf-8").splitlines():
        if line.strip():
            s = json.loads(line)
            segments[s["segment_id"]] = s

    seen, acts, dropped, missing = set(), [], [], []
    proposals: dict[str, list[str]] = defaultdict(list)
    for path in sorted(Path(args.acts).glob("*.jsonl")):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            act = json.loads(line)
            code = act["code"]
            while code in aliases:
                code = aliases[code]
            sid = act["segment_id"]
            seg = segments.get(sid)
            if seg is None:
                missing.append(f"{path.name}:{n} {sid}")
                continue
            if (sid, code) in seen:
                dropped.append(f"{path.name}:{n} {sid} {code}")
                continue
            seen.add((sid, code))
            if code not in known and act.get("proposed_definition"):
                proposals[code].append(act["proposed_definition"])
            acts.append({
                "segment_id": sid,
                "report_idx": seg["report_idx"],
                "verdict": seg["verdict"],
                "role": seg["role"],
                "flags": seg["flags"],
                "code": code,
                "aspect": act.get("aspect", ""),
                "quote": act.get("quote", ""),
                "memo": act.get("memo", ""),
                "source": path.name,
            })

    out = Path(args.out)
    with out.open("w", encoding="utf-8") as f:
        for a in acts:
            f.write(json.dumps(a, ensure_ascii=False) + "\n")

    print(f"wrote {len(acts)} acts -> {out} (dropped {len(dropped)} duplicates, {len(missing)} unknown segments)")
    for d in dropped[:20]:
        print(f"  dup: {d}")
    for m in missing:
        print(f"  MISSING SEGMENT: {m}")
    unknown = Counter(a["code"] for a in acts if a["code"] not in known)
    if unknown:
        print(f"\ncodes not in codebook ({len(unknown)}) — add, alias, or drop during consolidation:")
        for code, n in unknown.most_common():
            defs = proposals.get(code) or ["(no proposed_definition)"]
            print(f"  {code} x{n}: {defs[0][:160]}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
