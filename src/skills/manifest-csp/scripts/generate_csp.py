#!/usr/bin/env python3
"""Generate a Manifest V3-valid Content Security Policy for a manifest.json.

Reads the extension's current CSP (MV2 string form, MV3 object form, or absent),
strips everything MV3 forbids in the script/object directives, and emits a valid
MV3 `content_security_policy` object.

MV3 restricts the *script-loading* directives of extension pages to local code only.
For `extension_pages`, `script-src`/`script-src-elem`/`script-src-attr`/`worker-src`
may only use `'self'`, `'none'`, `'wasm-unsafe-eval'` (and `'inline-speculation-rules'`);
`object-src` may only use `'self'`/`'none'`. Remote origins, `'unsafe-eval'`,
`'unsafe-inline'`, nonces, hashes, `data:`/`blob:` are all rejected by Chrome and will
prevent the extension from loading. Other directives (style-src, img-src, connect-src, …)
are left untouched. The `sandbox` CSP is allowed the `'unsafe-inline'`/`'unsafe-eval'`
keywords but still may not load remote scripts.

Usage:
    generate_csp.py <manifest.json> [--write] [--json]

    --write   write the sanitized `content_security_policy` back into the manifest
              (and remove the MV2-only top-level `sandbox.content_security_policy`).
    --json    print only the resulting `content_security_policy` object as JSON.

Exit code is 0 on success, non-zero if the manifest can't be read/parsed.
"""

import argparse
import json
import sys
from collections import OrderedDict

# Directives whose sources Chrome restricts to local code on extension pages.
RESTRICTED_SCRIPT_DIRECTIVES = {
    "script-src",
    "script-src-elem",
    "script-src-attr",
    "worker-src",
}
RESTRICTED_OBJECT_DIRECTIVES = {"object-src"}

# Keyword sources that survive sanitization.
EXTENSION_SCRIPT_KEYWORDS = {
    "'self'",
    "'none'",
    "'wasm-unsafe-eval'",
    "'inline-speculation-rules'",
}
SANDBOX_SCRIPT_KEYWORDS = EXTENSION_SCRIPT_KEYWORDS | {
    "'unsafe-inline'",
    "'unsafe-eval'",
}
OBJECT_KEYWORDS = {"'self'", "'none'"}


def parse_csp(csp_string):
    """Parse a CSP string into an ordered {directive: [sources]} mapping."""
    directives = OrderedDict()
    for clause in csp_string.split(";"):
        tokens = clause.split()
        if not tokens:
            continue
        name = tokens[0].lower()
        directives[name] = tokens[1:]
    return directives


def serialize_csp(directives):
    """Serialize an ordered {directive: [sources]} mapping back to a CSP string."""
    parts = []
    for name, sources in directives.items():
        parts.append(" ".join([name, *sources]).strip())
    return "; ".join(parts)


def sanitize_directives(directives, script_keywords, removed):
    """Strip MV3-forbidden sources from the script/object directives in place."""
    result = OrderedDict()
    for name, sources in directives.items():
        if name in RESTRICTED_SCRIPT_DIRECTIVES:
            allowed = script_keywords
        elif name in RESTRICTED_OBJECT_DIRECTIVES:
            allowed = OBJECT_KEYWORDS
        else:
            result[name] = sources  # non-script directive — left untouched
            continue

        kept, dropped = [], []
        for src in sources:
            (kept if src.lower() in allowed else dropped).append(src)
        if not kept:
            kept = ["'self'"]
        if dropped:
            removed.append(f"{name}: {' '.join(dropped)}")
        result[name] = kept
    return result


def ensure_defaults(directives):
    """Guarantee the script-src/object-src baseline MV3 expects."""
    if "script-src" not in directives:
        directives["script-src"] = ["'self'"]
    if "object-src" not in directives:
        directives["object-src"] = ["'self'"]
    return directives


def build_policy(manifest, removed):
    """Return a valid MV3 `content_security_policy` object for the manifest."""
    csp = manifest.get("content_security_policy")
    sandbox = manifest.get("sandbox")
    sandbox_source = None

    if isinstance(csp, dict):
        ext_source = csp.get("extension_pages", "")
        sandbox_source = csp.get("sandbox")
    elif isinstance(csp, str):
        ext_source = csp  # MV2 string form
    else:
        ext_source = ""

    # MV2 kept the sandbox CSP under top-level "sandbox".content_security_policy.
    if isinstance(sandbox, dict) and sandbox.get("content_security_policy"):
        sandbox_source = sandbox["content_security_policy"]

    extension_pages = sanitize_directives(
        parse_csp(ext_source), EXTENSION_SCRIPT_KEYWORDS, removed
    )
    extension_pages = ensure_defaults(extension_pages)

    policy = OrderedDict()
    policy["extension_pages"] = serialize_csp(extension_pages)
    if sandbox_source:
        sandbox_directives = sanitize_directives(
            parse_csp(sandbox_source), SANDBOX_SCRIPT_KEYWORDS, removed
        )
        policy["sandbox"] = serialize_csp(sandbox_directives)
    return policy


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", help="path to the extension's manifest.json")
    parser.add_argument(
        "--write",
        action="store_true",
        help="write the sanitized CSP back into the manifest",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print only the content_security_policy object as JSON",
    )
    args = parser.parse_args(argv)

    try:
        with open(args.manifest, encoding="utf-8") as f:
            manifest = json.load(f, object_pairs_hook=OrderedDict)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read {args.manifest}: {exc}", file=sys.stderr)
        return 1

    removed = []
    policy = build_policy(manifest, removed)

    if args.json:
        print(json.dumps(policy, indent=2))
    else:
        print("Valid MV3 content_security_policy:\n")
        print(json.dumps({"content_security_policy": policy}, indent=2))
        if removed:
            print("\nRemoved MV3-forbidden sources:")
            for item in removed:
                print(f"  - {item}")
        else:
            print("\nNo forbidden sources found — CSP was already MV3-valid.")

    if args.write:
        manifest["content_security_policy"] = policy
        # The MV2 top-level sandbox CSP is folded into content_security_policy.sandbox.
        sandbox = manifest.get("sandbox")
        if isinstance(sandbox, dict) and "content_security_policy" in sandbox:
            del sandbox["content_security_policy"]
            if not sandbox:
                del manifest["sandbox"]
        with open(args.manifest, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")
        print(f"\nWrote sanitized CSP to {args.manifest}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
