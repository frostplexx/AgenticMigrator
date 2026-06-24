---
name: mv3-non-trivial
description: >-
  MV2→MV3 non-trivial rewrites: declarativeNetRequest (DNR) to replace blocking
  webRequest, and offscreen documents to replace background-page DOM/audio usage.
  Invoke when an extension uses blocking webRequest listeners or when the service
  worker needs DOM APIs, audio, canvas, clipboard, or localStorage.
---

# MV3 Non-Trivial Changes — DNR & Offscreen Documents

These two patterns require architectural rewrites, not just renames.

---

## 1. Blocking webRequest → declarativeNetRequest (DNR)

MV3 removes blocking `webRequest` (the ability to redirect, block, or modify
requests inside a listener). Rules must be expressed declaratively in a JSON
file that Chrome loads at extension startup.

**Chrome rejects the entire extension at load time if any rule is malformed.**
Error messages look like:
> *"Rule with id 1 specifies an incorrect value for the 'action.redirect' key"*

### manifest.json additions

```diff
+"permissions": ["declarativeNetRequest"],
+"declarative_net_request": {
+  "rule_resources": [
+    { "id": "ruleset_1", "enabled": true, "path": "rules.json" }
+  ]
+}
```

Use `"declarativeNetRequestWithHostAccess"` instead of `"declarativeNetRequest"`
when any rule performs a `redirect` action — redirect rules also need the
matched origin listed in `"host_permissions"`.

### rules.json structure

The file is an **array** of rule objects. Every rule requires all four keys:

```json
[
  {
    "id": 1,
    "priority": 1,
    "action": { "type": "block" },
    "condition": {
      "urlFilter": "||ads.example.com",
      "resourceTypes": ["script", "image"]
    }
  },
  {
    "id": 2,
    "priority": 1,
    "action": {
      "type": "redirect",
      "redirect": { "url": "https://safe.example.com/" }
    },
    "condition": {
      "urlFilter": "||tracker.example",
      "resourceTypes": ["main_frame"]
    }
  }
]
```

### action types and shapes

| `action.type` | Extra keys required |
|---|---|
| `"block"` | none |
| `"allow"` | none |
| `"upgradeScheme"` | none |
| `"redirect"` | `action.redirect` — see below |
| `"modifyHeaders"` | `action.requestHeaders` or `action.responseHeaders` |

`action.redirect` must be an **object** (never a bare string) with exactly one
of these forms:

```jsonc
{ "url": "https://absolute-url.example/" }           // absolute URL
{ "extensionPath": "/page.html" }                     // leading slash, web-accessible resource
{ "regexSubstitution": "\\1.example.com/" }           // used with condition.regexFilter
{ "transform": { "scheme": "https" } }                // URL transform
```

### condition keys

- `urlFilter` — glob-like pattern (`||` anchors to domain, `|` anchors start/end,
  `*` matches anything). Cannot be used with `regexFilter`.
- `regexFilter` — RE2 regex. Cannot be used with `urlFilter`.
- `resourceTypes` — required for most rules; must be an array of strings such as
  `"main_frame"`, `"sub_frame"`, `"xmlhttprequest"`, `"script"`, `"image"`,
  `"stylesheet"`, `"font"`, `"media"`, `"websocket"`, `"other"`.
- `initiatorDomains` / `excludedInitiatorDomains` — restrict by page origin.

### Removing the old webRequest code

```diff
-chrome.webRequest.onBeforeRequest.addListener(
-  (details) => ({ cancel: true }),
-  { urls: ['<all_urls>'] },
-  ['blocking']
-)
```

```diff
-"webRequestBlocking"
```

**Non-blocking** observation listeners (those that only read request data and
do not return a blocking response) may stay; keep `"webRequest"` in
`"permissions"` only if those remain.

### Dynamic rules (optional)

Rules can also be installed at runtime (e.g. from user settings) without a
static JSON file which is **preferred** for migration:

```js
await chrome.declarativeNetRequest.updateDynamicRules({
  addRules: [{ id: 100, priority: 1, action: { type: 'block' },
               condition: { urlFilter: '||evil.example', resourceTypes: ['main_frame'] } }],
  removeRuleIds: [99]
})
```

---

## 2. Offscreen Documents

The MV3 service worker has no DOM, no `window`, no `AudioContext`, no
`localStorage`, and no clipboard access. Offscreen documents solve this: they
are hidden pages (not visible to the user) that run in a renderer process where
DOM APIs are fully available.

### When to use them

Use an offscreen document when the service worker needs any of:
- DOM parsing / HTML manipulation
- Audio playback (`AudioContext`, `<audio>`)
- Canvas / WebGL rendering
- Clipboard read/write
- `localStorage` or `sessionStorage`
- Downloading a Blob
- WebRTC, `getUserMedia`

If the task can be done with `fetch`, `chrome.storage`, or a content script
injected into an existing tab, prefer those instead.

### manifest.json

```diff
+"permissions": ["offscreen"]
```

### API overview

Chrome allows **at most one** offscreen document per extension at a time.

```js
// Check whether one already exists (returns boolean)
const exists = await chrome.offscreen.hasDocument()

// Create one (no-op if one already exists — guard with hasDocument first)
await chrome.offscreen.createDocument({
  url: chrome.runtime.getURL('offscreen.html'),
  reasons: ['DOM_PARSER'],          // one or more reasons from the enum below
  justification: 'Parse HTML response from fetch'
})

// Close it when done (the document is reused across service-worker lifetimes,
// so close it explicitly rather than letting it accumulate)
await chrome.offscreen.closeDocument()
```

### reasons enum (must declare every reason that applies)

| Value | Use case |
|---|---|
| `AUDIO_PLAYBACK` | `AudioContext`, `<audio>` |
| `BLOBS` | Creating or reading Blob/File objects |
| `CLIPBOARD` | `navigator.clipboard` |
| `DOM_PARSER` | `DOMParser`, `innerHTML`, `document.createElement` |
| `DOM_SCRAPING` | Reading DOM content from a page |
| `GEOLOCATION` | `navigator.geolocation` |
| `LOCAL_STORAGE` | `localStorage` / `sessionStorage` |
| `MATCH_MEDIA` | `window.matchMedia` |
| `USER_MEDIA` | `navigator.getUserMedia` / `MediaDevices` |
| `WEB_RTC` | RTCPeerConnection |
| `WORKERS` | Web Workers |

### Communicating with the offscreen document

Service worker and offscreen document talk through `chrome.runtime` messaging:

```js
// service-worker.js — send a task to the offscreen document
const result = await chrome.runtime.sendMessage({
  type: 'parse-html',
  target: 'offscreen',
  payload: htmlString
})

// offscreen.js — receive and reply
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false
  if (msg.type === 'parse-html') {
    const doc = new DOMParser().parseFromString(msg.payload, 'text/html')
    sendResponse({ title: doc.title })
    return true // keep channel open for async response
  }
})
```

Use a `target` field (or similar discriminator) so messages intended for the
offscreen document are not confused with messages handled by content scripts or
the service worker itself.

### Lifecycle pitfall

The offscreen document survives as long as it is not explicitly closed — it
persists across service-worker restarts. Always call `hasDocument()` before
`createDocument()` to avoid an error, and `closeDocument()` when the work is
done to release the renderer process.
