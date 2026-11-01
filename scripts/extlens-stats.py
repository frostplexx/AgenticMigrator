#!/usr/bin/env python3
"""Extract useful stats from an extlens reports export.

Understands exports with and without a `tagsBackfill` block (written in place by
`npx tsx scripts/backfill_tags.ts`): when present, the backfilled vocabulary is reported
alongside the legacy tags.

Usage: uv run scripts/extlens-stats.py [path/to/export.json]
"""

import json
import sys
from collections import Counter
from pathlib import Path

DEFAULT_PATH = "data/extlens-reports-2026-10-12.json"


def pct(n, total):
    return f"{100 * n / total:.1f}%" if total else "n/a"


def dist(counter, total, label):
    print(f"\n{label}:")
    for key, count in counter.most_common():
        print(f"  {key}: {count} ({pct(count, total)})")


def main():
    path = Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH)
    with open(path) as f:
        data = json.load(f)

    reports = data["reports"]
    total = len(reports)
    print(f"Export: {data['exportedAt']}  |  {total} reports  |  transcripts: {data['transcriptsIncluded']}")

    # --- Report verdicts & booleans ---
    verdicts = Counter(r["report"].get("verdict") for r in reports)
    dist(verdicts, total, "Verdicts")

    bool_fields = ["tested", "installs", "worksInMv2", "needsLogin", "isInteresting",
                   "isPopupWorking", "isSettingsWorking", "isNewTabWorking", "overallWorking"]
    for field in bool_fields:
        c = Counter(r["report"].get(field) for r in reports)
        print(f"  {field}: " + ", ".join(f"{k}={v}" for k, v in c.most_common()))

    # --- Scores ---
    scores = [r["report"]["score"] for r in reports if r["report"].get("score") is not None]
    if scores:
        print(f"\nScores (n={len(scores)}): min={min(scores)}, max={max(scores)}, "
              f"mean={sum(scores) / len(scores):.1f}")
        dist(Counter(scores), len(scores), "Score distribution")

    # --- Verification duration ---
    durs = [r["report"]["verificationDurationSecs"] for r in reports
            if r["report"].get("verificationDurationSecs") is not None]
    if durs:
        durs.sort()
        print(f"\nVerification duration (n={len(durs)}): "
              f"median={durs[len(durs) // 2]:.0f}s, mean={sum(durs) / len(durs):.0f}s, "
              f"max={durs[-1]:.0f}s")

    # --- Surface statuses ---
    surface_status = Counter()
    by_surface = {}
    for r in reports:
        for s in r["report"].get("surfaces", []):
            surface_status[s["status"]] += 1
            by_surface.setdefault(s["surface"], Counter())[s["status"]] += 1
    print(f"\nSurface statuses (all surface checks): {dict(surface_status)}")
    print("\nBy surface (working / partial / broken / not_testable / untested):")
    for surface in sorted(by_surface):
        c = by_surface[surface]
        print(f"  {surface:20s} w={c.get('working', 0):3d}  p={c.get('partial', 0):2d}  "
              f"b={c.get('broken', 0):3d}  nt={c.get('not_testable', 0):3d}  "
              f"u={c.get('untested', 0):2d}")

    # --- Tags ---
    tag_counts = Counter(t for r in reports for t in r.get("tags", []))
    n_tags = len(tag_counts)
    print(f"\nTags ({n_tags} distinct), of {total} extensions:")
    for tag, count in tag_counts.most_common():
        print(f"  {tag:22s} {count:4d} ({pct(count, total)})")

    # Tag co-occurrence: most common pairs of tags on the same extension
    pair_counts = Counter()
    for r in reports:
        tags = sorted(set(r.get("tags", [])))
        for i, a in enumerate(tags):
            for b in tags[i + 1:]:
                pair_counts[(a, b)] += 1
    print("\nTop 15 tag co-occurrences:")
    for (a, b), count in pair_counts.most_common(15):
        print(f"  {a} + {b}: {count} ({pct(count, total)})")

    # Tag x verdict cross-tab: verdict distribution among extensions with each tag
    verdict_names = [v for v, _ in verdicts.most_common()]
    print("\nVerdict distribution by tag (row % within tag):")
    header = "  {:22s} {:>5s} " + " ".join(f">{v[:9]:>9s}" for v in verdict_names)
    print(header.format("tag", "n"))
    for tag, count in tag_counts.most_common():
        tagged = [r for r in reports if tag in r.get("tags", [])]
        vd = Counter(r["report"].get("verdict") for r in tagged)
        row = "  {:22s} {:>5d} ".format(tag, count)
        row += " ".join(f"{100 * vd.get(v, 0) / count:8.1f}%" for v in verdict_names)
        print(row)

    # --- Static analysis ---
    with_findings = [r for r in reports if r["analysis"].get("findingCount", 0) > 0]
    sig_cats = Counter()
    for r in reports:
        for cat, n in (r["analysis"].get("signalsByCategory") or {}).items():
            if n:
                sig_cats[cat] += 1
    print(f"\nStatic analysis: {len(with_findings)} extensions with findings "
          f"({pct(len(with_findings), total)})")
    print("Extensions with signals by category:")
    for cat, count in sig_cats.most_common():
        print(f"  {cat:24s} {count:4d} ({pct(count, total)})")
    top_findings = sorted(reports, key=lambda r: r["analysis"].get("findingCount", 0),
                          reverse=True)[:10]
    print("Top 10 by findingCount:")
    for r in top_findings:
        print(f"  {r['analysis']['findingCount']:4d}  {r['name']}")

    # Findings vs verdict: does static-analysis messiness predict verdict?
    print("\nVerdict distribution for extensions WITH vs WITHOUT analysis findings:")
    for label, subset in (("with findings", with_findings),
                          ("no findings", [r for r in reports if r not in with_findings])):
        vd = Counter(r["report"].get("verdict") for r in subset)
        n = len(subset)
        dist_str = ", ".join(f"{v}={pct(c, n)}" for v, c in vd.most_common())
        print(f"  {label} (n={n}): {dist_str}")

    # --- Agent usage ---
    tool_calls = Counter()
    usage_present = 0
    for r in reports:
        u = r.get("agentUsage") or {}
        if u:
            usage_present += 1
            for tool, n in (u.get("toolCalls") or {}).items():
                tool_calls[tool] += n
    print(f"\nAgent usage (present on {usage_present}/{total}):")
    known = Counter({t: n for t, n in tool_calls.items() if t.isidentifier()})
    other = {t: n for t, n in tool_calls.items() if not t.isidentifier()}
    print(f"  Total tool calls: {sum(tool_calls.values())}")
    print("  By tool: " + ", ".join(f"{t}={n}" for t, n in known.most_common()))
    if other:
        print(f"  (skipping {len(other)} malformed tool keys)")
    tc_per_ext = [u["toolCallCount"] for r in reports
                  if (u := r.get("agentUsage")) and u.get("toolCallCount") is not None]
    if tc_per_ext:
        tc_per_ext.sort()
        print(f"  Tool calls per extension: median={tc_per_ext[len(tc_per_ext) // 2]}, "
              f"max={tc_per_ext[-1]}")

    # --- Notes ---
    with_notes = [r for r in reports if (r["report"].get("notes") or "").strip()]
    print(f"\nReports with non-empty notes: {len(with_notes)} ({pct(len(with_notes), total)})")

    # --- Backfilled tags (tagsBackfill, written by scripts/backfill_tags.ts) ---
    backfilled = [r for r in reports if r.get("tagsBackfill")]
    if not backfilled:
        print("\nNo tagsBackfill blocks found — run: npx tsx scripts/backfill_tags.ts")
        return

    print(f"\n=== Backfilled tags ({len(backfilled)}/{total} reports) ===")
    dist(Counter(r["tagsBackfill"].get("source") for r in backfilled), total, "Backfill source (per report)")

    all_tags = [t for r in backfilled for t in r["tagsBackfill"].get("tags", [])]
    n_all = len(all_tags)
    # Kinds/reasons/provenance count tag occurrences, not reports, so they are percentages of all
    # backfilled tags rather than of the corpus.
    dist(Counter(t["kind"] for t in all_tags), n_all, "Backfill tags by kind (% of all tags)")

    reasons = Counter(t["reason"] for t in all_tags if t.get("reason"))
    dist(reasons, sum(reasons.values()), "Skips by reason (% of skipped)")

    prov = Counter(t["provenance"] for t in all_tags)
    dist(prov, n_all, "Backfill tags by provenance (% of all tags)")

    # Verbatim log lines that survived `runs.tail`, the source of truth for the db-derived tags
    with_lines = [r for r in backfilled if r["tagsBackfill"].get("tailTagLines")]
    with_summary = [r for r in backfilled if r["tagsBackfill"].get("summaryLine")]
    print(f"\nVerbatim tail tag lines: {len(with_lines)}/{total} reports have them "
          f"({len(with_summary)} carry the summary line)")

    btag_counts = Counter(t["tag"] for t in all_tags)
    print(f"\nBackfill tags ({len(btag_counts)} distinct, % of reports carrying each):")
    for tag, count in btag_counts.most_common():
        print(f"  {tag:44s} {count:4d} ({pct(count, total)})")

    # Verdict distribution per backfill tag, for the tags worth a results table: what a skip,
    # a spurious change or a repair does to the verdict.
    interesting = [t for t, _ in btag_counts.most_common()
                   if t.startswith(("skipped.", "spurious.", "repair."))][:12]
    if interesting and verdict_names:
        print("\nVerdict distribution by backfill tag (row % within tag):")
        header = "  {:44s} {:>5s} " + " ".join(f">{v[:9]:>9s}" for v in verdict_names)
        print(header.format("tag", "n"))
        for tag in interesting:
            count = btag_counts[tag]
            tagged = [r for r in backfilled
                      if any(t["tag"] == tag for t in r["tagsBackfill"].get("tags", []))]
            vd = Counter(r["report"].get("verdict") for r in tagged)
            row = "  {:44s} {:>5d} ".format(tag, count)
            row += " ".join(f"{100 * vd.get(v, 0) / count:8.1f}%" for v in verdict_names)
            print(row)

    # Cross-checks the backfill records as warnings: unresolved ones deserve a look.
    warnings = Counter()
    for r in backfilled:
        for w in r["tagsBackfill"].get("warnings", []):
            warnings[w[:90]] += 1
    if warnings:
        print(f"\nBackfill warnings ({sum(warnings.values())} total):")
        for w, count in warnings.most_common(10):
            print(f"  {count:4d}x {w}")
    else:
        print("\nBackfill warnings: none")


if __name__ == "__main__":
    main()
