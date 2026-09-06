import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkExtension, formatIssues } from "../src/container/checks.js";

/** Build an extension on disk from a {relative path: contents} map. */
function ext(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "checks-"));
    for (const [rel, body] of Object.entries(files)) {
        const full = join(dir, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body, null, 2));
    }
    return dir;
}
const ids = (dir: string) => checkExtension(dir).map((i) => i.id);
const clean = {
    manifest_version: 3,
    name: "t",
    version: "1.0",
    action: { default_popup: "popup.html" },
    background: { service_worker: "sw.js" },
    permissions: ["storage"],
    host_permissions: ["https://example.com/*"],
};

test("a clean MV3 extension produces no issues", () => {
    const d = ext({ "manifest.json": clean, "sw.js": "chrome.runtime.onInstalled.addListener(() => {});", "popup.html": "<html></html>" });
    try { assert.deepEqual(checkExtension(d), []); } finally { rmSync(d, { recursive: true, force: true }); }
});

test("catches the MV2 manifest leftovers Chrome rejects", () => {
    const d = ext({
        "manifest.json": {
            manifest_version: 2, name: "t", version: "1",
            background: { scripts: ["bg.js"], persistent: true },
            browser_action: { default_title: "t" },
            permissions: ["tabs", "https://a.com/*", "webRequestBlocking"],
            content_security_policy: "script-src 'self'",
            web_accessible_resources: ["x.js"],
        },
        "bg.js": "",
    });
    try {
        const found = ids(d);
        for (const id of ["manifest-version", "background-scripts", "background-persistent",
                          "legacy-action-key", "url-in-permissions", "removed-permission",
                          "csp-string", "war-flat-array"]) {
            assert.ok(found.includes(id), `expected ${id}, got ${found.join(", ")}`);
        }
    } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a string icon path is not mistaken for a map of per-character paths", () => {
    // Regression: Object.values("icon.png") yields characters, which reported one icon as a
    // dozen missing files and buried every real finding.
    const d = ext({
        "manifest.json": { ...clean, icons: "icon.png", action: { default_icon: "icon.png", default_popup: "popup.html" } },
        "sw.js": "", "popup.html": "", "icon.png": "x",
    });
    try { assert.deepEqual(ids(d), []); } finally { rmSync(d, { recursive: true, force: true }); }
});

test("flags manifest paths that do not exist", () => {
    const d = ext({ "manifest.json": clean, "sw.js": "" });
    try {
        const issues = checkExtension(d);
        assert.ok(issues.some((i) => i.id === "missing-file" && i.message.includes("popup.html")));
    } finally { rmSync(d, { recursive: true, force: true }); }
});

test("validates declarativeNetRequest rulesets and rule shape", () => {
    const d = ext({
        "manifest.json": { ...clean, action: undefined, declarative_net_request: { rule_resources: [{ path: "rules.json" }] } },
        "sw.js": "",
        "rules.json": [{ id: "one", action: { type: "redirect", redirect: {} }, condition: { urlFilter: "a" } }],
    });
    try {
        const found = ids(d);
        assert.ok(found.includes("dnr-ruleset-keys"), "missing id+enabled must be flagged");
        assert.ok(found.includes("dnr-rule-id"), "non-integer rule id must be flagged");
        assert.ok(found.includes("dnr-redirect-shape"), "redirect without redirect.url must be flagged");
    } finally { rmSync(d, { recursive: true, force: true }); }
});

test("flags worker-illegal globals only inside the service worker's own files", () => {
    const d = ext({
        "manifest.json": clean,
        "sw.js": "importScripts('lib.js');\nlocalStorage.setItem('a', 1);\n",
        "lib.js": "document.createElement('a');\n",
        "popup.html": "",
        "content.js": "document.body.innerHTML = '';\n", // legal: content scripts have a DOM
    });
    try {
        const issues = checkExtension(d).filter((i) => i.id === "sw-banned-global");
        assert.ok(issues.some((i) => i.file === "sw.js"), "localStorage in the worker");
        assert.ok(issues.some((i) => i.file === "lib.js"), "importScripts'd file runs in the worker too");
        assert.ok(!issues.some((i) => i.file === "content.js"), "content scripts legitimately use the DOM");
    } finally { rmSync(d, { recursive: true, force: true }); }
});

test("remote scripts are flagged in extension pages but not in bundled sample pages", () => {
    const d = ext({
        "manifest.json": clean, "sw.js": "",
        "popup.html": '<script src="https://cdn.example.com/x.js"></script>',
        "samples/saved.html": '<script src="https://cdn.example.com/x.js"></script>',
    });
    try {
        const remote = checkExtension(d).filter((i) => i.id === "remote-script");
        assert.deepEqual(remote.map((i) => i.file), ["popup.html"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
});

test("repeated hits in one file are capped and summarised rather than flooding the prompt", () => {
    const d = ext({
        "manifest.json": clean, "popup.html": "",
        "sw.js": Array.from({ length: 40 }, (_, i) => `document.getElementById('e${i}');`).join("\n"),
    });
    try {
        const issues = checkExtension(d).filter((i) => i.id === "sw-banned-global");
        assert.ok(issues.length <= 5, `expected the cap to apply, got ${issues.length}`);
        assert.ok(issues.some((i) => /more occurrences/.test(i.message)), "the remainder must still be mentioned");
    } finally { rmSync(d, { recursive: true, force: true }); }
});

test("formatIssues renders location, problem and fix, and caps its output", () => {
    const d = ext({ "manifest.json": { ...clean, manifest_version: 2 }, "sw.js": "", "popup.html": "" });
    try {
        const text = formatIssues(checkExtension(d));
        assert.match(text, /\[error\] manifest\.json/);
        assert.match(text, /FIX: /);
        assert.equal(formatIssues(checkExtension(d), 0), "");
    } finally { rmSync(d, { recursive: true, force: true }); }
});
