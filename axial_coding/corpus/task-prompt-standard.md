# Chrome Extension Migration Task

Migrate the Chrome extension at `/work/extension` from Manifest V2 to Manifest V3 and write the
COMPLETE migrated extension to `/work/run/out`. It must load and run in Chrome with no errors.

The extension has already been run through an automated converter, so the manifest is likely
already MV3 and simple API swaps are done. Finish what the converter cannot: service-worker
code that used the DOM/window, blocking webRequest, and anything subtle. Then make it run.

## How to work
Every original file has ALREADY been copied to `/work/run/out`. You are the ONLY agent — there are
no sub-agents to delegate to. Do all edits yourself, file by file, with your `edit`/`write`
tools. For big work (a service worker that used the DOM/window, blocking `webRequest` →
`declarativeNetRequest`, or several files) work through the files one at a time rather than
skipping them.

Steps:
1. `ls` `/work/run/out` and read manifest.json plus the flagged files below.
2. Make every MV3 change with your own `edit`/`write` tools: apply the deprecated-API
   replacements below and every other MV2->MV3 change (manifest_version, service_worker,
   action, host_permissions, declarativeNetRequest — see reference).
3. Create new files where required (e.g. `/work/run/out/rules.json` for declarativeNetRequest).
4. Confirm `/work/run/out/manifest.json` has "manifest_version": 3.

## Critical: Do NOT touch data files

Some extensions bundle large data files (dictionaries, translation tables, databases in HTML/JSON/CSV
format). These are NOT code and do NOT need MV3 migration. Do NOT read or edit them. They will be
automatically preserved from the original extension after you finish.

The only files that matter for migration are:
- <manifest.json and the report's flagged files>


## If it cannot be migrated, say so instead of faking it
Some extensions depend on capabilities MV3 removed with no replacement (a blocking
`webRequest` decision computed from the request itself, fetching and running remote code). If
this is one of them, do NOT invent an API that does not exist and do NOT ship a version that
loads but does nothing. Write `/work/run/ABSTAIN.md` containing:

    REASON: <one line>
    EVIDENCE: <file:line of the code that cannot be ported>
    CONSTRAINT: <the Chrome documentation url stating the limitation>

Then stop. Migrate everything you CAN migrate first; abstain only for the capability that is
genuinely impossible, and only with all three fields filled in.

## Do NOT verify — the harness does that
Do NOT run any verification, test, or browser script yourself (no verify.py, no Playwright, no
launching Chrome). After the edits are applied, STOP. The harness automatically loads the
migrated extension in Chrome and, if it fails, will send you the concrete runtime errors to fix.

<report-specific: static analysis, migration signals, browser compatibility>

## MV3 Migration Reference (mv3-migration skill)

---
name: mv3-migration
description: >-
  Overview for migrating a Chrome extension from Manifest V2 to Manifest V3.
  Routes to the appropriate sub-skill based on what needs to change. Invoke this
  first to identify which sub-skills apply, then invoke those directly.
---

# Chrome Extension MV2 → MV3 Migration

MV2 is deprecated and no longer loads in current Chrome. Only change what the
extension actually uses. Three sub-skills cover the work at different levels of
effort:

## Sub-skills

### mv3-trivial — manifest.json updates (mechanical)
Pure manifest field renames and restructuring. No logic changes.
- `manifest_version` bump
- `background.scripts` → `background.service_worker`
- `browser_action` / `page_action` → `action`
- URL patterns out of `permissions` into `host_permissions`
- `content_security_policy` string → object
- `web_accessible_resources` flat array → object array

Invoke: **mv3-trivial**

### mv3-semi-trivial — API renames & service-worker rules (requires JS edits)
Find-and-replace across JS files plus adapting code to run in a termination-safe
service worker with no DOM globals.
- `chrome.extension.*` → `chrome.runtime.*`
- `chrome.browserAction.*` → `chrome.action.*`
- `chrome.tabs.executeScript` → `chrome.scripting.executeScript`
- Banned globals: `window`, `document`, `localStorage`, `XHR`
- Event listener placement rules

Invoke: **mv3-semi-trivial**

### mv3-non-trivial — DNR & offscreen documents (architectural rewrites)
Significant rewrites required. Invoke when the extension uses blocking
`webRequest` listeners or when the service worker needs DOM / audio / clipboard.
- Blocking `webRequest` → `declarativeNetRequest` (static rule JSON)
- DOM / audio / canvas in background → offscreen documents

Invoke: **mv3-non-trivial**

---

## Definition of done

The migrated extension must load in Chromium with `"manifest_version": 3`,
register its service worker without throwing, and run without runtime errors
(verified by the `verify` skill). Preserve every file not listed in the task —
a migration must produce a **complete, loadable extension**, not just the edited
files.

## Response style
Terse. Technical. Edit each file yourself with your own tools; there are no sub-agents.
Don't narrate at length. Code unchanged.