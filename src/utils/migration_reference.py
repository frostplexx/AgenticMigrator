"""Manifest V2 -> Manifest V3 migration reference.

This text is attached to the agent's system prompt (via ``AgentContext.system_message_suffix``)
so the orchestrator and its subagents always have the domain knowledge needed to migrate a
Chrome extension, independent of any per-run task instructions.
"""

MIGRATION_REFERENCE = """\
# Chrome Extension Migration Reference (Manifest V2 -> Manifest V3)

You are working on migrating Chrome extensions from Manifest V2 (MV2) to Manifest V3 (MV3).
MV2 is deprecated and no longer loads in current Chrome. Use the knowledge below as the
source of truth for what must change. Only change what the extension actually uses.

## manifest.json

- `"manifest_version": 2` -> `"manifest_version": 3`.
- Background:
  - `"background": { "scripts": [...], "persistent": false }`
    -> `"background": { "service_worker": "<single-entry>.js" }`.
  - If MV2 listed multiple background scripts, combine them into one service worker
    entry (e.g. via `importScripts(...)` at the top of the worker) — MV3 allows only one
    `service_worker` entry (plus optional `"type": "module"`).
- Actions:
  - `"browser_action"` and `"page_action"` -> `"action"` (merge their fields:
    `default_popup`, `default_icon`, `default_title`).
- Permissions:
  - Move URL match patterns (e.g. `"*://*/*"`, `"https://example.com/*"`,
    `"<all_urls>"`) out of `"permissions"` into a new `"host_permissions"` array.
  - Keep API permissions (e.g. `"storage"`, `"tabs"`, `"scripting"`) in `"permissions"`.
  - If the extension injects scripts/CSS programmatically, add the `"scripting"` permission.
- Content Security Policy:
  - `"content_security_policy": "<string>"`
    -> `"content_security_policy": { "extension_pages": "<string>" }`.
  - Remote code is disallowed: remove `'unsafe-eval'` and any remote script/object sources.
- web_accessible_resources:
  - `"web_accessible_resources": ["a.png", "b.js"]`
    -> `"web_accessible_resources": [{ "resources": ["a.png", "b.js"], "matches": ["<all_urls>"] }]`.
- Remove MV2-only keys that no longer apply once converted.

## Service worker constraints (the background context in MV3)

The background page is replaced by an ephemeral, event-driven service worker. It has no DOM
and can be terminated at any time. This breaks common MV2 patterns:

- No `window`, `document`, `localStorage`, `XMLHttpRequest`, `alert`, or DOM APIs.
  - Use `fetch(...)` instead of `XMLHttpRequest`.
  - Use `chrome.storage.local`/`chrome.storage.session` instead of `localStorage` or
    in-memory globals (the worker may be unloaded, losing state).
- Do not rely on long-lived global variables or timers (`setTimeout`/`setInterval`).
  - Use `chrome.alarms` for scheduled work.
- Register all event listeners synchronously at the top level of the worker (not inside
  async callbacks), so events that wake the worker are not missed.
- `chrome.runtime.getBackgroundPage` and direct access to the background page's DOM/objects
  are gone — communicate via `chrome.runtime` messaging or shared storage.

## API replacements

| MV2 | MV3 |
|-----|-----|
| `chrome.browserAction.*` | `chrome.action.*` |
| `chrome.pageAction.*` | `chrome.action.*` |
| `chrome.extension.getURL(p)` | `chrome.runtime.getURL(p)` |
| `chrome.extension.connect(...)` | `chrome.runtime.connect(...)` |
| `chrome.extension.sendMessage(...)` / `sendRequest(...)` | `chrome.runtime.sendMessage(...)` |
| `chrome.extension.onMessage` / `onRequest` | `chrome.runtime.onMessage` |
| `chrome.extension.onConnect` | `chrome.runtime.onConnect` |
| `chrome.tabs.executeScript(tabId, details)` | `chrome.scripting.executeScript({ target: { tabId }, ... })` |
| `chrome.tabs.insertCSS(tabId, details)` | `chrome.scripting.insertCSS({ target: { tabId }, ... })` |
| `chrome.tabs.sendRequest(...)` | `chrome.tabs.sendMessage(...)` |
| `chrome.tabs.getAllInWindow(id, cb)` | `chrome.tabs.query({ windowId: id }, cb)` |
| `chrome.tabs.getSelected(id, cb)` | `chrome.tabs.query({ active: true, windowId: id }, cb)` |
| `chrome.tabs.onActiveChanged` / `onSelectionChanged` | `chrome.tabs.onActivated` |
| `chrome.tabs.onHighlightChanged` | `chrome.tabs.onHighlighted` |

Note: the exact set of APIs an extension uses is detected up front by static analysis and
provided in the task instructions — treat that list as authoritative for which call sites
to change, and use the table above for the correct replacement.

## Other common changes

- Replace any executable/remotely-hosted code with bundled, local code.
- Promise-based chrome.* APIs are available in MV3; callback style still works.
- Preserve every other file unchanged — a migration must produce a complete, loadable
  extension, not just the edited files.

## Definition of done

The migrated extension in the output directory must load in Chromium with
`"manifest_version": 3`, register its service worker without throwing, and run without
runtime errors (verified by the `verify` skill).
"""
