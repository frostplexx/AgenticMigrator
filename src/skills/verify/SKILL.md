---
name: verify
description: >-
  Verify a migrated Manifest V3 Chrome extension by loading it in a real Chromium
  browser and reporting runtime errors (service-worker exceptions, console errors,
  page errors). Use this whenever you need to check whether the migrated extension
  in /workspace/out actually loads and runs without errors. This is the ONLY
  supported way to test the extension — you do not have direct browser control.
---

# Verify a migrated Chrome extension

To check whether the migrated extension loads and runs correctly, run the bundled
verify command. It launches a real (headed) Chromium with the extension loaded, then
**actively exercises it** along the surface declared in its manifest — visiting pages
that match its content-script patterns, opening and clicking through its popup/options
pages, and loading its web-accessible resources — so errors that only appear when the
extension is *used* surface, not just load-time errors. It also checks that no
functionality was dropped. **You cannot drive a browser yourself — always use this command.**

## How to run it

```
python /workspace/.openhands/skills/verify/scripts/verify.py /workspace/out
```

- The first argument is the directory of the (migrated) extension to test.
- It writes a JSON report to `/workspace/test_report.json` and prints a summary.
- **Exit code is 0 on success, non-zero on failure** (extension failed to load, errors
  were captured at runtime, or functionality was dropped).

## Interpreting the result

The report (and stdout) contains:

- `loaded` — `true` if the extension's service worker registered.
- `extensionId` — the loaded extension's ID.
- `errors` — list of `{ "source": ..., "text": ... }`. **Non-empty means the
  migration is not correct yet.** Sources include `service_worker.*` (runtime errors in
  the background worker), `page.*` (errors in popup/options/content-script pages), and
  `coverage` (a chrome.* API used in the original was dropped with no MV3 replacement).
- `droppedNamespaces` — chrome.* namespaces present in the original but missing from the
  migrated output (deleted functionality).
- `warnings` — non-fatal issues worth reviewing.

## What to do with errors

If `loaded` is `false` or `errors` is non-empty, the migration is incomplete. Fix the
files in `/workspace/out` (delegate to `extension-transformer` with the exact error
text), then run verify again. Do not finish while the command exits non-zero.
