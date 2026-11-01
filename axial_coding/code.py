#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# ///
"""Start the pi coding agent on coding jobs with a standardized, token-lean prompt.

Takes a JSON job spec and runs one fresh `pi` process per target (packet or report), so each job
starts from a clean context. To keep API cost down:
  - the system prompt REPLACES pi's default and contains only the INSTRUCTIONS.md sections the
    phase needs (core [+ coding] + phase);
  - everything the model needs is attached up front (codebook, memo, packet, or a generated
    context bundle), so a job needs ~2 API calls and no exploration;
  - tools are restricted per phase (open coding gets only `write`);
  - this script runs the checks itself; only a failed quote check costs one extra repair call.

Job spec (a file path, '-' for stdin, or an inline JSON string):

  {"phase": "open", "targets": ["R03"], "model": "provider/id", "thinking": "low"}

  phase     calibrate | open | consolidate | trouble | axial | findings
  targets   packet ids ("R03-p2"), report ids ("R03" = all its packets), or "all" (default).
            Ignored for consolidate/axial/findings.
  provider, model, thinking   passed through to pi (omit to use pi's defaults)
  headless      true = no TUI: stream pi's events into this terminal instead
                (default: each job opens pi's normal UI, which closes itself once the job's outputs
                exist; scripts/pi-autoexit.ts does that)
  force         true = re-run finished targets / ignore a missing previous memo
  extra         extra text appended to the job message
  stop_on_fail  stop the batch when a job fails (default true)

Several jobs: {"jobs": [{...}, {...}], "thinking": "low"}; top-level keys are defaults for every job.

Usage:
  uv run code.py extlens-reports-2026-09-30.json [--dry-run] [--phases open,trouble] [--model provider/id]
                                                 # full pipeline on the export, resuming where it left off
  uv run code.py '{"phase": "calibrate", "thinking": "medium"}' [--dry-run]
  uv run code.py '{"phase": "open", "targets": ["R03"]}'
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))
from extract_transcripts import est_tokens  # noqa: E402
CODING = ROOT / "coding"
CTX = CODING / ".ctx"  # generated context bundles attached to jobs
PHASES = ("calibrate", "open", "consolidate", "trouble", "axial", "findings")
CALIBRATION = ["R02-p1", "R01-p1", "R17-p1", "R11-p1", "R05-p1"]
PIPELINE = [  # full run when code.py is given the raw export; thinking is the cost/quality default per phase
    {"phase": "calibrate", "thinking": "medium"},
    {"phase": "open", "thinking": "low"},
    {"phase": "consolidate", "thinking": "medium"},
    {"phase": "trouble", "thinking": "low"},
    {"phase": "axial", "thinking": "medium"},
    {"phase": "findings", "thinking": "medium"},
]
JOB_KEYS = {"phase", "targets", "provider", "model", "thinking", "headless", "force", "extra", "stop_on_fail"}

SECTIONS = {  # INSTRUCTIONS.md sections per phase, in prompt order
    "calibrate": ["core", "coding", "calibrate"],
    "open": ["core", "coding", "open"],
    "consolidate": ["core", "consolidate"],
    "trouble": ["core", "coding", "trouble"],
    "axial": ["core", "axial"],
    "findings": ["core", "findings"],
}
TOOLS = {
    "calibrate": "write,edit",
    "open": "write",
    "consolidate": "bash,write",
    "trouble": "bash,write",
    "axial": "bash,write",
    "findings": "bash,write",
    "repair": "bash,edit",
}
MESSAGES = {
    "calibrate": "Code packet {t}. Write coding/acts/{t}.jsonl, coding/codebook.json, coding/memos/{t}.md.",
    "open": "Code packet {t}. Write coding/acts/{t}.jsonl and coding/memos/{t}.md.",
    "consolidate": "Consolidate the codebook into version 1.0.0.",
    "trouble": "Trouble pass for report {t}. Write coding/trouble/{t}.md (and coding/acts/trouble-{t}.jsonl if acts are missing).",
    "axial": "Write coding/axial-coding.md.",
    "findings": "Write coding/findings.md.",
}


# ---------- spec ----------

def load_spec(arg: str):
    """Return (jobs, export_path). An extlens export (has "reports") means: full pipeline on that export."""
    if arg == "-":
        raw = sys.stdin.read()
    elif arg.lstrip().startswith(("{", "[")):
        raw = arg
    else:
        raw = Path(arg).read_text(encoding="utf-8")
    spec = json.loads(raw)
    if isinstance(spec, dict) and "reports" in spec:
        if arg == "-" or arg.lstrip().startswith("{"):
            sys.exit("pass the export as a file path so the corpus can record its source")
        return [dict(j) for j in PIPELINE], Path(arg).resolve()
    if isinstance(spec, list):
        spec = {"jobs": spec}
    if "jobs" not in spec:
        spec = {"jobs": [spec]}
    defaults = {k: v for k, v in spec.items() if k != "jobs"}
    jobs = []
    for job in spec["jobs"]:
        merged = {**defaults, **job}
        unknown = set(merged) - JOB_KEYS
        if unknown:
            sys.exit(f"unknown job key(s): {', '.join(sorted(unknown))} (allowed: {', '.join(sorted(JOB_KEYS))})")
        if merged.get("phase") not in PHASES:
            sys.exit(f"job needs \"phase\" in {PHASES}, got {merged.get('phase')!r}")
        jobs.append(merged)
    return jobs, None


def all_packets() -> list:
    manifest = json.loads((ROOT / "corpus" / "manifest.json").read_text(encoding="utf-8"))
    return [p["packet"] for p in manifest["packets"]]


def resolve_targets(job: dict) -> list:
    phase = job["phase"]
    if phase in ("consolidate", "axial", "findings"):
        return [None]
    targets = job.get("targets", "all")
    targets = [targets] if isinstance(targets, str) else targets
    packets = all_packets()
    if phase == "trouble":
        reports = sorted({p.split("-")[0] for p in packets})
        out = reports if "all" in targets else targets
        bad = [t for t in out if t not in reports]
        if bad:
            sys.exit(f"unknown report id(s): {bad}")
        return out
    if "all" in targets:
        return list(CALIBRATION) if phase == "calibrate" else [p for p in packets if p not in CALIBRATION]
    out = []
    for t in targets:
        expanded = [p for p in packets if p == t or p.startswith(t + "-p")]
        if not expanded:
            sys.exit(f"unknown packet/report id: {t}")
        out += [p for p in expanded if p not in out]
    return out


def previous_memo(packet: str):
    rid, n = packet.rsplit("-p", 1)
    return None if int(n) <= 1 else CODING / "memos" / f"{rid}-p{int(n) - 1}.md"


def outputs(phase: str, target) -> list:
    """Files a finished job must have produced."""
    return {
        "calibrate": [CODING / "acts" / f"{target}.jsonl", CODING / "memos" / f"{target}.md"],
        "open": [CODING / "acts" / f"{target}.jsonl", CODING / "memos" / f"{target}.md"],
        "consolidate": [],
        "trouble": [CODING / "trouble" / f"{target}.md"],
        "axial": [CODING / "axial-coding.md"],
        "findings": [CODING / "findings.md"],
    }[phase]


def is_done(phase: str, target) -> bool:
    if phase == "consolidate":
        cb = CODING / "codebook.json"
        return cb.exists() and str(json.loads(cb.read_text(encoding="utf-8")).get("version", "")).startswith("1.")
    outs = outputs(phase, target)
    return bool(outs) and all(p.exists() for p in outs)


# ---------- prompt assembly ----------

def instruction_sections() -> dict:
    text = (ROOT / "INSTRUCTIONS.md").read_text(encoding="utf-8")
    parts = re.split(r"^<!-- @(\w+) -->\s*$", text, flags=re.M)
    return {parts[i]: parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}


def system_prompt(phase: str) -> str:
    secs = instruction_sections()
    return "\n\n".join(secs[name] for name in SECTIONS[phase])


def script(*args: str) -> str:
    res = subprocess.run(["uv", "run", "--quiet", *args], cwd=ROOT, capture_output=True, text=True)
    return (res.stdout + res.stderr).strip()


def report_row(rid: str) -> dict:
    with (ROOT / "corpus" / "reports.csv").open(encoding="utf-8") as f:
        return next(r for r in csv.DictReader(f) if r["report_idx"] == rid)


def acts_for(rid: str) -> list:
    path = CODING / "open-codes.jsonl"
    if not path.exists():
        return []
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    return [r for r in rows if r["report_idx"] == rid]


def write_ctx(name: str, text: str) -> Path:
    CTX.mkdir(parents=True, exist_ok=True)
    path = CTX / f"{name}.md"
    path.write_text(text, encoding="utf-8")
    return path


def build_context(phase: str, target, dry_run: bool) -> list:
    """Return attachments in cache-friendly order (stable files first)."""
    rel = lambda p: str(p.relative_to(ROOT))
    if phase in ("calibrate", "open"):
        files = [CODING / "codebook.json"]
        memo = previous_memo(target)
        if memo is not None:
            files.append(memo)
        return [rel(f) for f in files] + [f"corpus/packets/{target}.md"]

    if phase == "consolidate":
        if dry_run:
            return ["coding/codebook.json"]
        merge = script("scripts/merge_codes.py")
        validate = script("scripts/validate_codes.py")
        ctx = write_ctx("consolidate", f"# merge_codes.py\n```\n{merge[:12000]}\n```\n\n"
                                       f"# validate_codes.py\n```\n{validate[:12000]}\n```\n")
        return ["coding/codebook.json", rel(ctx)]

    if phase == "trouble":
        row = report_row(target)
        memos = sorted((CODING / "memos").glob(f"{target}-p*.md"))
        acts = acts_for(target)
        lines = [f"# Context for {target}", "", "## reports.csv row", "```"]
        lines += [f"{k}: {v}" for k, v in row.items() if v not in ("", None)]
        lines += ["```", "", "## Packet memos"]
        for m in memos:
            lines += [f"### {m.stem}", m.read_text(encoding="utf-8").strip(), ""]
        lines += [f"## Acts ({len(acts)})"]
        lines += [f"- {a['segment_id']} {a['code']} [{a.get('aspect', '')}] \"{a['quote'][:90]}\" — {a['memo'][:120]}"
                  for a in acts]
        lines += ["", "## Timeline (flags in brackets)", "```",
                  script("scripts/lookup.py", "--timeline", target, "--width", "100"), "```"]
        return [rel(write_ctx(f"trouble-{target}", "\n".join(lines)))]

    trouble = sorted((CODING / "trouble").glob("R*.md"))
    bundle = write_ctx("trouble-all", "\n\n".join(p.read_text(encoding="utf-8").strip() for p in trouble))
    if phase == "axial":
        if not dry_run:
            script("scripts/merge_codes.py")
            script("scripts/axial.py", "--out", "coding/axial-input.md")
        return ["coding/codebook.json", "coding/axial-input.md", rel(bundle)]
    return ["coding/axial-coding.md", rel(bundle)]  # findings


def pi_command(job: dict, phase: str, system: str, attachments: list, message: str) -> list:
    cmd = ["pi"]
    for key in ("provider", "model", "thinking"):
        if job.get(key):
            cmd += [f"--{key}", str(job[key])]
    cmd += ["--system-prompt", system, "--tools", TOOLS[phase],
            "--no-context-files", "--no-skills", "--no-prompt-templates",
            "--session-dir", str(CODING / "sessions")]
    if job.get("headless"):
        cmd += ["--mode", "json"]  # event stream, rendered live by run_pi()
    else:
        cmd += ["--extension", str(ROOT / "scripts" / "pi-autoexit.ts")]  # quit the UI once the job's outputs exist
    return cmd + [f"@{a}" for a in attachments] + [message]


def estimate(system: str, attachments: list, message: str) -> int:
    total = est_tokens(system) + est_tokens(message)
    for a in attachments:
        p = ROOT / a
        total += est_tokens(p.read_text(encoding="utf-8")) if p.exists() else 0
    return total


# ---------- live view ----------

TTY = sys.stdout.isatty()
DIM, CYAN, GREEN, RED, YELLOW, RESET = (("\033[2m", "\033[36m", "\033[32m", "\033[31m", "\033[33m", "\033[0m")
                                        if TTY else ("",) * 6)
SHOW_THINKING = True  # set from --quiet


def tool_summary(name: str, args: dict) -> str:
    if not isinstance(args, dict):
        return name
    if "path" in args:
        size = len(args.get("content") or "") if "content" in args else None
        edits = len(args.get("edits") or []) if "edits" in args else None
        extra = f" ({size:,} chars)" if size is not None else f" ({edits} edits)" if edits is not None else ""
        return f"{name} {args['path']}{extra}"
    if "command" in args:
        return f"{name} $ {' '.join(str(args['command']).split())[:160]}"
    return f"{name} {json.dumps(args)[:160]}"


def run_pi(cmd: list, interactive: bool, expected: list = ()) -> int:
    """Run pi. UI mode: pi-autoexit.ts closes pi once `expected` files exist. Headless: render the event stream."""
    if interactive:
        env = {**os.environ, "CODING_JOB_OUTPUTS": os.pathsep.join(str(p) for p in expected)}
        return subprocess.run(cmd, cwd=ROOT, env=env).returncode
    proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0)
    totals = {"input": 0, "output": 0, "cacheRead": 0, "cost": 0.0}
    block = None      # kind of block currently streaming: thinking | text | toolcall
    arg_chars = 0     # streamed tool-call argument size, shown as a counter
    turns = 0

    def end_block():
        nonlocal block
        if block in ("thinking", "text"):
            print(RESET, flush=True)
        elif block == "toolcall":
            print("\r\033[K" if TTY else "", end="", flush=True)
        block = None

    buf = b""
    for chunk in iter(lambda: proc.stdout.read(4096), b""):
        buf += chunk
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            line = raw.decode("utf-8", "replace").rstrip("\r")
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                if line.strip():
                    print(f"{DIM}{line}{RESET}", flush=True)  # stderr diagnostics are merged in
                continue
            t = ev.get("type")
            if t == "turn_start":
                turns += 1
                print(f"{CYAN}── call {turns} ──{RESET}", flush=True)
            elif t == "message_update":
                a = ev.get("assistantMessageEvent") or {}
                at = a.get("type")
                if at == "thinking_start":
                    end_block(); block = "thinking"
                    if SHOW_THINKING:
                        print(f"{DIM}💭 ", end="", flush=True)
                elif at == "thinking_delta" and SHOW_THINKING:
                    print(a.get("delta", ""), end="", flush=True)
                elif at == "text_start":
                    end_block(); block = "text"
                elif at == "text_delta":
                    print(a.get("delta", ""), end="", flush=True)
                elif at == "toolcall_start":
                    end_block(); block = "toolcall"; arg_chars = 0
                    if TTY:
                        print(f"{YELLOW}🔧 {a.get('toolName')} …{RESET}", end="", flush=True)
                elif at == "toolcall_delta":
                    arg_chars += len(a.get("delta", ""))
                    if TTY and arg_chars % 400 < len(a.get("delta", "")):
                        print(f"\r{YELLOW}🔧 writing tool call … {arg_chars:,} chars{RESET}", end="", flush=True)
                elif at in ("thinking_end", "text_end", "toolcall_end"):
                    end_block()
            elif t == "tool_execution_start":
                end_block()
                print(f"{YELLOW}🔧 {tool_summary(ev.get('toolName'), ev.get('args'))}{RESET}", flush=True)
            elif t == "tool_execution_end":
                content = (ev.get("result") or {}).get("content") or []
                first = next((c.get("text", "") for c in content if c.get("type") == "text"), "").strip()
                mark = f"{RED}✗" if ev.get("isError") else f"{GREEN}✓"
                print(f"   {mark} {first.splitlines()[0][:160] if first else ''}{RESET}", flush=True)
            elif t == "message_end" and (ev.get("message") or {}).get("role") == "assistant":
                end_block()
                msg = ev["message"]
                u = msg.get("usage") or {}
                for k in ("input", "output", "cacheRead"):
                    totals[k] += u.get(k) or 0
                totals["cost"] += ((u.get("cost") or {}).get("total") or 0)
                if msg.get("errorMessage") or msg.get("stopReason") in ("error", "length"):
                    print(f"{RED}! stop={msg.get('stopReason')} {msg.get('errorMessage') or ''}{RESET}", flush=True)
                print(f"{DIM}   tokens: in {u.get('input', 0):,} · out {u.get('output', 0):,} · "
                      f"cached {u.get('cacheRead', 0):,}{RESET}", flush=True)
            elif t == "auto_retry_start":
                print(f"{RED}↻ retry {ev.get('attempt')}/{ev.get('maxAttempts')}: {ev.get('errorMessage')}{RESET}", flush=True)
            elif t == "compaction_start":
                print(f"{RED}⧉ context compaction ({ev.get('reason')}){RESET}", flush=True)
    end_block()
    rc = proc.wait()
    cost = f" · ${totals['cost']:.4f}" if totals["cost"] else ""
    print(f"{DIM}   job total: {turns} calls · in {totals['input']:,} · out {totals['output']:,} · "
          f"cached {totals['cacheRead']:,}{cost}{RESET}", flush=True)
    return rc


# ---------- checks ----------

def acts_files(phase: str, target) -> list:
    if phase in ("calibrate", "open"):
        return [CODING / "acts" / f"{target}.jsonl"]
    if phase == "trouble":
        p = CODING / "acts" / f"trouble-{target}.jsonl"
        return [p] if p.exists() else []
    return []


def verify(path: Path):
    res = subprocess.run(["uv", "run", "--quiet", "scripts/verify_quotes.py", "--acts", str(path)],
                         cwd=ROOT, capture_output=True, text=True)
    return res.returncode == 0, res.stdout.strip()


def repair(job: dict, path: Path, report: str) -> None:
    """One cheap call: only the failing act lines and the checker output, no packet."""
    fail_lines = sorted({int(n) for n in re.findall(rf"{re.escape(path.name)}:(\d+)", report)})
    src = path.read_text(encoding="utf-8").splitlines()
    bad = "\n".join(f"line {n}: {src[n - 1]}" for n in fail_lines if 0 < n <= len(src))
    system = instruction_sections()["coding"] + (
        "\n\n# Job: repair failed coding acts\nFix each failing act in place with `edit`. Find the exact "
        "text with `uv run scripts/lookup.py <segment_id> --max-chars 4000` and copy a verbatim substring "
        "of ≤120 chars into `quote`. If no substring supports the code, delete the act's line. "
        "Change nothing else. Then reply `done`.")
    msg = f"File: {path.relative_to(ROOT)}\n\nChecker output:\n{report[-3000:]}\n\nFailing lines:\n{bad}"
    run_pi(pi_command(job, "repair", system, [], msg), interactive=not job.get("headless"), expected=[path])


# ---------- main ----------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec", help="the extlens export JSON (runs the full pipeline), or a job JSON: "
                                 "file path, '-' for stdin, or an inline JSON string")
    ap.add_argument("--dry-run", action="store_true", help="print commands and token estimates without running pi")
    ap.add_argument("--phases", help=f"comma-separated subset of {','.join(PHASES)}")
    ap.add_argument("--targets", help="comma-separated packet/report ids (overrides the jobs' targets)")
    ap.add_argument("--model", help="pi model, e.g. provider/id (overrides the jobs)")
    ap.add_argument("--provider", help="pi provider (overrides the jobs)")
    ap.add_argument("--thinking", help="pi thinking level for every job (overrides the per-phase defaults)")
    ap.add_argument("--force", action="store_true", help="re-run finished targets")
    ap.add_argument("--headless", action="store_true",
                    help="no pi UI: stream events here and run all jobs unattended")
    ap.add_argument("--quiet", action="store_true", help="with --headless: hide the streamed thinking")
    args = ap.parse_args()
    global SHOW_THINKING
    SHOW_THINKING = not args.quiet

    jobs, export = load_spec(args.spec)
    if args.phases:
        wanted = [p.strip() for p in args.phases.split(",")]
        bad = [p for p in wanted if p not in PHASES]
        if bad:
            sys.exit(f"unknown phase(s): {bad}")
        jobs = [j for j in jobs if j["phase"] in wanted]
    for job in jobs:
        for key in ("model", "provider", "thinking"):
            if getattr(args, key):
                job[key] = getattr(args, key)
        if args.targets:
            job["targets"] = [t.strip() for t in args.targets.split(",")]
        if args.force:
            job["force"] = True
        if args.headless:
            job["headless"] = True

    manifest_path = ROOT / "corpus" / "manifest.json"
    if export is not None and manifest_path.exists():
        built_from = (ROOT / json.loads(manifest_path.read_text(encoding="utf-8"))["source"]).resolve()
        if built_from != export:
            if any((CODING / "acts").glob("*.jsonl")):
                sys.exit(f"corpus/ was built from {built_from.name} and coding/ already holds acts for it; "
                         f"move coding/ and corpus/ away before coding {export.name}")
            manifest_path.unlink()
    if not manifest_path.exists():
        source = export or ROOT / "extlens-reports-2026-09-30.json"
        print(f"building corpus/ from {source.name}")
        print(script("scripts/extract_transcripts.py", "--json", str(source)))
    for d in ("sessions", "acts", "memos", "trouble"):
        (CODING / d).mkdir(parents=True, exist_ok=True)
    codebook = CODING / "codebook.json"
    if not codebook.exists():  # empty seed; Phase 1 fills it
        codebook.write_text(json.dumps({
            "name": "extlens-mv3-migration-codes", "version": "0.0.0",
            "unit_of_analysis": "one transcript entry (segment_id = RXX-YYY)",
            "categories": {}, "aliases": {}, "codes": [],
        }, indent=2) + "\n", encoding="utf-8")
    ran = failed = skipped = 0
    planned: set = set()  # dry-run: targets assumed finished by the time later targets run
    est_total = 0

    for job in jobs:
        phase = job["phase"]
        targets = resolve_targets(job)
        if phase == "trouble" and not args.dry_run:
            script("scripts/merge_codes.py")  # acts with consolidated code names for the context bundles
        for target in targets:
            label = f"{phase} {target or ''}".strip()
            if not job.get("force"):
                if is_done(phase, target):
                    print(f"= skip {label}: already done (\"force\": true to redo)")
                    skipped += 1
                    continue
                memo = previous_memo(target) if phase in ("calibrate", "open") else None
                if memo is not None and not memo.exists() and not (args.dry_run and memo.stem in planned):
                    print(f"! skip {label}: previous memo {memo.relative_to(ROOT)} missing; code that packet first")
                    skipped += 1
                    continue

            system = system_prompt(phase)
            attachments = build_context(phase, target, args.dry_run)
            message = MESSAGES[phase].format(t=target)
            if job.get("extra"):
                message += f"\n\n{job['extra']}"
            cmd = pi_command(job, phase, system, attachments, message)
            est = estimate(system, attachments, message)
            est_total += est
            print(f"\n▶ {label}  (≈{est:,} input tokens per call; tools: {TOOLS[phase]})")

            if args.dry_run:
                planned.add(target)
                shown = [c if c != system else "<system prompt>" for c in cmd]
                print("  " + shlex.join(shown))
                continue

            ran += 1
            if not job.get("headless"):
                print(f"{DIM}   opening pi; it works on the job by itself and closes when the outputs exist "
                      f"(if it stays open, an output is missing: help it along or quit pi).{RESET}", flush=True)
            rc = run_pi(cmd, interactive=not job.get("headless"), expected=outputs(phase, target))
            missing = [p for p in outputs(phase, target) if not p.exists()]
            ok = rc == 0 and not missing
            if missing:
                print("  ! missing output: " + ", ".join(str(p.relative_to(ROOT)) for p in missing))
            for path in acts_files(phase, target) if ok else []:
                good, report = verify(path)
                if not good:
                    print(f"  quote check failed for {path.name}; one repair call")
                    repair(job, path, report)
                    good, report = verify(path)
                print("  " + (report.splitlines() or ["(no output)"])[-1])
                ok = ok and good
            if ok:
                print(f"  ✓ {label}")
                continue
            failed += 1
            print(f"  ✗ {label} failed (pi exit {rc})")
            if job.get("stop_on_fail", True):
                print("stopping batch (stop_on_fail)")
                return 1

    if args.dry_run:
        print(f"\n≈{est_total:,} input tokens for the first call of each job "
              f"(a job usually makes ~2 calls; cached prefixes cost less where the provider caches)")
    else:
        print(script("scripts/budget.py").splitlines()[-1])
    print(f"{ran} run, {failed} failed, {skipped} skipped")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
