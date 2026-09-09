import { test } from "node:test";
import assert from "node:assert/strict";
import { isInvalidInstance, scoreBehaviour, unpackedExtensionId, type BehaviourReport, type CheckResult } from "../src/container/behaviour.js";

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

test("invalid instances are the ones the baseline could not grade", () => {
    assert.equal(isInvalidInstance(report([], false)), true);
    assert.equal(isInvalidInstance(report([fail("background_alive"), na("popup_renders")])), true);
    assert.equal(isInvalidInstance(report([pass("background_alive")])), false);
});

test("unpacked extension id is a stable 32-char a-p string keyed on the path", () => {
    const id = unpackedExtensionId("/work/out");
    assert.match(id, /^[a-p]{32}$/);
    assert.equal(id, unpackedExtensionId("/work/out/"));
    assert.notEqual(id, unpackedExtensionId("/work/original"));
});
