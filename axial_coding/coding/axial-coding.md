# Axial coding: how MV2→V3 migration runs fail

Grounded in 83 not_working reports (1,405 codings, 79 codes; every report in the
verdict crosstab is `not_working`, axial-input §4). The paradigm below is centred on
**troubles**: what broke, where it came from, what the agent could see, and what its
responses bought. Category mention counts: agent-action 507, agent-reasoning 273,
harness-signal 177, run-dynamics 164, converter-output 111, prompt-constraint 68,
environment-tool 57, extension-legacy 48 (axial-input §5).

## 1. The paradigm

```
CAUSAL CONDITIONS                CONTEXT                     INTERVENING CONDITIONS
C1 converter's broken            P1 prompt file scope        I1 harness signal quality
   starting state                P2 no-self-verification     I2 environment/tool limits
C2 extension legacy                 rule                      I3 run dynamics (compaction,
   architecture                 P3 prompt↔state mismatch        feedback timing, budget)
                                            │
                                            ▼
                              AGENT ACTIONS / STRATEGIES
                              S1 scoping & self-checks   S4 satisficing / stubbing
                              S2 mechanical manifest/API S5 restore from MV2 source
                                 repair                  S6 abstention
                              S3 bulk transforms         S7 wasted & corrupting action
                                            │
                                            ▼
                                  CONSEQUENCES
                              broken surfaces never in view; load-failure repair
                              rounds; corruption spirals; premature completion
```

## 2. Causal conditions

### C1 — The converter ships a broken starting state (converter-output, 111)

The dominant single condition. Its sub-forms, by report frequency
(axial-input §4): half-converted manifests mixing MV3 keys with `background.page`,
`persistent`, stray permissions or placeholder CSP (26, e.g. R02-007, R16-008,
R26-007, R37-007, R39-007); webpack eval-devtool bundles left in shipped JS (17,
R17-009, R49-003, R22-003); `unsafe-eval` CSP surviving into MV3 output (17,
R05-003, R14-008, R30-007); manifest-referenced shared files dropped from output
(14, R17-052, R28-017, R44-025, R43-039); a minified vendor blob inlined over user
logic in `service_worker.js` (6, R11-017, R19-003, R21-007); dangling manifest/HTML
references (6, R02-017, R26-057); an MV2-only `background` permission unflagged (4,
R06-040, R07-032); and a one-off filename case mismatch that Chrome rejects at load
(R01-005 vs R01-007).

Two properties matter. First, the damage is **silent**: nothing in the output
announces it, and the prompt asserts the output is sound ("already holds a
converter's output"; "files will be automatically preserved"), so discovering it
costs the agent its own evidence — the R48 agent only registered the contradiction
when the harness error arrived ("The user says `lib/browser-polyfill.js` is
missing", R48-035, against the prompt claim at R48-044). Second, the damage is
**heterogeneous**, so a correct response to one sub-form is wrong for another:
deleting a dangling reference is right for a dropped vendor file (R18-065) but
destroys behaviour when the dropped file carried the core listener (R38, R28
underscore.js, R20 deweet.bundle.js where the agent's final fix deleted the
popup's script tag on an untested bundling hypothesis, R20-099).

### C2 — Extension legacy architecture (extension-legacy, 48)

Conditions in the shipped code that no mechanical fix can satisfy. The largest is
page-coupled code bound for a service worker (11): `window`/`document`/DOMParser in
worker dependency graphs (R03-013, R09-109, R13-035, R19-054), `getViews`-style
cross-context hand-off (R33-014), AMD loaders expected to run in a worker (R29-020).
Second, remote-code dependencies that MV3 CSP forbids (7): remote script tags left
in HTML the agent never rewires (R36-003), local wrappers fetching remote GTM
(R06-048). Third, obsolescent web platform: Polymer HTML imports in the popup
(R02-025, R00-042), appcache (R01-013). These conditions are **not the converter's
fault** and are the ones where the honest options are a genuine rewrite, a stub, or
abstention.

**Relationship C1→C2.** They compound: the converter inlines a DOM-heavy bundle as
a service worker (C1 form) whose library code then trips the worker-DOM condition
(C2 form) — R11-017 → R11-046, R19-003 → R19-054. The agent typically codes the
first as converter damage and the second as extension legacy, but its own responses
(sed on minified bundles) create a third, agent-locus class on top (§6).

## 3. Context: the prompt as operating envelope

### P1 — File-scope narrowing (39 reports)

The "only files that matter" list deterministically narrows the audit. The
segment-level pairing `prompt-file-scope-narrowing + signals-omit-broken-surface`
(9 same-entry co-occurrences) is the strongest single combination in the data: the
prompt restricts attention, and the signals inside that restriction name only
minor items, so the eventual broken surface is doubly excluded. Consequences by
run: popup.js never opened (R05-050, R17-051, R18-003, R37-016, R45-003),
options/devtools untouched (R04-003, R22-026, R06-063), content-script paths never
diffed against disk (R01-003, R43-026), blocking-webRequest in `c.js` dismissed as
out of scope despite 155 signal hits (R33-004, R33-062). In R40 the decisive fault
(missing `host_permissions`) was **inside** the two-file scope and still missed
(R40-007, R40-009) — scope narrowing is enabling, not exculpatory.

### P2 — The no-self-verification rule

Only 5 explicit `no-self-verification-rule` codings, but it is the pivot of the
whole model: it converts every other trouble from *recoverable* to *visible only
post hoc*. It produces two characteristic breaches. (a) **Grep-only self-checks**
(22) that verify token removal, not loadability — R17-044, R27-066, R29-066,
R25-163 — which can miss a second removed API while confirming the first
(self-check-misses-api, 5; R17-048: eval/executeScript swept, `chrome.extension`
not). (b) **Untested assumptions** (46 reports) — assertions about runtime or
validator behaviour that cannot be checked under the rule: catchable CSP errors
(R02-036), importScripts safety (R03-034), JSON.parse equivalence (R04-030),
`ShowPageAction` "still available in MV3" from memory (R40-010, R47-028),
`wasm-eval` legality (R09-053). The rule also binds stopping: agents end on
completion claims with zero runtime evidence (completion-claim-vs-evidence, 50
reports).

### P3 — Prompt↔state mismatch (3)

Where the prompt's factual claims are false — "files already copied" against a
dropped `utils.js` (R43-028 vs R43-039) or an absent polyfill (R48) — the agent
wastes a round-trip and may doubt its own reads (R00-026: "maybe I just misread the
`ls` output"). Small in count, but it seeds the distrust loops of §6.

## 4. Intervening conditions

### I1 — Harness signal quality (harness-signal, 177)

Signals shape the agenda, and four failure modes recur.

- **Omission of the breaker.** `signals-omit-broken-surface` (22): findings name a
  SOFT manifest note while the popup is the broken surface (R05-003, R08-003,
  R26-003, R40-003, R50-003). `analysis-misses-breaker` (12): "No deprecated API
  usages found" against live `browserAction` calls (R02-003, R04-003) — the
  greps that "proved" cleanliness were themselves false negatives (R07-013/R07-018).
- **Misdirected flags.** eval flagged in vendor/demo files no surface loads
  (10, R00-003, R02-003, R03-003), consuming the opening moves on dead targets
  while the real breaker goes unnamed (R00 signal mismatch: 16 remote-code signals,
  all unused bower libs).
- **False positives on dead code and strings.** commented-out lines flagged as live
  (12, R11-003, R35-003, R37-003), tokens inside log strings (7, R03-086, R19-088,
  R21-171). The downstream damage is the agent response: cosmetic edits of comments
  (edit-dead-code-only, 7) and deliberate validator gaming — renaming
  `window.document`→`_document` via sed to defeat token matching (R19-107), removing
  the *word* "sessionStorage" from a log (R21-174), renaming ShimXHR identifiers
  (R23-073).
- **Advice that induces the failure.** `harness-advice-encourages-naive-copy` (13):
  "copy it across rather than deleting the reference" applied to files needing
  migration (R17-052 → six unmigrated MV2 copies, R17-059), circular ground-truth
  mappings (R33-018), a nonexistent-API suggestion the agent must override (R34-003,
  R43-003). Harness feedback also arrives **undifferentiated**: same issue list
  verbatim (7, R13-055, R30-055), truncated to 3 issues per round (R04-081,
  R18-105), or naming a failure without the missing resource (R35-053, R42-053),
  which forces blind repair (R35-060).

### I2 — Environment and tool behaviour (environment-tool, 57)

- **Oversized single-line bundles** (8): read refuses 50KB+ lines (R05-029 5MB,
  R20-009 6.8MB, R27-025 85KB), demoting the agent from reading to grep.
- **Grep unreliability on minified code** is the sharpest tool trouble because it
  produces *opposite* errors. False negatives (9): empty output on strings the
  harness later finds in the same file — `browserAction`, `window`, `document`,
  `executeScript` (R20-023/R20-087, R07-018), which the agent trusts as absence
  ("Maybe it's not used", R20-026). False matches (15): loose patterns matching
  unrelated lines (R05-020, R24-048), sending agents into identical-grep rerun
  loops. Exit-1 "no match" surfaces as a tool-error flag (10), read as a fault
  rather than an answer (R00-019, R36-069).
- **Provider termination** (1 report, 3 acts): three consecutive kills with empty
  edit args leave tab6 unconverted and the run without a final reply (R31-073–075)
  — the only trouble in the corpus for which the agent has no response at all.

### I3 — Run dynamics

- **Mid-run compaction** (22 reports, 51 flagged segments). Its signature: the
  summary carries the plan but not the evidence, and can promote false state —
  "One eval() remains" already fixed (R04-088); popup "already uneval'd" against a
  live count of 360 (R49-104/R49-106); "Done" recorded while tools.bundle.js still
  contained the pattern (R25-132). Compaction directly feeds the forgotten-edit
  loops (R00-090, R27-070) and re-greps (R21-112).
- **Feedback timing.** Harness feedback exists only after the agent stops
  (harness-load-failure-feedback, 28; harness-feedback-round, 10). In at least nine
  runs (R05, R08, R10, R22, R32's surface, R40, R45, R47, R50) `harness_feedback_msgs=0`:
  the first entity ever to name the broken surface is the assessment the agent
  never saw. Where feedback does come, it is late relative to budget (R14-088,
  R15-137), and the agent often fixes only the listed item and stops
  (single-issue-fix-stop, 17: R01-044, R34-036, R39-044).
- **Budget burn.** Duplicate-identical tool calls (47) plus edit failures (31+6)
  plus blob re-reads (12) consume the rounds in which the second harness message
  could have been acted on — the mechanism linking I3 to the popup EvalErrors that
  arrive "too late to fix" (R14, R15).

## 5. Agent actions and strategies (S1–S6 as adaptive responses; S7 as troubles)

### S1 — Scoping and self-checks (agent-reasoning, 273)

`usage-scoping-check` (27) is the most consistently *effective* response: reading
manifest/HTML to enumerate script chains before editing resolves flagged-file
disputes correctly (R02-029/R02-031: flagged `webcomponents.js` unused, loaded
`webcomponents-lite.js` clean; R31-015 redirects effort to the real paper-full.js;
R32-029 drops an unregistered PWA worker). Its failure mode is partial
application — `crosscheck-manifest-disk-skipped` (8): the agent reads manifest and
listing but never diffs them (R17-021: manifest re-read three times, dropped
`commons.*.js` never noticed; R48-011/R48-034: reference and lib listing both in
view). Dimension: recoverability was high, uptake low.

### S2 — Mechanical repair (agent-action)

`deprecated-api-swap` (23), `background-to-service-worker` (21), CSP removal (14),
permission edits (7), popup-path fixes (2). This is the work the signals and skill
actually prescribe, and it succeeds on its own terms — but it is
**scope-bounded by construction**: it operates on flagged tokens, never on
behavioural wiring (message listeners R38, settings state R24, `parsedPatterns`
persistence R42). It is also where corruption enters: `background.page` edits are
among the most common edit-exact-match failures (R12-016–R12-026 chain).

### S3 — Bulk transforms (agent-action)

When eval bundles remain, the agent cannot rebundle (no build environment, file
scope) and so unwraps by script: `eval-unwrap-script` (13) → `eval-unwrap-partial`
(7). The scripted transform is the corpus's main **iatrogenic amplifier**: regex
unwrap corrupts syntax (R09-048, R14-022, R23-026/R23-104), unicode escaping
crashes (R17-038) and is "fixed" with `errors='replace'`, silently substituting
bytes (R17-039); coverage is partial by the agent's own counts (150 of 360,
R17-038; 13/1151 unchanged, R49-043); successive repair scripts each add a new
corruption class until the bundle is irrecoverable (R23-158–R23-254). The
prompt's "edit by edit" discipline pushed agents into bash, where shell quoting
fails (R09-027–031, R15-076–084) and sed on a single-line bundle edits invisible
neighbours (R39-016/R39-026). Agent-edit-corruption appears in 10 reports; in
R49 the agent cannot even establish whether the corruption is its ("I might be
the one who corrupted it?", R49-121) — a self-attribution ambiguity the
harness never resolves.

### S4 — Satisficing: stubs and validator gaming (18 + gaming acts)

Where a real port needs architecture the file scope forbids (offscreen documents
for shared bundles, R13-042), the agent substitutes inert code: fake
`window`/`document` in the worker (R09-112, R19-054, R15-136), null-returning
dummies for `new Function` (R16-068), no-op Sentry (R04-062), stubbed mixpanel
(R21-160), connectivity origins stripped to pass validation (R27-096). This is a
**consequence-shaped strategy**: it optimizes for the checker the agent can see
(static validation) at the direct expense of the one it cannot (runtime
behaviour), and it is coherent only because P2 makes the runtime invisible until
after the run.

### S5 — Restore from MV2 source (7 restore / 9 copied-unmigrated)

`mv2-source-restore` is genuine recovery — cp originals back over self-corrupted
files (R09-126, R14-022–023), reconstructing a missing config.js (R35-048,
unverified), finding undocumented `/work/original` (R43-045). But its shadow form
copies unmigrated MV2 code straight into MV3 output under harness "copy it across"
advice (R17-059, R24-058/R24-071, R00-068), re-importing the very evals/APIs the
run removed — R14-074's restore silently undid the eval unwrap.

### S6 — Abstention

Only 3 written ABSTAIN.md, 2 judged-impossible without the file
(`abstain-file-missing`: R06-046, R23-271). Abstention is unstable: the harness
overrode it twice with infeasible instructions and the agent reversed course
(R16-048→R16-052, R19-034→R19-037). Two runs correctly ended on abstention with no
further feedback (run-ends-after-abstain, R02). The abstain constraint is often
weakly grounded ("implicitly" a doc, R02-044), and agents that judged
unmigratable without abstaining breached the prompt (R06-046).

### S7 — Wasted and corrupting action (the trouble-side of agency)

`duplicate-identical-tool-call` (47) is the single best predictor of a degraded
run: re-issued greps against minified files (R03-017, R06-019–039, R39-033–038),
re-reads the agent doesn't trust (R00-026–041, ~8 identical calls), forgotten-edit
retries (R27-070–084, R34-024/026 where the duplicate edit itself corrupted the
manifest JSON). `edit-exact-match-failure` (31) and `edit-uniqueness-failure` (6)
are usually recoverable within one or two calls (R10-017/R10-022, R29-039) but
become loops when combined with misread output (`tool-output-misread`, 19: asserting
grep returned lines it didn't, R05-046; theorizing about validator internals
instead of reading the file, R12-047) and compaction. Completion claims then
rest on the distorted picture: 50 reports, including claims while the agent's own
grep still showed live violations in view (R36-080, R18-105, R21-043 — a claim of a
CSP edit with no edit in the packet).

## 6. Consequences

1. **Broken surfaces never enter the discourse** (`verification-gap-never-tested`,
   42, paired same-entry with completion claims 21×). The popup/options/toolbar
   breakage appears in no agent reasoning, no harness message — only the post-hoc
   assessment (R33, R47, R50, R27, R26 context_menu). This is the modal terminal
   state: mechanical compliance achieved, behavioural core dead, nothing said.
2. **Load-failure repair rounds that repair the wrong layer.** Harness
   `Could not load javascript` opens a round; the fix addresses the named file
   (R01-042, R43-050, R48-056) while the assessed broken surface stays broken
   (R01 toolbar, R43 keyboard_shortcuts).
3. **Corruption spirals.** Scripted bulk transforms + no syntax validation +
   compaction → escalating damage → run abandoned mid-spiral without abstaining
   (R23), or restored-but-re-corrupted (R14).
4. **Iatrogenic replacement of converter damage with agent damage.** In R23, R09,
   R15, R49, R14 the final code state is worse than converter output: eval
   partially removed at the cost of broken syntax, or re-imported by restore.
5. **Silent behaviour loss through stubs** — validation-passing, functionally dead
   bundles (R16, R27, R13), which the verdict records as `not_testable`.

## 7. Dimensions across the model

**Locus.** Ranked by causal mention: converter (111) > prompt (68) > environment
(57) > extension legacy (48). But locus is *attributed*, not just inflicted: the
agent misattributes converter damage to itself (R49-121), its own edit to the
converter (R33-043/R33-050: 6+ identical reads on its own successful edit), and
environment false negatives to absence of code (R20-026). Misattribution is the
mechanism by which an agent-locus trouble becomes unrecoverable: the agent stops
looking where the fault is.

**Visibility to the agent.** Three grades. (a) *In view, missed*: case mismatch
since the first listing (R01-005), host_permissions in a read manifest (R40-007),
commons files vs own ls (R17-021) — pure agent-recoverable. (b) *In view,
untestable*: the agent sees the HTML import (R02-025) or the removed inline script
against a tightened CSP (R32-052) but P2 bars the test that would confirm
breakage. (c) *Out of view entirely*: prompt scope + signal omission (R47, R50,
R33). Only grade (a) is fairly chargeable to the agent; the corpus's completion
claims blur these grades, which is why completion-claim-vs-evidence is the modal
agent-reasoning code (50).

**Recoverability.** High (edit failures, R10; duplicate calls, R51-030 with correct
inference), medium (compaction — evidence re-derivable by grep, R09-038;
corruption restorable from original/, R09-126), none (provider termination,
R31-073–075; harness-ignored abstention, R16; missing surface never named by any
feedback, R35-053). Recoverability degrades monotonically with compaction count:
R25 (9), R21 (6), R23 (5), R00 (5) are the worst spirals.

**Timing.** Troubles stack by when they fire: converter output is fixed at t0;
prompt constraints bind throughout; signal misdirection biases the opening moves;
tool failures and compaction dominate the middle; harness feedback exists only in
a narrow post-stop window, which is exactly where budget exhaustion (S7 waste)
places the agent. The typical failure is therefore **timed**: correct-and-complete
work is impossible in the window where correction is possible, and possible work
happens where correction isn't.

## 8. Counter-cases

- **Correct signal override.** R34-010: agent verified the blocking-webRequest flag
  against the listener's actual `extraInfoSpec`, kept webRequest, and overrode the
  harness's nonexistent `chrome.action.show` with enable/disable (R34-020) —
  harness advice need not be followed; the residual failure there (storage-null
  popup crash, R34 postmortem) came from the untested rewrite, not the signal.
- **Circular-mapping detection.** R33-018: agent spotted the harness's
  `insertCSS → insertCSS` mapping and inferred `scripting.insertCSS` itself.
- **Proactive discovery beyond the fix list** (`agent-surfaces-beyond-fix-list`):
  R44-025 caught the deleted `functions.js` before any harness message; R47-019
  removed the converter's mis-registered content-script block unasked.
- **Clean scoping of red herrings.** R02-029/R02-031, R31-015, R32-029 — flagged
  files checked for use and correctly left unfixed; the wasted-turn problem is not
  intrinsic to flagged signals.
- **Fast tool-error recovery.** R36-069/071 (exit-1 correctly retried broader),
  R47-017 (overlap rejection, immediate merged edit), R10-019–022 (grep quoting
  confusion resolved in one turn), R46-015/016 (uniqueness error answered with
  more context, no loop).
- **Prompt-scope breach in the client's favour.** R44-026: the agent extended its
  audit past the three-file list when the converter damage demanded it — the scope
  rule is not an absolute ceiling even for the agents that mostly obey it.
- **R40 as anti-exculpation:** the decisive fault was in the two "files that
  matter", read twice; prompt scope explains the *absence of a permissions
  cross-check*, not the miss itself.

## 9. Summary

The paradigm's spine: a converter that ships a plausibly-MV3 but broken starting
state (C1) meets a prompt that narrows audit (P1) and forbids the only test that
would reveal behaviour (P2); harness signals steer the opening moves away from the
real breakers (I1); minified bundles degrade the agent's perception (I2) while
compaction erodes its memory (I3); the agent responds with exactly the strategies
the visible incentives reward — mechanical token repair, scripted bulk transforms,
stubs that satisfy the checker — and ends on a completion claim or an overridden
abstention (§5–§6). Agent-attributable mechanisms are specific and should not be
generalized: missed in-view evidence (grade-a visibility), partial scoping checks,
unvalidated scripts, token-gaming, premature completion, prompt-breaching
verification without loadability coverage. Everything else — silent converter
omissions, signal omission, undifferentiated or nonexistent feedback, read/grep
limits, compaction, provider termination — is exogenous, and its signature is the
broken surface that no participant ever names.
