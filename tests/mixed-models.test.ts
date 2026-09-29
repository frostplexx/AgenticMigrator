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

// The guard used to fire on the case it exists to allow: outcomes recorded the bare model id while
// LLM_MODEL carries the provider, so every resume of a run root with results exited 64 telling you
// to use a different --out. Rows written now carry the full spec; legacy bare rows still match.
test("allows resuming a root whose rows predate the provider prefix", () => {
    assert.equal(mixedModelError(["deepseek-v4-flash-0731"], "saia/deepseek-v4-flash-0731"), null);
});

test("still refuses two providers serving the same model id", () => {
    // Tolerating this would let them share a root and overwrite each other, which is the whole loss.
    const problem = mixedModelError(["ollama/gemma4:31b"], "saia/gemma4:31b");
    assert.ok(problem);
    assert.match(problem, /ollama\/gemma4:31b/);
});

test("does not match a bare row against a different model", () => {
    assert.ok(mixedModelError(["qwen3.5-122b-a10b"], "saia/deepseek-v4-flash-0731"));
});
