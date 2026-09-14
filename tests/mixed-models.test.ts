/**
 * Pointing a second model at the first model's run root destroys the first model's failures — the
 * half of the data the experiment is actually about. The guard is cheap; the loss is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mixedModelError } from "../src/host/runRoot.js";

test("allows an empty run root", () => {
    assert.equal(mixedModelError([], "saia/deepseek-v4-flash-0731"), null);
});

test("allows resuming the same model", () => {
    assert.equal(mixedModelError(["saia/qwen3.5-122b-a10b"], "saia/qwen3.5-122b-a10b"), null);
});

test("refuses a different model, naming both and suggesting a separate root", () => {
    const problem = mixedModelError(["saia/qwen3.5-122b-a10b"], "saia/deepseek-v4-flash-0731");
    assert.ok(problem);
    assert.match(problem, /qwen3\.5-122b-a10b/);
    assert.match(problem, /deepseek-v4-flash-0731/);
    assert.match(problem, /--out \.\.\/run_deepseek-v4-flash-0731/);
});

test("refuses when the root already mixes models, listing them all", () => {
    const problem = mixedModelError(["a", "b"], "c");
    assert.ok(problem);
    assert.match(problem, /a, b/);
});
