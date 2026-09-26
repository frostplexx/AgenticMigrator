import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = "https://rate-limit.test/v1";
const URL_UNDER_TEST = `${BASE}/chat/completions`;

/**
 * Load a fresh copy of the module per test: it wraps globalThis.fetch once per process and
 * keeps window state in module scope, so tests would otherwise contaminate each other.
 */
async function freshModule() {
    return (await import(`../src/container/rateLimit.js?t=${Math.random()}`)) as typeof import("../src/container/rateLimit.js");
}

/** Queue of canned responses, plus a record of when each request was made. */
function stubFetch(responses: Response[] | (() => Response)) {
    const calls: { url: string; at: number }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
        calls.push({ url: String(input), at: Date.now() });
        if (typeof responses === "function") return responses();
        const next = responses.shift();
        if (!next) throw new Error("unexpected extra request");
        return next;
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
}

const limited = (headers: Record<string, string>) => new Response(null, { status: 429, headers });
const ok = (headers: Record<string, string> = {}) => new Response("{}", { status: 200, headers });

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const saved = Object.entries(env).map(([k, v]) => [k, process.env[k]] as const);
    Object.entries(env).forEach(([k, v]) => { process.env[k] = v; });
    try {
        return await fn();
    } finally {
        for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
}

// The whole point: the caller sees a 200, and the 429 never becomes a failed assistant turn.
test("waits out the advertised reset and retries, so the 429 never reaches the caller", async () => {
    await withEnv({ LLM_BASE_URL: BASE, LLM_RATE_LIMIT_MAX_WAIT_MS: "20" }, async () => {
        const stub = stubFetch([limited({ "ratelimit-reset": "30" }), ok()]);
        try {
            const { installRateLimitHandling } = await freshModule();
            const stats = installRateLimitHandling();
            const response = await fetch(URL_UNDER_TEST);
            assert.equal(response.status, 200);
            assert.equal(stub.calls.length, 2);
            assert.equal(stats().absorbed, 1);
            assert.ok(stats().waitedMs > 0);
        } finally {
            stub.restore();
        }
    });
});

// A 429 that says nothing about recovery is not ours to sit on.
test("passes a 429 with no reset header straight through", async () => {
    await withEnv({ LLM_BASE_URL: BASE }, async () => {
        const stub = stubFetch([limited({})]);
        try {
            const { installRateLimitHandling } = await freshModule();
            const stats = installRateLimitHandling();
            const response = await fetch(URL_UNDER_TEST);
            assert.equal(response.status, 429);
            assert.equal(stub.calls.length, 1);
            assert.equal(stats().passedThrough, 1);
        } finally {
            stub.restore();
        }
    });
});

// The budget is wall clock and shared, so the agent's own retry layered above this one cannot
// multiply it: once a streak has run out, every request through here gives up immediately.
test("gives up on a streak that outlives the budget, and resumes after a success", async () => {
    await withEnv({ LLM_BASE_URL: BASE, LLM_RATE_LIMIT_MAX_WAIT_MS: "20", LLM_RATE_LIMIT_BUDGET_MS: "50" }, async () => {
        // A day-quota reset the wait can never reach: each wait expires early and finds it shut,
        // until the test lifts the limit to prove the streak clears.
        let shut = true;
        const stub = stubFetch(() => (shut ? limited({ "ratelimit-reset": "3600" }) : ok()));
        try {
            const { installRateLimitHandling } = await freshModule();
            const stats = installRateLimitHandling();

            const first = await fetch(URL_UNDER_TEST);
            assert.equal(first.status, 429, "budget spent, so the 429 is handed back");
            assert.equal(stats().budgetExhausted, 1);
            const spent = stub.calls.length;

            // The retry above ours inherits the same deadline rather than starting a new one.
            const second = await fetch(URL_UNDER_TEST);
            assert.equal(second.status, 429);
            assert.equal(stub.calls.length, spent + 1, "no further waiting once the budget is gone");
            assert.equal(stats().budgetExhausted, 2);

            // Served again: the streak is over, so a later limit gets a full budget of its own.
            shut = false;
            assert.equal((await fetch(URL_UNDER_TEST)).status, 200);
            shut = true;
            assert.equal((await fetch(URL_UNDER_TEST)).status, 429);
            assert.ok(stats().absorbed > 0, "a fresh streak waits again rather than giving up");
        } finally {
            stub.restore();
        }
    });
});

// The cheap half: a response saying the window is spent means the NEXT call waits instead of
// spending a request to be told so again.
test("holds the next request when the window is reported exhausted", async () => {
    await withEnv({ LLM_BASE_URL: BASE, LLM_RATE_LIMIT_MAX_WAIT_MS: "60" }, async () => {
        const stub = stubFetch([ok({ "x-ratelimit-remaining-minute": "0", "ratelimit-reset": "30" }), ok()]);
        try {
            const { installRateLimitHandling } = await freshModule();
            const stats = installRateLimitHandling();
            await fetch(URL_UNDER_TEST);
            await fetch(URL_UNDER_TEST);
            assert.equal(stats().preemptiveWaits, 1);
            assert.ok(stub.calls[1].at - stub.calls[0].at >= 50, "second request should have been held");
        } finally {
            stub.restore();
        }
    });
});

// Anything that is not the model endpoint must be untouched — verify.ts and the browser share
// this process and must not inherit the LLM's rate limiting.
test("leaves requests to other hosts alone", async () => {
    await withEnv({ LLM_BASE_URL: BASE }, async () => {
        const stub = stubFetch([limited({ "ratelimit-reset": "30" })]);
        try {
            const { installRateLimitHandling } = await freshModule();
            const stats = installRateLimitHandling();
            const response = await fetch("https://example.invalid/whatever");
            assert.equal(response.status, 429);
            assert.equal(stub.calls.length, 1);
            assert.equal(stats().absorbed, 0);
        } finally {
            stub.restore();
        }
    });
});
