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

// The bug this pair of tests exists for: waiting inside fetch spends the CALLER's request deadline,
// and when the wait outlives it the SDK aborts mid-sleep and reports "Request timed out" — a
// phantom turn blamed on the model, for a request that never reached the provider. A 429 must
// never be able to disguise itself as a timeout.
test("refuses to start a wait that would outlive the caller's request deadline", async () => {
    await withEnv(
        {
            LLM_BASE_URL: BASE,
            LLM_RATE_LIMIT_MAX_WAIT_MS: "5000",
            LLM_RATE_LIMIT_BUDGET_MS: "60000",
            // Shorter than the wait: the misconfiguration the run had, stated outright.
            LLM_REQUEST_TIMEOUT_MS: "100",
        },
        async () => {
            const stub = stubFetch([limited({ "ratelimit-reset": "30" })]);
            try {
                const { installRateLimitHandling } = await freshModule();
                const stats = installRateLimitHandling();
                const started = Date.now();
                const response = await fetch(URL_UNDER_TEST);
                assert.equal(response.status, 429, "the caller gets the real reason, not a timeout");
                assert.equal(stub.calls.length, 1);
                assert.equal(stats().deadlineHits, 1);
                assert.ok(Date.now() - started < 2000, "and gets it now rather than after the wait");
            } finally {
                stub.restore();
            }
        },
    );
});

test("wakes from a wait the moment the caller gives up, rather than when the sleep ends", async () => {
    await withEnv({ LLM_BASE_URL: BASE, LLM_RATE_LIMIT_MAX_WAIT_MS: "10000" }, async () => {
        const stub = stubFetch([limited({ "ratelimit-reset": "30" })]);
        try {
            const { installRateLimitHandling } = await freshModule();
            const stats = installRateLimitHandling();
            const controller = new AbortController();
            const started = Date.now();
            setTimeout(() => controller.abort(), 50);
            const response = await fetch(URL_UNDER_TEST, { signal: controller.signal });
            const elapsed = Date.now() - started;
            assert.equal(response.status, 429);
            assert.ok(elapsed < 5000, `should wake on the abort, not after 10s (took ${elapsed}ms)`);
            assert.equal(stats().deadlineHits, 1);
        } finally {
            stub.restore();
        }
    });
});

// What the batch above reads to decide whether the next extension is worth attempting.
test("records when the window reopens once a long quota wall is proved", async () => {
    await withEnv({ LLM_BASE_URL: BASE, LLM_RATE_LIMIT_MAX_WAIT_MS: "20", LLM_RATE_LIMIT_BUDGET_MS: "50" }, async () => {
        const stub = stubFetch(() => limited({ "ratelimit-reset": "3600" }));
        try {
            const { installRateLimitHandling } = await freshModule();
            const stats = installRateLimitHandling();
            assert.equal(stats().closedUntil, null, "nothing is known before a streak gives up");
            await fetch(URL_UNDER_TEST);
            const closedUntil = stats().closedUntil;
            assert.ok(closedUntil !== null && closedUntil > Date.now() + 3_000_000, "an hour out, per the header");
        } finally {
            stub.restore();
        }
    });
});

// A burst is absorbed and says nothing about the next extension; only a long window is a wall.
test("leaves closedUntil unset for a burst it waited out successfully", async () => {
    await withEnv({ LLM_BASE_URL: BASE, LLM_RATE_LIMIT_MAX_WAIT_MS: "20" }, async () => {
        const stub = stubFetch([limited({ "ratelimit-reset": "30" }), ok()]);
        try {
            const { installRateLimitHandling } = await freshModule();
            const stats = installRateLimitHandling();
            assert.equal((await fetch(URL_UNDER_TEST)).status, 200);
            assert.equal(stats().closedUntil, null);
        } finally {
            stub.restore();
        }
    });
});

// The invariant the whole fix rests on: a fully spent wait budget has to fit inside one request,
// or the waiting cannot survive to be retried. Defaults must satisfy it without being asked to.
test("the default request deadline is longer than the wait budget", async () => {
    await withEnv({ LLM_BASE_URL: BASE }, async () => {
        const { REQUEST_DEADLINE_MS } = await freshModule();
        const budget = Number(process.env.LLM_RATE_LIMIT_BUDGET_MS ?? 900_000);
        assert.ok(
            REQUEST_DEADLINE_MS > budget,
            `deadline ${REQUEST_DEADLINE_MS}ms must exceed the ${budget}ms budget`,
        );
    });
});

// "A longer quota window is shut" was true and useless: a minute is worth waiting out and a month
// means the key is finished until it resets. The provider says which, so the log should too.
test("names the quota window that is actually exhausted", async () => {
    await withEnv({ LLM_BASE_URL: BASE, LLM_RATE_LIMIT_MAX_WAIT_MS: "20", LLM_RATE_LIMIT_BUDGET_MS: "40" }, async () => {
        const stub = stubFetch(() =>
            limited({
                "ratelimit-reset": "2396808",
                "x-ratelimit-limit-minute": "30",
                "x-ratelimit-remaining-minute": "30",
                "x-ratelimit-limit-hour": "200",
                "x-ratelimit-remaining-hour": "200",
                "x-ratelimit-limit-day": "1000",
                "x-ratelimit-remaining-day": "0",
                "x-ratelimit-limit-month": "3000",
                "x-ratelimit-remaining-month": "0",
            }),
        );
        try {
            const { installRateLimitHandling } = await freshModule();
            const stats = installRateLimitHandling();
            await fetch(URL_UNDER_TEST);
            // Spent windows only: the minute and hour had their full allowance.
            assert.deepEqual(stats().exhaustedWindows, ["day (1000)", "month (3000)"]);
            assert.ok(stats().closedUntil !== null);
        } finally {
            stub.restore();
        }
    });
});

test("says nothing about windows when the provider sends no per-window headers", async () => {
    await withEnv({ LLM_BASE_URL: BASE, LLM_RATE_LIMIT_MAX_WAIT_MS: "20", LLM_RATE_LIMIT_BUDGET_MS: "40" }, async () => {
        const stub = stubFetch(() => limited({ "ratelimit-reset": "3600" }));
        try {
            const { installRateLimitHandling } = await freshModule();
            const stats = installRateLimitHandling();
            await fetch(URL_UNDER_TEST);
            assert.deepEqual(stats().exhaustedWindows, []);
        } finally {
            stub.restore();
        }
    });
});
