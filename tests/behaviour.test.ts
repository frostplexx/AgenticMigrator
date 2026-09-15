import { test } from "node:test";
import assert from "node:assert/strict";
import {
    baselineUnavailable,
    isInvalidInstance,
    scoreBehaviour,
    unpackedExtensionId,
    type BehaviourReport,
    type CheckResult,
} from "../src/container/behaviour.js";

const report = (checks: CheckResult[], loaded = true): BehaviourReport => ({ loaded, checks });
const pass = (name: string): CheckResult => ({ name, status: "pass" });
const fail = (name: string): CheckResult => ({ name, status: "fail" });
const na = (name: string): CheckResult => ({ name, status: "na" });

test("score counts only checks the ORIGINAL passed", () => {
    // popup_renders was already broken in MV2, so losing it is not the migration's doing and
    // must not move the score.
    const s = scoreBehaviour(
        report([pass("background_alive"), pass("storage_roundtrip"), fail("popup_renders")]),
        report([pass("background_alive"), fail("storage_roundtrip"), fail("popup_renders")]),
    );
    assert.equal(s.denominator, 2);
    assert.equal(s.passed, 1);
    assert.equal(s.score, 0.5);
    assert.deepEqual(s.regressions, ["storage_roundtrip"]);
});

test("a preserved capability that became `na` counts as lost, not as a free pass", () => {
    // "the popup is gone from the manifest" is the silent-removal failure the score exists to
    // catch; treating na as neutral here would score it as a perfect migration.
    const s = scoreBehaviour(report([pass("popup_renders")]), report([na("popup_renders")]));
    assert.equal(s.score, 0);
    assert.deepEqual(s.regressions, ["popup_renders"]);
});

test("a check missing entirely from the post run is a regression", () => {
    const s = scoreBehaviour(report([pass("dnr_rulesets_enabled")]), report([]));
    assert.equal(s.score, 0);
    assert.deepEqual(s.regressions, ["dnr_rulesets_enabled"]);
});

test("score is null, not 0 or 1, when the baseline passed nothing", () => {
    const s = scoreBehaviour(report([fail("background_alive"), na("popup_renders")]), report([pass("background_alive")]));
    assert.equal(s.score, null);
    assert.equal(s.denominator, 0);
});

test("a fully preserved migration scores 1", () => {
    const s = scoreBehaviour(
        report([pass("background_alive"), pass("popup_renders")]),
        report([pass("background_alive"), pass("popup_renders"), fail("worker_survives_restart")]),
    );
    assert.equal(s.score, 1);
    assert.deepEqual(s.regressions, []);
});

test("invalid instances are the ones the baseline graded and found dead", () => {
    // A baseline that produced no checks at all is NOT an invalid instance: nothing was judged, so
    // there is nothing to call the extension broken for. That distinction is what keeps a missing
    // browser from labelling an entire corpus INVALID_INSTANCE.
    assert.equal(isInvalidInstance(report([], false)), false);
    assert.equal(baselineUnavailable(report([], false)), true);

    assert.equal(isInvalidInstance(report([fail("background_alive"), na("popup_renders")])), true);
    assert.equal(isInvalidInstance(report([pass("background_alive")])), false);
});

test("unpacked extension id is a stable 32-char a-p string keyed on the path", () => {
    const id = unpackedExtensionId("/work/out");
    assert.match(id, /^[a-p]{32}$/);
    assert.equal(id, unpackedExtensionId("/work/out/"));
    assert.notEqual(id, unpackedExtensionId("/work/original"));
});

test("a check the harness could not judge is excluded from the score, not counted as lost", () => {
    // A timeout means we did not look. Scoring it as a regression makes a flaky harness read as a
    // bad migration, which is the opposite conclusion.
    const baseline = report([
        { name: "popup_renders", status: "pass" },
        { name: "storage_roundtrip", status: "pass" },
    ]);
    const post = report([
        { name: "popup_renders", status: "pass" },
        { name: "storage_roundtrip", status: "error", detail: "timed out" },
    ]);
    const score = scoreBehaviour(baseline, post);
    assert.equal(score.score, 1);
    assert.equal(score.denominator, 1);
    assert.deepEqual(score.regressions, []);
    assert.deepEqual(score.inconclusive, ["storage_roundtrip"]);
});

test("an unavailable baseline is a harness failure, never an invalid instance", () => {
    // The case that mislabelled a whole run: current Chrome cannot load MV2, so every check
    // errored and every extension looked broken.
    const noBrowser: BehaviourReport = {
        loaded: false,
        checks: [{ name: "background_alive", status: "error", detail: "no MV2-capable browser (set CHROME_OLD)" }],
        error: "no MV2-capable browser available",
    };
    assert.equal(baselineUnavailable(noBrowser), true);
    assert.equal(isInvalidInstance(noBrowser), false);
});

test("an extension that genuinely does nothing is still an invalid instance", () => {
    const dead = report([
        { name: "background_alive", status: "fail" },
        { name: "popup_renders", status: "fail" },
    ]);
    assert.equal(baselineUnavailable(dead), false);
    assert.equal(isInvalidInstance(dead), true);
});

test("a baseline of only na checks is unavailable rather than invalid", () => {
    // Nothing was judged either way, so there is nothing to call the extension broken for.
    const nothing: BehaviourReport = { loaded: false, checks: [] };
    assert.equal(baselineUnavailable(nothing), true);
});

test("an extension with no reachable surface is ungradeable, not invalid", () => {
    // Measured on a real corpus extension: content-script-only, with match patterns that never
    // cover a page the harness can serve. Every check is `na` — nothing was tested, so there is no
    // evidence on which to call the original broken.
    const nothingToCheck = report([
        na("background_alive"),
        na("popup_renders"),
        na("content_script_injects"),
    ]);
    assert.equal(baselineUnavailable(nothingToCheck), true);
    assert.equal(isInvalidInstance(nothingToCheck), false);
});
