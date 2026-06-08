---
name: manifest-csp
description: >-
  Generate a Manifest V3-valid Content Security Policy for an extension's
  manifest.json. Use this whenever the extension declares a
  `content_security_policy` (MV2 string form or MV3 object form) or a top-level
  `sandbox.content_security_policy`, to convert it to the MV3 object form and strip
  the script/object sources Chrome forbids (remote origins, 'unsafe-eval',
  'unsafe-inline', nonces, hashes) that would otherwise stop the extension loading.
---

# Generate a valid MV3 Content Security Policy

MV3 enforces a strict CSP on extension pages: the script-loading directives may only
reference local code. If the migrated manifest keeps an MV2 CSP with a remote script
origin or `'unsafe-eval'`, Chrome refuses to load the extension. This skill produces a
valid `content_security_policy` object from whatever the manifest currently declares.

## When to use it

- The MV2 manifest has `"content_security_policy": "<string>"` (convert to the MV3 object
  form `{ "extension_pages": "<string>" }`).
- The MV2 manifest has a top-level `"sandbox": { "content_security_policy": "..." }`
  (fold it into `content_security_policy.sandbox`).
- An MV3 manifest already has the object form but you want it re-checked/sanitized.

If the manifest declares no CSP at all, the extension uses Chrome's secure default and you
do **not** need to add one.

## How to run it

Print the valid policy and a report of what was stripped (does not modify the file):

```
python /workspace/.openhands/skills/manifest-csp/scripts/generate_csp.py /workspace/out/manifest.json
```

Sanitize and write it back into the manifest in place:

```
python /workspace/.openhands/skills/manifest-csp/scripts/generate_csp.py /workspace/out/manifest.json --write
```

`--write` sets `content_security_policy` to the MV3 object form and removes the MV2-only
top-level `sandbox.content_security_policy` (its value moves to
`content_security_policy.sandbox`). Use `--json` to print only the policy object.

The script uses the standard library only — no install step.

## What is and isn't allowed (the rules it enforces)

For **`extension_pages`**, in `script-src` / `script-src-elem` / `script-src-attr` /
`worker-src`:

- Allowed: `'self'`, `'none'`, `'wasm-unsafe-eval'`, `'inline-speculation-rules'`.
- Removed: remote origins (`https://…`, `http://…`, `*`), `'unsafe-eval'`,
  `'unsafe-inline'`, nonces (`'nonce-…'`), hashes (`'sha256-…'`), `data:`, `blob:`.
- `object-src` is restricted to `'self'` / `'none'`.
- A restricted directive that ends up empty falls back to `'self'`; if `script-src` or
  `object-src` is missing entirely it is added as `'self'`.

For **`sandbox`**, `'unsafe-inline'` and `'unsafe-eval'` are additionally allowed (sandboxed
pages need them), but remote script origins are still stripped.

Non-script directives (`style-src`, `img-src`, `connect-src`, `font-src`, …) are left
untouched — MV3 does not restrict them.

## Example

MV2:

```json
"content_security_policy": "script-src 'self' https://cdn.firebase.com 'unsafe-eval'; object-src 'self'"
```

becomes:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```

This is part of the MV2 -> MV3 migration; see the `mv3-migration` skill for the full set of
manifest changes.
