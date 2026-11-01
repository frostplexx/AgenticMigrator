# Axial-coding input matrices

Codings: 1405 · distinct codes: 79 · reports: 83

## 1. Report-level co-occurrence (pairs ≥ 2)
Two codes co-occur when both are applied anywhere in the same report.

- completion-claim-vs-evidence + duplicate-identical-tool-call: 46
- completion-claim-vs-evidence + untested-assumption: 43
- duplicate-identical-tool-call + untested-assumption: 40
- completion-claim-vs-evidence + verification-gap-never-tested: 40
- duplicate-identical-tool-call + verification-gap-never-tested: 39
- completion-claim-vs-evidence + prompt-file-scope-narrowing: 38
- untested-assumption + verification-gap-never-tested: 36
- duplicate-identical-tool-call + prompt-file-scope-narrowing: 34
- prompt-file-scope-narrowing + untested-assumption: 33
- prompt-file-scope-narrowing + verification-gap-never-tested: 31
- completion-claim-vs-evidence + edit-exact-match-failure: 29
- edit-exact-match-failure + untested-assumption: 29
- completion-claim-vs-evidence + harness-load-failure-feedback: 28
- duplicate-identical-tool-call + edit-exact-match-failure: 27
- duplicate-identical-tool-call + harness-load-failure-feedback: 27
- completion-claim-vs-evidence + usage-scoping-check: 24
- edit-exact-match-failure + prompt-file-scope-narrowing: 24
- completion-claim-vs-evidence + half-converted-manifest: 24
- duplicate-identical-tool-call + half-converted-manifest: 24
- duplicate-identical-tool-call + usage-scoping-check: 23
- untested-assumption + usage-scoping-check: 23
- usage-scoping-check + verification-gap-never-tested: 23
- self-check-grep-only + untested-assumption: 22
- signals-omit-broken-surface + untested-assumption: 22
- completion-claim-vs-evidence + considered-then-dropped: 22
- completion-claim-vs-evidence + deprecated-api-swap: 22
- harness-load-failure-feedback + prompt-file-scope-narrowing: 22
- half-converted-manifest + untested-assumption: 22
- edit-exact-match-failure + verification-gap-never-tested: 22
- harness-load-failure-feedback + untested-assumption: 22
- completion-claim-vs-evidence + mid-run-compaction: 21
- completion-claim-vs-evidence + self-check-grep-only: 21
- completion-claim-vs-evidence + signals-omit-broken-surface: 21
- duplicate-identical-tool-call + mid-run-compaction: 21
- considered-then-dropped + verification-gap-never-tested: 21
- deprecated-api-swap + prompt-file-scope-narrowing: 21
- half-converted-manifest + verification-gap-never-tested: 21
- harness-load-failure-feedback + verification-gap-never-tested: 21
- considered-then-dropped + untested-assumption: 21
- duplicate-identical-tool-call + self-check-grep-only: 20
- duplicate-identical-tool-call + signals-omit-broken-surface: 20
- prompt-file-scope-narrowing + usage-scoping-check: 20
- considered-then-dropped + duplicate-identical-tool-call: 20
- considered-then-dropped + prompt-file-scope-narrowing: 20
- deprecated-api-swap + duplicate-identical-tool-call: 20
- background-to-service-worker + completion-claim-vs-evidence: 20
- mid-run-compaction + untested-assumption: 19
- half-converted-manifest + prompt-file-scope-narrowing: 19
- background-to-service-worker + duplicate-identical-tool-call: 19
- completion-claim-vs-evidence + tool-output-misread: 19
- deprecated-api-swap + untested-assumption: 19
- edit-exact-match-failure + mid-run-compaction: 18
- deprecated-api-swap + verification-gap-never-tested: 18
- background-to-service-worker + untested-assumption: 18
- duplicate-identical-tool-call + tool-output-misread: 18
- tool-output-misread + untested-assumption: 18
- edit-exact-match-failure + harness-load-failure-feedback: 18
- converter-state-hypothesis + duplicate-identical-tool-call: 17
- mid-run-compaction + prompt-file-scope-narrowing: 17
- completion-claim-vs-evidence + single-issue-fix-stop: 17

## 2. Report-level co-occurrence matrix (diagonal = # reports with code)

```
| code                                     | completion-claim-vs-evidence | duplicate-identical-tool-call | untested-assumption | verification-gap-never-tested | prompt-file-scope-narrowing | edit-exact-match-failure | harness-load-failure-feedback | usage-scoping-check | half-converted-manifest | considered-then-dropped | deprecated-api-swap | mid-run-compaction | self-check-grep-only | signals-omit-broken-surface | background-to-service-worker | tool-output-misread | stub-instead-of-migration | converter-state-hypothesis | single-issue-fix-stop | converter-left-eval-bundle | converter-left-unsafe-eval-csp | grep-tool-false-match | converter-dropped-shared-files | csp-unsafe-eval-removed | eval-unwrap-script | harness-advice-encourages-naive-copy | analysis-misses-breaker | minified-blob-read-loop | dead-code-flagged | compat-hard-soft-guidance |
|------------------------------------------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|------|
| completion-claim-vs-evidence             |    0 |   46 |   43 |   40 |   38 |   29 |   28 |   24 |   24 |   22 |   22 |   21 |   21 |   21 |   20 |   19 |   16 |   16 |   17 |   17 |   16 |   14 |   14 |   13 |   12 |   12 |   11 |   12 |   11 |   10 |
| duplicate-identical-tool-call            |   46 |    0 |   40 |   39 |   34 |   27 |   27 |   23 |   24 |   20 |   20 |   21 |   20 |   20 |   19 |   18 |   16 |   17 |   15 |   17 |   15 |   13 |   14 |   11 |   12 |   10 |   12 |   12 |    9 |   10 |
| untested-assumption                      |   43 |   40 |    0 |   36 |   33 |   29 |   22 |   23 |   22 |   21 |   19 |   19 |   22 |   22 |   18 |   18 |   16 |   14 |   12 |   16 |   15 |   13 |   12 |   13 |   13 |   12 |   11 |    9 |   10 |    9 |
| verification-gap-never-tested            |   40 |   39 |   36 |    0 |   31 |   22 |   21 |   23 |   21 |   21 |   18 |   15 |   15 |   16 |   16 |   14 |   13 |   13 |   14 |   14 |   13 |   11 |   10 |   11 |    9 |   10 |   11 |   10 |    9 |    8 |
| prompt-file-scope-narrowing              |   38 |   34 |   33 |   31 |    0 |   24 |   22 |   20 |   19 |   20 |   21 |   17 |   15 |   15 |   14 |   15 |   11 |   15 |   14 |    9 |   10 |   12 |   11 |    8 |    7 |   12 |    6 |    7 |   12 |    9 |
| edit-exact-match-failure                 |   29 |   27 |   29 |   22 |   24 |    0 |   18 |   15 |   17 |   16 |   15 |   18 |   14 |   13 |   11 |   15 |   15 |    9 |    8 |   13 |   11 |   10 |    8 |    8 |   10 |    9 |    5 |    7 |    9 |    3 |
| harness-load-failure-feedback            |   28 |   27 |   22 |   21 |   22 |   18 |    0 |   11 |   15 |   11 |   14 |   16 |   14 |    7 |   12 |   12 |   12 |    8 |   14 |   12 |   14 |    9 |   10 |    5 |   11 |   10 |    7 |    8 |    6 |    4 |
| usage-scoping-check                      |   24 |   23 |   23 |   23 |   20 |   15 |   11 |    0 |   15 |   12 |   11 |   10 |   13 |   10 |   13 |    7 |    9 |   10 |    8 |    6 |    7 |    9 |    6 |    5 |    5 |    4 |    7 |    7 |    6 |    4 |
| half-converted-manifest                  |   24 |   24 |   22 |   21 |   19 |   17 |   15 |   15 |    0 |   12 |   13 |   11 |   12 |    7 |   16 |   11 |   11 |    9 |    8 |    9 |    8 |    8 |    8 |    5 |    6 |    7 |    4 |    8 |    5 |    6 |
| considered-then-dropped                  |   22 |   20 |   21 |   21 |   20 |   16 |   11 |   12 |   12 |    0 |   13 |    9 |    7 |    9 |    9 |   10 |    8 |    7 |    8 |    8 |    5 |    5 |    2 |    6 |    5 |    7 |    6 |    2 |    5 |    5 |
| deprecated-api-swap                      |   22 |   20 |   19 |   18 |   21 |   15 |   14 |   11 |   13 |   13 |    0 |   10 |   11 |    9 |   10 |    9 |    8 |    7 |   13 |    7 |    8 |    9 |    6 |    6 |    5 |    7 |    5 |    7 |    6 |    7 |
| mid-run-compaction                       |   21 |   21 |   19 |   15 |   17 |   18 |   16 |   10 |   11 |    9 |   10 |    0 |   13 |    7 |    9 |    8 |   13 |    7 |    7 |   13 |   13 |    8 |    7 |    6 |   11 |    6 |    3 |    8 |    4 |    2 |
| self-check-grep-only                     |   21 |   20 |   22 |   15 |   15 |   14 |   14 |   13 |   12 |    7 |   11 |   13 |    0 |   10 |    9 |    7 |   10 |    6 |    7 |   11 |    9 |    9 |    9 |    4 |   10 |    5 |    5 |    6 |    2 |    4 |
| signals-omit-broken-surface              |   21 |   20 |   22 |   16 |   15 |   13 |    7 |   10 |    7 |    9 |    9 |    7 |   10 |    0 |    4 |    8 |    6 |    9 |    4 |    6 |    4 |    6 |    6 |    9 |    5 |    2 |    4 |    4 |    4 |    5 |
| background-to-service-worker             |   20 |   19 |   18 |   16 |   14 |   11 |   12 |   13 |   16 |    9 |   10 |    9 |    9 |    4 |    0 |   11 |    9 |    4 |    8 |    7 |    7 |    7 |    5 |    5 |    4 |    5 |    6 |    7 |    3 |    5 |
| tool-output-misread                      |   19 |   18 |   18 |   14 |   15 |   15 |   12 |    7 |   11 |   10 |    9 |    8 |    7 |    8 |   11 |    0 |   10 |    5 |    6 |    7 |    8 |    7 |    5 |    6 |    4 |    5 |    4 |    5 |    6 |    2 |
| stub-instead-of-migration                |   16 |   16 |   16 |   13 |   11 |   15 |   12 |    9 |   11 |    8 |    8 |   13 |   10 |    6 |    9 |   10 |    0 |    4 |    4 |   11 |   10 |    6 |    3 |    7 |   10 |    4 |    5 |    5 |    2 |    0 |
| converter-state-hypothesis               |   16 |   17 |   14 |   13 |   15 |    9 |    8 |   10 |    9 |    7 |    7 |    7 |    6 |    9 |    4 |    5 |    4 |    0 |    4 |    5 |    3 |    4 |    7 |    4 |    4 |    3 |    4 |    2 |    5 |    4 |
| single-issue-fix-stop                    |   17 |   15 |   12 |   14 |   14 |    8 |   14 |    8 |    8 |    8 |   13 |    7 |    7 |    4 |    8 |    6 |    4 |    4 |    0 |    4 |    7 |    6 |    5 |    4 |    2 |    5 |    3 |    6 |    3 |    5 |
| converter-left-eval-bundle               |   17 |   17 |   16 |   14 |    9 |   13 |   12 |    6 |    9 |    8 |    7 |   13 |   11 |    6 |    7 |    7 |   11 |    5 |    4 |    0 |   10 |    6 |    4 |    6 |   11 |    5 |    5 |    5 |    1 |    0 |
| converter-left-unsafe-eval-csp           |   16 |   15 |   15 |   13 |   10 |   11 |   14 |    7 |    8 |    5 |    8 |   13 |    9 |    4 |    7 |    8 |   10 |    3 |    7 |   10 |    0 |    8 |    4 |    7 |    9 |    3 |    6 |    7 |    4 |    1 |
| grep-tool-false-match                    |   14 |   13 |   13 |   11 |   12 |   10 |    9 |    9 |    8 |    5 |    9 |    8 |    9 |    6 |    7 |    7 |    6 |    4 |    6 |    6 |    8 |    0 |    6 |    1 |    3 |    3 |    3 |    5 |    4 |    3 |
| converter-dropped-shared-files           |   14 |   14 |   12 |   10 |   11 |    8 |   10 |    6 |    8 |    2 |    6 |    7 |    9 |    6 |    5 |    5 |    3 |    7 |    5 |    4 |    4 |    6 |    0 |    0 |    4 |    6 |    1 |    3 |    3 |    4 |
| csp-unsafe-eval-removed                  |   13 |   11 |   13 |   11 |    8 |    8 |    5 |    5 |    5 |    6 |    6 |    6 |    4 |    9 |    5 |    6 |    7 |    4 |    4 |    6 |    7 |    1 |    0 |    0 |    5 |    2 |    4 |    3 |    3 |    2 |
| eval-unwrap-script                       |   12 |   12 |   13 |    9 |    7 |   10 |   11 |    5 |    6 |    5 |    5 |   11 |   10 |    5 |    4 |    4 |   10 |    4 |    2 |   11 |    9 |    3 |    4 |    5 |    0 |    4 |    4 |    2 |    1 |    0 |
| harness-advice-encourages-naive-copy     |   12 |   10 |   12 |   10 |   12 |    9 |   10 |    4 |    7 |    7 |    7 |    6 |    5 |    2 |    5 |    5 |    4 |    3 |    5 |    5 |    3 |    3 |    6 |    2 |    4 |    0 |    2 |    1 |    4 |    2 |
| analysis-misses-breaker                  |   11 |   12 |   11 |   11 |    6 |    5 |    7 |    7 |    4 |    6 |    5 |    3 |    5 |    4 |    6 |    4 |    5 |    4 |    3 |    5 |    6 |    3 |    1 |    4 |    4 |    2 |    0 |    3 |    0 |    2 |
| minified-blob-read-loop                  |   12 |   12 |    9 |   10 |    7 |    7 |    8 |    7 |    8 |    2 |    7 |    8 |    6 |    4 |    7 |    5 |    5 |    2 |    6 |    5 |    7 |    5 |    3 |    3 |    2 |    1 |    3 |    0 |    2 |    2 |
| dead-code-flagged                        |   11 |    9 |   10 |    9 |   12 |    9 |    6 |    6 |    5 |    5 |    6 |    4 |    2 |    4 |    3 |    6 |    2 |    5 |    3 |    1 |    4 |    4 |    3 |    3 |    1 |    4 |    0 |    2 |    0 |    2 |
| compat-hard-soft-guidance                |   10 |   10 |    9 |    8 |    9 |    3 |    4 |    4 |    6 |    5 |    7 |    2 |    4 |    5 |    5 |    2 |    0 |    4 |    5 |    0 |    1 |    3 |    4 |    2 |    0 |    2 |    2 |    2 |    2 |    0 |
```

## 3. Segment-level co-occurrence (pairs on the same entry, n≥2)

- completion-claim-vs-evidence + verification-gap-never-tested: 21
- prompt-file-scope-narrowing + signals-omit-broken-surface: 9
- compat-hard-soft-guidance + prompt-file-scope-narrowing: 7
- dead-code-flagged + prompt-file-scope-narrowing: 7
- harness-advice-encourages-naive-copy + harness-load-failure-feedback: 7
- flagged-unused-vendor-eval + prompt-file-scope-narrowing: 6
- harness-load-failure-feedback + verification-gap-never-tested: 6
- completion-claim-vs-evidence + untested-assumption: 6
- completion-claim-vs-evidence + considered-then-dropped: 5
- single-issue-fix-stop + verification-gap-never-tested: 5
- considered-then-dropped + untested-assumption: 5
- compat-hard-soft-guidance + signals-omit-broken-surface: 5
- converter-dropped-shared-files + harness-load-failure-feedback: 5
- analysis-misses-breaker + prompt-file-scope-narrowing: 4
- self-check-grep-only + verification-gap-never-tested: 4
- untested-assumption + verification-gap-never-tested: 4
- completion-claim-vs-evidence + prompt-file-scope-narrowing: 4
- completion-claim-vs-evidence + single-issue-fix-stop: 4
- converter-dropped-shared-files + harness-advice-encourages-naive-copy: 4
- flagged-unused-vendor-eval + signals-omit-broken-surface: 3
- converter-left-eval-bundle + prompt-file-scope-narrowing: 3
- completion-claim-vs-evidence + no-self-verification-rule: 3
- untested-assumption + usage-scoping-check: 3
- dead-code-flagged + signals-omit-broken-surface: 3
- harness-feedback-round + verification-gap-never-tested: 3
- flagged-file-not-in-use-chain + prompt-file-scope-narrowing: 3
- csp-remote-origins-kept + half-converted-manifest: 3
- prompt-file-scope-narrowing + verification-gap-never-tested: 3
- analysis-misses-breaker + compat-hard-soft-guidance: 2
- analysis-misses-breaker + flagged-unused-vendor-eval: 2
- run-ends-after-abstain + verification-gap-never-tested: 2
- analysis-misses-breaker + converter-left-eval-bundle: 2
- harness-feedback-round + harness-load-failure-feedback: 2
- single-issue-fix-stop + untested-assumption: 2
- analysis-misses-breaker + signals-omit-broken-surface: 2
- completion-claim-vs-evidence + self-check-grep-only: 2
- completion-claim-vs-evidence + run-ends-no-harness-feedback: 2
- considered-then-dropped + no-self-verification-rule: 2
- considered-then-dropped + usage-scoping-check: 2
- considered-then-dropped + verification-gap-never-tested: 2
- no-self-verification-rule + untested-assumption: 2
- no-self-verification-rule + verification-gap-never-tested: 2
- run-ends-no-harness-feedback + untested-assumption: 2
- run-ends-no-harness-feedback + verification-gap-never-tested: 2
- prompt-file-scope-narrowing + untested-assumption: 2
- compat-hard-soft-guidance + dead-code-flagged: 2
- csp-remote-origins-kept + harness-load-failure-feedback: 2
- harness-load-failure-feedback + service-worker-dom-dependency: 2
- harness-advice-encourages-naive-copy + harness-feedback-round: 2
- converter-left-eval-bundle + signals-miss-second-file: 2
- prompt-file-scope-narrowing + signals-miss-second-file: 2
- converter-dropped-shared-files + converter-left-unsafe-eval-csp: 2
- converter-left-eval-bundle + converter-left-unsafe-eval-csp: 2
- converter-left-unsafe-eval-csp + harness-load-failure-feedback: 2
- agent-edit-corruption + harness-load-failure-feedback: 2
- harness-feedback-repetition + harness-load-failure-feedback: 2
- behaviour-loss-feedback + verification-gap-never-tested: 2
- harness-load-failure-feedback + single-issue-fix-stop: 2
- converter-left-unsafe-eval-csp + half-converted-manifest: 2
- harness-advice-encourages-naive-copy + prompt-file-scope-narrowing: 2

## 4. Code × verdict (report counts)

```
| code                                     | not_working |
|------------------------------------------|------|
| abstain-file-missing                     |    2 |
| abstain-file-written                     |    3 |
| abstain-weak-constraint                  |    2 |
| agent-edit-corruption                    |   10 |
| agent-surfaces-beyond-fix-list           |    1 |
| analysis-misses-breaker                  |   12 |
| background-to-service-worker             |   21 |
| bash-quoting-error                       |    3 |
| behaviour-loss-feedback                  |    4 |
| case-mismatch-reference                  |    1 |
| compat-hard-soft-guidance                |   11 |
| completion-claim-vs-evidence             |   50 |
| considered-then-dropped                  |   24 |
| converter-dropped-shared-files           |   14 |
| converter-inlined-jquery-blob            |    6 |
| converter-left-eval-bundle               |   17 |
| converter-left-unsafe-eval-csp           |   17 |
| converter-state-hypothesis               |   17 |
| crosscheck-manifest-disk-skipped         |    8 |
| csp-remote-origins-kept                  |    7 |
| csp-unsafe-eval-removed                  |   14 |
| dangling-manifest-reference              |    6 |
| dead-code-flagged                        |   12 |
| deprecated-api-swap                      |   23 |
| duplicate-identical-tool-call            |   47 |
| edit-dead-code-only                      |    7 |
| edit-exact-match-failure                 |   31 |
| edit-uniqueness-failure                  |    6 |
| empty-background-key-dropped             |    1 |
| empty-background-page                    |    2 |
| error-page-download-detected             |    1 |
| eval-unwrap-partial                      |    7 |
| eval-unwrap-script                       |   13 |
| flagged-file-not-in-use-chain            |    8 |
| flagged-unused-vendor-eval               |   10 |
| grep-false-negative-minified             |    9 |
| grep-tool-false-match                    |   15 |
| half-converted-manifest                  |   26 |
| harness-advice-encourages-naive-copy     |   13 |
| harness-feedback-repetition              |    7 |
| harness-feedback-round                   |   10 |
| harness-load-failure-feedback            |   28 |
| html-import-dependency                   |    2 |
| invalid-permission-unflagged             |    4 |
| legacy-artifact-unflagged                |    5 |
| manifest-permission-edit                 |    7 |
| mid-run-compaction                       |   22 |
| minified-blob-read-loop                  |   12 |
| minified-bundle-sed-replace              |    6 |
| mv2-original-copied-unmigrated           |    9 |
| mv2-source-restore                       |    7 |
| no-self-verification-rule                |    5 |
| oversized-line-read-block                |    8 |
| popup-path-fix                           |    2 |
| prompt-file-scope-narrowing              |   39 |
| prompt-output-mismatch                   |    3 |
| provider-error-terminated                |    1 |
| remote-code-dependency                   |    7 |
| replace-errors-mask                      |    1 |
| rewrite-judgment-blocks-port             |   10 |
| run-ends-after-abstain                   |    2 |
| run-ends-no-harness-feedback             |    2 |
| script-unicode-mangling                  |    1 |
| self-check-grep-only                     |   22 |
| self-check-misses-api                    |    5 |
| service-worker-dom-dependency            |   11 |
| service-worker-rewrite                   |    7 |
| signals-miss-second-file                 |    9 |
| signals-omit-broken-surface              |   22 |
| single-issue-fix-stop                    |   17 |
| stub-instead-of-migration                |   18 |
| tool-error-flag                          |   10 |
| tool-output-misread                      |   19 |
| untested-assumption                      |   46 |
| unvalidated-script-output                |    9 |
| usage-scoping-check                      |   27 |
| validator-string-literal-false-positive  |    7 |
| vendor-eval-guarded                      |    2 |
| verification-gap-never-tested            |   42 |
```

## 5. Category rollup

- **agent-action** (507 mentions): abstain-file-missing, abstain-file-written, agent-edit-corruption, agent-surfaces-beyond-fix-list, background-to-service-worker, bash-quoting-error, csp-remote-origins-kept, csp-unsafe-eval-removed, deprecated-api-swap, duplicate-identical-tool-call, edit-dead-code-only, edit-exact-match-failure, edit-uniqueness-failure, empty-background-key-dropped, eval-unwrap-partial, eval-unwrap-script, manifest-permission-edit, minified-blob-read-loop, minified-bundle-sed-replace, mv2-original-copied-unmigrated, mv2-source-restore, popup-path-fix, replace-errors-mask, script-unicode-mangling, service-worker-rewrite, stub-instead-of-migration
- **agent-reasoning** (273 mentions): abstain-weak-constraint, completion-claim-vs-evidence, considered-then-dropped, converter-state-hypothesis, crosscheck-manifest-disk-skipped, error-page-download-detected, rewrite-judgment-blocks-port, tool-output-misread, untested-assumption, usage-scoping-check
- **harness-signal** (177 mentions): analysis-misses-breaker, behaviour-loss-feedback, compat-hard-soft-guidance, dead-code-flagged, flagged-file-not-in-use-chain, flagged-unused-vendor-eval, harness-advice-encourages-naive-copy, harness-feedback-repetition, harness-feedback-round, harness-load-failure-feedback, signals-miss-second-file, signals-omit-broken-surface, validator-string-literal-false-positive
- **run-dynamics** (164 mentions): mid-run-compaction, no-self-verification-rule, run-ends-after-abstain, run-ends-no-harness-feedback, self-check-grep-only, self-check-misses-api, unvalidated-script-output, verification-gap-never-tested
- **converter-output** (111 mentions): case-mismatch-reference, converter-dropped-shared-files, converter-inlined-jquery-blob, converter-left-eval-bundle, converter-left-unsafe-eval-csp, dangling-manifest-reference, half-converted-manifest, invalid-permission-unflagged
- **prompt-constraint** (68 mentions): prompt-file-scope-narrowing, prompt-output-mismatch, single-issue-fix-stop
- **environment-tool** (57 mentions): grep-false-negative-minified, grep-tool-false-match, oversized-line-read-block, provider-error-terminated, tool-error-flag
- **extension-legacy** (48 mentions): empty-background-page, html-import-dependency, legacy-artifact-unflagged, remote-code-dependency, service-worker-dom-dependency, vendor-eval-guarded

## 6. Code × segment flag (acts on flagged segments)

```
| code                                     | compaction | provider-error | tool-error-flag |
|------------------------------------------|------|------|------|
| agent-edit-corruption                    |    0 |    0 |    7 |
| bash-quoting-error                       |    0 |    0 |    5 |
| converter-dropped-shared-files           |    0 |    0 |    1 |
| dangling-manifest-reference              |    0 |    0 |    3 |
| duplicate-identical-tool-call            |    0 |    0 |    7 |
| edit-exact-match-failure                 |    0 |    0 |   56 |
| edit-uniqueness-failure                  |    0 |    0 |    8 |
| eval-unwrap-partial                      |    0 |    0 |    3 |
| eval-unwrap-script                       |    0 |    0 |    2 |
| grep-false-negative-minified             |    0 |    0 |    1 |
| grep-tool-false-match                    |    0 |    0 |    2 |
| mid-run-compaction                       |   51 |    0 |    0 |
| minified-blob-read-loop                  |    1 |    0 |    0 |
| mv2-source-restore                       |    0 |    0 |    1 |
| provider-error-terminated                |    0 |    3 |    0 |
| script-unicode-mangling                  |    0 |    0 |    1 |
| tool-error-flag                          |    0 |    0 |   10 |
```
