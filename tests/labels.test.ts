/**
 * Label validation is the only thing standing between an adjudication pass and a pile of
 * unusable rows, so it runs at write time and these tests pin what it refuses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    FAILURE_LABELS,
    HARNESS_ASSIGNABLE,
    labelInstructions,
    validateAdjudication,
    type Adjudication,
} from "../src/host/labels.js";

const base: Adjudication = {
    extension: "abc",
    label: "SILENT_BEHAVIOUR_LOSS",
    description: "Loads as MV3 but the runtime.onMessage listener never registers.",
    evidence: [{ file: "background.js", line: 12, snippet: "chrome.runtime.onMessage" }],
    annotator: "human:daniel",
    adjudicatedAt: "2026-09-14T00:00:00.000Z",
};

test("accepts a complete adjudication", () => {
    assert.deepEqual(validateAdjudication(base), []);
});

test("refuses a label outside the closed set", () => {
    // An open set drifts until two annotators stop agreeing.
    const issues = validateAdjudication({ ...base, label: "SOMETHING_ELSE" as never });
    assert.ok(issues.some((i) => i.field === "label"));
});

test("refuses IMPOSSIBLE_PLATFORM without a citable constraint", () => {
    // Without the URL the label degrades into "the annotator found it hard".
    const issues = validateAdjudication({ ...base, label: "IMPOSSIBLE_PLATFORM" });
    assert.ok(issues.some((i) => i.field === "constraintUrl"));

    const withUrl = validateAdjudication({
        ...base,
        label: "IMPOSSIBLE_PLATFORM",
        constraintUrl: "https://developer.chrome.com/docs/extensions/develop/migrate/known-issues",
    });
    assert.deepEqual(withUrl, []);
});

test("refuses POSSIBLE_MODEL_FAILED without the run that proves it", () => {
    const issues = validateAdjudication({ ...base, label: "POSSIBLE_MODEL_FAILED" });
    assert.ok(issues.some((i) => i.field === "provenBy"));
});

test("requires evidence and a description worth checking", () => {
    assert.ok(validateAdjudication({ ...base, evidence: [] }).some((i) => i.field === "evidence"));
    assert.ok(validateAdjudication({ ...base, description: "broken" }).some((i) => i.field === "description"));
});

test("requires an annotator that says who or what decided", () => {
    // Agreement between an LLM pass and a human sample cannot be measured otherwise.
    assert.ok(validateAdjudication({ ...base, annotator: "daniel" }).some((i) => i.field === "annotator"));
    assert.deepEqual(validateAdjudication({ ...base, annotator: "llm:claude-opus-5" }), []);
});

test("keeps the harness out of the judgement labels", () => {
    // The harness may state facts about its own execution and nothing more.
    assert.deepEqual(HARNESS_ASSIGNABLE, ["INVALID_INSTANCE", "HARNESS_FAILURE"]);
});

test("derives the LLM instructions from the same table", () => {
    const text = labelInstructions();
    for (const { label } of FAILURE_LABELS) assert.ok(text.includes(label), `${label} missing from instructions`);
    assert.ok(text.includes("closed set"));
});
