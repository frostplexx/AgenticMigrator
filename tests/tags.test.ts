/**
 * The tag vocabulary beyond "applied": a skip has a reason, a repair has a footprint, and the
 * sample has a shape. Each case below is one the flat applied/skipped split could not express.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChangeLedger, type ChangeId, type ChangeRecord } from "../src/host/changes.js";
import {
    blockerTags,
    buildTags,
    countSkipsByReason,
    detectSurfaces,
    diffSnapshots,
    ledgerTags,
    repairTags,
    snapshotTree,
} from "../src/host/tags.js";

function trees(files: { input: Record<string, string | object>; output: Record<string, string | object> }): {
    input: string;
    output: string;
} {
    const root = mkdtempSync(join(tmpdir(), "tags-"));
    const write = (name: string, contents: Record<string, string | object>): string => {
        const dir = join(root, name);
        mkdirSync(dir, { recursive: true });
        for (const [path, content] of Object.entries(contents)) {
            mkdirSync(join(dir, path, ".."), { recursive: true });
            writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content, null, 2));
        }
        return dir;
    };
    const paths = { input: write("in", files.input), output: write("out", files.output) };
    process.on("exit", () => rmSync(root, { recursive: true, force: true }));
    return paths;
}

function record(records: ChangeRecord[], id: ChangeId): ChangeRecord {
    const found = records.find((r) => r.id === id);
    assert.ok(found, `no record for ${id}`);
    return found;
}

const skip = (id: ChangeId, evidence: ChangeRecord["evidence"] = []): ChangeRecord => ({
    id,
    title: id,
    support: "full",
    needed: true,
    applied: false,
    evidence,
});

// --- skipped: with a reason -------------------------------------------------------------------

test("a skip of a change MV3 cannot express is the platform's, with the citable constraint", () => {
    const [tag] = ledgerTags([skip("webrequest_response_inspection", [{ file: "bg.js", line: 4 }])]);
    assert.equal(tag.kind, "skipped");
    assert.equal(tag.reason, "platform");
    assert.ok(tag.evidence?.some((e) => e.file.startsWith("https://developer.chrome.com/")));
    assert.ok(tag.evidence?.some((e) => e.file === "bg.js"));
});

test("a skip of a fully supported change with nothing to account for it is unexplained", () => {
    const [tag] = ledgerTags([skip("action_rename")]);
    assert.equal(tag.reason, "unexplained");
});

test("a skip the agent's abstention names is attributed to the agent", () => {
    const [tag] = ledgerTags([skip("offscreen_document")], "REASON: the background renders a canvas via the DOM");
    assert.equal(tag.reason, "abstained");
    assert.ok(tag.evidence?.some((e) => e.file === "ABSTAIN.md"));
});

test("an abstention outranks 'limited': the agent's claim about this extension beats the table", () => {
    const [tag] = ledgerTags([skip("webrequest_to_dnr")], "REASON: the block decision reads the request body");
    assert.equal(tag.reason, "abstained");
});

test("a removal-type change is not applied when there was nothing to remove", () => {
    const { input, output } = trees({
        input: { "manifest.json": { manifest_version: 2 } },
        output: { "manifest.json": { manifest_version: 3 } },
    });
    const ledger = buildChangeLedger(input, output);
    for (const id of ["csp_object_form", "background_persistent_removed", "web_accessible_resources_v3"] as const) {
        assert.equal(record(ledger, id).applied, false, `${id} applied vacuously`);
    }
    assert.ok(!ledgerTags(ledger).some((t) => t.kind === "spurious"));
});

test("an abstention about something else does not explain an unrelated skip", () => {
    const [tag] = ledgerTags([skip("action_rename")], "REASON: blocking webRequest cannot be ported");
    assert.equal(tag.reason, "unexplained");
});

test("skips count by reason", () => {
    const tags = ledgerTags(
        [skip("webrequest_response_inspection"), skip("action_rename"), skip("offscreen_document")],
        "REASON: DOM in the background",
    );
    assert.deepEqual(countSkipsByReason(tags), { platform: 1, abstained: 1, limited: 0, unexplained: 1 });
});

test("a HARD compat blocker the ledger does not model is a platform skip of its own", () => {
    const tags = blockerTags([{ key: "tabs.getSelected", file: "bg.js", line: 9, mdnUrl: "https://mdn/x" }], []);
    assert.equal(tags.length, 1);
    assert.equal(tags[0].tag, "skipped.tabs_getSelected");
    assert.equal(tags[0].reason, "platform");
});

test("a HARD compat blocker the ledger already models is not tagged twice", () => {
    const records = [skip("webrequest_to_dnr")];
    assert.deepEqual(blockerTags([{ key: "webRequestBlocking" }], records), []);
});

// --- the webRequest split ---------------------------------------------------------------------

test("a blocking header rewrite is its own change, separate from block/redirect", () => {
    const { input, output } = trees({
        input: {
            "manifest.json": { manifest_version: 2, permissions: ["webRequest", "webRequestBlocking"], background: { scripts: ["bg.js"] } },
            "bg.js": `chrome.webRequest.onBeforeSendHeaders.addListener(d => ({ requestHeaders: d.requestHeaders }), {urls: ["<all_urls>"]}, ["blocking", "requestHeaders"]);`,
        },
        output: {
            "manifest.json": { manifest_version: 3, permissions: ["declarativeNetRequest"], declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "rules.json" }] } },
            "rules.json": [{ id: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "x", operation: "set", value: "1" }] }, condition: {} }],
        },
    });
    const ledger = buildChangeLedger(input, output);
    assert.equal(record(ledger, "webrequest_to_dnr").applied, true);
    const headers = record(ledger, "webrequest_header_modification");
    assert.equal(headers.needed, true);
    assert.equal(headers.applied, true);
    assert.equal(headers.support, "partial");
});

test("DNR without modifyHeaders leaves a header rewrite skipped, and the skip is marked limited, not excused", () => {
    const { input, output } = trees({
        input: {
            "manifest.json": { manifest_version: 2, permissions: ["webRequestBlocking"], background: { scripts: ["bg.js"] } },
            "bg.js": `chrome.webRequest.onHeadersReceived.addListener(f, {}, ["blocking", "responseHeaders"]);`,
        },
        output: { "manifest.json": { manifest_version: 3, permissions: ["declarativeNetRequest"] } },
    });
    const { tags } = buildTags({ inputDir: input, outputDir: output });
    const tag = tags.find((t) => t.tag === "skipped.webrequest_header_modification");
    assert.equal(tag?.reason, "limited");
    assert.ok(tag?.evidence?.some((e) => e.file.includes("declarativeNetRequest")), "carries the constraint to read against");
    assert.ok(tags.some((t) => t.tag === "change.webrequest_to_dnr"));
});

test("response inspection is needed from the original and can never be applied", () => {
    const { input, output } = trees({
        input: {
            "manifest.json": { manifest_version: 2, permissions: ["webRequestBlocking"] },
            "bg.js": `const f = chrome.webRequest.filterResponseData(d.requestId);`,
        },
        output: { "manifest.json": { manifest_version: 3 } },
    });
    const r = record(buildChangeLedger(input, output), "webrequest_response_inspection");
    assert.equal(r.needed, true);
    assert.equal(r.applied, false);
    assert.equal(r.support, "none");
});

test("block/redirect without any header handling does not claim a header rewrite was needed", () => {
    const { input, output } = trees({
        input: {
            "manifest.json": { manifest_version: 2, permissions: ["webRequestBlocking"] },
            "bg.js": `chrome.webRequest.onBeforeRequest.addListener(() => ({cancel: true}), {}, ["blocking"]);`,
        },
        output: { "manifest.json": { manifest_version: 3 } },
    });
    assert.equal(record(buildChangeLedger(input, output), "webrequest_header_modification").needed, false);
});

// --- eval -----------------------------------------------------------------------------------

test("string evaluation is a change: needed when the original evals, applied when the output does not", () => {
    const { input, output } = trees({
        input: { "manifest.json": { manifest_version: 2 }, "a.js": `const fn = new Function("return 1");` },
        output: { "manifest.json": { manifest_version: 3 }, "a.js": `const fn = () => 1;` },
    });
    const r = record(buildChangeLedger(input, output), "eval_removed");
    assert.equal(r.needed, true);
    assert.equal(r.applied, true);
});

// --- repair: what the LLM touched ---------------------------------------------------------------

test("a tree snapshot diff names added, removed and rewritten files", () => {
    const { input, output } = trees({
        input: { "a.js": "1", "b.js": "2", "gone.js": "3" },
        output: { "a.js": "1", "b.js": "changed", "new.js": "4" },
    });
    assert.deepEqual(diffSnapshots(snapshotTree(input), snapshotTree(output)), ["b.js", "gone.js", "new.js"]);
});

test("repair edits are tagged by the role of the file, even when no ledger change flipped", () => {
    // The case the ledger diff cannot see: a global-variable fix inside the worker.
    const { input, output } = trees({
        input: { "manifest.json": { manifest_version: 3, background: { service_worker: "sw.js" } }, "sw.js": "let count = 0;", "popup.js": "a" },
        output: {
            "manifest.json": { manifest_version: 3, background: { service_worker: "sw.js" }, action: { default_popup: "popup.html" } },
            "sw.js": "chrome.storage.session.get('count');",
            "popup.js": "b",
            "popup.html": "<script src=popup.js></script>",
        },
    });
    const ledger: ChangeRecord[] = [];
    const manifest = { manifest_version: 3, background: { service_worker: "sw.js" }, action: { default_popup: "popup.html" } };
    const tags = repairTags(ledger, ledger, { before: snapshotTree(input), after: snapshotTree(output), manifest });
    const names = tags.map((t) => t.tag);
    assert.ok(names.includes("repair.files_edited"));
    assert.ok(names.includes("repair.manifest_edited"));
    assert.ok(names.includes("repair.background_edited"));
    assert.ok(names.includes("repair.ui_page_edited"), "popup.js follows popup.html's role");
    assert.ok(!names.includes("repair.content_script_edited"));
});

test("a ledger change that flipped during repair is still attributed as before", () => {
    const before: ChangeRecord[] = [{ ...skip("storage_over_dom_state") }];
    const after: ChangeRecord[] = [{ ...skip("storage_over_dom_state"), applied: true }];
    assert.deepEqual(
        repairTags(before, after).map((t) => t.tag),
        ["repair.storage_over_dom_state"],
    );
});

test("no repair tags when the tree did not change", () => {
    const { input } = trees({ input: { "a.js": "1" }, output: {} });
    const snap = snapshotTree(input);
    assert.deepEqual(repairTags([], [], { before: snap, after: snap }), []);
});

// --- misc: what the sample is made of ---------------------------------------------------------

test("surfaces are detected from the manifest and from API use", () => {
    const { input } = trees({
        input: {
            "manifest.json": {
                manifest_version: 2,
                browser_action: { default_popup: "p.html" },
                options_ui: { page: "o.html" },
                permissions: ["contextMenus"],
                content_scripts: [{ matches: ["https://*.example.com/*"], js: ["c.js"] }],
                background: { scripts: ["bg.js"] },
            },
            "bg.js": "chrome.omnibox.onInputEntered.addListener(f); chrome.notifications.create({});",
        },
        output: {},
    });
    const surfaces = detectSurfaces(input).map((s) => s.surface);
    for (const expected of ["popup", "options_page", "context_menu", "page_interaction", "background", "omnibox", "notifications"]) {
        assert.ok(surfaces.includes(expected as never), `missing ${expected}`);
    }
    assert.ok(!surfaces.includes("toolbar_action"), "an action with a popup is a popup, not a bare button");
});

test("buildTags emits one misc tag per surface without being told them", () => {
    const { input, output } = trees({
        input: { "manifest.json": { manifest_version: 2, permissions: ["contextMenus"], browser_action: {} } },
        output: { "manifest.json": { manifest_version: 3 } },
    });
    const names = buildTags({ inputDir: input, outputDir: output }).tags.map((t) => t.tag);
    assert.ok(names.includes("surface.context_menu"));
    assert.ok(names.includes("surface.toolbar_action"));
});

test("a shipped framework and WebAssembly are tagged", () => {
    const { input, output } = trees({
        input: {
            "manifest.json": { manifest_version: 2 },
            "vendor.js": "var jQuery = function(){}; jQuery.fn.jquery = '3.6.0';",
            "lib/core.wasm": "\0asm",
        },
        output: { "manifest.json": { manifest_version: 3 } },
    });
    const tags = buildTags({ inputDir: input, outputDir: output }).tags;
    assert.equal(tags.find((t) => t.tag === "source.framework")?.evidence?.[0]?.snippet, "jquery");
    assert.equal(tags.find((t) => t.tag === "source.wasm")?.evidence?.[0]?.file, "lib/core.wasm");
});
