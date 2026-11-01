# merge_codes.py
```
wrote 1412 acts -> coding/open-codes.jsonl (dropped 1 duplicates, 0 unknown segments)
  dup: R33-p1.jsonl:3 R33-003 signals-flag-dead-file

codes not in codebook (357) — add, alias, or drop during consolidation:
  tool-error-flag x7: Tool reported an error requiring inspection of the exit/cause.
  csp-unsafe-eval-removed x7: Agent edits manifest CSP to drop 'unsafe-eval', satisfying MV3 load.
  self-check-reveals-new-corruption x6: agent-run syntax check surfaces additional corruption caused by its own prior bulk edits
  error-page-download-detected x4: agent suspects fetched files are HTML error pages rather than the requested scripts
  edit-uniqueness-failure x4: edit fails because oldText matches multiple sites, forcing re-batching with more context
  validator-string-literal-false-positive x3: Static validator flags identifiers appearing inside string literals or object keys, producing false errors.
  unvalidated-script-output x3: (no proposed_definition)
  grep-false-negative-minified x3: bash grep over the bundle returns no output for strings the harness later reports present; agent trusts the negative.
  edit-succeeded x3: (no proposed_definition)
  provider-error-terminated x3: Provider kills the turn with 'terminated' before the tool call executes
  minified-grep-false-negative x3: Grep against a minified bundle returns no matches for patterns the bundle plainly contains, and the agent accepts the absence as evidence.
  minified-bundle-sed-replace x3: Agent applies sed string replacement to a minified single-line bundle, editing invisible surrounding code.
  gtm-local-file-unflagged x2: Shipped local gtm.js plus per-page GTM tags that the findings list never flagged and the agent only partially removes.
  bash-quoting-failures x2: (no proposed_definition)
  naive-replace-ineffective x2: (no proposed_definition)
  run-ends-no-harness-feedback x2: Run ends on the agent's stop with no harness feedback message returned.
  whole-file-rewrite-recovery x2: (no proposed_definition)
  validator-behavior-hypothesis x2: Agent speculates the validator reads a cached or older file because feedback contradicts its read.
  mv2-source-restore-cp x2: Agent copies MV2 originals back into out to reset corrupted files between script attempts.
  harness-advice-encourages-naive-fix x2: Harness FIX text pushes rewrite/substitute for what a minimal token change might satisfy.
  bash-quoting-syntax-error x2: bash rejects the agent's command because unquoted parens/braces in the replacement text hit shell parsing.
  regex-unbalanced-paren x2: (no proposed_definition)
  sed-bulk-replace-loop x2: Agent uses iterative sed -i passes on a huge bundle, escalating from targeted patterns to a blanket word-boundary replace.
  dummy-stub-instead-of-migration x2: Agent replaces failing APIs with no-op dummies to pass load checks, disabling features.
  eval-unwrap-partial x2: Unwrap script's regex misses a quote variant (single vs double), leaving evals in place while claiming success.
  dangling-html-reference-noted x2: (no proposed_definition)
  remote-script-removal x2: Agent deletes or comments out a remotely-hosted script tag from an extension HTML file.
  edit-introduces-syntax-error x2: an agent edit leaves residual text behind, creating a new syntax error
  completion-claim-unverified x2: (no proposed_definition)
  rewrite-iterate-loop x2: Agent rewrites the same migration script many times after each failed or partial result.
  partial-deeval-garbage-artifacts x2: Eval-unwrap script leaves residual escaped/source-map text, corrupting migrated bundles.
  deeval-multifile-run x2: Agent runs a rewritten multi-file deeval.py on the popup and tools bundles after harness EvalError feedback.
  targeted-grep-for-prefixes x2: (no proposed_definition)
  extract-shared-config-plan x2: (no proposed_definition)
  eval-stub-changes-behavior x2: Agent replaces flagged eval/new Function with a stub that swallows calls, altering runtime behavior rather than porting the feature.
  curl-remote-code-into-output x2: Agent uses curl via bash to fetch remote scripts into MV3 output instead of rewriting the logic, leaving remote-code dependency in place.
  harness-mapping-typo x2: Harness findings give a deprecated-API mapping whose target equals the source, providing no actionable replacement.
  service-worker-full-rewrite x2: (no proposed_definition)
  flagged-file-dismissed-as-unused x2: Agent declares a harness-flagged file unused and skips its fix; harness later re-flags it.
  agent-surfaces-beyond-fix-list x2: Agent finds and fixes a migration bug not present in harness findings.
  script-regex-crash x2: (no proposed_definition)
  script-silently-noop x2: (no proposed_definition)
  corruption-attribution-hypothesis x2: agent infers its earlier automated edit corrupted the bundle, without yet confirming how
  partial-script-removal x2: (no proposed_definition)
  grep-tool-false-error x1: (no proposed_definition)
  environment-tool x1: (no proposed_definition)
  empty-tool-result-loop x1: (no proposed_definition)
  flagged-file-never-shown-loaded x1: Harness signals flag patterns in files the extension never loads anywhere, consuming agent time without effect.
  extension-legacy-dom-dependency x1: Legacy extension JS depends on page-context globals (window/localStorage/DOM) that MV3 service workers lack.
  grep-filename-reference-confusion x1: Agent misreads an empty grep result as a tool failure when the true answer is that no references exist.
  async-messaging-bridge-rewrite x1: Agent rewrites synchronous background-page access into chrome.runtime messaging with callback/promise wrappers.
  harness-scope-to-listed-issues x1: Harness feedback enumerates a closed issue list, and the agent's subsequent audit is bounded by it.
  tool-output-misread-inverse x1: Agent correctly reads tool/validator output against its apparent finding, identifying false positives.
  edit-uniqueness-failure-loop x1: (no proposed_definition)
  sed-fallback-for-edit-loop x1: (no proposed_definition)
  stub-polyfill-mock x1: Agent writes stub polyfills that satisfy static checks but silently no-op real functionality.
  sed-pattern-mismatch-detected x1: (no proposed_definition)
  false-positive-left-in-place x1: (no proposed_definition)
  script-run-unverified x1: (no proposed_definition)
  runtime-eval-found x1: (no proposed_definition)
  sw-dom-polyfill-mock x1: Agent defines fake window/document/localStorage globals in service worker instead of porting storage or offscreen docs.
  harness-does-not-flag-polyfill-cause x1: (no proposed_definition)
  new-function-inline x1: Agent hand-inlines a new Function body into equivalent literal code.
  sentry-dialog-noop x1: Agent comments out or stubs a shipped feature instead of porting it, silently losing functionality.
  polyfill-removal-reversal x1: Agent undoes its own earlier workaround when it causes new failures.
  harness-whack-a-mole-feedback x1: (no proposed_definition)
  behaviour-loss-feedback x1: (no proposed_definition)
  bash-empty-output-ambiguity x1: Bash tool shows '(no output)' with a truncated log reference, leaving match status ambiguous.
  abstain-file-not-written x1: Agent judges migration impossible in its reply but does not write ABSTAIN.md as the prompt requires.
  local-wrapper-loads-remote x1: A locally-shipped script file whose content loads remote code, so a local src tag still triggers remote-code CSP violation.
  malformed-edit-arguments x1: Edit tool call arrives with arguments structurally corrupted (oldText missing or embedded in newText), producing schema validation failure before any match atte
  grep-no-output-ambiguous x1: Grep over a minified single-line bundle returns no output repeatedly; agent is never sure whether the pattern is absent or the search failed.
  signals-miss-broken-popup x1: harness findings omit the surface the later assessment marks broken, so agent never audits it
  already-mv3-manifest x1: converted manifest is already fully MV3, so agent's manifest work reduces to verification only
  demo-localization-plan x1: agent plans to fetch flagged remote scripts and rewrite HTML references to local copies
  false-positive-local-src x1: edit-dead-code style mistake; agent treats local relative src as remote due to substring match
  insecure-download-workaround x1: (no proposed_definition)
  environment-speculation x1: agent invents unverifiable explanations for manifest fields mid-task
  shipping-known-broken-files x1: agent deliberately leaves downloaded error stubs in shipped output instead of removing or substituting
  demo-scope-degradation x1: agent downgrades work on demo/auxiliary surfaces to concentrate on claimed core migration
  remote-scripts-localized x1: (no proposed_definition)
  shipped-stub-referenced x1: HTML script tags repointed to files the agent already knows are non-functional stubs
  xhr-host-permission-reasoning x1: (no proposed_definition)
  double-replacement-corruption x1: (no proposed_definition)
  degrading-behaviour x1: (no proposed_definition)
  script-blind-sweep x1: (no proposed_definition)
  validator-evasion-polyfill x1: Agent injects stub DOM/global objects to satisfy static checks instead of migrating the DOM-dependent code.
  bulk-unwrap-corrupts-syntax x1: String-unescape unwrap of eval bundles leaves invalid JS (unescaped quotes/newlines), breaking the page at runtime.
  file-inventory-check x1: Agent lists directories to locate backup/original copies before repairing a damaged file.
  mv2-original-available x1: Original MV2 sources remain accessible, letting the agent undo converter/agent damage by restoring.
  restore-and-redo x1: Agent restores damaged output from original sources and re-applies fixes with corrected logic.
  mv2-manifest-edit-success x1: edit tool reports successful replacement of the manifest blocks.
  grep-tool-false-match-suspect x1: Grep returns no match for a pattern that demonstrably exists in the file, misleading the agent.
  signals-miss-shipped-eval x1: Agent's usage scoping stays partial; whether the flagged library file is loaded is never resolved.
  no-verification-observed x1: Agent defers to the no-verification rule instead of self-checking a suspected runtime hazard.
  prompt-rule-contradiction-perceived x1: Agent perceives the prompt's file-scope rule as contradicting the migration signals and uses it to defer flagged fixes.
  edit-overwrites-target-key x1: Agent's edit replaces existing manifest content unintentionally, deleting a key it meant to keep.
  csp-key-dropped x1: (no proposed_definition)
  repair-edit-restores-key x1: (no proposed_definition)
  duplicate-manifest-key x1: Repeated blind edits leave the manifest with a duplicated key and invalid JSON that the agent then must rewrite wholesale.
  empty-csp-hypothesis x1: Agent infers a manifest field will fail at load without any tool evidence, then edits it on that basis.
  deferred-flagged-fix x1: Agent uses the file-scope rule to permanently drop a flagged fix in a file the extension loads.
  harness-load-feedback-contradiction x1: Harness reports the extension loads, contradicting the agent's prior unverified load-failure prediction.
  validator-flags-commented-code x1: (no proposed_definition)
  dead-code-removal x1: (no proposed_definition)
  signals-miss-broken-surfaces x1: Harness feedback lists only minor findings while the run's broken surfaces never appear in the transcript.
  service-worker-dom-incompatibility x1: (no proposed_definition)
  service-worker-window-usage x1: Static validation flags any window reference in service-worker dependency graph, including unexecuted library code.
  harness-feedback-repetition x1: Harness feedback round repeats the same issue list unchanged, giving the agent no signal its attempted fix moved anything.
  missing-rAF-polyfill-warning x1: (no proposed_definition)
  regex-escaping-bug x1: Edit-script regex mishandles escaped quotes inside eval strings.
  regex
```

# validate_codes.py
```
UNKNOWN CODES (426 uses) — add to codebook or fix:
  tool-error-flag  x7
  csp-unsafe-eval-removed  x7
  self-check-reveals-new-corruption  x6
  error-page-download-detected  x4
  edit-uniqueness-failure  x4
  validator-string-literal-false-positive  x3
  unvalidated-script-output  x3
  grep-false-negative-minified  x3
  edit-succeeded  x3
  provider-error-terminated  x3
  minified-grep-false-negative  x3
  minified-bundle-sed-replace  x3
  gtm-local-file-unflagged  x2
  bash-quoting-failures  x2
  naive-replace-ineffective  x2
  run-ends-no-harness-feedback  x2
  whole-file-rewrite-recovery  x2
  validator-behavior-hypothesis  x2
  mv2-source-restore-cp  x2
  harness-advice-encourages-naive-fix  x2
  bash-quoting-syntax-error  x2
  regex-unbalanced-paren  x2
  sed-bulk-replace-loop  x2
  dummy-stub-instead-of-migration  x2
  eval-unwrap-partial  x2
  dangling-html-reference-noted  x2
  remote-script-removal  x2
  edit-introduces-syntax-error  x2
  completion-claim-unverified  x2
  rewrite-iterate-loop  x2
  partial-deeval-garbage-artifacts  x2
  deeval-multifile-run  x2
  targeted-grep-for-prefixes  x2
  extract-shared-config-plan  x2
  eval-stub-changes-behavior  x2
  curl-remote-code-into-output  x2
  harness-mapping-typo  x2
  service-worker-full-rewrite  x2
  flagged-file-dismissed-as-unused  x2
  agent-surfaces-beyond-fix-list  x2
  script-regex-crash  x2
  script-silently-noop  x2
  corruption-attribution-hypothesis  x2
  partial-script-removal  x2
  grep-tool-false-error  x1
  environment-tool  x1
  empty-tool-result-loop  x1
  flagged-file-never-shown-loaded  x1
  extension-legacy-dom-dependency  x1
  grep-filename-reference-confusion  x1
  async-messaging-bridge-rewrite  x1
  harness-scope-to-listed-issues  x1
  tool-output-misread-inverse  x1
  edit-uniqueness-failure-loop  x1
  sed-fallback-for-edit-loop  x1
  stub-polyfill-mock  x1
  sed-pattern-mismatch-detected  x1
  false-positive-left-in-place  x1
  script-run-unverified  x1
  runtime-eval-found  x1
  sw-dom-polyfill-mock  x1
  harness-does-not-flag-polyfill-cause  x1
  new-function-inline  x1
  sentry-dialog-noop  x1
  polyfill-removal-reversal  x1
  harness-whack-a-mole-feedback  x1
  behaviour-loss-feedback  x1
  bash-empty-output-ambiguity  x1
  abstain-file-not-written  x1
  local-wrapper-loads-remote  x1
  malformed-edit-arguments  x1
  grep-no-output-ambiguous  x1
  signals-miss-broken-popup  x1
  already-mv3-manifest  x1
  demo-localization-plan  x1
  false-positive-local-src  x1
  insecure-download-workaround  x1
  environment-speculation  x1
  shipping-known-broken-files  x1
  demo-scope-degradation  x1
  remote-scripts-localized  x1
  shipped-stub-referenced  x1
  xhr-host-permission-reasoning  x1
  double-replacement-corruption  x1
  degrading-behaviour  x1
  script-blind-sweep  x1
  validator-evasion-polyfill  x1
  bulk-unwrap-corrupts-syntax  x1
  file-inventory-check  x1
  mv2-original-available  x1
  restore-and-redo  x1
  mv2-manifest-edit-success  x1
  grep-tool-false-match-suspect  x1
  signals-miss-shipped-eval  x1
  no-verification-observed  x1
  prompt-rule-contradiction-perceived  x1
  edit-overwrites-target-key  x1
  csp-key-dropped  x1
  repair-edit-restores-key  x1
  duplicate-manifest-key  x1
  empty-csp-hypothesis  x1
  deferred-flagged-fix  x1
  harness-load-feedback-contradiction  x1
  validator-flags-commented-code  x1
  dead-code-removal  x1
  signals-miss-broken-surfaces  x1
  service-worker-dom-incompatibility  x1
  service-worker-window-usage  x1
  harness-feedback-repetition  x1
  missing-rAF-polyfill-warning  x1
  regex-escaping-bug  x1
  regex-rename-loop  x1
  looping-unchanged-result  x1
  hmr-dead-code-in-worker  x1
  dnr-infeasible-reasoning  x1
  assumed-source-dir-missing  x1
  manifest-permission-csp-edit  x1
  eval-wrapping-blocks-edit  x1
  raw-byte-inspection  x1
  tool-loop-recovery  x1
  perl-substitution-attempt  x1
  perl-substitution-in-flight  x1
  write-script-to-avoid-quoting  x1
  script-claims-done-unverified  x1
  eval-bundle-persists  x1
  escaping-hypothesis-correction  x1
  edit-landed-unconfirmed  x1
  hmr-reloader-in-prod-bundle  x1
  dom-api-in-service-worker  x1
  new-function-remaining  x1
  graceful-degradation-fix  x1
  harness-dom-reference-feedback  x1
  guard-only-partial-fix  x1
  harness-csp-popup-feedback  x1
  wrong-directory-grep-result  x1
  deeval-applied-to-popup-options  x1
  harness-ignores-abstention  x1
  abstain-reversed-under-feedback  x1
  stub-dynamic-code  x1
  grep-pattern-collateral-match  x1
  harness-fix-copy-source-advice  x1
  file-reference-removal-instead-of-restore  x1
  stale-edit-retry  x1
  agent-reasoning-quotes-signal-text  x1
  abstain-reasoning  x1
  mv2-source-path-uncertain  x1
  remote-dependency-download  x1
  partial-edit-application-unclear  x1
  harness-repeats-dom-findings  x1
  validator-is-text-search-hypothesis  x1
  validator-evading-rename  x1
  edit-non-unique-match  x1
  sed-bypass-of-edit-rule  x1
  mass-rename-over-bundle  x1
  tool-output-trusted-blindly  x1
  eval-count-sweep  x1
  edit-script-rule-rationalization  x1
  harness-feedback-opens-repair  x1
  self-check-none-after-script  x1
  delete-reference-not-restore  x1
  ground-truth-line-inventory  x1
  permissions-edit  x1
  window-to-top-level-variables  x1
  batch-edit-overlap-rejection  x1
  executeScript-api-swap  x1
  long-tail-edits-incomplete  x1
  converter-left-remote-csp  x1
  bundled-lib-sw-neutralization  x1
  webpack-dev-middleware-shipped  x1
  background-logic-narrowed  x1
  eval-unwrap-judgment  x1
  eval-bundle-pattern-inference  x1
  promises-honored-over-broken-surfaces  x1
  webpack-middleware-stripped  x1
  partial-stripped-middleware  x1
  csp-cleaned  x1
  chrome-style-key-removed  x1
  shim-file-orphans  x1
  shim-prepend-verified  x1
  harness-signal-repeat  x1
  checker-model-revision  x1
  token-rename-to-evade-analyzer  x1
  agent-regression-syntax-error  x1
  self-check-syntax-breach  x1
  eval-script-regex-corruption  x1
  error-localization-failure  x1
  spec-misread-as-test-suite  x1
  unresolved-loop  x1
  regex-unescape-edit  x1
  agent-self-inflicted-corruption  x1
  degraded-give-up-without-abstain  x1
  repeated-error-lines  x1
  corrupted-deeval-mistaken-for-legacy-dom  x1
  agent-caused-corruption-recognition  x1
  targeted-module-neutralization  x1
  harness-behaviour-lost-feedback  x1
  compaction-stale-done-claim  x1
  extension-worker-window-ref  x1
  bash-grep-empty-result  x1
  edit-non-unique-oldtext  x1
  edit-uniqueness-retry  x1
  csp-edit-failure-loop  x1
  harness-static-validation-feedback  x1
  connectivity-dropped-for-validation  x1
  optional-host-permissions-swap  x1
  prompt-signal-overruled  x1
  compaction-loss-misstate  x1
  remote-code-removed  x1
  edit-corrupts-structure  x1
  grep-regex-syntax-error  x1
  looping-reread  x1
  brace-structure-diagnosis  x1
  iife-removal-planning  x1
  window-prefix-removal-edit  x1
  ga-script-search-loop  x1
  self-inflicted-runtime-error  x1
  misattributed-breakage  x1
  dangling-html-script-reference  x1
  import-scripts-reasoning  x1
  template-stub-replacement  x1
  rename-symbol-conflict-plan  x1
  duplicate-symbol-discovered  x1
  import-scripts-edit  x1
  eval-in-loaded-library  x1
  amd-loader-dependency  x1
  harness-feedback-repair-round  x1
  static-analyzer-flags-unguarded-refs  x1
  tool-output-misread-adjacent-reasoning  x1
  analyzer-satisficing-guard-wrap  x1
  static-analysis-no-findings  x1
  sandbox-spawning-hypothesis  x1
  grep-no-match-exit1  x1
  whole-app-inside-eval  x1
  unwrap-script-ran-on-all-js  x1
  false-alarm-tool-error  x1
  failure-diagnosis-loop  x1
  path-rewrite-from-false-belief  x1
  claimed-edit-not-executed  x1
  harness-feedback-repeats-identical  x1
  self-correction-after-phantom-edit  x1
  dummy-service-worker-written  x1
  paperscript-rewrite-port  x1
  eval-neutralize-dummy-function  x1
  script-before-canvas-null-setup  x1
  self-check-read-edited-file  x1
  tab6-left-unconverted  x1
  flagged-pwa-serviceworker-as-background  x1
  cdn-module-urls-persist  x1
  minified-single-line-grep-flood  x1
  background-js-stub-written  x1
  csp-left-unfixed  x1
  csp-fix-after-harness  x1
  signals-flag-dead-file  x1
  converter-unconverted-manifest  x1
  empty-browser-action  x1
  extension-getviews-serviceworker  x1
  live-webrequest-behind-comment-prelude  x1
  background-getviews-rewrite  x1
  duplicate-write-of-same-file  x1
  mystery-state-confusion-loop  x1
  flagged-signals-dismissed-unmigrated  x1
  signals-misclassify-nonblocking-webrequest  x1
  harness-advice-nonexistent-api  x1
  harness-advice-contradicted-kept-anyway  x1
  offscreen-document-port  x1
  manifest-permission-edit  x1
  tool-result-clip-hides-error  x1
  duplicate-edit-repair  x1
  self-check-read-manifest  x1
  storage-state-rewrite  x1
  source-manifest-already-mv3  x1
  reconstruct-missing-file  x1
  remote-script-signals  x1
  bundle-remotely-plan  x1
  duplicate-recordhandler-confusion  x1
  service-worker-rewrite-consequence  x1
  minified-bundle-read-loop  x1
  tool-error-false-alarm  x1
  harness-feedback-round  x1
  mv2-source-edited-not-bundled  x1
  html-not-repointed-to-local-libs  x1
  csp-removed-unprompted  x1
  flags-name-dom-in-bundled-library  x1
  unexamined-popup-directory  x1
  inlined-vendor-bundle-in-worker  x1
  offscreen-document-implementation  x1
  prompt-rule-keeps-manifest-blindspots  x1
  harness-demands-offscreen-for-polyfill  x1
  signals-miss-manifest-issue  x1
  harness-feedback-partially-acted  x1
  polyfill-branch-removal  x1
  overbroad-grep-noise  x1
  harness-duplicate-issue-lines  x1
  spa-hash-path-fix  x1
  hard-flag-no-mv3-replacement  x1
  api-ground-truth-rejected  x1
  manifest-csp-key-removed  x1
  malformed-html-never-verified  x1
  agent-removed-source-files  x1
  unverified-functional-claim  x1
  agent-infers-lost-jquery-context  x1
  full-async-rewrite-by-messaging  x1
  tool-output-misread-adjacent  x1
  harness-behaviour-loss-feedback  x1
  regression-introduced-in-repair  x1
  options-fix-dropped-prefmanager-script  x1
  unaddressed-broken-toolbar  x1
  csp-empty-object-kept  x1
  harness-fix-wrong-api-name  x1
  false-grep-match-window  x1
  prompt-contradicted-by-state  x1
  agent-environment-confusion  x1
  repair-only-harness-listed-item  x1
  flagged-dead-alert  x1
  flagged-line-not-19  x1
  converter-inlined-library-blob  x1
  grep-contradicts-read  x1
  narrow-file-scope-inference  x1
  crosscheck-manifest-disk  x1
  rewrite-judgment-split-port  x1
  untested-regex-parsing  x1
  functions-file-recreated  x1
  edit-args-missing-path  x1
  missing-symbol-chase  x1
  edit-reported-no-change  x1
  flagged-commented-alert  x1
  original-source-discovered  x1
  line-number-confusion  x1
  bash-used-for-read  x1
  edit-commented-code  x1
  deprecated-api-flag-accurate  x1
  self-check-reread-only  x1
  empty-tool-args-read  x1
  edit-exact-match-avoided  x1
  agent-added-permission  x1
  converter-left-stale-manifest-entry  x1
  edit-overlap-rejection  x1
  analysis-trust-no-self-check  x1
  prompt-vs-reality-mismatch  x1
  partial-unwrap-damage  x1
  harness-behaviour-regression-feedback  x1
  silent-noop-script-run  x1
  compaction-summary-contradicts-evidence  x1
  corrupted-eval-wrapper  x1
  corruption-forensics  x1
  script-iteration-loop  x1
  genuine-eval-remaining  x1
  eval-stub-noop  x1
  dangling-closing-token  x1
  legacy-commented-observer  x1
  csp-key-removed-speculatively  x1
  agent-invents-missing-file  x1
  recovery-after-duplicate-edit  x1
  extension-legacy-load-timing  x1
  history-misreading-loop  x1
  speculative-cosmetic-edit  x1
  csp-empty-object-speculation  x1
NON-KEBAB-CASE code names: ['executeScript-api-swap', 'missing-rAF-polyfill-warning']
codings without a quote: 1

========================================================================
CODE FREQUENCIES (1412 codings over 4337 segments)
=====================================
```
