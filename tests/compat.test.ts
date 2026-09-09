import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeCompat, formatCompat } from "../src/host/compat.js";

/** Build an extension on disk from a {relative path: contents} map. */
function ext(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "compat-"));
    for (const [rel, body] of Object.entries(files)) {
        const full = join(dir, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body, null, 2));
    }
    return dir;
}
const keys = async (dir: string) => (await analyzeCompat(dir)).findings.map((f) => f.key);

const mv3 = {
    manifest_version: 3,
    name: "x",
    version: "1.0",
    action: {},
    background: { service_worker: "sw.js" },
};

test("clean MV3 extension has no findings and no hard blocker", async () => {
    const r = await analyzeCompat(ext({ "manifest.json": mv3, "sw.js": "chrome.runtime.onInstalled.addListener(() => {});\n" }));
    assert.deepEqual(r.findings, []);
    assert.equal(r.hasHardBlocker, false);
    assert.equal(formatCompat(r), "");
});

test("webRequestBlocking is a HARD blocker with a citable constraint", async () => {
    const r = await analyzeCompat(
        ext({
            "manifest.json": { ...mv3, permissions: ["webRequestBlocking"] },
            "sw.js": "",
        }),
    );
    const hard = r.findings.filter((f) => f.severity === "HARD");
    assert.equal(hard.length, 1);
    assert.equal(hard[0].key, "webRequestBlocking");
    assert.equal(hard[0].source, "mv3");
    assert.match(hard[0].mdnUrl!, /^https:\/\//);
    assert.equal(r.hasHardBlocker, true);
});

// BCD is keyed by browser, not manifest version: Chrome still "has" these, so only the MV3
// overlay can flag them. This is the regression that matters if the overlay is ever dropped.
test("MV2 manifest keys are reported as SOFT, not missed", async () => {
    const found = await keys(
        ext({
            "manifest.json": {
                manifest_version: 2,
                name: "x",
                version: "1.0",
                browser_action: { default_popup: "p.html" },
                background: { scripts: ["bg.js"], persistent: true },
                content_security_policy: "script-src 'self' 'unsafe-eval'",
            },
            "bg.js": "",
            "p.html": "<html></html>",
        }),
    );
    for (const k of ["browser_action", "background.scripts", "background.persistent", "content_security_policy"])
        assert.ok(found.includes(k), `missing ${k}`);
});

test("MV3 object-form CSP is not flagged", async () => {
    const found = await keys(
        ext({
            "manifest.json": { ...mv3, content_security_policy: { extension_pages: "script-src 'self'" } },
            "sw.js": "",
        }),
    );
    assert.ok(!found.includes("content_security_policy"));
});

test("an API that does not exist in Chrome is flagged from source, with a location", async () => {
    const r = await analyzeCompat(
        ext({
            "manifest.json": mv3,
            "sw.js": "chrome.runtime.onInstalled.addListener(() => {});\nchrome.totallyMadeUpApi.doThing();\n",
        }),
    );
    const api = r.findings.find((f) => f.kind === "api");
    assert.ok(api, "expected an api finding");
    assert.equal(api!.source, "bcd");
    assert.equal(api!.file?.endsWith("sw.js"), true);
    assert.equal(api!.line, 2);
});

test("a directory with no manifest yields an empty report instead of throwing", async () => {
    const r = await analyzeCompat(ext({ "notes.txt": "nothing here" }));
    assert.deepEqual(r.findings, []);
    assert.equal(r.hasHardBlocker, false);
});
