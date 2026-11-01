#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Verify coding acts (JSONL) against the authoritative segment store.

Checks every act: segment exists; quote is an exact substring of the segment
text (whitespace-insensitive); quote <=200 chars; memo non-empty; no duplicate (segment_id, code).
Empty-text segments are skipped with a note (nothing can be quoted from them).

Usage (paths are CWD-relative unless overridden):
  uv run scripts/verify_quotes.py                             # acts dir: coding/acts, segments: corpus/segments.jsonl
  uv run scripts/verify_quotes.py --acts coding/acts/R07-p1.jsonl   # single packet
  uv run scripts/verify_quotes.py --segments seg.jsonl --text-field stored_text
  uv run scripts/verify_quotes.py --self-test                 # no corpus needed

Exits 1 if any act fails.
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

FAIL = "FAIL"


def load_segments(path, text_field):
    segs = {}
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                s = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"BADSEG {path}:{n}: invalid JSON ({e})")
                continue
            if "segment_id" not in s:
                print(f"BADSEG {path}:{n}: no segment_id field")
                continue
            segs[s["segment_id"]] = s.get(text_field) or ""
    return segs


def check_acts(act_paths, segs, max_quote):
    fail = total = skipped = 0
    seen = {}
    for path in act_paths:
        file_fail = 0
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                act = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"FAIL {path.name}:{n}: invalid JSON ({e})")
                fail += 1
                file_fail += 1
                continue
            sid = act.get("segment_id")
            code = act.get("code")
            quote = act.get("quote", "")
            if sid is None or code is None:
                print(f"FAIL {path.name}:{n}: act missing segment_id or code")
                fail += 1
                file_fail += 1
                continue
            text = segs.get(sid)
            if text is not None and text == "" and quote == "":
                skipped += 1
                print(f"SKIP {path.name}:{n} {sid}: empty segment text")
                continue
            total += 1
            problems = []
            if sid not in segs:
                problems.append("segment not found in segment store")
            elif quote not in text and " ".join(quote.split()) not in " ".join(text.split()):
                problems.append("quote NOT substring of stored segment text (whitespace-insensitive)")
            if len(quote) > max_quote:
                problems.append(f"quote too long ({len(quote)} > {max_quote})")
            if not act.get("memo"):
                problems.append("missing memo")
            if (sid, code) in seen:
                problems.append(f"duplicate (segment,code), first at {seen[(sid, code)]}")
            else:
                seen[(sid, code)] = f"{path.name}:{n}"
            if problems:
                fail += 1
                file_fail += 1
                print(f"{FAIL} {path.name}:{n} {sid} [{code}]: {'; '.join(problems)}")
                print(f"     quote: {quote[:120]}")
        if file_fail:
            print(f"-- {path.name}: {file_fail} bad acts")
    print(f"\n{total - fail}/{total} acts OK ({skipped} empty-segment skips)")
    return fail


BAD_ACTS = [
    '{"segment_id": "S1", "code": "c1", "quote": "not present in text", "memo": "x"}',
    '{"segment_id": "S1", "code": "c2", "quote": "hello world this is way too long for the limit set by the test which is twenty chars", "memo": "x"}',
    '{"segment_id": "S1", "code": "c1", "quote": "hello", "memo": "x"}',
    '{"segment_id": "S999", "code": "c3", "quote": "hello", "memo": "x"}',
    '{"segment_id": "S1", "code": "c4", "quote": "hello"}',
    "not json at all",
]


def self_test():
    """Plant a known-bad fixture and assert the checker reports every failure class."""
    expected_failures = 6  # bad quote, too-long quote, dup, missing segment, missing memo, invalid JSON
    with tempfile.TemporaryDirectory() as tmp:
        seg_path = Path(tmp, "segments.jsonl")
        seg_path.write_text(
            json.dumps({"segment_id": "S1", "text": "hello world", "verdict": "working"})
            + "\n"
            + json.dumps({"segment_id": "S2", "text": ""})  # empty segment -> skip
            + "\n",
            encoding="utf-8",
        )
        act_dir = Path(tmp, "acts")
        act_dir.mkdir()
        (act_dir / "bad.jsonl").write_text(
            "\n".join(BAD_ACTS)
            + "\n"
            + json.dumps({"segment_id": "S1", "code": "ok", "quote": "hello world", "memo": "fine"})
            + "\n"
            + json.dumps({"segment_id": "S2", "code": "empty-ok", "quote": "", "memo": "empty segment, empty quote"}),
            encoding="utf-8",
        )
        segs = load_segments(seg_path, "text")
        fail = check_acts([act_dir / "bad.jsonl"], segs, max_quote=20)
    ok = fail == expected_failures
    print(f"\nself-test: {'OK' if ok else 'BROKEN'} (expected {expected_failures} failures, got {fail})")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--segments", default="corpus/segments.jsonl", help="JSONL segment store")
    ap.add_argument("--acts", default="coding/acts", help="dir or single .jsonl of coding acts")
    ap.add_argument("--text-field", default="text", help="segment field holding the authoritative text")
    ap.add_argument("--max-quote", type=int, default=200)
    ap.add_argument("--self-test", action="store_true", help="run against a built-in bad fixture and exit")
    args = ap.parse_args()

    if args.self_test:
        sys.exit(self_test())

    seg_path = Path(args.segments)
    if not seg_path.exists():
        print(f"segment store not found: {seg_path} (run from project root or pass --segments)")
        sys.exit(2)
    acts = Path(args.acts)
    act_paths = sorted(acts.glob("*.jsonl")) if acts.is_dir() else [acts]
    if not act_paths:
        print(f"no act files found at: {acts}")
        sys.exit(2)

    segs = load_segments(seg_path, args.text_field)
    fail = check_acts(act_paths, segs, args.max_quote)
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
