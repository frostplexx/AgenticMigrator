import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModel } from "../src/container/model.js";

/** Resolve a model under a fixed env, restoring whatever the ambient env had. */
async function resolve(spec: string, thinking: string) {
    const saved = { model: process.env.LLM_MODEL, thinking: process.env.LLM_THINKING };
    process.env.LLM_MODEL = spec;
    process.env.LLM_THINKING = thinking;
    try {
        return await resolveModel();
    } finally {
        process.env.LLM_MODEL = saved.model;
        process.env.LLM_THINKING = saved.thinking;
    }
}

// Mistral 400s on any reasoning_effort but none|high. The map tells pi which rungs exist so it
// clamps `medium` up to `high` instead of sending it and failing the request.
test("mistral models declare only the thinking levels mistral accepts", async () => {
    for (const id of ["mistral-large-instruct", "magistral-small", "Devstral-Small-2507"]) {
        const { model } = await resolve(`saia/${id}`, "medium");
        assert.deepEqual(model.thinkingLevelMap, {
            off: "none",
            minimal: null,
            low: null,
            medium: null,
            high: "high",
        });
    }
});

test("non-mistral models keep the provider's own thinking levels", async () => {
    const { model } = await resolve("saia/gemma-4-31b-it", "medium");
    assert.equal(model.thinkingLevelMap, undefined);
});
