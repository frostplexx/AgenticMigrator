/**
 * The difficulty summary that travels with a score.
 *
 * A score alone cannot be read: "1.0" from an extension needing twelve non-mechanical rewrites and
 * "1.0" from one needing none are the same cell, and every model-comparison question turns on
 * telling them apart. These cases are the ones where a careless summary would erase that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    CATEGORIES,
    MAX_RECORDED_SITES,
    sampleSites,
    summarizeAnalysis,
    type Finding,
    type Signal,
} from "../src/host/staticAnalyzer.js";

const finding = (file: string, line = 1): Finding => ({
    api: "chrome.browserAction.setTitle",
    replacement: "chrome.action.setTitle",
    file,
    line,
    snippet: "chrome.browserAction.setTitle({title: 'x'})",
});
const signal = (category: string, file: string): Signal => ({
    category,
    skill: CATEGORIES[category].skill,
    file,
    line: 1,
    snippet: "chrome.webRequest.onBeforeRequest.addListener",
});

test("counts the mechanical and non-mechanical halves separately", () => {
    // They are different questions: the prompt hands a finding its replacement, and hands a signal
    // only a hint. Summing them would hide which kind of work a model actually faced.
    const summary = summarizeAnalysis(
        [finding("a.js"), finding("a.js", 9)],
        [signal("blocking_webrequest", "bg.js"), signal("background_dom", "bg.js"), signal("background_dom", "c.js")],
    );
    assert.equal(summary.findingCount, 2);
    assert.equal(summary.signalCount, 3);
    assert.deepEqual(summary.signalsByCategory.background_dom, 2);
    assert.deepEqual(summary.signalsByCategory.blocking_webrequest, 1);
});

test("every category is present even at zero, so a corpus export has stable columns", () => {
    // A column that appears only when some extension triggered it makes two exports of the same
    // corpus undiffable, and makes "no extension needed this" indistinguishable from "not measured".
    const summary = summarizeAnalysis([], []);
    for (const key of Object.keys(CATEGORIES)) assert.equal(summary.signalsByCategory[key], 0, key);
});

test("counts distinct files across both kinds, not once per site", () => {
    // The question is how much of the extension the migration had to touch; three findings in one
    // file is one file's worth of risk, not three.
    const summary = summarizeAnalysis(
        [finding("bg.js"), finding("bg.js", 4), finding("popup.js")],
        [signal("remote_code", "bg.js")],
    );
    assert.equal(summary.filesAffected, 2);
});

test("an extension with nothing to do summarizes as zero, not as missing", () => {
    // Zero here is a real measurement — the converter left nothing behind — and it must survive
    // into the export as 0 rather than as a blank that reads as "not analysed".
    const summary = summarizeAnalysis([], []);
    assert.equal(summary.findingCount, 0);
    assert.equal(summary.signalCount, 0);
    assert.equal(summary.filesAffected, 0);
});

test("a bounded sample keeps every file represented, not the first file fifty times", () => {
    // A minified bundle can produce thousands of hits in one file. Slicing from the head would
    // report that one file and hide every other file the migration actually had to touch.
    const noisy = Array.from({ length: 3000 }, (_, i) => signal("remote_code", "vendor/jquery.js"));
    const rest = ["bg.js", "popup.js", "options.js"].map((f) => signal("background_dom", f));
    const sample = sampleSites([...noisy, ...rest]);
    assert.equal(sample.length, MAX_RECORDED_SITES);
    for (const file of ["bg.js", "popup.js", "options.js"]) {
        assert.ok(sample.some((s) => s.file === file), `${file} missing from the sample`);
    }
});

test("a scan under the cap is kept whole", () => {
    const sites = [finding("a.js"), finding("b.js")];
    assert.deepEqual(sampleSites(sites), sites);
});

test("the counts stay exact even when the sites are capped", () => {
    // The sample is evidence; the count is the measurement. Capping must never reach the number a
    // corpus table is built from.
    const many = Array.from({ length: 3402 }, () => signal("remote_code", "vendor/jquery.js"));
    assert.equal(summarizeAnalysis([], many).signalCount, 3402);
    assert.equal(sampleSites(many).length, MAX_RECORDED_SITES);
});
