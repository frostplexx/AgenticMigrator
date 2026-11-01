# Appendix — Distribution of changes across the necessary MV3 migrations

Corpus: **500 Chrome extensions** migrated MV2→MV3 by one pipeline run (converter + LLM agent, model `saia/gemma-4-31b-it-fp8-256k`), then installed and verified in Chrome.

Every change is attributed through one of four measurement channels, each lossless at its source:

1. **pipeline ledger** (`runs.tail` in migrator.db): the run's own final log lines, copied verbatim — exact per-migration skip reasons, spurious and repair events;
2. **transcript replay**: the agent's read/edit/write calls replayed over the extension's files — applied changes and final manifest state, with file-level evidence;
3. **verification report**: surfaces exposed and the verdict after install-and-test;
4. **two-sided call-site scan**: MV2-only API forms counted in the MV2 source (`needed`) and in the migrated output (`residual`); `converted = needed − residual`.

A migration counts as *needed* for an extension when the task-build's static analysis flagged it (`neededSignals`) or the call-site scan found `needed > 0`; for the manifest-mechanical migrations the final state is the observation, since the converter applies them before the transcript begins.

## Necessary migrations

| tier | migration | observed via |
|---|---|---|
| trivial | manifest_version bumped to 3 | final-state scan + ledger |
| trivial | background page/scripts → service worker | final-state scan + ledger |
| trivial | background.persistent removed | final-state scan + ledger |
| trivial | browser_action/page_action → action | final-state scan + ledger |
| trivial | URL permissions → host_permissions | final-state scan + ledger |
| non-trivial | blocking webRequest → declarativeNetRequest | ledger + transcript + static signal |
| non-trivial | blocking header rewrite → declarativeNetRequest modifyHeaders | ledger + transcript + static signal |
| non-trivial | response body / blocking auth handling | ledger + transcript + static signal |
| non-trivial | DOM use in background → offscreen document | ledger + transcript + static signal |
| semi-trivial | tabs.executeScript → scripting.executeScript | ledger + call-site scan |
| non-trivial | remotely hosted code removed or bundled | ledger + transcript + static signal |
| trivial | web_accessible_resources → MV3 object form | final-state scan + ledger |
| trivial | content_security_policy → object form | final-state scan + ledger |
| trivial | _execute_browser_action → _execute_action | final-state scan + ledger |
| non-trivial | global variables in background → chrome.storage | ledger + transcript + static signal |
| non-trivial | string evaluation (eval / new Function) removed | ledger + transcript + static signal |
| semi-trivial | `chrome.extension.*` → `chrome.runtime.*` | call-site scan |
| semi-trivial | MV2-only `chrome.tabs.*` forms → `chrome.tabs.query` / `chrome.tabs.onActivated` | call-site scan |
| semi-trivial | `chrome.browserAction.*` → `chrome.action.*` (JS level) | call-site scan |
| semi-trivial | `chrome.pageAction.*` → `chrome.action.*` (JS level) | call-site scan |
| semi-trivial | `chrome.runtime.onSuspend` removed | call-site scan |

## Distribution per migration

Verdicts after install-and-test, % within the extension set marked by the migration. `needed` is the number of extensions the migration applied to; `skipped` is needed-but-not-applied, with the pipeline's own reason.

### trivial

- **manifest_version bumped to 3**
  - needed/applied/skipped/spurious: 411 / 411 / 0 / 0
  - verdicts: 169 (41%) | 150 (36%) | 49 (12%) | 43 (10%) | **411**
- **background page/scripts → service worker**
  - needed/applied/skipped/spurious: 266 / 261 / 5 / 10 (skips: unexplained 5)
  - verdicts: 99 (37%) | 86 (32%) | 44 (17%) | 37 (14%) | **266**
  - verdicts when skipped: 4 (80%) | 0 (0%) | 1 (20%) | 0 (0%) | **5**
- **background.persistent removed** — never needed in this corpus.
- **browser_action/page_action → action**
  - needed/applied/skipped/spurious: 289 / 289 / 0 / 3
  - verdicts: 127 (44%) | 74 (26%) | 47 (16%) | 41 (14%) | **289**
- **URL permissions → host_permissions**
  - needed/applied/skipped/spurious: 192 / 188 / 3 / 23 (skips: unexplained 3)
  - verdicts: 68 (35%) | 62 (32%) | 31 (16%) | 31 (16%) | **192**
  - verdicts when skipped: 0 (0%) | 1 (33%) | 2 (67%) | 0 (0%) | **3**
- **web_accessible_resources → MV3 object form**
  - needed/applied/skipped/spurious: 92 / 92 / 0 / 2
  - verdicts: 24 (26%) | 34 (37%) | 20 (22%) | 14 (15%) | **92**
- **content_security_policy → object form**
  - needed/applied/skipped/spurious: 254 / 254 / 0 / 0
  - verdicts: 93 (37%) | 82 (32%) | 41 (16%) | 38 (15%) | **254**
- **_execute_browser_action → _execute_action**
  - needed/applied/skipped/spurious: 7 / 0 / 7 / 0 (skips: unexplained 7)
  - verdicts: 4 (57%) | 3 (43%) | 0 (0%) | 0 (0%) | **7**
  - verdicts when skipped: 4 (57%) | 3 (43%) | 0 (0%) | 0 (0%) | **7**

### semi-trivial

- **tabs.executeScript → scripting.executeScript**
  - needed/applied/skipped/spurious: 58 / 50 / 8 / 0 (skips: unexplained 8)
  - verdicts: 20 (34%) | 20 (34%) | 9 (16%) | 9 (16%) | **58**
  - verdicts when skipped: 2 (25%) | 2 (25%) | 1 (13%) | 3 (38%) | **8**
- **`chrome.extension.*` → `chrome.runtime.*`** — 711 call sites needed in 124 extensions; 664 converted, 47 residual (100 extensions fully converted, 24 partial)
  - verdicts: 43 (35%) | 34 (27%) | 22 (18%) | 25 (20%) | **124**
- **MV2-only `chrome.tabs.*` forms → `chrome.tabs.query` / `chrome.tabs.onActivated`** — 79 call sites needed in 34 extensions; 77 converted, 2 residual (32 extensions fully converted, 2 partial)
  - verdicts: 13 (38%) | 10 (29%) | 3 (9%) | 8 (24%) | **34**
- **`chrome.browserAction.*` → `chrome.action.*` (JS level)** — 292 call sites needed in 99 extensions; 276 converted, 16 residual (91 extensions fully converted, 8 partial)
  - verdicts: 46 (46%) | 18 (18%) | 19 (19%) | 16 (16%) | **99**
- **`chrome.pageAction.*` → `chrome.action.*` (JS level)** — 62 call sites needed in 27 extensions; 60 converted, 2 residual (25 extensions fully converted, 2 partial)
  - verdicts: 10 (37%) | 7 (26%) | 5 (19%) | 5 (19%) | **27**
- **`chrome.runtime.onSuspend` removed** — 1 call sites needed in 1 extensions; 0 converted, 1 residual (0 extensions fully converted, 1 partial)
  - verdicts: 0 (0%) | 1 (100%) | 0 (0%) | 0 (0%) | **1**

### non-trivial

- **blocking webRequest → declarativeNetRequest**
  - needed/applied/skipped/spurious: 21 / 16 / 7 / 1 (skips: limited 3, abstained 4)
  - verdicts: 5 (24%) | 9 (43%) | 2 (10%) | 5 (24%) | **21**
  - verdicts when skipped: 1 (14%) | 5 (71%) | 0 (0%) | 1 (14%) | **7**
- **blocking header rewrite → declarativeNetRequest modifyHeaders**
  - needed/applied/skipped/spurious: 6 / 0 / 5 / 1 (skips: limited 2, abstained 3)
  - verdicts: 1 (17%) | 5 (83%) | 0 (0%) | 0 (0%) | **6**
  - verdicts when skipped: 1 (20%) | 4 (80%) | 0 (0%) | 0 (0%) | **5**
- **response body / blocking auth handling** — never needed in this corpus.
- **DOM use in background → offscreen document**
  - needed/applied/skipped/spurious: 90 / 35 / 55 / 19 (skips: unexplained 55)
  - verdicts: 31 (34%) | 26 (29%) | 14 (16%) | 19 (21%) | **90**
  - verdicts when skipped: 19 (35%) | 17 (31%) | 9 (16%) | 10 (18%) | **55**
- **remotely hosted code removed or bundled**
  - needed/applied/skipped/spurious: 34 / 0 / 34 / 0 (skips: platform 34)
  - verdicts: 10 (29%) | 8 (24%) | 8 (24%) | 8 (24%) | **34**
  - verdicts when skipped: 10 (29%) | 8 (24%) | 8 (24%) | 8 (24%) | **34**
- **global variables in background → chrome.storage**
  - needed/applied/skipped/spurious: 100 / 0 / 50 / 50 (skips: unexplained 50)
  - verdicts: 39 (39%) | 34 (34%) | 11 (11%) | 16 (16%) | **100**
  - verdicts when skipped: 16 (32%) | 22 (44%) | 6 (12%) | 6 (12%) | **50**
- **string evaluation (eval / new Function) removed**
  - needed/applied/skipped/spurious: 133 / 41 / 118 / 0 (skips: unexplained 115, abstained 3)
  - verdicts: 42 (32%) | 28 (21%) | 36 (27%) | 27 (20%) | **133**
  - verdicts when skipped: 39 (33%) | 23 (19%) | 31 (26%) | 25 (21%) | **118**

## Per-extension detail

One row per extension. `applied` lists applied migrations (state = converter-applied manifest form, change = agent-attributable); `skipped` carries the pipeline's reason; API conversion cells are `converted/needed` call sites.

| extension | verdict | label | applied (state) | applied (change) | skipped | spurious | repairs | extension | tabs | browser_action | page_action | runtime |
|---|---|---|---|---|---|---|---|---|---|---|---|---
| `abnlpgnoijoa…` | partially_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | offscreen_document | remote_code_removed (platform), eval_removed | offscreen_document | 0 | 1/1 | — | — | — | — |
| `acdglffpgono…` | not_working | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `adffhnigbmem…` | working | HARNESS_FAILURE | manifest_version, action_rename, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `adhdbclaplni…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | webrequest_to_dnr, execute_script_api | offscreen_document, storage_over_dom_state, agent_abstained (abstained) | — | 5 | 2/2 | — | — | 0/1 | — |
| `adllocmhjlia…` | working | — | manifest_version, background_service_worker | — | — | — | 0 | 1/1 | — | — | 1/1 | — |
| `admkahgcbipg…` | not_testable | HARNESS_FAILURE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | storage_over_dom_state | — | 2 | — | — | — | — | — |
| `adnjlnpdndic…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | — | — | 6 | 2/5 | — | — | — | — |
| `aedcegbncjgd…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | webrequest_to_dnr, eval_removed | offscreen_document, execute_script_api | storage_over_dom_state | 4 | 6/6 | 1/1 | — | — | — |
| `afaaijiijklf…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `afakeafhcjjg…` | working | HARNESS_FAILURE | manifest_version, action_rename | — | — | action_rename | 0 | — | — | — | — | — |
| `afijdkapacbn…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, csp_object_form | execute_script_api, offscreen_document | eval_removed | — | 0 | 7/7 | — | — | — | — |
| `ahepglganllf…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `aianghkolnph…` | working | INVALID_INSTANCE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `ajajocakkdfl…` | not_testable | — | manifest_version, action_rename, host_permissions_split, csp_object_form | webrequest_to_dnr | — | — | 3 | — | — | — | — | — |
| `ajiemnfobhbj…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | eval_removed | — | 2 | — | — | — | — | — |
| `ajkhhbbojkdg…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | offscreen_document | — | — | 3 | 4/4 | — | 1/1 | — | — |
| `ajnennolgjba…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | — | — | 0 | — | — | — | — | — |
| `akghknjchdho…` | not_testable | HARNESS_FAILURE | manifest_version, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `aklfgleddjhn…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | — | storage_over_dom_state | 0 | 2/2 | 1/1 | 1/1 | — | — |
| `alhljceidfdm…` | not_testable | — | manifest_version, background_service_worker, csp_object_form | — | storage_over_dom_state | — | 0 | — | — | — | — | — |
| `amlffnkkdaed…` | working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | execute_script_api | — | 0 | — | — | — | 1/1 | — |
| `andbigojninb…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `annmmkpobpkm…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | — | — | 0 | — | — | 1/1 | — | — |
| `aoihghfnnhci…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `baakjfhbggcm…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `bafajkcbalfk…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | webrequest_to_dnr, execute_script_api | eval_removed | — | 0 | 5/9 | — | 4/11 | — | — |
| `bamekgeijlhg…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `banegighfdca…` | working | HARNESS_FAILURE | manifest_version, host_permissions_split, csp_object_form | — | — | host_permissions_split | 0 | — | — | — | — | — |
| `baobkpiejapn…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | offscreen_document | — | offscreen_document, storage_over_dom_state | 0 | — | — | — | — | — |
| `baoehcinncaf…` | working | — | manifest_version, background_service_worker | — | eval_removed | — | 0 | 2/2 | — | — | 1/1 | — |
| `bbngmchfigni…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `bbofkffmfiam…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | eval_removed | — | 2 | — | — | — | — | — |
| `bccdohmacgki…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | execute_script_api, offscreen_document | eval_removed | — | 3 | — | — | 5/5 | — | — |
| `beaepapjkhdc…` | working | — | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `bedodokiampc…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | — | — | 4 | 1/1 | — | 4/4 | — | — |
| `beknlgommgoa…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | eval_removed | — | 0 | 0/5 | — | 0/1 | — | — |
| `bennjncpdnag…` | working | HARNESS_FAILURE | — | eval_removed | — | — | 0 | 6/6 | — | — | — | — |
| `bfbljmnkhmlj…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `bfmfbnlagkdf…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document | — | 2 | 0/1 | — | 3/3 | — | — |
| `bgcajjlghcba…` | working | — | manifest_version, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `bggjpabhffcb…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | — | storage_over_dom_state | — | 0 | — | — | — | — | — |
| `bhbokemlpmdl…` | partially_working | — | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `bhichmmmceom…` | partially_working | — | manifest_version, action_rename, web_accessible_resources_v3, csp_object_form | — | remote_code_removed (platform), eval_removed | — | 0 | 1/1 | — | — | — | — |
| `bhjpefidnkhm…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `bjopjmdidokj…` | not_testable | INVALID_INSTANCE | manifest_version, action_rename, host_permissions_split | — | — | — | 0 | — | — | — | — | — |
| `bkpdohcllhca…` | not_testable | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3 | — | — | — | 0 | 1/1 | — | — | — | — |
| `blaghicfklak…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | webrequest_to_dnr (limited), webrequest_header_modification (limited), storage_over_dom_state | — | 3 | 3/3 | — | — | — | — |
| `bleldoiccieh…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | execute_script_api | remote_code_removed (platform) | — | 1 | — | — | — | — | — |
| `blhmbnpjfldj…` | not_working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | offscreen_document, eval_removed | — | 5 | — | — | 1/1 | — | — |
| `blndcbbnjekm…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split | — | — | — | 0 | — | — | — | — | — |
| `bndfdncjampi…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `boaeobjcahic…` | working | INVALID_INSTANCE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `boekfjjlekaf…` | not_testable | HARNESS_FAILURE | manifest_version, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `bpikjpiahcgh…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3 | — | offscreen_document | — | 2 | — | 0/1 | — | 1/1 | — |
| `caccbdlmcdnn…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, csp_object_form | — | offscreen_document | storage_over_dom_state | 0 | 2/2 | — | — | — | — |
| `cbdadgfefpga…` | not_working | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | — | eval_removed | — | 2 | 0/5 | — | 2/5 | — | — |
| `cbhgkjdeinac…` | not_testable | — | manifest_version, background_service_worker, action_rename | — | — | — | 0 | — | — | — | — | — |
| `cboiihjkpogl…` | working | — | — | — | remote_code_removed (platform), eval_removed, agent_abstained (abstained) | — | 0 | — | — | — | — | — |
| `ccboopnefeai…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | execute_script_api | — | host_permissions_split, storage_over_dom_state | 0 | 1/1 | 1/1 | — | — | — |
| `ccfjahpenjnb…` | not_testable | INVALID_INSTANCE | — | — | — | — | 0 | — | — | — | — | — |
| `ccnkhcmepilm…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | eval_removed | execute_script_api, eval_removed | host_permissions_split | 2 | — | — | — | — | — |
| `ccocombhhhap…` | not_testable | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | — | — | 0 | — | 1/1 | — | — | — |
| `cdaiopnpmkfo…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | webrequest_to_dnr | webrequest_to_dnr (abstained), webrequest_header_modification (abstained), agent_abstained (abstained) | — | 6 | 2/2 | — | 1/1 | — | — |
| `cdcmkgmpkgcp…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, csp_object_form | execute_script_api | offscreen_document | — | 0 | — | — | — | — | — |
| `cdmadbfkfhdf…` | working | — | — | — | — | — | 0 | — | — | — | — | — |
| `cfodmpfppkdl…` | not_working | — | — | — | eval_removed | — | 3 | 2/2 | — | — | — | — |
| `cgjhiddkdoog…` | working | — | manifest_version, action_rename | — | eval_removed | — | 0 | — | — | — | — | — |
| `cgnpnjmjklfc…` | not_working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | — | — | 3 | — | — | — | — | — |
| `cgpopilahkka…` | not_working | INVALID_INSTANCE | manifest_version, action_rename, host_permissions_split, csp_object_form | — | — | host_permissions_split | 0 | — | — | — | — | — |
| `chlmccdddeko…` | working | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | offscreen_document | remote_code_removed (platform), eval_removed | — | 0 | 108/108 | — | — | — | — |
| `ciodheinffec…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `cjfcggncifmb…` | working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | eval_removed | — | 0 | 8/8 | — | 1/1 | — | — |
| `cjkdhmpngnpb…` | partially_working | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | — | eval_removed (abstained), agent_abstained (abstained) | storage_over_dom_state | 2 | — | — | — | — | — |
| `ckgfpdpkcneg…` | working | — | manifest_version, background_service_worker, csp_object_form | — | offscreen_document | — | 0 | 1/1 | — | — | — | — |
| `ckhljhdocmhk…` | working | INVALID_INSTANCE | manifest_version, action_rename, host_permissions_split | — | — | — | 0 | — | — | — | — | — |
| `cmpnokappeag…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `cnhkghcbdppf…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `coaeeoeibgkg…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | webrequest_to_dnr | webrequest_header_modification (limited), offscreen_document, remote_code_removed (platform), eval_removed | — | 2 | — | — | — | — | — |
| `coamhmbkfikj…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `cocpfkobggjb…` | not_working | INVALID_INSTANCE | manifest_version, action_rename | — | — | — | 0 | — | 1/1 | — | — | — |
| `cpddacmhomhm…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, csp_object_form | execute_script_api | — | — | 2 | — | — | — | — | — |
| `dafeagfjbepc…` | not_testable | HARNESS_FAILURE | — | — | agent_abstained (abstained) | — | 0 | — | — | — | — | — |
| `damliljmlfom…` | working | — | manifest_version, action_rename, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `dcbilkcifcfh…` | working | HARNESS_FAILURE | manifest_version, background_service_worker, action_rename, csp_object_form | — | commands_execute_action, eval_removed | storage_over_dom_state | 2 | 2/2 | — | — | — | — |
| `dckeccolfaoo…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, web_accessible_resources_v3 | — | storage_over_dom_state | — | 0 | — | — | — | — | — |
| `ddkhocdgafdh…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker | — | — | — | 0 | 1/1 | — | — | 1/1 | — |
| `decefkmlddoh…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `dedcmfbnakeh…` | partially_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | — | — | 0 | 1/1 | — | 1/1 | — | — |
| `dedlkenbgjlk…` | not_testable | HARNESS_FAILURE | manifest_version, host_permissions_split, web_accessible_resources_v3, csp_object_form | eval_removed | — | — | 0 | 1/1 | — | — | — | — |
| `dekdaonldakg…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `dfabnoahjnbk…` | not_working | HARNESS_FAILURE | manifest_version, action_rename, csp_object_form | eval_removed | — | — | 0 | — | — | — | — | — |
| `dfcbllpmkfdl…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `dfcpillpkonf…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `dfgnmnhpepng…` | working | — | — | — | — | — | 0 | — | — | — | — | — |
| `dfgplcpanfdn…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `dfinmoanpfep…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | — | — | 0 | — | — | 1/1 | — | — |
| `dfjikpibamfd…` | partially_working | — | manifest_version, background_service_worker, web_accessible_resources_v3, csp_object_form | eval_removed | remote_code_removed (platform), storage_over_dom_state, eval_removed | — | 0 | 6/6 | — | — | — | — |
| `dglcceamkcjl…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `dhenabeepcbh…` | working | — | manifest_version, action_rename | — | background_service_worker, storage_over_dom_state | — | 0 | — | — | — | — | — |
| `diggamfbkfkk…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | remote_code_removed (platform), eval_removed | — | 2 | 2/2 | 2/2 | — | — | — |
| `djigkpimlnkm…` | not_testable | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | execute_script_api | — | — | 0 | 5/5 | — | — | — | — |
| `dkfmdjgeddba…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `dkheaplknmpl…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | webrequest_to_dnr, offscreen_document, eval_removed | eval_removed | webrequest_header_modification, offscreen_document | 3 | 24/25 | — | — | 6/6 | — |
| `dkhleleeagmd…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | offscreen_document | — | offscreen_document | 3 | 4/4 | — | — | — | — |
| `dldageaefkkp…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `dlgjlpalfblo…` | working | — | manifest_version, background_service_worker, action_rename | — | — | storage_over_dom_state | 2 | — | — | 1/1 | — | — |
| `dllkogdmbanl…` | working | — | manifest_version, action_rename, host_permissions_split | — | execute_script_api | — | 0 | — | — | — | — | — |
| `dmpcdfoaekmm…` | partially_working | — | manifest_version, background_service_worker, action_rename, csp_object_form | offscreen_document | eval_removed | offscreen_document | 3 | — | — | 1/1 | — | — |
| `doakbobgenag…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document | — | 2 | — | — | 2/2 | — | — |
| `dpdgihjlickj…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `dphbcfdndilk…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3 | — | eval_removed | — | 0 | — | — | — | — | — |
| `dpnlficaljgo…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename | — | — | — | 0 | — | — | — | 1/1 | — |
| `eaaoedpoomkj…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `eapcahpeapnk…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `eapmdkoepipn…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | offscreen_document | — | host_permissions_split, offscreen_document | 4 | — | — | — | — | — |
| `ebmgagejcifb…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document | — | 2 | 6/6 | 1/1 | 7/7 | 6/6 | — |
| `ecfghdaebifh…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `ecogijbkokfn…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `edcmdkajjaph…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, csp_object_form | eval_removed | eval_removed | — | 4 | — | — | — | — | — |
| `ededhhcknlpo…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | eval_removed, execute_script_api | eval_removed | — | 3 | 1/1 | — | 1/1 | — | — |
| `edfdgimilfib…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `edfflpconbnj…` | working | — | manifest_version, web_accessible_resources_v3 | — | — | — | 0 | 1/1 | — | — | — | — |
| `eejhdkkihlma…` | not_testable | — | manifest_version, background_service_worker, action_rename | — | eval_removed | — | 0 | — | — | — | — | 0/1 |
| `eendnbabcpbj…` | not_testable | — | manifest_version, background_service_worker, action_rename | — | — | — | 2 | — | — | — | 1/1 | — |
| `eeoeakefoojb…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | execute_script_api, eval_removed | webrequest_to_dnr (limited), offscreen_document, remote_code_removed (platform), eval_removed | — | 2 | 16/19 | — | 12/12 | — | — |
| `efifejldhjga…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | — | — | 2 | 1/1 | — | — | — | — |
| `efknekcleepp…` | working | INVALID_INSTANCE | manifest_version, action_rename, host_permissions_split, csp_object_form | — | background_service_worker | host_permissions_split | 0 | — | — | — | — | — |
| `egehmnkakhfb…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker | — | — | — | 0 | — | — | — | — | — |
| `ehbnlikfgamp…` | not_testable | HARNESS_FAILURE | manifest_version, host_permissions_split, web_accessible_resources_v3 | — | — | host_permissions_split, web_accessible_resources_v3 | 0 | — | — | — | — | — |
| `ehhoppehlpoh…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | webrequest_to_dnr | remote_code_removed (platform), eval_removed | storage_over_dom_state | 2 | 14/15 | — | 10/10 | — | — |
| `ehijbdhgohbf…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `ehjkaidpgimm…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `eibmigfcioan…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | eval_removed, execute_script_api | — | storage_over_dom_state | 3 | — | — | — | — | — |
| `eifhnmgbkcbe…` | working | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `eihjingefkck…` | working | — | manifest_version, action_rename, host_permissions_split, web_accessible_resources_v3 | — | — | — | 0 | — | — | — | — | — |
| `eipojanlhhff…` | not_testable | — | manifest_version, action_rename, csp_object_form | — | — | — | 0 | 1/1 | — | — | — | — |
| `ekghhlpfokop…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | — | offscreen_document, storage_over_dom_state, agent_abstained (abstained) | — | 3 | — | — | — | — | — |
| `ekgipgiaopkf…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | webrequest_to_dnr | — | storage_over_dom_state | 2 | 1/1 | — | 2/2 | — | — |
| `eknnbnlelphb…` | partially_working | INVALID_INSTANCE | manifest_version, action_rename, host_permissions_split | — | eval_removed | — | 0 | — | — | — | — | — |
| `ekoncmgcdjjf…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `eleicddmliac…` | working | INVALID_INSTANCE | manifest_version, action_rename, host_permissions_split, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `elkgdelckkld…` | not_working | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | eval_removed | — | — | 1 | — | — | — | — | — |
| `ellccpkcncpo…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `emcjdngajkpb…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | webrequest_to_dnr | eval_removed | storage_over_dom_state | 2 | 2/2 | 1/1 | — | — | — |
| `emegfipbpklj…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | eval_removed | offscreen_document, eval_removed | — | 3 | — | — | — | — | — |
| `enfmooofdgne…` | not_testable | HARNESS_FAILURE | — | — | agent_abstained (abstained) | — | 0 | — | — | — | — | — |
| `enkgpigninik…` | partially_working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | — | — | 0 | — | — | 3/3 | — | — |
| `ennaiiiicpco…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, csp_object_form | — | offscreen_document, storage_over_dom_state | — | 0 | 1/1 | — | — | — | — |
| `ennjefgehhmk…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | eval_removed | eval_removed | — | 4 | 0/2 | — | 1/1 | — | — |
| `ennnhdcfleap…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `enobkmonaall…` | working | — | manifest_version, csp_object_form | — | remote_code_removed (platform), eval_removed | — | 0 | — | — | — | — | — |
| `eockakolmhcb…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | eval_removed | eval_removed, agent_abstained (abstained) | — | 3 | 22/25 | — | — | 6/6 | — |
| `eoojigjmgmai…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | eval_removed | — | 0 | — | — | 1/1 | — | — |
| `epkpilgligfp…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `fafjdbenbdpj…` | working | INVALID_INSTANCE | — | — | — | — | 2 | — | — | — | — | — |
| `fbbfeoonjjfk…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | execute_script_api, offscreen_document | webrequest_to_dnr (limited), remote_code_removed (platform) | — | 5 | 43/43 | — | — | — | — |
| `fbgikljdagba…` | not_testable | — | manifest_version, background_service_worker, action_rename | — | — | — | 0 | — | — | — | — | — |
| `fddcbbjillbf…` | working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | offscreen_document | storage_over_dom_state | 2 | — | — | 2/2 | — | — |
| `feclcilnnbhn…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, csp_object_form | execute_script_api | — | — | 0 | 1/1 | — | — | — | — |
| `fedagdconefj…` | working | INVALID_INSTANCE | — | — | — | — | 0 | — | — | — | — | — |
| `felklfphngai…` | partially_working | — | — | — | — | — | 0 | — | — | — | — | — |
| `felohcdemdbd…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `feogbpckopje…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `ffaajihcojdg…` | not_testable | — | manifest_version, background_service_worker, action_rename | — | remote_code_removed (platform) | storage_over_dom_state | 0 | — | — | — | — | — |
| `ffheidicfkoc…` | working | — | manifest_version, action_rename, host_permissions_split, web_accessible_resources_v3 | — | eval_removed | — | 2 | 1/1 | — | — | — | — |
| `ffofikficihk…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `fgafanobdbbm…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | eval_removed | offscreen_document, storage_over_dom_state, eval_removed | — | 2 | 6/6 | — | — | 5/5 | — |
| `fgammopmbkka…` | working | INVALID_INSTANCE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `fhockinabfen…` | not_testable | — | — | — | — | — | 0 | — | — | — | — | — |
| `fidhdfmgflja…` | working | — | manifest_version, action_rename, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `fjlknokoiboj…` | working | INVALID_INSTANCE | manifest_version, action_rename, host_permissions_split | — | — | — | 0 | — | — | — | — | — |
| `fjmbdeicipcg…` | working | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `fkbmkefjindo…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document, storage_over_dom_state, eval_removed | host_permissions_split | 2 | — | — | — | — | — |
| `fkhbiebcklaj…` | working | INVALID_INSTANCE | — | — | — | — | 0 | — | — | 1/1 | — | — |
| `fmhigajdbogn…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document, eval_removed | — | 4 | 1/1 | — | — | — | — |
| `fmnbeaicfinc…` | partially_working | — | manifest_version, background_service_worker, action_rename, csp_object_form | eval_removed | execute_script_api, eval_removed | storage_over_dom_state | 3 | — | — | — | — | — |
| `fnfpdeaijfjm…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | — | — | 0 | — | 1/1 | 5/5 | — | — |
| `fnkohfnhjgie…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | offscreen_document | — | offscreen_document, storage_over_dom_state | 0 | 2/2 | — | 4/4 | — | — |
| `fodnjpelpfda…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `foffoiohhalp…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `follminpdpgh…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, csp_object_form | — | eval_removed | — | 0 | — | — | 1/1 | — | — |
| `fomboakkmhgb…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, csp_object_form | — | eval_removed | — | 0 | — | — | — | — | — |
| `gaapehfiodin…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker | — | storage_over_dom_state | — | 0 | — | — | — | — | — |
| `gamcmmbgkgad…` | working | — | manifest_version, action_rename, host_permissions_split, csp_object_form | execute_script_api | — | — | 0 | — | — | — | — | — |
| `ganoilfefbad…` | working | — | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `gaojhcekjhdb…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `gbapciimajmh…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `gcliolhofgcf…` | working | INVALID_INSTANCE | manifest_version, action_rename, host_permissions_split | — | — | host_permissions_split | 0 | — | — | — | — | — |
| `gdgegpnkjddb…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | — | storage_over_dom_state | 3 | — | 2/2 | — | — | — |
| `gdpecfemoflc…` | not_testable | — | manifest_version, action_rename, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `gdphgdnpciik…` | working | HARNESS_FAILURE | manifest_version, action_rename, host_permissions_split | — | — | — | 0 | — | — | — | — | — |
| `gedegpjjmmhg…` | working | — | manifest_version, background_service_worker, action_rename | — | commands_execute_action | — | 0 | — | — | 1/1 | — | — |
| `gegmhbfkagnm…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, csp_object_form | — | storage_over_dom_state, eval_removed | — | 0 | 3/3 | — | — | — | — |
| `gfcfmagkdjgm…` | not_testable | HARNESS_FAILURE | manifest_version, csp_object_form | — | — | — | 2 | — | — | — | — | — |
| `gghacdgflidm…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `ggpflhcnoman…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | remote_code_removed (platform) | storage_over_dom_state | 0 | 1/1 | — | — | — | — |
| `ghfinncbapdd…` | not_working | — | — | — | storage_over_dom_state, eval_removed | — | 2 | — | — | — | — | — |
| `ghlijfjnodjn…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split | — | offscreen_document, storage_over_dom_state, eval_removed | — | 0 | — | — | — | — | — |
| `giadkdabdbdh…` | not_testable | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | — | — | 2 | — | — | — | — | — |
| `giijkkefkpgg…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `gjhomgniaide…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | eval_removed | — | 0 | — | — | — | — | — |
| `gldgapmekfid…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | eval_removed | offscreen_document, eval_removed | storage_over_dom_state | 2 | — | — | — | — | — |
| `glhaigmholpe…` | working | INVALID_INSTANCE | manifest_version, action_rename, host_permissions_split, csp_object_form | — | — | host_permissions_split | 0 | — | — | — | — | — |
| `glllfmibomed…` | not_testable | INVALID_INSTANCE | — | — | — | — | 2 | — | — | — | — | — |
| `glmmbajndnlk…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | — | — | storage_over_dom_state | 0 | 2/2 | — | — | — | — |
| `glmniimhlmbf…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, web_accessible_resources_v3 | webrequest_to_dnr | storage_over_dom_state | — | 1 | — | — | — | — | — |
| `gmfnhgekmcgk…` | not_testable | — | — | — | offscreen_document, eval_removed | — | 0 | 3/3 | — | — | — | — |
| `gmiaemibdhfg…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, csp_object_form | — | offscreen_document, execute_script_api, storage_over_dom_state | — | 4 | — | — | — | — | — |
| `gmnbooobfpmp…` | working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | remote_code_removed (platform), eval_removed, agent_abstained (abstained) | — | 2 | 1/1 | — | — | 1/1 | — |
| `gmphmnmdmcdl…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | offscreen_document | — | offscreen_document | 0 | — | — | 3/3 | — | — |
| `gnapooibnaga…` | working | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | — | offscreen_document, eval_removed | storage_over_dom_state | 6 | -1/1 | — | — | — | — |
| `gojdeelmcgmm…` | working | — | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `gpcmeiebpfle…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `gpjdfganijin…` | not_working | INVALID_INSTANCE | manifest_version, action_rename | — | remote_code_removed (platform), eval_removed | — | 0 | 9/9 | — | 1/1 | — | — |
| `gpkihnjhjfnn…` | working | HARNESS_FAILURE | manifest_version, background_service_worker, action_rename | — | — | background_service_worker, action_rename | 0 | — | — | — | — | — |
| `gpmcjjjajpdj…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | offscreen_document | — | 2 | 1/3 | — | 3/4 | — | — |
| `hafpbfgcfiap…` | not_testable | — | manifest_version, action_rename, host_permissions_split, csp_object_form | execute_script_api | commands_execute_action, eval_removed | — | 0 | — | — | — | — | — |
| `haimmmglahdc…` | working | — | manifest_version, action_rename | — | — | — | 3 | — | — | — | — | — |
| `hanjfllnmjom…` | working | — | — | — | eval_removed | — | 2 | — | — | — | — | — |
| `hcghgegolfhj…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename | — | — | background_service_worker | 0 | — | — | — | — | — |
| `hcmepffgbben…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `hdhafnlnpgih…` | working | INVALID_INSTANCE | — | — | storage_over_dom_state | — | 0 | — | — | 1/1 | — | — |
| `hdifgcbbielf…` | not_testable | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | — | eval_removed | — | 2 | — | — | 1/1 | — | — |
| `hebmopjpmnpc…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | eval_removed | remote_code_removed (platform) | — | 0 | — | — | — | 1/1 | — |
| `heenegfokphj…` | partially_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | storage_over_dom_state | web_accessible_resources_v3 | 0 | — | — | 1/1 | — | — |
| `hfcmeikimmje…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `hgaofhcidmhf…` | working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | — | — | 0 | 1/1 | — | — | 1/1 | — |
| `hgdmkcdlldld…` | not_testable | — | manifest_version | — | — | — | 0 | 2/2 | — | — | — | — |
| `hgmdeeoighmh…` | not_working | — | manifest_version, background_service_worker, action_rename, csp_object_form | eval_removed | eval_removed | — | 1 | 1/1 | — | — | — | — |
| `hhbhcggbfgaj…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | eval_removed | offscreen_document, storage_over_dom_state | — | 3 | 43/43 | — | 1/1 | — | — |
| `hhhnlfjjgehe…` | not_testable | — | — | — | — | — | 0 | — | — | 1/1 | — | — |
| `hhinchjegkfe…` | not_testable | HARNESS_FAILURE | manifest_version, host_permissions_split | — | — | — | 0 | — | — | — | — | — |
| `hholgmphhacf…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | eval_removed | — | 0 | — | 5/5 | — | — | — |
| `hhppgklamoag…` | working | — | — | — | eval_removed | — | 0 | — | — | — | — | — |
| `hijfpflgcdkc…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | — | storage_over_dom_state | — | 0 | — | — | — | — | — |
| `hjmpphjfbnmb…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `hkemkgpbjkgl…` | working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | — | storage_over_dom_state | 0 | 4/4 | — | — | — | — |
| `hkghkfjmhdka…` | working | INVALID_INSTANCE | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `hkhlocepmjgo…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `hkiecdebiebb…` | working | — | manifest_version, action_rename, csp_object_form | — | background_service_worker | — | 2 | — | — | — | — | — |
| `hljeeelkdfhj…` | working | — | manifest_version, csp_object_form | — | eval_removed | — | 0 | — | — | — | — | — |
| `hmlbbpbfhpdl…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | eval_removed | — | 0 | 1/2 | — | — | — | — |
| `hnckgnbicnmp…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | webrequest_to_dnr, eval_removed | offscreen_document, storage_over_dom_state, eval_removed, agent_abstained (abstained) | — | 5 | 1/1 | — | 0/1 | — | — |
| `hndckmccaaoc…` | not_testable | INVALID_INSTANCE | — | — | — | — | 0 | — | — | — | — | — |
| `hodphpbkkfio…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, web_accessible_resources_v3, csp_object_form | — | storage_over_dom_state | — | 0 | — | — | — | — | — |
| `hojdaeaggpoo…` | working | — | manifest_version, action_rename, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `holkaimpefmo…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | eval_removed | offscreen_document | — | 5 | — | — | — | — | — |
| `hpnknoigkkch…` | not_testable | INVALID_INSTANCE | manifest_version, action_rename, host_permissions_split | — | — | — | 2 | — | — | — | — | — |
| `iagmopmpiecj…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `ibchpjahjhif…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document | — | 0 | — | — | — | — | — |
| `ibkmmlejbcdi…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document, execute_script_api | storage_over_dom_state | 0 | — | — | 3/3 | — | — |
| `ickpbgkmjodb…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `idcmeohcendf…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `idjoiihokgcj…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | offscreen_document | — | offscreen_document, storage_over_dom_state | 0 | — | — | 2/2 | — | — |
| `idjpogkmgpbf…` | partially_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | eval_removed | — | 0 | — | — | 0/1 | — | — |
| `idlfipfkeckf…` | working | — | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `idojlgkdoohg…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | — | storage_over_dom_state | — | 1 | 4/5 | — | — | — | — |
| `iebcnmngfmbg…` | not_testable | HARNESS_FAILURE | — | — | agent_abstained (abstained) | — | 0 | — | — | — | — | — |
| `iekallpaneii…` | working | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | — | — | — | 0 | — | — | 1/1 | — | — |
| `ifddjhjeeeah…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `iffoooedmcng…` | not_testable | HARNESS_FAILURE | manifest_version, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `ifinhiedefie…` | not_testable | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | — | — | — | 2 | — | — | — | — | — |
| `ifkickiginfo…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `igbaaplkmhfc…` | not_testable | — | manifest_version | — | eval_removed | — | 0 | 2/2 | — | — | — | — |
| `igehidgmdcia…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split | execute_script_api | — | — | 4 | 11/11 | — | — | — | — |
| `igfbjepcmlga…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | webrequest_to_dnr | remote_code_removed (platform) | webrequest_to_dnr | 3 | 5/8 | — | 5/5 | — | — |
| `iggacokahppn…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `igoojenlmajf…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | execute_script_api, eval_removed | eval_removed | — | 0 | — | — | — | — | — |
| `ihdanbaefbkj…` | not_working | HARNESS_FAILURE | manifest_version, background_service_worker, host_permissions_split, csp_object_form | — | eval_removed | background_service_worker | 4 | — | — | — | — | — |
| `ihmogkmilpcj…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | offscreen_document | — | — | 0 | 1/1 | — | 26/26 | — | — |
| `iikcdekihign…` | not_working | INVALID_INSTANCE | manifest_version, action_rename, csp_object_form | — | background_service_worker, eval_removed | — | 0 | — | — | — | — | — |
| `iinhhememjfk…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `ijanbjhbpglk…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | execute_script_api | — | — | 0 | — | — | 1/1 | — | — |
| `ijcicekfknla…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | — | storage_over_dom_state | 0 | — | — | — | — | — |
| `imgonkciigio…` | working | — | — | — | — | — | 0 | — | — | — | — | — |
| `ioenhafggjeo…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `iohimoffklhj…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `ipcblpolaean…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `iphoklkbghon…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | — | storage_over_dom_state | — | 0 | — | — | — | — | — |
| `ipjlpmanhled…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | — | — | 0 | — | 1/1 | — | — | — |
| `jcklpblmdpnl…` | working | INVALID_INSTANCE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `jdmepaljbmgl…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | webrequest_to_dnr, eval_removed | offscreen_document | — | 3 | — | — | — | — | — |
| `jfkpbpamjphc…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | — | host_permissions_split | 2 | — | — | — | — | — |
| `jfnmofjjjaob…` | working | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `jfpffimkffki…` | working | — | manifest_version, action_rename, web_accessible_resources_v3, csp_object_form | — | remote_code_removed (platform), eval_removed | — | 2 | 1/1 | — | — | — | — |
| `jfpmipfmnole…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | — | storage_over_dom_state | 3 | 6/6 | 1/1 | — | 7/7 | — |
| `jhblcjicpdjb…` | not_testable | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | eval_removed | — | 2 | — | — | — | — | — |
| `jhnekgnjiifl…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `jicfhkclcbbd…` | partially_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | webrequest_to_dnr | eval_removed | — | 2 | 2/2 | 1/1 | — | — | — |
| `jifgdinlemmb…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `jjoojeldkdni…` | working | — | manifest_version, background_service_worker, action_rename | — | — | — | 0 | — | — | 1/1 | — | — |
| `jkhpcjlkalgn…` | not_testable | — | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `jkkajfdlllkl…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split | — | offscreen_document | — | 3 | 40/40 | 2/2 | 1/1 | — | — |
| `jlpchpckgnbi…` | not_testable | HARNESS_FAILURE | manifest_version, action_rename, web_accessible_resources_v3 | — | — | — | 0 | 1/1 | — | — | — | — |
| `jmlodgfmibdm…` | not_testable | — | manifest_version, background_service_worker, action_rename | — | — | — | 0 | — | — | — | — | — |
| `jnjmfoocddpe…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | offscreen_document, storage_over_dom_state | — | 3 | 2/2 | — | 1/1 | — | — |
| `jnlbmhcbnmid…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `jnldbjecklhl…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, csp_object_form | — | eval_removed | storage_over_dom_state | 0 | — | — | — | — | — |
| `jokohgmhnpcj…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `jpejajbhcnbp…` | working | — | manifest_version, action_rename, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `jpgcjkmidbpm…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `jpginnjealbk…` | working | — | — | — | storage_over_dom_state | — | 0 | 1/1 | — | — | — | — |
| `jpidmonbpnhc…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `jpjgnkoobdjg…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | remote_code_removed (platform), eval_removed, agent_abstained (abstained) | — | 0 | — | — | — | — | — |
| `kaahdbmbpejj…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `kajdnjdbjjnk…` | working | — | manifest_version, action_rename | — | — | — | 2 | — | — | — | — | — |
| `kambddpednej…` | not_testable | HARNESS_FAILURE | manifest_version, background_service_worker, action_rename | — | — | background_service_worker | 4 | — | — | — | — | — |
| `kamdgboidomc…` | not_testable | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | remote_code_removed (platform), storage_over_dom_state, eval_removed | — | 3 | 1/1 | — | 1/1 | — | — |
| `kbbclhhljmpm…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | offscreen_document | host_permissions_split | offscreen_document | 3 | 1/1 | — | 1/1 | — | — |
| `kbgaihnlngff…` | not_working | INVALID_INSTANCE | — | — | eval_removed | — | 0 | — | — | — | — | — |
| `kbiaooppehkl…` | working | — | — | eval_removed | eval_removed | — | 0 | — | — | — | — | — |
| `kbkaadcbdaio…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | eval_removed, offscreen_document | — | offscreen_document, storage_over_dom_state | 1 | 3/3 | — | 13/13 | — | — |
| `kcbhhbgkmcje…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | offscreen_document | — | offscreen_document | 0 | 1/1 | — | 4/4 | — | — |
| `kccbikohjeal…` | partially_working | — | manifest_version, action_rename, host_permissions_split, csp_object_form | — | eval_removed | — | 0 | — | — | — | — | — |
| `kccnkinkappf…` | working | — | manifest_version, action_rename, web_accessible_resources_v3, csp_object_form | — | eval_removed | — | 0 | — | — | — | — | — |
| `kcggjcnjagma…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `kclkakodphjh…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3 | — | — | — | 0 | 0/1 | — | — | 1/1 | — |
| `kdlldkmdldhh…` | not_testable | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | eval_removed | — | — | 4 | — | — | — | — | — |
| `kdmfcofnhnll…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `kfoleapoalbo…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | eval_removed | — | 0 | — | — | 1/1 | — | — |
| `khneipdgeiof…` | not_working | — | manifest_version, background_service_worker, action_rename | execute_script_api | remote_code_removed (platform), storage_over_dom_state, eval_removed | — | 2 | 7/7 | — | — | — | — |
| `kjkehehijnan…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | — | — | 0 | — | — | 1/1 | — | — |
| `kjmdkeknjohe…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | — | background_service_worker, host_permissions_split | 1 | — | — | 4/4 | — | — |
| `kkaapbjemjde…` | working | — | manifest_version, background_service_worker, host_permissions_split, csp_object_form | — | — | host_permissions_split | 0 | — | — | — | — | — |
| `kkbefhnoidbe…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | — | storage_over_dom_state | 0 | — | — | — | — | — |
| `kkmmijhhiphh…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split | — | — | storage_over_dom_state | 0 | — | — | — | — | — |
| `klclbacdcfig…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split | — | offscreen_document, storage_over_dom_state | — | 0 | — | — | 1/1 | — | — |
| `klekjkocnhkk…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | execute_script_api | — | — | 0 | 1/1 | — | 1/1 | — | — |
| `klngbpegljjd…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3 | — | — | — | 2 | — | — | — | — | — |
| `kmbgpflaojmk…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename | — | — | — | 0 | — | — | 1/1 | — | — |
| `kmfkgbembmgp…` | working | — | manifest_version, action_rename, host_permissions_split, csp_object_form | eval_removed | eval_removed | — | 0 | — | — | — | — | — |
| `kmjccehdojph…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | execute_script_api | storage_over_dom_state | 4 | 9/9 | 3/3 | — | — | — |
| `knbpcoimkjgf…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, csp_object_form | — | offscreen_document, commands_execute_action, eval_removed | — | 0 | 1/1 | — | 1/1 | — | — |
| `kndnfbmjopke…` | working | — | manifest_version, background_service_worker, action_rename, csp_object_form | execute_script_api | — | — | 0 | — | — | 0/1 | — | — |
| `knecnendkbbd…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, csp_object_form | — | — | storage_over_dom_state | 0 | — | 1/1 | 1/1 | — | — |
| `kngmlmkiapjb…` | not_testable | — | manifest_version, action_rename, host_permissions_split, csp_object_form | — | — | host_permissions_split | 0 | — | — | — | — | — |
| `knhjbhkpdfml…` | working | — | manifest_version, background_service_worker, action_rename | — | — | background_service_worker | 4 | — | — | — | — | — |
| `kogangejpnmb…` | working | INVALID_INSTANCE | manifest_version, host_permissions_split, web_accessible_resources_v3 | — | — | — | 0 | 1/1 | — | — | — | — |
| `koiicpkkmlnh…` | not_testable | INVALID_INSTANCE | manifest_version, host_permissions_split, web_accessible_resources_v3, csp_object_form | execute_script_api | — | — | 0 | — | — | — | — | — |
| `konmhndloeip…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `kopecoagikhe…` | working | INVALID_INSTANCE | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `kpfehncehohd…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `kpkejmelooba…` | working | — | manifest_version, action_rename, host_permissions_split | — | — | — | 0 | — | — | — | — | — |
| `lcaccbenpmml…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | offscreen_document | — | offscreen_document | 0 | — | — | — | — | — |
| `lchgncgkegpo…` | not_working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | host_permissions_split, eval_removed | — | 2 | 1/1 | — | — | — | — |
| `lcpaogdhkijh…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | webrequest_to_dnr | webrequest_to_dnr (abstained), eval_removed, agent_abstained (abstained) | — | 4 | 21/22 | — | — | 5/6 | — |
| `ldigknfdafjb…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split | — | — | storage_over_dom_state | 0 | — | — | — | — | — |
| `ldmndgpabggp…` | working | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | — | — | background_service_worker | 0 | 6/6 | 2/2 | — | — | — |
| `ldncjdbdafdk…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | offscreen_document, storage_over_dom_state | — | 0 | — | — | — | — | — |
| `leaichjefmjh…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | — | storage_over_dom_state | — | 0 | — | — | — | — | — |
| `legdfpaiinfk…` | working | — | — | — | — | — | 0 | — | — | 2/2 | — | — |
| `leghipcfbbgf…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split | — | — | — | 0 | — | — | 1/1 | — | — |
| `lemioedjmmln…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `lfdkbfgkbeaa…` | working | — | — | — | — | — | 0 | — | — | 3/3 | — | — |
| `lfogkjopedil…` | working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | eval_removed | — | 0 | — | — | — | — | — |
| `lgaankgifdhi…` | working | — | manifest_version, action_rename, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `lhepcaejamkd…` | partially_working | — | manifest_version, action_rename, csp_object_form | eval_removed | remote_code_removed (platform), eval_removed | — | 0 | 1/1 | — | — | — | — |
| `lhmliamcnkid…` | not_working | INVALID_INSTANCE | — | — | eval_removed | — | 0 | — | — | — | — | — |
| `lidiflbogjbe…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `lifecgkglfdb…` | working | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | offscreen_document | — | — | 2 | 1/1 | — | 4/4 | — | — |
| `liinipoackgj…` | partially_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, csp_object_form | offscreen_document, execute_script_api | — | offscreen_document | 7 | — | — | — | — | — |
| `ljibmalhangc…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | eval_removed | remote_code_removed (platform), eval_removed | — | 4 | — | — | 1/2 | — | — |
| `ljjfbdkncoga…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | execute_script_api | eval_removed | host_permissions_split | 2 | 6/6 | 3/3 | 2/2 | — | — |
| `lkaognfoomlc…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | — | storage_over_dom_state | 0 | 1/1 | — | — | — | — |
| `lklmlnfoegfg…` | not_testable | INVALID_INSTANCE | — | — | — | — | 0 | — | — | — | — | — |
| `llhccjlbojjm…` | not_testable | HARNESS_FAILURE | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `lmldjiliodhg…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split | execute_script_api | storage_over_dom_state | — | 0 | — | 1/1 | 1/1 | — | — |
| `lnmkkohgjfjo…` | working | — | — | — | commands_execute_action, eval_removed | — | 2 | — | — | — | — | — |
| `lobmpnlkbikh…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document, storage_over_dom_state, eval_removed | — | 2 | — | — | 3/3 | — | — |
| `lohpdfikcbeg…` | working | — | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `lokeeijgkleg…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | storage_over_dom_state, eval_removed | — | 0 | 1/1 | — | 2/2 | — | — |
| `lolapmlhhkkf…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `maefomipmebl…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename | — | — | — | 0 | — | — | — | 1/1 | — |
| `mafjhggcnkno…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | execute_script_api | eval_removed | — | 0 | — | — | 1/1 | — | — |
| `maoineplgnai…` | working | — | manifest_version, background_service_worker, host_permissions_split, csp_object_form | — | — | background_service_worker, storage_over_dom_state | 0 | — | — | — | — | — |
| `mboadjigkfhg…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `mcmeaebmnjcp…` | not_working | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | eval_removed | remote_code_removed (platform), eval_removed (abstained), agent_abstained (abstained) | — | 2 | — | — | 2/2 | — | — |
| `mdjmijghafld…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `mdlhominadhb…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker | — | storage_over_dom_state | — | 0 | — | — | — | — | — |
| `mebhnnfdhipf…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename | execute_script_api | — | — | 0 | 6/6 | — | 1/1 | — | — |
| `meelgppppibg…` | partially_working | — | — | eval_removed | eval_removed | — | 0 | — | — | — | — | — |
| `melfmbkfjclj…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `memokfnkpgdj…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | eval_removed, execute_script_api | eval_removed | — | 4 | 1/1 | — | — | — | — |
| `meomojfiombm…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document, eval_removed | — | 3 | 0/1 | — | 2/2 | — | — |
| `mfbnmhjdgbjd…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `mflhbpkjffpp…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | remote_code_removed (platform), storage_over_dom_state, eval_removed | — | 3 | — | 1/1 | 2/2 | — | — |
| `mflhkebbldoh…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document, storage_over_dom_state | — | 1 | — | — | 4/4 | — | — |
| `mgnicgalaici…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `mhaofkmdpgjd…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document | — | 4 | — | — | — | — | — |
| `mhlodgmpnjjh…` | not_testable | HARNESS_FAILURE | manifest_version, host_permissions_split | — | — | — | 0 | — | — | — | — | — |
| `mhmhdkokgcdo…` | working | — | — | — | — | — | 0 | — | — | — | — | — |
| `mhpelcikddgf…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `mibpohnengmo…` | not_testable | HARNESS_FAILURE | manifest_version, csp_object_form | eval_removed | — | — | 0 | — | — | — | — | — |
| `miflofidoigp…` | working | — | manifest_version, action_rename, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `mjcgkhlnnegn…` | not_testable | — | manifest_version, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `mjhogeibfefl…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | storage_over_dom_state, eval_removed | — | 0 | — | — | — | — | — |
| `mkdeccahohlp…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | eval_removed | eval_removed | — | 2 | 1/2 | — | — | — | — |
| `mkfoljfaagoh…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | storage_over_dom_state | — | 2 | — | — | — | 3/3 | — |
| `mkhnlogngigm…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `mkhohhpeajne…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `mkljmpojnend…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | execute_script_api | offscreen_document, remote_code_removed (platform), eval_removed | storage_over_dom_state | 4 | 43/43 | — | 1/1 | — | — |
| `mknflhinhbbi…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document, eval_removed | host_permissions_split | 0 | — | — | — | — | — |
| `mknibjeheold…` | working | INVALID_INSTANCE | — | — | offscreen_document, storage_over_dom_state | — | 0 | — | — | — | — | — |
| `mkpbikojjcjm…` | not_testable | HARNESS_FAILURE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | commands_execute_action | — | 2 | — | — | — | — | — |
| `mkpnghnaoagl…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `mmiemoagbplj…` | not_testable | HARNESS_FAILURE | — | — | agent_abstained (abstained) | — | 0 | — | — | — | — | — |
| `mmkmmgdmglbh…` | working | — | manifest_version, background_service_worker, action_rename, csp_object_form | offscreen_document | — | — | 1 | — | — | — | — | — |
| `mmojfhbllhld…` | not_testable | — | manifest_version, background_service_worker, action_rename, csp_object_form | offscreen_document | eval_removed | — | 2 | — | — | — | — | — |
| `mpnokdijeinf…` | partially_working | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, csp_object_form | eval_removed | eval_removed | — | 0 | 10/10 | 1/1 | — | — | — |
| `nabmnggkfkae…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split | — | storage_over_dom_state | — | 0 | — | — | — | — | — |
| `nbfgffhkoonl…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | — | storage_over_dom_state | 0 | — | 1/1 | 8/8 | — | — |
| `nbfnnejhijoe…` | working | — | manifest_version, background_service_worker, action_rename, csp_object_form | eval_removed | — | — | 0 | — | — | 17/17 | — | — |
| `nchjdnhlflbo…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `ndpnnaadmfdn…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `nejonmoghjji…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `nekhigagdlio…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | — | — | 0 | — | — | — | — | — |
| `neokdbgnoimp…` | not_testable | — | manifest_version, action_rename, host_permissions_split, csp_object_form | execute_script_api | — | — | 0 | — | — | — | — | — |
| `nfohhgcgdfci…` | working | — | manifest_version, action_rename, host_permissions_split, web_accessible_resources_v3 | — | — | — | 0 | 1/1 | — | — | — | — |
| `nggkkjbcbnaj…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `nianghdcpick…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `nibbmlaaffjn…` | working | — | manifest_version, background_service_worker, action_rename | — | — | storage_over_dom_state | 0 | — | — | — | — | — |
| `nidpinnckkmo…` | working | — | manifest_version, action_rename, csp_object_form | — | background_service_worker, offscreen_document, storage_over_dom_state | — | 0 | — | — | — | — | — |
| `nildjgafogjp…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker | — | eval_removed | storage_over_dom_state | 0 | 1/1 | — | — | — | — |
| `njchepcljhle…` | working | — | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `njfmakabgion…` | working | INVALID_INSTANCE | — | — | — | — | 0 | — | — | — | — | — |
| `njihmgeigicp…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | eval_removed, execute_script_api | offscreen_document, storage_over_dom_state, eval_removed | host_permissions_split | 2 | 1/1 | 1/1 | 7/7 | — | — |
| `nkdepmnfhdjf…` | working | INVALID_INSTANCE | manifest_version, action_rename, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `nkdlgjklfeek…` | not_testable | HARNESS_FAILURE | — | — | agent_abstained (abstained) | — | 0 | — | — | — | — | — |
| `nkhmngpedilc…` | working | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | offscreen_document | — | 2 | — | — | — | 1/1 | — |
| `nkldlcgbcefc…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename | — | eval_removed | — | 0 | — | — | 1/1 | — | — |
| `nkppjhcodobf…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `nlbjaajfamaj…` | not_testable | HARNESS_FAILURE | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `nlkpljkacgmb…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split | — | — | host_permissions_split | 0 | — | — | — | — | — |
| `nlllffpgjfkg…` | not_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | offscreen_document | — | storage_over_dom_state | 7 | 1/1 | — | — | 2/2 | — |
| `nmacnakpmbeg…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | — | host_permissions_split, webrequest_to_dnr (abstained), webrequest_header_modification (abstained), storage_over_dom_state, agent_abstained (abstained) | — | 3 | — | — | — | — | — |
| `nmbklkkbojha…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `nmecppbaggcp…` | working | — | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `nmhkeeibpnhk…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, csp_object_form | — | — | action_rename | 0 | 1/1 | — | — | 1/1 | — |
| `nneamfdhikho…` | not_working | HARNESS_FAILURE | manifest_version, background_service_worker, action_rename, csp_object_form | — | remote_code_removed (platform), eval_removed | — | 2 | — | — | 1/1 | — | — |
| `nnfihfihbmgn…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | offscreen_document | — | 0 | 22/24 | — | — | — | — |
| `nnmpkdcdifml…` | not_testable | — | manifest_version, background_service_worker, action_rename, csp_object_form | — | offscreen_document | — | 0 | — | 29/29 | — | — | — |
| `noklhnibgehj…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document, eval_removed | — | 0 | — | — | — | — | — |
| `nomgnakdcocg…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `npadfkcikbkg…` | working | INVALID_INSTANCE | manifest_version, action_rename, host_permissions_split, csp_object_form | execute_script_api | — | — | 0 | — | — | — | — | — |
| `npapjhdlcolf…` | working | — | manifest_version, background_service_worker, action_rename | — | — | — | 0 | — | — | — | — | — |
| `odadhnmcilei…` | working | — | manifest_version, background_service_worker, action_rename | — | — | — | 0 | — | — | — | — | — |
| `odmfafdmbbia…` | not_testable | HARNESS_FAILURE | manifest_version, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `odpmclpmikgh…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | — | storage_over_dom_state | 2 | 1/2 | — | — | 2/2 | — |
| `oehnnplgoegk…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename | offscreen_document | — | offscreen_document, storage_over_dom_state | 6 | — | — | 3/3 | — | — |
| `oepncppigoia…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `ofddaejenmgd…` | working | — | — | — | offscreen_document, remote_code_removed (platform), eval_removed | host_permissions_split | 2 | 1/1 | 5/5 | 1/1 | — | — |
| `ofngeedihale…` | working | — | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `ofoaklobkijc…` | partially_working | — | — | — | offscreen_document, storage_over_dom_state, eval_removed | — | 0 | — | — | — | — | — |
| `ofpaooafcdpb…` | working | — | manifest_version, host_permissions_split, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `oigdddkmgnfi…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | — | — | — | 0 | — | — | — | — | — |
| `oipmhfjfahha…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename | — | remote_code_removed (platform), eval_removed | — | 2 | — | — | 4/4 | — | — |
| `ojadomlpppli…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `olpofgjoceed…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, web_accessible_resources_v3, csp_object_form | offscreen_document | — | — | 0 | — | — | — | — | — |
| `omaiapdnhjmn…` | not_testable | HARNESS_FAILURE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `omdlklpilnmd…` | working | — | — | — | — | — | 0 | — | — | — | — | — |
| `onbjfjajekem…` | partially_working | INVALID_INSTANCE | manifest_version, action_rename, csp_object_form | execute_script_api | remote_code_removed (platform), eval_removed | — | 0 | — | — | — | — | — |
| `ooabifbpgfdk…` | not_testable | HARNESS_FAILURE | manifest_version, host_permissions_split, web_accessible_resources_v3 | — | — | — | 0 | — | — | — | — | — |
| `opofknelcmap…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, csp_object_form | offscreen_document | — | storage_over_dom_state | 0 | — | — | — | — | — |
| `pahcliklakme…` | not_testable | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `pakpfgooafhn…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split | — | — | — | 0 | 1/1 | 1/1 | 3/3 | — | — |
| `palfmbecnjlb…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | offscreen_document | — | offscreen_document, storage_over_dom_state | 2 | 0/1 | — | 6/6 | — | — |
| `pbohjjhllefh…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `pcglcincgpnl…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3 | execute_script_api, offscreen_document | remote_code_removed (platform), eval_removed | host_permissions_split | 4 | 1/1 | — | 1/1 | — | — |
| `pchalmfipapb…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | remote_code_removed (platform), commands_execute_action, eval_removed | storage_over_dom_state | 3 | 3/3 | 1/1 | 6/6 | — | — |
| `pcmoeemedgai…` | working | — | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `pdhcplbcmmag…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, csp_object_form | — | — | — | 0 | — | — | 2/2 | — | — |
| `pdkilmlkbegk…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | remote_code_removed (platform), eval_removed (abstained), agent_abstained (abstained) | background_service_worker, host_permissions_split, storage_over_dom_state | 0 | 2/2 | 2/2 | — | — | — |
| `pecflpnngpkb…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | webrequest_to_dnr (abstained), webrequest_header_modification (abstained), agent_abstained (abstained) | — | 4 | 3/3 | — | — | — | — |
| `pehpbiaaihdh…` | working | — | manifest_version, background_service_worker, action_rename | — | storage_over_dom_state | — | 0 | — | 1/1 | — | — | — |
| `pekjcpfadgjc…` | not_testable | INVALID_INSTANCE | — | — | offscreen_document, storage_over_dom_state | — | 2 | — | — | — | — | — |
| `pffkklpbehjp…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api, offscreen_document | storage_over_dom_state | — | 2 | — | — | — | — | — |
| `pfgdcebeaipg…` | working | INVALID_INSTANCE | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `pfmiclpcbjki…` | not_testable | INVALID_INSTANCE | — | — | — | — | 0 | — | — | — | — | — |
| `pgcmocepbpfh…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | offscreen_document | — | offscreen_document, storage_over_dom_state | 2 | — | — | 7/7 | — | — |
| `pgddhpmoaand…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | execute_script_api | offscreen_document | storage_over_dom_state | 2 | 2/2 | 1/1 | — | — | — |
| `pgdfklcflknl…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, csp_object_form | execute_script_api, eval_removed | eval_removed, agent_abstained (abstained) | — | 5 | 5/5 | — | — | — | — |
| `pgeebkoooblf…` | not_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | eval_removed | offscreen_document | storage_over_dom_state | 6 | — | — | — | — | — |
| `pgikkieojfch…` | partially_working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | offscreen_document | eval_removed | — | 3 | 4/5 | — | — | — | — |
| `pgnjcjahahkh…` | not_testable | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | offscreen_document | — | — | 0 | — | — | 4/4 | 2/2 | — |
| `phhnnjmjgoln…` | not_testable | HARNESS_FAILURE | — | — | — | — | 0 | — | — | — | — | — |
| `pijgifejpphc…` | working | INVALID_INSTANCE | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `piklbpeioehe…` | working | — | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `pimjgeemhpcf…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | execute_script_api | — | host_permissions_split | 3 | — | — | 4/4 | — | — |
| `pjcdhklpcmad…` | not_testable | — | manifest_version, action_rename, host_permissions_split, web_accessible_resources_v3 | — | — | host_permissions_split | 0 | — | — | — | — | — |
| `pjndiiopiioj…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | — | background_service_worker | 0 | 2/2 | — | — | 1/1 | — |
| `pkapgokdkgop…` | partially_working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, csp_object_form | — | — | storage_over_dom_state | 0 | — | 1/1 | 1/1 | — | — |
| `pknjhbmcfdoe…` | partially_working | — | manifest_version, background_service_worker, action_rename, csp_object_form | offscreen_document | — | offscreen_document | 1 | 1/1 | — | — | — | — |
| `pmflbpkabook…` | working | — | manifest_version | — | — | — | 0 | — | — | — | — | — |
| `pmkfcaeagpol…` | not_testable | HARNESS_FAILURE | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `pmpfhpljobmc…` | working | — | manifest_version, action_rename, host_permissions_split, csp_object_form | — | — | — | 2 | — | — | — | — | — |
| `pnbfiinedmem…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | — | — | — | 0 | 5/5 | 0/1 | 2/2 | — | — |
| `ppamcpgjecji…` | working | INVALID_INSTANCE | manifest_version, action_rename | — | — | — | 0 | — | — | — | — | — |
| `ppihcnmdofjg…` | working | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename | — | — | — | 0 | — | — | 1/1 | — | — |
| `ppncdbmpkkfh…` | working | — | manifest_version, background_service_worker, action_rename, host_permissions_split, csp_object_form | — | offscreen_document, eval_removed | — | 2 | — | — | 1/1 | — | — |
| `ppnhhlbhcnnn…` | not_testable | INVALID_INSTANCE | manifest_version, background_service_worker, action_rename, host_permissions_split, web_accessible_resources_v3, csp_object_form | offscreen_document | — | offscreen_document | 6 | 0/1 | — | — | 1/1 | — |

## Residual MV2 API forms (verbatim)

Every MV2-only call site that survived migration, exactly as written in the migrated output.

### `20261005-081824-gemma-4-31b-it-fp8-256k/adhdbclaplninpalnlcgaooncbkjocmp`

- `service_worker.js:525`: `// chrome.pageAction.onClicked.addListener(function(tab) {`

### `20261005-081824-gemma-4-31b-it-fp8-256k/adnjlnpdndicafchbglghieljplkhphk`

- `service_worker.js:150`: `//     if (chrome.extension.lastError) {`
- `service_worker.js:151`: `//         console.log("Got expected error: " + chrome.extension.lastError.message);`
- `service_worker.js:310`: `// chrome.extension.sendMessage({'message': 'updateContextMenu', "isShow": isLogIn});`

### `20261005-081824-gemma-4-31b-it-fp8-256k/bafajkcbalfkkdghjpgcaaopfalikmlk`

- `coverage/lcov-report/background/background.js.html:1632`: `redirectUrl: chrome.extension.getURL('content/omni_newtab.html')`
- `coverage/lcov-report/background/background.js.html:1638`: `redirectUrl: chrome.extension.getURL(`
- `coverage/lcov-report/background/background.js.html:1646`: `redirectUrl: chrome.extension.getURL(`
- `coverage/lcov-report/background/tab.js.html:542`: `url: chrome.extension.getURL('content/omni_newtab.html')`
- `coverage/lcov-report/background/background.js.html:1287`: `<span class="cstat-no" title="statement not covered" >      chrome.browserAction.setBadgeText({ text: '✔️' });</span>`
- `coverage/lcov-report/background/background.js.html:1288`: `<span class="cstat-no" title="statement not covered" >      chrome.browserAction.setBadgeBackgroundColor({ color: '#beadfa75' });</span>`
- `coverage/lcov-report/background/background.js.html:1290`: `<span class="cstat-no" title="statement not covered" >      chrome.browserAction.setBadgeText({ text: '' });</span>`
- `coverage/lcov-report/background/background.js.html:1495`: `chrome.browserAction.onClicked.addListener(Tefter.onMainIconClicked);`
- `coverage/lcov-report/background/have_it.js.html:163`: `chrome.browserAction.setBadgeText({ text: '✔️' });`
- `coverage/lcov-report/background/have_it.js.html:164`: `chrome.browserAction.setBadgeBackgroundColor({ color: '#beadfa75' });`
- `coverage/lcov-report/background/have_it.js.html:166`: `chrome.browserAction.setBadgeText({ text: '' });`

### `20261005-081824-gemma-4-31b-it-fp8-256k/beknlgommgoagklgejjlpnhmpaihlgdg`

- `popup/bullhorn.js:2`: `!function(modules){var installedModules={};function __webpack_require__(moduleId){if(installedModules[moduleId])return installedModules[moduleId].exports;var module=installedModules[moduleId]={i:modul`
- `popup/index.js:2`: `!function(modules){var installedModules={};function __webpack_require__(moduleId){if(installedModules[moduleId])return installedModules[moduleId].exports;var module=installedModules[moduleId]={i:modul`
- `popup/standalone.js:2`: `!function(modules){var installedModules={};function __webpack_require__(moduleId){if(installedModules[moduleId])return installedModules[moduleId].exports;var module=installedModules[moduleId]={i:modul`
- `popup/zoho.js:2`: `!function(modules){var installedModules={};function __webpack_require__(moduleId){if(installedModules[moduleId])return installedModules[moduleId].exports;var module=installedModules[moduleId]={i:modul`
- `service_worker.js:2`: `!function(modules){var installedModules={};function __webpack_require__(moduleId){if(installedModules[moduleId])return installedModules[moduleId].exports;var module=installedModules[moduleId]={i:modul`
- `service_worker.js:2`: `!function(modules){var installedModules={};function __webpack_require__(moduleId){if(installedModules[moduleId])return installedModules[moduleId].exports;var module=installedModules[moduleId]={i:modul`

### `20261005-081824-gemma-4-31b-it-fp8-256k/bfmfbnlagkdfnhdeibiaimidhdaonhcm`

- `popup-min.js:1`: `$(document).ready(function(){$(".collapsible").collapsible(),$(".tooltipped").tooltip({margin:1})});const animateValue=(e,t,i,a)=>{let n=document.getElementById(e),s=i-t,l=Math.abs(Math.floor(a/s));l=`

### `20261005-081824-gemma-4-31b-it-fp8-256k/bpikjpiahcghfboceffhojblkpfofbjf`

- `service_worker.js:15`: `!function(t){var e={};function r(n){if(e[n])return e[n].exports;var o=e[n]={i:n,l:!1,exports:{}};return t[n].call(o.exports,o,o.exports,r),o.l=!0,o.exports}r.m=t,r.c=e,r.d=function(t,e,n){r.o(t,e)\|\|Ob`

### `20261005-081824-gemma-4-31b-it-fp8-256k/cbdadgfefpgaiiefilhjlbgnjhkffhmo`

- `js/background.js:1`: `var background=function(t){function e(r){if(n[r])return n[r].exports;var o=n[r]={i:r,l:!1,exports:{}};return t[r].call(o.exports,o,o.exports,e),o.l=!0,o.exports}var n={};return e.m=t,e.c=n,e.d=functio`
- `js/inject.js:1`: `var inject=function(e){function t(r){if(n[r])return n[r].exports;var o=n[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,t),o.l=!0,o.exports}var n={};return t.m=e,t.c=n,t.d=function(e,`
- `js/popup.js:1`: `var popup=function(n){function e(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return n[r].call(o.exports,o,o.exports,e),o.l=!0,o.exports}var t={};return e.m=n,e.c=t,e.d=function(n,t`
- `js/simpleTab.js:1`: `var simpleTab=function(n){function e(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return n[r].call(o.exports,o,o.exports,e),o.l=!0,o.exports}var t={};return e.m=n,e.c=t,e.d=function`
- `js/tab.js:1`: `var tab=function(n){function e(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return n[r].call(o.exports,o,o.exports,e),o.l=!0,o.exports}var t={};return e.m=n,e.c=t,e.d=function(n,t,r`
- `js/inject.js:1`: `var inject=function(e){function t(r){if(n[r])return n[r].exports;var o=n[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,t),o.l=!0,o.exports}var n={};return t.m=e,t.c=n,t.d=function(e,`
- `js/popup.js:1`: `var popup=function(n){function e(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return n[r].call(o.exports,o,o.exports,e),o.l=!0,o.exports}var t={};return e.m=n,e.c=t,e.d=function(n,t`
- `js/simpleTab.js:1`: `var simpleTab=function(n){function e(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};return n[r].call(o.exports,o,o.exports,e),o.l=!0,o.exports}var t={};return e.m=n,e.c=t,e.d=function`

### `20261005-081824-gemma-4-31b-it-fp8-256k/dkheaplknmplgdcaffadpicnbooojlob`

- `service_worker.js:51986`: `chrome.extension.isAllowedFileSchemeAccess(function (isAllowedAccess) {`

### `20261005-081824-gemma-4-31b-it-fp8-256k/eejhdkkihlmampdfllofghbdlojapfbf`

- `service_worker.js:1`: `!function(e){var n={};function t(r){if(n[r])return n[r].exports;var o=n[r]={i:r,l:!1,exports:{}};return e[r].call(o.exports,o,o.exports,t),o.l=!0,o.exports}t.m=e,t.c=n,t.d=function(e,n,r){t.o(e,n)\|\|Ob`

### `20261005-081824-gemma-4-31b-it-fp8-256k/eeoeakefoojbgmmileebfcjgdgpekfae`

- `main.js:912`: `chrome.extension.isAllowedIncognitoAccess(function(isAllowedIncognito) {`
- `settings.js:303`: `chrome.extension.isAllowedIncognitoAccess(function(isAllowedIncognito) {`
- `theme/js/lib/simplemde/simplemde.min.js:7`: `!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var t;t="undefined"!=typeof window?window:"undef`

### `20261005-081824-gemma-4-31b-it-fp8-256k/ehhoppehlpohjjbflmffjpoblnfhikbi`

- `src/bg/background.js:11`: `// chrome.extension.onMessage.addListener(function(request, sender, sendResponse) {`

### `20261005-081824-gemma-4-31b-it-fp8-256k/ennjefgehhmkgbeeckkaamhcohhghilf`

- `content.js:921`: `eval("__webpack_require__.r(__webpack_exports__);\n/* WEBPACK VAR INJECTION */(function(global) {/* harmony import */ var core_js_modules_es6_regexp_constructor__WEBPACK_IMPORTED_MODULE_0__ = __webpac`
- `content.js:945`: `eval("__webpack_require__.r(__webpack_exports__);\n/* harmony import */ var core_js_modules_es6_array_find__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! core-js/modules/es6.array.find */ \"..`

### `20261005-081824-gemma-4-31b-it-fp8-256k/eockakolmhcbpimokdidgpjgemlhajib`

- `service_worker.js:3368`: `chrome.extension.isAllowedFileSchemeAccess(function (isAllowedAccess) {`
- `service_worker.js:3389`: `chrome.extension.isAllowedFileSchemeAccess(function (isAllowedAccess) {`
- `service_worker.js:52753`: `chrome.extension.isAllowedFileSchemeAccess(function (isAllowedAccess) {`

### `20261005-081824-gemma-4-31b-it-fp8-256k/gnapooibnagamngemlkkjmjfkmgbdmcl`

- `popup/popup.js:18918`: `port: chrome.extension.connect({`
- `service_worker.js:9156`: `chrome.extension.onConnect.addListener(function (port) {`

### `20261005-081824-gemma-4-31b-it-fp8-256k/gpmcjjjajpdjpcogciopbjbnagmdalfd`

- `popup.js:3`: `//chrome.extension.getBackgroundPage().console.log('test');`
- `popup.js:4`: `//chrome.extension.getBackgroundPage().console.log(a);`
- `service_worker.js:17`: `//chrome.browserAction.setIcon({path:icon_open})`

### `20261005-081824-gemma-4-31b-it-fp8-256k/hmlbbpbfhpdlgfnpdlgkjbkkbfhpaoai`

- `js/inject.js:137`: `eval("// Jquery\nwindow.$ = __webpack_require__(59);\nwindow.JQuery = __webpack_require__(59);\n\n// get path of build folder files\nvar url = chrome.extension.getURL('pages/app.html');\n// Iframe ele`

### `20261005-081824-gemma-4-31b-it-fp8-256k/hnckgnbicnmpdppjnbchkokjinfhfpla`

- `service_worker.js:21925`: `//chrome.browserAction.setTitle({tabId: tabId, title: title});`

### `20261005-081824-gemma-4-31b-it-fp8-256k/idjpogkmgpbfokejnjegjlfniocgfhnp`

- `service_worker.js:1`: `!function(t){var e={};function r(n){if(e[n])return e[n].exports;var i=e[n]={i:n,l:!1,exports:{}};return t[n].call(i.exports,i,i.exports,r),i.l=!0,i.exports}r.m=t,r.c=e,r.d=function(t,e,n){r.o(t,e)\|\|Ob`

### `20261005-081824-gemma-4-31b-it-fp8-256k/idojlgkdoohgidhpcjamhpdaofafiocj`

- `dist/bundle.js:28`: `chrome.extension.getBackgroundPage = function() {`

### `20261005-081824-gemma-4-31b-it-fp8-256k/igfbjepcmlgabkgpkpbklmpbbnlagcoj`

- `scripts/combined-head-libraries.js:1`: `!function(f){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=f();else if("function"==typeof define&&define.amd)define([],f);else{("undefined"!=typeof window?window:"undefined"!=`
- `scripts/popup-combined-head-libraries.js:1`: `!function(f){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=f();else if("function"==typeof define&&define.amd)define([],f);else{("undefined"!=typeof window?window:"undefined"!=`
- `service_worker.js:107268`: `/** @namespace chrome.extension.onMessage */`

### `20261005-081824-gemma-4-31b-it-fp8-256k/kclkakodphjhmpeoboogpgipinfmocdk`

- `scripts/content.js:1`: `"use strict";function loadingOverlay(){var a={lines:13,length:11,width:5,radius:17,corners:1,rotate:0,color:"#FFF",speed:1,trail:60,shadow:!1,hwaccel:!1,className:"spinner",zIndex:2e9,top:"auto",left:`

### `20261005-081824-gemma-4-31b-it-fp8-256k/kndnfbmjopkenghimanimafaijmhibac`

- `service_worker.js:1`: `(()=>{"use strict";var e={136:function(e,n,t){var r=this&&this.__awaiter\|\|function(e,n,t,r){return new(t\|\|(t=Promise))((function(o,i){function a(e){try{u(r.next(e))}catch(e){i(e)}}function c(e){try{u(`

### `20261005-081824-gemma-4-31b-it-fp8-256k/lcpaogdhkijhbibofdgmcabbgpcdlplm`

- `service_worker.js:47040`: `chrome.extension.isAllowedFileSchemeAccess(function (isAllowedAccess) {`
- `service_worker.js:47012`: `// chrome.pageAction.show(tabId); // Not needed in MV3 as action is always shown`

### `20261005-081824-gemma-4-31b-it-fp8-256k/ljibmalhangcmjoodlklooihehgnohei`

- `service_worker.js:36`: `\nself['local' + 'Storage'] = {\n  getItem: function() { return null; },\n  setItem: function() { return null; },\n  removeItem: function() { return null; },\n  clear: function() { return null; },\n  `

### `20261005-081824-gemma-4-31b-it-fp8-256k/meomojfiombmjonneipeklinaikkokgh`

- `undo.bundle.js:36914`: `function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function\; } }\n\nfunction _possibleConstructorReturn(self, ca`

### `20261005-081824-gemma-4-31b-it-fp8-256k/mkdeccahohlpfjbhmmaaijljjhmfmdfn`

- `popup.bundle.js:120762`: `var bgPage = null; // chrome.extension.getBackgroundPage();`

### `20261005-081824-gemma-4-31b-it-fp8-256k/nnfihfihbmgnkeeeebhanhmpojclfpad`

- `service_worker.js:1254`: `// chrome.extension.isAllowedFileSchemeAccess is not available in MV3`
- `service_worker.js:1255`: `// chrome.extension.isAllowedFileSchemeAccess(function(isAllowedAccess) {`

### `20261005-081824-gemma-4-31b-it-fp8-256k/odpmclpmikghiankflfcholkpflbnffa`

- `injection.js:43`: `//chrome.extension.sendRequest(title);`

### `20261005-081824-gemma-4-31b-it-fp8-256k/palfmbecnjlbjmnjiflmkpnpjmlcgfke`

- `popup.js:15`: `// BG = chrome.extension.getBackgroundPage(); // Deprecated in MV3`

### `20261005-081824-gemma-4-31b-it-fp8-256k/pgikkieojfchgigcakidkphfdbpihgpl`

- `chromeevents.js:19`: `//chrome.extension.getBackgroundPage().console.log('POPUP: update called\n');`

### `20261005-081824-gemma-4-31b-it-fp8-256k/pnbfiinedmemhcdgfkniadoeomlgkkbn`

- `js/app.js:6`: `// chrome.tabs.getAllInWindow(undefined, function(tabs) {`

### `20261005-081824-gemma-4-31b-it-fp8-256k/ppnhhlbhcnnncmpdipllejanjhckjhoh`

- `content.bundle.js:2`: `(()=>{var e={755:function(e,t){var n;!function(t,n){"use strict";"object"==typeof e.exports?e.exports=t.document?n(t,!0):function(e){if(!e.document)throw new Error("jQuery requires a window with a doc`
