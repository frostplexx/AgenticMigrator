import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MV2_API_RULES, residualTags, scanDir, scanRunRoot, scanText, type ResidualFamily } from "../scripts/mv2_residuals.js";

/** One JS line exercising every MV2-only form the skill's replacement table lists. */
const MV2_LINES: [ResidualFamily, string][] = [
    ["extension", "const port = chrome.extension.connect();"],
    ["extension", "chrome.extension.getURL('img.png');"],
    ["extension", "chrome.extension.sendMessage(msg, cb);"],
    ["extension", "chrome.extension.onRequest.addListener(fn);"],
    ["extension", "const tabs = chrome.extension.getExtensionTabs();"],
    ["tabs", "chrome.tabs.getSelected(null, tab => {});"],
    ["tabs", "chrome.tabs.getAllInWindow({}, cb);"],
    ["tabs", "chrome.tabs.sendRequest(id, msg, cb);"],
    ["tabs", "chrome.tabs.onActiveChanged.addListener(fn);"],
    ["browser_action", "chrome.browserAction.setBadgeText({ text: '3' });"],
    ["page_action", "chrome.pageAction.show(tab.id);"],
    ["runtime", "chrome.runtime.onSuspend.addListener(cleanup);"],
];

describe("mv2_residuals", () => {
    it("flags every MV2-only form from the mv3-semi-trivial skill table, with verbatim lines", () => {
        for (const [family, line] of MV2_LINES) {
            const found = scanText(line);
            assert.equal(found.length, 1, `expected one family for: ${line}`);
            assert.equal(found[0].family, family, line);
            assert.equal(found[0].hits[0].snippet, line);
            assert.equal(found[0].hits[0].line, 1);
        }
    });

    it("does not flag MV3-legal forms, including the skill's still-allowed members", () => {
        const clean = [
            "chrome.runtime.getURL('img.png');",
            "chrome.extension.getViews({ type: 'tab' });", // still legal per the skill table
            "if (chrome.extension.inIncognitoContext) return;", // ditto
            "chrome.runtime.onSuspendRemoved // near-miss naming",
            "chrome.scripting.executeScript({ target: { tabId } });",
            "await chrome.storage.local.get('k');",
        ].join("\n");
        assert.deepEqual(scanText(clean), []);
    });

    it("scanDir walks js/html and reports paths relative to the scanned dir", () => {
        const dir = mkdtempSync(join(tmpdir(), "mv2-res-"));
        try {
            writeFileSync(join(dir, "bg.js"), "chrome.extension.getURL('x');\n");
            mkdirSync(join(dir, "pages"));
            writeFileSync(join(dir, "pages", "popup.html"), "<script>chrome.browserAction.disable();</script>\n");
            writeFileSync(join(dir, "manifest.json"), '{"browser_action": {}}'); // manifest keys not scanned here
            const fams = scanDir(dir);
            assert.equal(fams.extension?.length, 1);
            assert.equal(fams.extension![0].file, "bg.js");
            assert.equal(fams.extension![0].line, 1);
            assert.equal(fams.browser_action?.length, 1);
            assert.equal(fams.browser_action![0].file, join("pages", "popup.html"));
            assert.equal(fams.tabs, undefined);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("residualTags emits family-level state.* tags with count and evidence", () => {
        const fams = scanText("chrome.tabs.getSelected();\nchrome.extension.connect();\n");
        const tags = residualTags(Object.fromEntries(fams.map((f) => [f.family, f.hits])));
        assert.deepEqual(tags.map((t) => t.tag).sort(), ["state.mv2_api_residual.extension", "state.mv2_api_residual.tabs"]);
        const tabs = tags.find((t) => t.tag === "state.mv2_api_residual.tabs")!;
        assert.match(tabs.title, /\(1 hit\)/);
        assert.equal(tabs.provenance, "scan");
        assert.equal(tabs.evidence[0].file, ":1");
        assert.equal(tabs.evidence[0].snippet, "chrome.tabs.getSelected();");
        assert.deepEqual(residualTags({}), []);
    });

    it("scanRunRoot handles the grouped run_test layout and skips non-extension children", () => {
        const root = mkdtempSync(join(tmpdir(), "mv2-root-"));
        try {
            // grouped layout: <root>/<model-run>/<extId>/out
            const model = join(root, "20261005-gemma");
            const ext = join(model, "a".repeat(32));
            mkdirSync(join(ext, "out"), { recursive: true });
            writeFileSync(join(ext, "out", "bg.js"), "chrome.extension.connect();");
            // flat layout: <root>/<extId>
            const flat = join(root, "b".repeat(32));
            mkdirSync(flat);
            writeFileSync(join(flat, "p.js"), "chrome.tabs.getSelected();");
            // non-extension children are skipped entirely
            mkdirSync(join(root, "blobs", "00"), { recursive: true });
            writeFileSync(join(root, "blobs", "00", "deadbeef"), "chrome.extension.getURL('x');");
            const byExt = scanRunRoot(root);
            assert.deepEqual(Object.keys(byExt).sort(), ["20261005-gemma/" + "a".repeat(32), "b".repeat(32)]);
            assert.equal(byExt["20261005-gemma/" + "a".repeat(32)]?.extension?.length, 1);
            assert.equal(byExt["b".repeat(32)]?.tabs?.length, 1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("every MV2 API rule maps to a distinct tag name", () => {
        const names = MV2_API_RULES.map((r) => `state.mv2_api_residual.${r.family}`);
        assert.equal(new Set(names).size, MV2_API_RULES.length);
    });
});
