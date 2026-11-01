#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Axial-coding support: relationship matrices over open codes.

Produces the quantitative scaffolding for axial coding (Strauss & Corbin):
  1. code × code co-occurrence at REPORT level  (which codes describe the same case)
  2. code × code co-occurrence at SEGMENT level (which codes fire on the same moment)
  3. code × verdict crosstab                    (codes vs. outcomes)
  4. category rollup from the codebook          (mentions per axis/category)
  5. code × segment flag                         (codes landing on output-cap / error / compaction segments)

Output is capped (--top, --max-pairs) so the markdown stays well under 15k tokens.

Usage:
  uv run scripts/axial.py [--codebook coding/codebook.json] [--codes coding/open-codes.jsonl]
                   [--segments corpus/segments.jsonl] [--min-co 2] [--top 30] [--max-pairs 60]
                   [--out coding/axial-input.md]
  uv run scripts/axial.py --show CODE [--limit 40]   # print the acts for one code (quote + memo), compactly
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("//"):
            rows.append(json.loads(line))
    return rows


def matrix_md(header: list[str], rows: list[tuple[str, list[int]]], keywidth: int) -> str:
    colw = 4
    out = ["| " + "code".ljust(keywidth) + " | " + " | ".join(h.rjust(colw) for h in header) + " |"]
    out.append("|" + "-" * (keywidth + 2) + ("|" + "-" * (colw + 2)) * len(header) + "|")
    for key, vals in rows:
        out.append("| " + key.ljust(keywidth) + " | " + " | ".join(str(v).rjust(colw) for v in vals) + " |")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--codebook", default="coding/codebook.json")
    ap.add_argument("--codes", default="coding/open-codes.jsonl")
    ap.add_argument("--segments", default="corpus/segments.jsonl")
    ap.add_argument("--min-co", type=int, default=2, help="min co-occurrence count to list")
    ap.add_argument("--top", type=int, default=30, help="codes shown in the co-occurrence matrix")
    ap.add_argument("--max-pairs", type=int, default=60, help="max co-occurrence pairs listed")
    ap.add_argument("--out", default="", help="write markdown here (in addition to stdout)")
    ap.add_argument("--show", default="", help="print the acts coded with this code and exit")
    ap.add_argument("--limit", type=int, default=40, help="max acts printed by --show")
    args = ap.parse_args()

    if args.show:
        rows = [r for r in load_jsonl(Path(args.codes)) if r["code"] == args.show]
        print(f"{args.show}: {len(rows)} acts in {len({r['report_idx'] for r in rows})} reports")
        for r in rows[: args.limit]:
            print(f"- {r['segment_id']} ({r['verdict']}) \"{r['quote'][:160]}\" — {r['memo'][:200]}")
        if len(rows) > args.limit:
            print(f"… {len(rows) - args.limit} more (raise --limit)")
        return 0

    cb = json.loads(Path(args.codebook).read_text(encoding="utf-8"))
    codings = load_jsonl(Path(args.codes))
    segments = {s["segment_id"]: s for s in load_jsonl(Path(args.segments))}

    cat_of = {c["code"]: c.get("category", "uncategorized") for c in cb["codes"]}

    # segment-level code sets
    seg_codes: dict[str, set[str]] = defaultdict(set)
    report_codes: dict[str, set[str]] = defaultdict(set)
    report_verdict: dict[str, str] = {}
    for r in codings:
        seg = segments.get(r["segment_id"])
        if not seg:
            continue
        seg_codes[r["segment_id"]].add(r["code"])
        report_codes[r["report_idx"]].add(r["code"])
        report_verdict[r["report_idx"]] = seg.get("verdict", "?")

    all_codes = sorted({r["code"] for r in codings})

    def cooc(sets: dict[str, set[str]], min_co: int) -> list[tuple[str, str, int]]:
        counter: Counter = Counter()
        for codes in sets.values():
            for a, b in combinations(sorted(codes), 2):
                counter[(a, b)] += 1
        return [(a, b, n) for (a, b), n in counter.most_common() if n >= min_co]

    # ---- 1. report-level co-occurrence list ----
    rep_co = cooc(report_codes, args.min_co)[: args.max_pairs]

    # ---- 2. report-level co-occurrence matrix ----
    code_reports: dict[str, set[str]] = defaultdict(set)
    for rid, codes in report_codes.items():
        for c in codes:
            code_reports[c].add(rid)
    top_codes = [c for c, _ in Counter({c: len(v) for c, v in code_reports.items()}).most_common(args.top)]
    mat_rows = []
    for a in top_codes:
        row = []
        for b in top_codes:
            if a == b:
                row.append(len(report_codes[a]))
            else:
                row.append(sum(1 for codes in report_codes.values() if a in codes and b in codes))
        mat_rows.append((a, row))
    kw = max(len(c) for c in all_codes) + 1
    mat = matrix_md(top_codes, mat_rows, kw)

    # ---- 3. segment-level co-occurrence ----
    seg_co = cooc(seg_codes, 2)[: args.max_pairs]

    # ---- 4. code × verdict crosstab ----
    verdicts = sorted({v for v in report_verdict.values()})
    vt_rows = []
    for code in all_codes:
        reps = {r for r, codes in report_codes.items() if code in codes}
        vt_rows.append((code, [sum(1 for r in reps if report_verdict[r] == v) for v in verdicts]))
    vt = matrix_md(verdicts, vt_rows, kw)

    # ---- 5. category rollup ----
    cat_mentions: Counter = Counter()
    for r in codings:
        cat_mentions[cat_of.get(r["code"], "uncategorized")] += 1
    cat_codes: dict[str, list[str]] = defaultdict(list)
    for c in all_codes:
        cat_codes[cat_of.get(c, "uncategorized")].append(c)

    lines = [
        "# Axial-coding input matrices",
        "",
        f"Codings: {len(codings)} · distinct codes: {len(all_codes)} · reports: {len(report_codes)}",
        "",
        "## 1. Report-level co-occurrence (pairs ≥ {})".format(args.min_co),
        "Two codes co-occur when both are applied anywhere in the same report.",
        "",
    ]
    for a, b, n in rep_co:
        lines.append(f"- {a} + {b}: {n}")
    lines += ["", "## 2. Report-level co-occurrence matrix (diagonal = # reports with code)", "", "```", mat, "```", ""]
    lines += ["## 3. Segment-level co-occurrence (pairs on the same entry, n≥2)", ""]
    lines += [f"- {a} + {b}: {n}" for a, b, n in seg_co] or ["(none)"]
    lines += ["", "## 4. Code × verdict (report counts)", "", "```", vt, "```", ""]
    lines += ["## 5. Category rollup", ""]
    for cat, n in cat_mentions.most_common():
        lines.append(f"- **{cat}** ({n} mentions): {', '.join(sorted(cat_codes[cat]))}")

    # ---- 6. code × segment flag ----
    flag_counts: dict[str, Counter] = defaultdict(Counter)
    for r in codings:
        for fl in (segments.get(r["segment_id"]) or {}).get("flags") or []:
            flag_counts[r["code"]][fl] += 1
    flags = sorted({fl for c in flag_counts.values() for fl in c})
    lines += ["", "## 6. Code × segment flag (acts on flagged segments)", ""]
    if flags:
        rows6 = [(c, [flag_counts[c][fl] for fl in flags]) for c in sorted(flag_counts)]
        lines += ["```", matrix_md(flags, rows6, kw), "```"]
    else:
        lines.append("(no coded segment carries a flag)")

    text = "\n".join(lines) + "\n"
    print(text)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"written -> {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
