/**
 * The batch's stop condition. A wrong answer here is expensive in one direction and cheap in the
 * other: a missed wall costs the whole remaining corpus at 15 minutes an extension, while a false
 * one costs a rerun.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { quotaWallUntil } from "../src/host/runReport.js";
import type { RunReport } from "../src/host/runReport.js";

const report = (closedUntil: number | null | undefined): RunReport =>
    ({ passed: false, provider: { rateLimit: { closedUntil } } }) as RunReport;

test("reports the reopening time of a window that is still shut", () => {
    const until = Date.now() + 4 * 3600_000;
    const wall = quotaWallUntil(report(until));
    assert.ok(wall instanceof Date);
    assert.equal(wall.getTime(), until);
});

test("a window that has already reopened is not a wall", () => {
    // The run may have sat in verification for an hour after the wall lifted; the next extension
    // would sail through, so stopping the batch on it would be wrong.
    assert.equal(quotaWallUntil(report(Date.now() - 60_000)), null);
});

test("says nothing when the run hit no wall", () => {
    assert.equal(quotaWallUntil(report(null)), null);
    assert.equal(quotaWallUntil(report(undefined)), null);
});

test("survives a report from before this field existed, or a broken one", () => {
    // Every run in the corpus predates it, and an export must not crash on them.
    assert.equal(quotaWallUntil(null), null);
    assert.equal(quotaWallUntil({ passed: true } as RunReport), null);
    assert.equal(quotaWallUntil({ passed: false, provider: {} } as RunReport), null);
    assert.equal(quotaWallUntil(report(Number.NaN)), null);
    assert.equal(quotaWallUntil({ passed: false, provider: { rateLimit: { closedUntil: "soon" } } } as unknown as RunReport), null);
});
