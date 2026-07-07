---
name: mv3-semi-trivial
description: >-
  MV2→MV3 API renames and service-worker constraints: chrome.extension.*→
  chrome.runtime.*, chrome.browserAction.*→chrome.action.*, tabs.executeScript→
  scripting.executeScript, and rules for coding in a termination-safe service
  worker. Invoke before rewriting extension JS so you pick the correct MV3 call
  at every call site.
---

# MV3 Semi-Trivial Changes — API Renames & Service-Worker Constraints

These changes require touching JavaScript source files (not just the manifest),
but are still mechanical: find each MV2 call site, swap it for the MV3 form,
and handle the altered parameter shape where noted.

## API replacement table

| Manifest V2 API                      | Manifest V3 Replacement             |
| ------------------------------------ | ----------------------------------- | 
| chrome.extension.connect()           | chrome.runtime.connect()            |
| chrome.extension.connectNative()     | chrome.runtime.connectNative()      |
| chrome.extension.getURL()            | chrome.runtime.getURL()             |
| chrome.extension.onConnect           | chrome.runtime.onConnect            |
| chrome.extension.onConnectExternal   | chrome.runtime.onConnectExternal    |
| chrome.extension.onMessage           | chrome.runtime.onMessage            |
| chrome.extension.sendMessage()       | chrome.runtime.sendMessage()        |
| chrome.extension.sendNativeMessage() | chrome.runtime.sendNativeMessage()  |
| chrome.extension.sendRequest()       | chrome.runtime.sendMessage()        |
| chrome.extension.onRequest           | chrome.runtime.onMessage            |
| chrome.extension.onRequestExternal   | chrome.runtime.onMessageExternal    |
| chrome.tabs.getAllInWindow()         | chrome.tabs.query()                 |
| chrome.tabs.getSelected()            | chrome.tabs.query()                 |
| chrome.tabs.onActiveChanged          | chrome.tabs.onActivated             |
| chrome.tabs.onHighlightChanged       | chrome.tabs.onHighlighted           |
| chrome.tabs.onSelectionChanged       | chrome.tabs.onActivated             |
| chrome.tabs.sendRequest()            | chrome.runtime.sendMessage()        |
| chrome.browserAction.                | chrome.action.                      | 
| chrome.pageAction.                   | chrome.action.                      |
| chrome.extension.getExtensionTabs    | chrome.extension.getViews           |
| chrome.runtime.onSuspend             | -                                   |


`chrome.scripting` requires the `"scripting"` permission in `manifest.json`.

### scripting.executeScript shape change

MV2 `tabs.executeScript` accepted `file` or `code` directly in the details
object. MV3 `scripting.executeScript` wraps the target in a `target` key and
uses `files` (array) or `func`/`args`. Inline `code` strings are not allowed
in MV3 — use `func` instead.

```diff
-chrome.tabs.executeScript(tabId, { file: 'content.js' })
-chrome.tabs.executeScript(tabId, { code: 'document.body.style.color="red"' })
+chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
+chrome.scripting.executeScript({
+  target: { tabId },
+  func: () => { document.body.style.color = 'red' }
+})
```

## Service-worker constraints

The background page is replaced by an **ephemeral**, event-driven service
worker. It has no DOM and can be terminated by Chrome at any time between
events.

### Banned globals / APIs

| MV2 (background page) | MV3 replacement |
|---|---|
| `window`, `document` | Not available — use offscreen documents for DOM work |
| `localStorage` | `chrome.storage.local` or `chrome.storage.session` |
| `XMLHttpRequest` | `fetch(...)` |
| `alert()`, `confirm()` | Not available |
| In-memory globals (survive forever) | Write to `chrome.storage` — the worker may be unloaded |
| `setTimeout` / `setInterval` for long work | `chrome.alarms` |
| `chrome.runtime.getBackgroundPage` | Removed — use messaging or shared storage |

### Event listener registration

Register all event listeners **synchronously at the top level** of the service
worker, not inside async callbacks. Chrome wakes the worker when an event fires,
but if the listener was registered inside an async chain it may not be present
yet.

```diff
-chrome.runtime.onInstalled.addListener(async () => {
-  await someAsyncSetup()
-  chrome.tabs.onUpdated.addListener(handler) // registered too late
-})
+chrome.tabs.onUpdated.addListener(handler)
+chrome.runtime.onInstalled.addListener(() => someAsyncSetup())
```

### Promise support

All `chrome.*` APIs that previously required callbacks now return Promises in
MV3. Both styles still work; prefer `async`/`await` for new code:

```diff
-chrome.storage.local.get('key', (result) => { /* ... */ })
+const result = await chrome.storage.local.get('key')
```
