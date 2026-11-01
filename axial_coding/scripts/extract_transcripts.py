#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Extract agent transcripts from an extlens report export into a codable corpus.

FAILURE FOCUS: preprocessing keeps only failed extensions — a report is dropped unless its verdict
is in --failed-verdicts (default: not_working). Pass --failed-verdicts "" to keep
all reports. Kept reports are renumbered R00..RNN in source order; the corpus therefore contains
only failure runs, and all downstream coding (open, trouble, axial, findings) codes failures.

Reads the raw export JSON (reports with embedded transcripts) and writes:

  corpus/reports.csv              report-level metadata (verdict, surfaces, tokens, errors, ...)
  corpus/segments.jsonl           one codable unit per transcript entry (authoritative text for quotes)
  corpus/packets/RXX-pN.md        coding packets: consecutive segments of one report, each sized to
                                  fit a 128k-token context together with instructions and codebook
  corpus/manifest.json            extraction summary incl. per-packet token estimates

Segment text is rendered ONCE and reused verbatim in packets, so any quote copied from a packet is a
substring of corpus/segments.jsonl. Thinking is kept in full (it is where the agent's reasons for
trouble live); only tool results and tool-call arguments are clipped (bulk file dumps).

Usage:
  uv run scripts/extract_transcripts.py [--json extlens-reports-2026-09-30.json] [--out corpus]
                                 [--failed-verdicts not_working]
                                 [--packet-tokens 35000] [--output-cap 8192]
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import sys
import unicodedata
from pathlib import Path

# Token economy: thinking is kept in full (it carries the agent's reasons); everything else is trimmed.
TOOL_RESULT_HEAD = 700     # chars kept from the start of a tool result (file dumps, command output)
TOOL_RESULT_TAIL = 250     # chars kept from the end (exit codes and errors usually land here)
TOOL_ARGS_LIMIT = 300      # chars of tool-call arguments (bash commands, paths)
PAYLOAD_PREVIEW = 150      # chars of write/edit payload shown
COMPACTION_LIMIT = 2000    # chars of a compaction summary
PROMPT_SPECIFIC_LIMIT = 3000  # chars of the report-specific part of the task prompt
SEGMENT_HARD_LIMIT = 40000  # chars; safety net so no single segment can blow a packet
HEADER_RESERVE = 600       # tokens kept free for the packet header


def est_tokens(text: str) -> int:
    """Conservative token estimate: ~3.2 chars/token for ASCII, 1 token per non-ASCII char."""
    non_ascii = sum(1 for ch in text if ord(ch) > 127)
    return int((len(text) - non_ascii) / 3.2) + non_ascii


def slugify(name: str, max_len: int = 40) -> str:
    slug = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^A-Za-z0-9]+", "-", slug).strip("-").lower()
    return slug[:max_len].rstrip("-") or "report"


def clip(text: str, limit: int) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit] + f" …[+{len(text) - limit} chars clipped]"


def clip_mid(text: str, head: int, tail: int) -> str:
    text = text or ""
    if len(text) <= head + tail + 40:
        return text
    return f"{text[:head]} …[{len(text) - head - tail} chars clipped]… {text[-tail:]}"


def squeeze(text: str) -> str:
    """Drop trailing spaces and collapse blank-line runs (pure token savings, no content change)."""
    text = "\n".join(line.rstrip() for line in (text or "").splitlines())
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def block_texts(entry: dict, btype: str) -> str:
    return squeeze("\n".join(b.get("text") or "" for b in entry.get("blocks") or [] if b.get("type") == btype))


STD_PROMPT_SPLIT = ("## Static Analysis", "## MV3 Migration Reference")
FILES_MARKER = "The only files that matter for migration are:"


def standard_prompt_parts(text: str):
    """Split a task prompt into (shared head, report-specific middle, shared tail), or None."""
    i, j = text.find(STD_PROMPT_SPLIT[0]), text.find(STD_PROMPT_SPLIT[1])
    if i < 0 or j < i:
        return None
    return text[:i], text[i:j], text[j:]


def compress_task_prompt(text: str) -> str:
    """Replace the boilerplate shared by all reports with a pointer; keep the report-specific parts."""
    parts = standard_prompt_parts(text)
    if not parts:
        return text
    head, middle, _ = parts
    files = []
    if FILES_MARKER in head:
        after = head.split(FILES_MARKER, 1)[1].split("\n## ", 1)[0]
        files = [l.strip() for l in after.splitlines() if l.strip().startswith("- ")]
    return squeeze(
        "[Standard task prompt — boilerplate in corpus/task-prompt-standard.md and INSTRUCTIONS. Report-specific parts:]\n"
        "Files named as 'the only files that matter':\n" + "\n".join(files) + "\n\n"
        + clip(middle, PROMPT_SPECIFIC_LIMIT)
    )


def render_tool_call(block: dict, entry: dict) -> tuple[str, list[str]]:
    """Render one tool call; return (line, flags)."""
    flags: list[str] = []
    name = block.get("name") or entry.get("toolName") or "?"
    args = block.get("arguments")
    parsed = args
    if isinstance(args, str):
        try:
            parsed = json.loads(args)
        except (json.JSONDecodeError, TypeError):
            parsed = None
    if isinstance(parsed, dict) and name == "write" and parsed.get("content", None) == "":
        flags.append("empty-write-content")
    if isinstance(parsed, dict) and ("content" in parsed or "edits" in parsed):
        # write/edit: path + payload size + short preview instead of the whole file
        payload = parsed.get("content") if "content" in parsed else json.dumps(parsed.get("edits"), ensure_ascii=False)
        preview = " ".join((payload or "").split())
        return (f"<tool_call {name}> path={parsed.get('path')} ({len(payload or '')} chars) "
                f"{clip(preview, PAYLOAD_PREVIEW)}"), flags
    raw = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
    compact = " ".join((raw or "").split())
    return f"<tool_call {name}> {clip(compact, TOOL_ARGS_LIMIT)}", flags


def build_segment(entry: dict, output_cap: int) -> tuple[str, str, str, list[str]]:
    """Return (role, tool_name, text, flags) for one transcript entry."""
    kind = entry.get("kind") or "message"
    role = entry.get("role")
    flags: list[str] = []
    tool_name = entry.get("toolName") or ""

    if kind == "meta":
        return "meta", "", f"{entry.get('label') or 'meta'}: {entry.get('detail') or ''}", flags
    if kind == "compaction":
        flags.append("compaction")
        summary = block_texts(entry, "text")  # what the agent keeps after compaction
        head = f"[{entry.get('label') or 'compaction'}] {entry.get('detail') or ''}"
        return "compaction", "", clip(f"{head}\n{summary}".strip(), COMPACTION_LIMIT), flags

    if entry.get("isError"):
        flags.append("tool-error-flag")
    if entry.get("error"):
        flags.append("provider-error")
    stop = entry.get("stopReason")
    if stop == "length":
        flags.append("stop-length")
    out_tok = (entry.get("usage") or {}).get("output") or 0
    if out_tok and out_tok >= output_cap:
        flags.append("output-cap-hit")

    if role == "tool":
        return "tool_result", tool_name or "result", clip_mid(block_texts(entry, "text"), TOOL_RESULT_HEAD, TOOL_RESULT_TAIL), flags

    parts: list[str] = []
    thinking = block_texts(entry, "thinking")
    if thinking:
        parts.append(f"<thinking>\n{thinking}\n</thinking>")
    for b in entry.get("blocks") or []:
        if b.get("type") == "tool_call":
            line, f = render_tool_call(b, entry)
            parts.append(line)
            flags.extend(f)
    text = block_texts(entry, "text")
    if text:
        parts.append(text)
    if entry.get("error"):
        parts.append(f"<provider_error> {entry['error']}")
    seg_role = role or "assistant"
    body = "\n".join(parts)
    if seg_role == "user":
        seg_role = "harness"  # task prompt and harness feedback both arrive as user turns
        if standard_prompt_parts(body):
            body = compress_task_prompt(body)
    return seg_role, tool_name, clip(body, SEGMENT_HARD_LIMIT), flags


def segment_header(seg: dict) -> str:
    """Compact header: `### R01-037 assistant !output-cap-hit,stop-length` (stop reasons live in the flags)."""
    head = f"### {seg['segment_id']} {seg['role']}" + (f":{seg['tool_name']}" if seg["tool_name"] else "")
    return head + (f" !{','.join(seg['flags'])}" if seg["flags"] else "")


def render_segment(seg: dict) -> str:
    return f"{segment_header(seg)}\n{seg['text']}\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", default="extlens-reports-2026-09-30.json")
    ap.add_argument("--out", default="corpus")
    ap.add_argument("--failed-verdicts", default="not_working",
                    help="comma-separated verdicts that count as failure; only reports with these "
                         "verdicts are extracted (empty string = keep all)")
    ap.add_argument("--packet-tokens", type=int, default=35000, help="max estimated tokens per packet")
    ap.add_argument("--output-cap", type=int, default=8192, help="model output-token cap to flag")
    args = ap.parse_args()

    src, out = Path(args.json), Path(args.out)
    pdir = out / "packets"
    if pdir.exists():
        shutil.rmtree(pdir)
    pdir.mkdir(parents=True)

    data = json.loads(src.read_text(encoding="utf-8"))
    reports = data.get("reports", [])

    # ---- preprocessing: keep failed extensions only ----
    failed = {v.strip() for v in args.failed_verdicts.split(",") if v.strip()}
    n_source = len(reports)
    if failed:
        reports = [r for r in reports if ((r.get("report") or {}).get("verdict") or "unknown") in failed]
        print(f"failure filter: kept {len(reports)} of {n_source} reports "
              f"(verdict in {', '.join(sorted(failed))})")

    report_rows, all_segments, manifest_packets = [], [], []
    std_prompt = ""

    for r_idx, report in enumerate(reports):
        name = report.get("name") or f"report-{r_idx}"
        rep = report.get("report") or {}
        analysis = report.get("analysis") or {}
        tr = report.get("transcript") or {}
        summary = tr.get("summary") or {}
        u = summary.get("usage") or {}
        entries = tr.get("entries") or []
        rid = f"R{r_idx:02d}"
        verdict = rep.get("verdict") or "unknown"
        surfaces = "; ".join(f"{s.get('surface')}={s.get('status')}" for s in rep.get("surfaces") or [])

        segs = []
        for entry in entries:
            if not std_prompt and entry.get("role") == "user":
                std_prompt = block_texts(entry, "text") if standard_prompt_parts(block_texts(entry, "text")) else ""
            role, tool_name, text, flags = build_segment(entry, args.output_cap)
            e_idx = entry.get("index", -1)
            segs.append({
                "segment_id": f"{rid}-{e_idx:03d}",
                "report_idx": rid,
                "report": name,
                "verdict": verdict,
                "entry_index": e_idx,
                "role": role,
                "tool_name": tool_name,
                "stop_reason": entry.get("stopReason") or "",
                "output_tokens": (entry.get("usage") or {}).get("output") or 0,
                "is_error": bool(entry.get("isError")),
                "error": entry.get("error") or "",
                "flags": sorted(set(flags)),
                "text": text,
            })
        all_segments.extend(segs)
        harness_msgs = sum(1 for s in segs if s["role"] == "harness") - 1  # minus the task prompt

        report_rows.append({
            "report_idx": rid,
            "name": name,
            "extension_id": rep.get("extensionId", ""),
            "verdict": verdict,
            "score": rep.get("score", ""),
            "surfaces": surfaces,
            "installs": rep.get("installs", ""),
            "needs_login": rep.get("needsLogin", ""),
            "harness_feedback_msgs": max(harness_msgs, 0),
            "task_prompt_chars": len(next((block_texts(e, "text") for e in entries if e.get("role") == "user"), "")),
            "skills_read": ";".join((report.get("agentUsage") or {}).get("skillsRead") or []),
            "tool_calls": summary.get("toolCalls", ""),
            "tool_errors": summary.get("toolErrors", ""),
            "provider_errors": sum(1 for s in segs if s["error"]),
            "compactions": summary.get("compactions", ""),
            "output_cap_hits": sum(1 for s in segs if "output-cap-hit" in s["flags"]),
            "signals_by_category": json.dumps(analysis.get("signalsByCategory") or {}),
            "model": summary.get("model", ""),
            "input_tokens": u.get("input", ""),
            "output_tokens": u.get("output", ""),
            "n_segments": len(segs),
            "postmortem_notes": " ".join((rep.get("notes") or "").split()),
        })

        # ---- packets: balanced split at segment boundaries, each under the token budget ----
        cap = args.packet_tokens - HEADER_RESERVE
        codable = [s for s in segs if s["role"] != "meta"]  # session/model/thinking lines: nothing to code
        sizes = [est_tokens(render_segment(s)) for s in codable]
        n_target = max(1, -(-sum(sizes) // cap))
        target = sum(sizes) / n_target
        chunks: list[list[dict]] = [[]]
        used = 0
        for seg, t in zip(codable, sizes):
            if chunks[-1] and (used + t > cap or used >= target):
                chunks.append([])
                used = 0
            chunks[-1].append(seg)
            used += t

        for p_i, chunk in enumerate(chunks, 1):
            pid = f"{rid}-p{p_i}"
            row = report_rows[-1]
            header = [
                f"# {pid} ({p_i}/{len(chunks)}) {rid} {name}",
                f"outcome: {verdict} score={rep.get('score')} | {surfaces or 'no surfaces'}",
                f"run: {summary.get('toolCalls')} tool calls, {summary.get('toolErrors')} tool errors, "
                f"{row['provider_errors']} provider errors, {summary.get('compactions')} compactions, "
                f"{row['output_cap_hits']} output-cap hits, {max(harness_msgs, 0)} harness feedback msgs",
                "",
            ]
            body = "\n".join(render_segment(s) for s in chunk)
            text = "\n".join(header) + "\n" + body
            (pdir / f"{pid}.md").write_text(text, encoding="utf-8")
            manifest_packets.append({
                "packet": pid, "report_idx": rid, "name": name, "verdict": verdict,
                "first": chunk[0]["segment_id"], "last": chunk[-1]["segment_id"],
                "segments": len(chunk), "est_tokens": est_tokens(text),
            })

    if std_prompt:
        head, _, tail = standard_prompt_parts(std_prompt)
        before, after = head.split(FILES_MARKER, 1) if FILES_MARKER in head else (head, "")
        after = "\n".join(l for l in after.splitlines() if not l.strip().startswith("- ")) if after else ""
        (out / "task-prompt-standard.md").write_text(
            before + FILES_MARKER + "\n- <manifest.json and the report's flagged files>\n" + after
            + "\n<report-specific: static analysis, migration signals, browser compatibility>\n\n" + tail,
            encoding="utf-8")

    with (out / "reports.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(report_rows[0].keys()))
        w.writeheader()
        w.writerows(report_rows)

    with (out / "segments.jsonl").open("w", encoding="utf-8") as f:
        for seg in all_segments:
            f.write(json.dumps(seg, ensure_ascii=False) + "\n")

    (out / "manifest.json").write_text(json.dumps({
        "source": str(src),
        "exportedAt": data.get("exportedAt"),
        "n_reports_source": n_source,
        "verdict_filter": sorted(failed) if failed else "all",
        "n_reports": len(reports),
        "n_segments": len(all_segments),
        "packet_token_budget": args.packet_tokens,
        "n_packets": len(manifest_packets),
        "max_packet_est_tokens": max(p["est_tokens"] for p in manifest_packets),
        "packets": manifest_packets,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"extracted {len(reports)} of {n_source} reports (failed only: {', '.join(sorted(failed)) or 'all'}), "
          f"{len(all_segments)} segments, {len(manifest_packets)} packets -> {out}/")
    print(f"  largest packet ≈ {max(p['est_tokens'] for p in manifest_packets):,} tokens (budget {args.packet_tokens:,})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
