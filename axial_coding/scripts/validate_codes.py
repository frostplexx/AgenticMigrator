#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Validate open-coding output against the codebook and print frequency tables.

Inputs:
  coding/codebook.json    code inventory: {"codes": [{code, definition, category, ...}]}
  coding/open-codes.jsonl one JSON object per coding act:
                          {"segment_id", "code", "quote", "memo", "coder"}
  corpus/segments.jsonl   from extract_transcripts.py (for segment existence + quote checks)

Usage:
  uv run scripts/validate_codes.py [--codebook coding/codebook.json]
                           [--codes coding/open-codes.jsonl]
                           [--segments corpus/segments.jsonl]

Exit code 1 if there are blocking problems (unknown codes, missing segments).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as e:
            print(f"ERROR: {path}:{i}: bad JSON: {e}")
            sys.exit(1)
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--codebook", default="coding/codebook.json")
    ap.add_argument("--codes", default="coding/open-codes.jsonl")
    ap.add_argument("--segments", default="corpus/segments.jsonl")
    args = ap.parse_args()

    cb = json.loads(Path(args.codebook).read_text(encoding="utf-8"))
    codes_def = {c["code"]: c for c in cb["codes"]}
    codings = load_jsonl(Path(args.codes))
    segments = {s["segment_id"]: s for s in load_jsonl(Path(args.segments))}

    blocking = 0

    # ---- structural checks ----
    unknown = Counter()
    dups = Counter()
    missing_seg = Counter()
    quote_mismatch = []
    no_quote = 0
    bad_name = []
    for r in codings:
        code = r.get("code", "")
        sid = r.get("segment_id", "")
        if code not in codes_def:
            unknown[code] += 1
        if not KEBAB.match(code):
            bad_name.append(code)
        if not (r.get("quote") or "").strip():
            no_quote += 1
        if sid not in segments:
            missing_seg[sid] += 1
        else:
            seg_text = segments[sid].get("text", "")
            q = (r.get("quote") or "").strip()
            if q and q not in seg_text:
                # tolerate whitespace differences
                if " ".join(q.split()) not in " ".join(seg_text.split()):
                    quote_mismatch.append((sid, code))
        dups[(sid, code)] += 1

    if unknown:
        blocking += 1
        print(f"UNKNOWN CODES ({sum(unknown.values())} uses) — add to codebook or fix:")
        for c, n in unknown.most_common():
            print(f"  {c}  x{n}")
    if missing_seg:
        blocking += 1
        print(f"MISSING SEGMENTS ({sum(missing_seg.values())}):")
        for s, n in missing_seg.most_common(10):
            print(f"  {s}  x{n}")
    dups = {k: v for k, v in dups.items() if v > 1}
    if dups:
        print(f"DUPLICATE (segment, code) pairs: {len(dups)} (not blocking, but dedupe)")
        for (s, c), n in list(dups.items())[:10]:
            print(f"  {s} · {c}  x{n}")
    if bad_name:
        print(f"NON-KEBAB-CASE code names: {sorted(set(bad_name))}")
    if no_quote:
        print(f"codings without a quote: {no_quote}")
    if quote_mismatch:
        print(f"quotes not found verbatim in segment text: {len(quote_mismatch)} (first 5)")
        for sid, code in quote_mismatch[:5]:
            print(f"  {sid} · {code}")

    # ---- frequency tables ----
    code_freq = Counter(r["code"] for r in codings)
    code_reports = defaultdict(set)
    code_verdicts = defaultdict(Counter)
    for r in codings:
        seg = segments.get(r["segment_id"], {})
        code_reports[r["code"]].add(r["report_idx"])
        code_verdicts[r["code"]][seg.get("verdict", "?")] += 1

    print(f"\n{'=' * 72}\nCODE FREQUENCIES ({len(codings)} codings over {len(segments)} segments)\n{'=' * 72}")
    print(f"{'code':32} {'uses':>5} {'reps':>5}  verdict spread")
    for code, n in code_freq.most_common():
        reps = len(code_reports[code])
        vs = ", ".join(f"{v}:{c}" for v, c in code_verdicts[code].most_common())
        print(f"{code:32} {n:>5} {reps:>5}  {vs}")

    unused = sorted(set(codes_def) - set(code_freq))
    if unused:
        print(f"\nUNUSED CODEBOOK CODES ({len(unused)}): {', '.join(unused)}")

    singletons = [c for c, n in code_freq.items() if n == 1]
    single_report = [c for c, reps in code_reports.items() if len(reps) == 1 and code_freq[c] > 1]
    if singletons:
        print(f"\nSINGLETON CODES (used once — merge or justify): {', '.join(singletons)}")
    if single_report:
        print(f"ONE-REPORT-ONLY CODES (≥2 uses, 1 report — check generality): {', '.join(single_report)}")

    # ---- per-report code coverage ----
    print(f"\n{'=' * 72}\nCODES PER REPORT\n{'=' * 72}")
    per_report = defaultdict(set)
    for r in codings:
        per_report[r["report_idx"]].add(r["code"])
    for rid in sorted(per_report):
        print(f"{rid}: {len(per_report[rid]):>2} distinct codes | {', '.join(sorted(per_report[rid]))}")
    uncoded = sorted(set(segments[s]['report_idx'] for s in segments) - set(per_report))
    if uncoded:
        print(f"REPORTS WITH ZERO CODINGS: {', '.join(uncoded)}")

    if blocking:
        print(f"\n{blocking} blocking problem group(s); fix and re-run.")
        return 1
    print("\nvalidation OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
