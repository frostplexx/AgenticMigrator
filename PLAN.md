# Plan: Backfill thorough migration tags onto the 2026-10-12 extlens corpus

## Overview

The corpus (499 extensions, model `saia/gemma-4-31b-it-fp8-256k`) has only 12 legacy
SCREAMING_CASE tags (HAS_SERVICE_WORKER, MINIFIED_CODE, …) in the export
`data/extlens-reports-2026-10-12.json`. The repo's real vocabulary — `change.*` (applied),
`skipped.*` with reasons, `spurious.*`, `repair`, `surface.*`, `source.*` — lives in
`src/host/tags.ts` / `src/host/changes.ts` and was computed at run time, but the input/output
trees stayed on the Linux box. What we have locally:

1. **`data/migrator.db`** (verified: 499 runs / 499 reports / 499 outcomes). `runs.tail` holds the
   final migration logs including the **per-tag lines**: `skipped (<reason>): <title>`,
   `spurious: <title>`, `repair: <title>`, plus the summary `changes: X/Y applied · tags: …`.
   Present for **495/499 runs**. `outcomes` adds `label`, `abstained`, `has_hard_blocker`.
2. **The export JSON** — full agent transcripts (edits with oldText/newText, writes with content,
   ABSTAIN.md writes, initial prompt carrying the original MV2 static analysis = "needed" ground
   truth).

The tails itemize skips/spurious/repair exactly (they are the tags the pipeline actually emitted),
but never itemize *applied* changes — only counts — and never itemize misc tags. So the backfill
is two sources joined by extension id: db tails for skipped/spurious/repair, transcripts for
applied specifics, needed-signals, and misc.

## Approach

**Tier 1 — db tail mining (no LLM, exact).** Parse `runs.tail` per-tag lines; map titles to
`ChangeId` via the `add(…)` title strings in `src/host/changes.ts`. Covers skipped (with reason),
spurious, repair, applied/needed counts for 495 runs.

**Tier 2 — transcript extraction (no LLM, deterministic).** For applied specifics and the 4
truncated tails: locate the task message (embedded MV2 static analysis → needed-signals), replay
manifest.json edits from the first `read` result, and pattern-match edit/write arguments per
ChangeId — reusing the same conditions `buildChangeLedger` uses.

**Tier 3 — real trees (optional, best).** The logs reveal run dirs at
`/home/dinama/run_test/<ts>/<extensionId>/out` and sources at `/home/dinama/full_set/<extensionId>`.
If these can be rsynced, run the actual `buildTags` pipeline over them and skip Tier 2 entirely.

Order: Tier 1 always; Tier 2 fills applied specifics + broken tails; Tier 3 replaces Tier 2 if the
trees arrive.

## Losslessness

The backfill must not discard what the sources say. Two rules:

1. **Verbatim first.** Every recovered tag is stored twice: as the raw log line (or transcript
   evidence) exactly as captured, and as the normalized dotted tag derived from it. Nothing is
   reduced to the normalized form alone; an unmapped title surfaces as a verbatim line without a
   derived tag rather than being dropped or guessed.
2. **Additive.** The original `tags` array is never modified. Recovered data goes under a new
   `reports[].tagsBackfill` key, written **in place** into the export file (the original `tags`
   array stays untouched; re-running the script replaces the block rather than duplicating it).

Irrecoverable gaps, accepted and recorded per report rather than papered over: applied changes
were never itemized in the logs (counts only — filled by Tier 2/3, marked `provenance`), and 4
runs have tails truncated at capture time (their `tailTagLines` are simply absent).

## Files changed

- `scripts/backfill_tags.ts` — new (TypeScript, not Python, so it can import `ChangeId`,
  `CHANGE_SUPPORT`, and title constants from `src/host/` directly instead of duplicating them).
- `src/host/changes.ts` — small refactor: export the change `title` strings as a
  `CHANGE_TITLES: Record<ChangeId, string>` record used by `buildChangeLedger`'s `add()` calls, so
  the backfill script and the ledger cannot drift apart.
- `data/extlens-reports-2026-10-12.json` — the export itself, updated in place: each report
  gains a `tagsBackfill` block:

  ```jsonc
  "tagsBackfill": {
    "source": "migrator.db runs.tail" | "transcript" | "both",
    "tailTagLines": ["<verbatim log lines, exactly as captured>"],
    "summaryLine": "<verbatim 'changes: … tags: …' line>",
    "runMeta": { "label": "…", "abstained": true, "hasHardBlocker": false, "runDir": "/home/dinama/run_test/…" },
    "tags": [ { "tag": "skipped.remote_code_removed", "kind": "skipped", "reason": "platform",
                 "title": "remotely hosted code removed or bundled", "provenance": "db" | "transcript" } ]
  }
  ```

- `PLAN.md` — this file.

## Tag vocabulary and extraction source

| Family | Source | Notes |
|---|---|---|
| `skipped.<id>` + `reason` (platform/limited/abstained/unexplained) | db tail `skipped (<reason>): <title>` | exact, incl. the 4× webRequest-abstained cases |
| `spurious.<id>` | db tail `spurious: <title>` | e.g. 50× storage-over-DOM-state applied unneeded |
| `repair` | db tail `repair: <title>` | e.g. 86× "edited the manifest" |
| applied counts | db tail `changes: X/Y applied` | sanity bound for Tier 2 |
| `change.<id>` (applied) | Tier 2 transcript edit/write patterns | agent-attributable changes only: the four the converter cannot do (offscreen, DNR, executeScript, eval) |
| `state.mv2_api_residual.<family>` (misc) | Tier 3 residual scan (`scripts/mv2_residuals.ts`) | MV2-only API forms from the mv3-semi-trivial skill's replacement table that REMAIN in the migrated output (`chrome.extension.*`, the MV2-only tabs forms, `browserAction`/`pageAction` JS, `runtime.onSuspend`) — the semi-trivial rewrites, measured as residue since they are bulk call-site edits, not discrete applied events |
| `state.<id>` (misc) | Tier 2 manifest replay | final-state observations of the mechanical manifest features the converter applied before the transcript began — MV3, service_worker, action, host_permissions, WAR object form, CSP object form |
| needed-signals | Tier 2: first user message (Deprecated APIs / Migration Signals / compat) | fallback when no tree |
| `surface.*` | `report.surfaces[]` + `contextMenus.create`/`notifications.create`/`commands.onCommand`/`omnibox`/`sidePanel` seen in transcript edit/write content | mirrors `SURFACE_API` in tags.ts |
| `source.*` + legacy mapping | existing export tags | `MINIFIED_CODE`→`source.minified`, `WEBPACK_BUNDLED`→`source.bundled`, `HAS_BROWSER_POPUP`→`surface.popup`, `HAS_BACKGROUND_PAGE`/`HAS_SERVICE_WORKER`→`surface.background`, `HAS_CONTENT_SCRIPTS`→`surface.page_interaction`, `NEW_TAB_OVERRIDE`→`surface.new_tab`; API-usage tags (USES_TABS_API, CONTAINS_EVAL, USES_WEB_REQUEST, USES_STORAGE_LOCAL, HAS_HOST_PERMISSIONS) kept verbatim as legacy |
| run metadata | db `outcomes`: `label`, `abstained`, `has_hard_blocker`; `runs`: timestamps, run dir path | sidecar only, not tags |

## Implementation steps

**Step 1 — Export `CHANGE_TITLES` from `src/host/changes.ts`.**
Lift each `add(id, title, …)` title into a `CHANGE_TITLES` constant; `buildChangeLedger` consumes
it; no behavior change. This gives the backfill script an authoritative title→id map.

**Step 2 — db tail parser (Tier 1).**
Read `runs` joined with `outcomes`; keep the per-tag lines **verbatim** in `tailTagLines` and the
summary line in `summaryLine`; derive the normalized tags from them via `CHANGE_TITLES` (an
unmapped title stays verbatim and is reported, never guessed or dropped); parse the
`changes: X/Y applied, S skipped · tags: …` summary for counts. Record the run dir path from
the final `Migrated extension in …` line (for Tier 3) in `runMeta`, alongside `label`,
`abstained`, `has_hard_blocker` from `outcomes`.

**Step 3 — Transcript extractor (Tier 2).**
- Task-message locator (first `role=="user"` entry containing "Chrome Extension Migration Task");
  parse needed-signals (blocking webRequest, header rewrite, response inspection, eval, remote
  code, background DOM, offscreen needs) with quoted evidence.
- Manifest replay: seed from the first `read` of `*/manifest.json`, apply `edit`/`write` events in
  transcript order, and record the same conditions `buildChangeLedger` evaluates (`manifest_version`,
  `background.service_worker`, `action` key, `host_permissions`, `web_accessible_resources`
  object form, CSP object form) → `state.<id>` tags with evidence (final state, not attributed —
  the converter applied these before the transcript began).
- Code-level detectors over edit/write arguments: offscreen (offscreen.html/js write,
  `chrome.offscreen.createDocument`), DNR (`rules.json` write, `declarativeNetRequest` edits),
  `execute_script_api`, `eval_removed`, `remote_code_removed` (incl. the `uneval.py`-style helper
  writes observed in the corpus).
- Cross-check against Tier 1: applied-count from the db tail must equal |`change.*` tags ∩ needed|;
  mismatches are reported, not silently accepted.

**Step 4 — Misc + legacy mapping + emit.**
Assemble `surface.*` from `report.surfaces[]` and transcript API patterns; apply the legacy→dotted
mapping (into `tagsBackfill.tags`, still alongside the untouched legacy `tags`); write the full
export copy. Add a `--stats` mode printing tag distributions, skip reasons, and co-occurrence in
the style of `scripts/extlens-stats.py`.

**Step 5 — (conditional) Tier 3.**
If `/home/dinama/run_test/*` trees are rsynced, run `buildTags` directly per run and overwrite the
Tier 2-derived `change.*`/`source.*` tags with pipeline-exact ones; keep Tier 1 skip lines as a
cross-check.

## Testing plan

- **Title-map completeness:** assert every `ChangeId` has a `CHANGE_TITLES` entry and that every
  title found in the 499 tails maps to an id (the 4 unmapped-tail runs are reported separately).
- **Fixtures:** `run/extension_mv2/` and `run/abnlpgnoijoannioldehkdjfofbpnfad/` have complete
  artifacts (out tree, transcript, plan.json) — run Tier 2 against their transcripts and assert
  the derived tags match `buildTags` on their actual trees.
- **Corpus invariants:** every `skipped.*`/`spurious.*` tag's title must match a tail line
  verbatim; per-run `change.*` count ≤ db applied count; `outcomes.abstained=1` runs must carry
  ≥1 `skipped.*` with reason `abstained`.
- **Manual audit:** 20 reports across verdicts, transcript read against emitted tags; tighten
  detectors until the sample is clean.
- **Losslessness check:** for all 495 tag-bearing runs, the multiset of derived `skipped.*` /
  `spurious.*` / `repair` tags must reconstruct 1:1 from `tailTagLines` alone — the verbatim
  lines, not the derived tags, are the source of truth in the output.
- **Idempotence:** two runs produce a byte-identical output file.

## Out of scope

- The LLM-assisted pass — deterministic extraction is expected to suffice now that the db provides
  exact skip/spurious/repair tags; revisit only if the manual audit shows systematic gaps in
  applied-change detection.
- Mutating the export or the CSV.
- Backfilling future runs — `runMigration.ts` already computes these tags at run time.

## Open questions

1. Can you rsync `/home/dinama/run_test/` (migrated `out/` trees) and `/home/dinama/full_set/`
   (MV2 sources)? That enables Tier 3 and makes Tier 2 a cross-check only.
2. Legacy API-usage tags (USES_TABS_API, CONTAINS_EVAL, …): keep verbatim (plan's default) or
   rename into a `uses.<api>` family?
3. Sidecar format: JSON (default) or JSONL?
