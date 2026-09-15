/**
 * The change ledger answers the question the old counters could not: not "how many offscreen
 * documents did we inject" but "how many should we have". The cases below are the ones where a
 * careless detector would report the wrong half of that pair.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChangeLedger, summarizeLedger, type ChangeId, type ChangeRecord } from "../src/host/changes.js";
import { buildTags, countByKind, ledgerTags, repairTags } from "../src/host/tags.js";

/** A throwaway pair of extension trees. Each test gets its own root. */
function trees(files: { input: Record<string, string | object>; output: Record<string, string | object> }): {
    input: string;
    output: string;
} {
    const root = mkdtempSync(join(tmpdir(), "ledger-"));
    const write = (name: string, contents: Record<string, string | object>): string => {
        const dir = join(root, name);
        mkdirSync(dir, { recursive: true });
        for (const [path, content] of Object.entries(contents)) {
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

test("reports a change that was needed and made", () => {
    const { input, output } = trees({
        input: { "manifest.json": { manifest_version: 2, background: { scripts: ["bg.js"] } } },
        output: { "manifest.json": { manifest_version: 3, background: { service_worker: "bg.js" } } },
    });
    const sw = record(buildChangeLedger(input, output), "background_service_worker");
    assert.equal(sw.needed, true);
    assert.equal(sw.applied, true);
});

test("reports a change that was needed and silently skipped", () => {
    // The cell the whole ledger exists for.
    const { input, output } = trees({
        input: { "manifest.json": { manifest_version: 2, background: { scripts: ["bg.js"] } } },
        output: { "manifest.json": { manifest_version: 3, background: { scripts: ["bg.js"] } } },
    });
    const sw = record(buildChangeLedger(input, output), "background_service_worker");
    assert.equal(sw.needed, true);
    assert.equal(sw.applied, false);
});

test("does not claim a change was needed when the original never had the construct", () => {
    const { input, output } = trees({
        input: { "manifest.json": { manifest_version: 2 } },
        output: { "manifest.json": { manifest_version: 3 } },
    });
    assert.equal(record(buildChangeLedger(input, output), "action_rename").needed, false);
});

test("blocking webRequest is needed from the permission alone", () => {
    const { input, output } = trees({
        input: { "manifest.json": { manifest_version: 2, permissions: ["webRequest", "webRequestBlocking"] } },
        output: { "manifest.json": { manifest_version: 3 } },
    });
    const dnr = record(buildChangeLedger(input, output), "webrequest_to_dnr");
    assert.equal(dnr.needed, true);
    assert.equal(dnr.applied, false);
});

test("blocking webRequest counts as applied when the output declares DNR", () => {
    const { input, output } = trees({
        input: { "manifest.json": { manifest_version: 2, permissions: ["webRequestBlocking"] } },
        output: { "manifest.json": { manifest_version: 3, permissions: ["declarativeNetRequest"] } },
    });
    assert.equal(record(buildChangeLedger(input, output), "webrequest_to_dnr").applied, true);
});

test("an offscreen document is needed when background code touches the DOM", () => {
    const { input, output } = trees({
        input: {
            "manifest.json": { manifest_version: 2, background: { scripts: ["bg.js"] } },
            "bg.js": "const el = document.createElement('canvas');",
        },
        output: { "manifest.json": { manifest_version: 3 } },
    });
    const offscreen = record(buildChangeLedger(input, output), "offscreen_document");
    assert.equal(offscreen.needed, true);
    assert.equal(offscreen.evidence[0]?.file, "bg.js");
});

test("an offscreen document is not needed for DOM use in a content script", () => {
    // Content scripts keep their DOM under MV3; only the background lost one.
    const { input, output } = trees({
        input: {
            "manifest.json": { manifest_version: 2, background: { scripts: ["bg.js"] } },
            "bg.js": "chrome.runtime.onMessage.addListener(() => {});",
            "content.js": "document.querySelector('body');",
        },
        output: { "manifest.json": { manifest_version: 3 } },
    });
    assert.equal(record(buildChangeLedger(input, output), "offscreen_document").needed, false);
});

test("the summary splits applied from skipped, and they add up", () => {
    const { input, output } = trees({
        input: {
            "manifest.json": {
                manifest_version: 2,
                browser_action: { default_popup: "p.html" },
                background: { scripts: ["bg.js"] },
            },
        },
        output: {
            "manifest.json": {
                manifest_version: 3,
                action: { default_popup: "p.html" },
                background: { scripts: ["bg.js"] },
            },
        },
    });
    const summary = summarizeLedger(buildChangeLedger(input, output));
    assert.ok(summary.applied > 0);
    assert.ok(summary.skipped > 0);
    assert.equal(summary.needed, summary.applied + summary.skipped);
});

test("a skipped change is tagged with the evidence for the need", () => {
    const records: ChangeRecord[] = [
        {
            id: "webrequest_to_dnr",
            title: "blocking webRequest → DNR",
            needed: true,
            applied: false,
            evidence: [{ file: "bg.js", line: 3 }],
        },
    ];
    const [tag] = ledgerTags(records);
    assert.equal(tag.tag, "skipped.webrequest_to_dnr");
    assert.equal(tag.kind, "skipped");
    assert.equal(tag.evidence?.[0]?.file, "bg.js");
});

test("a change is attributed to repair only when it appeared after the repair round", () => {
    // The output tree alone cannot say when something appeared, so repair is a diff.
    const before: ChangeRecord[] = [{ id: "action_rename", title: "t", needed: true, applied: false, evidence: [] }];
    const after: ChangeRecord[] = [{ id: "action_rename", title: "t", needed: true, applied: true, evidence: [] }];
    assert.deepEqual(
        repairTags(before, after).map((t) => t.tag),
        ["repair.action_rename"],
    );
    assert.deepEqual(repairTags(after, after), []);
});

test("minified, bundled and obfuscated sources are tagged", () => {
    // A failure on a 2MB minified bundle is a different observation from one on readable source.
    const { input, output } = trees({
        input: {
            "manifest.json": { manifest_version: 2 },
            "app.js": `var _0x1a2b=1;${"x".repeat(600)}\nwebpackJsonp([],[]);`,
        },
        output: { "manifest.json": { manifest_version: 3 } },
    });
    const names = buildTags({ inputDir: input, outputDir: output }).tags.map((t) => t.tag);
    assert.ok(names.includes("source.minified"));
    assert.ok(names.includes("source.bundled"));
    assert.ok(names.includes("source.obfuscated"));
});

test("an abstention is recorded as a skip carrying its reason", () => {
    const { input, output } = trees({
        input: { "manifest.json": { manifest_version: 2 } },
        output: { "manifest.json": { manifest_version: 3 } },
    });
    const { tags } = buildTags({ inputDir: input, outputDir: output, abstainReason: "blocking webRequest" });
    const abstain = tags.find((t) => t.tag === "skipped.agent_abstained");
    assert.equal(abstain?.kind, "skipped");
    assert.ok(abstain?.evidence?.[0]?.snippet?.includes("blocking webRequest"));
});

test("tags count by kind", () => {
    const counts = countByKind([
        { tag: "a", kind: "applied", title: "" },
        { tag: "b", kind: "skipped", title: "" },
        { tag: "c", kind: "skipped", title: "" },
    ]);
    assert.deepEqual(counts, { applied: 1, skipped: 2, repair: 0, spurious: 0, misc: 0 });
});

test("a change applied without being needed is tagged spurious", () => {
    // The case that actually happened: the harness demanded a service worker of an extension that
    // never had a background, and the model wrote one to satisfy it.
    const records: ChangeRecord[] = [
        {
            id: "background_service_worker",
            title: "background page/scripts → service worker",
            needed: false,
            applied: true,
            evidence: [],
        },
    ];
    const [tag] = ledgerTags(records);
    assert.equal(tag.tag, "spurious.background_service_worker");
    assert.equal(tag.kind, "spurious");
});

test("counts spurious changes separately from applied ones", () => {
    const counts = countByKind([
        { tag: "a", kind: "applied", title: "" },
        { tag: "b", kind: "spurious", title: "" },
    ]);
    assert.equal(counts.applied, 1);
    assert.equal(counts.spurious, 1);
});
