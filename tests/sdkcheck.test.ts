/**
 * The SDK probe exists because a stale `file:` dependency copy is indistinguishable from a broken
 * analyzer at the UI, and that ambiguity cost two debugging sessions. These tests pin what it
 * accepts and what it must reject.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSdk } from "../src/extlens/sdkCheck.js";

test("passes against the SDK this checkout builds against", () => {
    // If this fails locally, the local extlens build is stale — which is exactly the point.
    const result = checkSdk();
    assert.equal(result.ok, true, result.detail);
    assert.match(result.detail, /popup/);
});

test("states the surfaces it saw, so a failure is diagnosable from the log alone", () => {
    assert.match(checkSdk().detail, /surfaces:/);
});
