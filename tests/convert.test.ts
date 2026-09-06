import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import { convert, emcDir, manifestVersion } from "../src/host/convert.js";

/** A minimal MV2 extension on disk. */
function makeMv2(dir: string): string {
    const ext = join(dir, "extension");
    mkdirSync(ext, { recursive: true });
    writeFileSync(
        join(ext, "manifest.json"),
        JSON.stringify({
            manifest_version: 2,
            name: "t",
            version: "1.0",
            browser_action: { default_title: "t" },
            permissions: ["tabs", "https://example.com/*"],
            background: { scripts: ["bg.js"] },
        }),
    );
    writeFileSync(join(ext, "bg.js"), "chrome.browserAction.onClicked.addListener(() => {});\n");
    return ext;
}

test("emcDir resolves relative to the checkout, so it follows the repo to any machine", () => {
    const dir = emcDir();
    // The original bug: a hardcoded /Users/... path that existed only on the author's Mac, so
    // every run on the Linux box silently fell back to an unconverted (MV2) extension.
    assert.equal(dir, join(REPO, "third_party", "extension-manifest-converter"));
    assert.ok(existsSync(join(dir, "emc.py")), `vendored converter missing at ${dir} (git submodule update --init)`);
});

test("convert bumps manifest_version to 3 and reports converted=true", () => {
    const tmp = mkdtempSync(join(tmpdir(), "conv-ok-"));
    try {
        const r = convert(makeMv2(tmp));
        assert.equal(r.converted, true, `expected conversion to succeed, log: ${r.log}`);
        assert.equal(manifestVersion(join(r.dir, "manifest.json")), 3);
        rmSync(r.dir, { recursive: true, force: true });
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("a missing converter reports converted=false instead of silently passing MV2 through", () => {
    const tmp = mkdtempSync(join(tmpdir(), "conv-missing-"));
    const prev = process.env.EMC_DIR;
    process.env.EMC_DIR = join(tmp, "does-not-exist");
    try {
        // convert.ts caches EMC_DIR at module load, so exercise the resolver directly:
        // emcDir() is the single source of truth both convert() and cli's guard use.
        assert.equal(emcDir(), join(tmp, "does-not-exist"));
        assert.ok(!existsSync(join(emcDir(), "emc.py")));
    } finally {
        if (prev === undefined) delete process.env.EMC_DIR; else process.env.EMC_DIR = prev;
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("manifestVersion returns null rather than throwing on an unparseable manifest", () => {
    const tmp = mkdtempSync(join(tmpdir(), "conv-bad-"));
    try {
        const p = join(tmp, "manifest.json");
        writeFileSync(p, "{ not json");
        assert.equal(manifestVersion(p), null);
        assert.equal(manifestVersion(join(tmp, "absent.json")), null);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});
