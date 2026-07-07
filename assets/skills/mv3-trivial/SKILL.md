---
name: mv3-trivial
description: >-
  MV2→MV3 manifest.json-only changes: version bump, background→service_worker,
  browser_action/page_action→action, permissions→host_permissions split, CSP
  restructure, web_accessible_resources restructure. Invoke before touching
  manifest.json so every field lands in the correct MV3 form.
---

# MV3 Trivial Changes — manifest.json

Every field below is a mechanical find-and-replace. Nothing about extension
logic changes here; only the manifest file structure changes.

## manifest_version

```diff
- "manifest_version": 2
+ "manifest_version": 3
```

## host_permissions split

URL match patterns must move out of `"permissions"` into a new top-level
`"host_permissions"` array. API permission strings stay in `"permissions"`.

```diff
-"permissions": ["storage", "tabs", "*://*/*", "https://example.com/*"]
+"permissions": ["storage", "tabs"],
+"host_permissions": ["*://*/*", "https://example.com/*"]
```

If the extension injects scripts or CSS programmatically, also add `"scripting"`
to `"permissions"`.

## web_accessible_resources

The web accessible resources field has been restructured to require explicit match patterns that specify which websites
can access each resources, each pairing a `resources` list with a `matches` pattern list.

```diff
-"web_accessible_resources": ["images/icon.png", "injected.js"]
+"web_accessible_resources": [
+  { "resources": ["images/icon.png", "injected.js"], "matches": ["<all_urls>"] }
+]
```

Restrict `matches` to only the origins that actually need access — avoid
`<all_urls>` unless the extension genuinely needs it on every page.

## browser_action / page_action → action

Both MV2 action types collapse into a single `"action"` key. Merge their
fields (`default_popup`, `default_icon`, `default_title`) into it.

```diff
-"browser_action": { "default_popup": "popup.html", "default_icon": "icon.png" },
-"page_action":    { "default_popup": "popup.html" }
+"action": { "default_popup": "popup.html", "default_icon": "icon.png" }
```

## background

MV3 allows exactly **one** service worker entry. Multiple background scripts
must be combined (e.g. via `importScripts(...)` at the top of the worker, or
bundled into a single file). Add `"type": "module"` to use ES module syntax.

```diff
-"background": { "scripts": ["bg1.js", "bg2.js"], "persistent": false }
+"background": { "service_worker": "background.js" }
```

## content_security_policy

The value changes from a bare string to an object. Remote code is forbidden in
MV3 — remove `'unsafe-eval'` and any remote script/object sources.

```diff
-"content_security_policy": "script-src 'self'; object-src 'self'"
+"content_security_policy": {
+  "extension_pages": "script-src 'self'; object-src 'self'"
+}
```

## Remove MV2-only keys

Delete these keys if present; they have no MV3 equivalent:
- `"background.persistent"` (the MV3 service worker is always non-persistent)
- `"browser_action"` and `"page_action"` (replaced by `"action"`)
- `"web_accessible_resources"` as a flat array (replaced by object form above)
- `"chrome_style"` has been completely deprecated in manifest v3
