# agentic-migrator-ts

TypeScript rewrite of AgenticMigrator on the [pi](https://pi.dev) SDK (Path B). Migrates a
Chrome extension MV2 → MV3 using an LLM agent that runs, with a headed-Chromium verifier, in
a **self-rolled container** — no OpenHands agent-server.

## Architecture

```
HOST (nix: node + python3 + docker)                CONTAINER (self-rolled image)
  cli.ts                                             entrypoint.sh: tini → Xvfb (→ VNC)
   ├─ convert.ts   → emc.py (Python subprocess)      runMigration.ts
   ├─ staticAnalyzer.ts → plan.json / analysis.json   ├─ model.ts  (pi custom OpenAI provider)
   └─ docker run  ── mounts: extension:ro, run/ ──▶   ├─ pi agent session (read/edit/write/bash)
                                                      │    prompt.ts (findings + signals + mv3 skill)
   ◀── run/out (migrated ext) + run/report.json ──    └─ verify.ts (headed Chromium on Xvfb) + fix loop
```

Faithful ports of the Python originals: `staticAnalyzer` (findings + non-mechanical
signals), `prompt` generator, `verify` (Chrome `--log-file` load-error extraction). The
orchestrator/subagent split collapses into one pi session (pi edits files with native tools).
Retry + compaction come from pi's `SettingsManager` (the rate-limit + condenser lessons).

## Run

```sh
nix develop            # node + python3
npm install && npm run build
docker build -t agentic-migrator-ts:latest .
node dist/cli.js /path/to/mv2-extension --out ./run
# → ./run/out (migrated extension), ./run/report.json
```

### Migrate a single extension or a whole corpus

The CLI auto-detects the input shape. Point it at a single MV2 extension dir
or at a folder whose subdirectories each contain an MV2 `manifest.json`; it
migrates every extension into one output root. A single extension writes into
the output root directly; a corpus writes one subfolder per extension.

```sh
npx tsx src/cli.ts /path/to/mv2-extension --out ./run
# → ./run/out (migrated extension), ./run/report.json

npx tsx src/cli.ts ./corpus --out ./mv3-output
# → ./mv3-output/<id>/out  (migrated MV3 tree, one per extension)
# → ./mv3-output/<id>/report.json
```

A target whose run already finished (`report.json` passed) is skipped, so a
corpus re-run resumes where it left off. When started under the extlens
controller (one-shot child) the same code path handles both shapes.

Testing: `npm test` runs the registry and batch tests with no Docker or LLM
needed.

Model via env (`LLM_MODEL`, `LLM_BASE_URL`), pi custom OpenAI-completions
provider. Default `ollama/gemma4:31b-cloud` over `host.docker.internal:11434`; any
OpenAI-compatible endpoint works, e.g. GWDG SAIA: `saia/gemma-4-31b-it` over
`https://chat-ai.academiccloud.de/v1` with a key booked via the KISSKI LLM Service page.
`LLM_API_KEY` is resolved from secretspec (1Password vault `DevVault`, see `secretspec.toml`)
when not already exported: `secretspec set LLM_API_KEY` stores it.

### Single agent

One main agent handles the whole migration. It edits every file itself with its
`edit`/`write` tools — there are no nested sub-agents or delegation. The run logs:

```sh
node dist/cli.js /path/to/mv2-extension --out ./run
# [migrate]  session: main (single agent, direct edits)
# [migrate]  verify #1: PASS
```

## Proven end-to-end (RESULTS.txt)

Migrating `tmp/extension_mv2` with **gemma4:31b-cloud** (local Ollama):

```
[cli] converting (extension-manifest-converter)...  → manifest_version 3, service_worker, action, host_permissions
[cli] static analysis: 2 deprecated API site(s), 4 signal(s)
[migrate] model: gemma4:31b-cloud ... 7 turns
[migrate] verify #1: PASS
[cli] SUCCESS ✅ — service worker: chrome-extension://ccoifhcpnedp…/service_worker.js
```

The agent produced a valid MV3 manifest **and** a correct declarativeNetRequest `rules.json`
(`action.redirect.url`), and the extension loaded headed under Xvfb with its service worker
registering. Chrome emitted `_metadata/` (indexed rulesets) — it accepts the DNR ruleset.

## Deferred (vs. the Python original)

The goal-completion judge loop, the per-run critic, and batch mode. All straightforward
additions on this foundation.

## Change ledger and tags

`report.json` records, for every MV2→MV3 change, whether it was **needed** (detected in the
original MV2 source) and whether it was **applied** (detected in the migrated output). Counting
applied changes alone cannot distinguish a pipeline that handles every offscreen case from one
that handles half of them — the interesting cell is `needed && !applied`, a silently skipped
change, which a load-only verifier cannot see.

Changes tracked: `manifest_version`, `background_service_worker`,
`background_persistent_removed`, `action_rename`, `host_permissions_split`, `webrequest_to_dnr`,
`webrequest_header_modification`, `webrequest_response_inspection`, `offscreen_document`,
`execute_script_api`, `remote_code_removed`, `web_accessible_resources_v3`, `csp_object_form`,
`commands_execute_action`, `storage_over_dom_state`, `eval_removed` (`src/host/changes.ts`).
webRequest is three changes rather than one because MV3 supports them differently: a static
block/redirect ports to declarativeNetRequest, a header rewrite ports only when the new value is a
constant (`modifyHeaders`), and reading the response does not port at all. Every change carries
its MV3 `support` — `full`, `partial` or `none` — with the Chrome documentation URL for anything
less than full (`CHANGE_SUPPORT`).

`needed` is always measured on the **unconverted original** (`/work/original`), never on the
converter's output: the converter has already made the mechanical changes there, and measuring
against it reports every one of them as invented.

Tags (`src/host/tags.ts`) come in five kinds, because they answer different questions:

| kind | example | answers |
| --- | --- | --- |
| `applied` | `change.webrequest_to_dnr` | what the pipeline does |
| `skipped` | `skipped.webrequest_header_modification` | where the pipeline stops — and why, see below |
| `repair` | `repair.storage_over_dom_state`, `repair.background_edited` | what LLM repair is worth |
| `spurious` | `spurious.background_service_worker` | what the pipeline invents |
| `misc` | `source.minified`, `source.framework`, `surface.context_menu` | what the sample is made of |

**Every skip carries a reason**, because "purposely left out" and "silently dropped" support
opposite conclusions about the model and used to be the same cell:

| reason | meaning | example |
| --- | --- | --- |
| `platform` | MV3 cannot express it at all; the framework purposely ignores it. Evidence carries the citable constraint. | response body inspection, remote code, any HARD compat blocker |
| `abstained` | the agent's `ABSTAIN.md` names this capability | — |
| `limited` | MV3 expresses only part of it; the evidence decides whether this instance was portable, and the tag refuses to decide for it | header rewrite, computed block decisions |
| `unexplained` | nothing accounts for it — the cell that counts against the model | a dropped offscreen document |

`report.json` carries `skipReasons` alongside `tagCounts`, so a corpus table can split "skipped"
four ways without re-reading evidence.

**Repair** is attributed two ways. The change ledger is diffed before and after the first repair
prompt (`repair.<change>`: a change the first pass missed and repair made), and the output tree is
hashed at the same moment so edits that flip no ledger bit — a global-variable fix inside the
worker — are still counted: `repair.files_edited` with the file list, plus `repair.manifest_edited`,
`repair.background_edited`, `repair.content_script_edited`, `repair.ui_page_edited` by the file's
role in the manifest. Both loops count as repair: the load-fix rounds and the behaviour round.

**Misc** covers the UI surfaces the extension exposes (`surface.popup`, `surface.context_menu`,
`surface.omnibox`, `surface.notifications`, `surface.keyboard_shortcuts`, `surface.side_panel`,
`surface.devtools`, `surface.new_tab`, `surface.options_page`, `surface.page_interaction`,
`surface.toolbar_action`, `surface.background`, in extlens's vocabulary), and what the source is
made of: `source.minified`, `source.bundled`, `source.obfuscated`, `source.large`,
`source.framework` (react / vue / angular / jquery), `source.wasm`.

**A skipped capability is no longer a failed run.** The framework used to stop and exit non-zero
when it met something it could not migrate, which removed the extension from the results instead
of recording what *did* migrate. It now applies everything it can, records the skip as a tag with
its evidence, and exits 0; whether the migration succeeded is the analyst's call.

## Comparing models fairly

Two models are only comparable when both were given the same starting information, which is easy
to believe and hard to prove months later. Each run records a `promptRef`: a hash over the
reference documents plus the flags that change the prompt's shape. Equal fingerprints mean equal
starting information; different ones mean the rows need a caveat.

`PROMPT_WITH_ORIGINAL=1` lets the agent read the untouched MV2 source. It is **off by default**
and is an experimental condition rather than a setting: showing the original turns "produce a
working MV3 extension" into "port this one", a different task with a different difficulty. Run
both conditions and compare — the flag is recorded in `promptRef.includesOriginalSource`, so the
two are never silently mixed.

## Failure labels

`src/host/labels.ts` defines the closed label set for *why* an extension is not working, with
`validateAdjudication()` enforcing the rules at write time:

`IMPOSSIBLE_PLATFORM`, `DEGRADED_ONLY`, `POSSIBLE_MODEL_FAILED`, `MODEL_INCOMPLETE`,
`MODEL_HALLUCINATED_API`, `SILENT_BEHAVIOUR_LOSS`, `SOURCE_NOT_EDITABLE`, `NOT_TESTABLE`,
`INVALID_INSTANCE`, `HARNESS_FAILURE`.

Every label needs a description and file-level evidence; `IMPOSSIBLE_PLATFORM` and
`DEGRADED_ONLY` additionally need a citable platform-documentation URL, without which the label
degrades into "the annotator found it hard". `POSSIBLE_MODEL_FAILED` needs the run id that proves
the migration is possible. The harness only ever assigns `INVALID_INSTANCE` and `HARNESS_FAILURE`
— facts about its own execution; everything else is adjudication.

## Measuring migration quality

`report.json` carries more than pass/fail, because "Chrome loaded it" is a weak success
criterion — an MV3 port whose every feature is dead still passes it:

- `baseline` — the same behavioural checks run against the **unconverted MV2 original** before
  the agent starts (mounted at `/work/original`). A check the original already failed is not
  evidence about the migration, and an original that grades nothing is labelled
  `INVALID_INSTANCE` and leaves the denominator instead of counting as a model failure.
- `behaviour` / `score` / `regressions` — the same checks after migration, scored as the
  fraction of baseline-passing checks preserved (0–1). Checks: background context alive, popup /
  options / newtab render, storage round-trip, content-script injection, DNR rulesets actually
  enabled, and **service-worker survives termination** — the last being where MV3 ports break in
  the wild and where a load-only harness is blind.
- `blockers` — MDN compat findings (`src/host/compat.ts`) over the input and the output, tagged
  HARD (no MV3 equivalent exists) or SOFT (a replacement exists). An input HARD blocker bounds
  what any model could achieve on that extension.
- `abstained` — the agent wrote `ABSTAIN.md` instead of migrating. Recorded, never folded into
  the pass rate: models abstain from hard-but-possible work too.
- `usage` / `wallTimeMs` — tokens and cost per run.

Every run is also appended to the `outcomes` table in `run/migrator.db` keyed by
`(extension, model, run_id)`, so a second model accumulates alongside the first rather than
overwriting it. `Registry.migratedByAnyModel()` is then the union of everything any model has
ever migrated, and `unmigratedSoFar()` its complement — the set an impossibility audit should
sample from.

## Running the host

The host is a long-running background process. `scripts/host.sh` tracks it so you never have to
find it in `ps aux | grep node` — a pattern that also matches the migrator's own node processes,
and the ssh session you are typing in:

```sh
npm run host:start -- --source-dir ../corpus --out ../run_test/   # detached; args are remembered
npm run host:restart                                              # reuses the remembered args
npm run host:stop
npm run host:status                                               # running? since when? which port?
npm run host:logs                                                 # or: npm run host -- logs -f
```

`start` puts the host in its own process group and records it, so `stop` signals that group and
nothing else. It waits for the server to announce its port rather than reporting success the
instant it forks, so a bad key or a port clash surfaces immediately.

`.env` (tracked: model, base url) and `.env.local` (gitignored: `LLM_API_KEY`) are both loaded on
start, so a restart needs no environment juggling.

`status` also surfaces the SDK staleness warning, which is the first thing to check when the review
form under-reports what an extension exposes.
