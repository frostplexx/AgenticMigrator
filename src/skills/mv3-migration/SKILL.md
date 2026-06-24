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
