// Honour the provider's published rate limits instead of guessing at them.
//
// SAIA (Kong) enforces a per-minute quota — 10 requests/minute on a standard key — and answers
// an over-quota request with a bare `429` and NO body, then tells you exactly how to recover in
// the response headers:
//
//   ratelimit-reset: 54                 seconds until the window resets
//   x-ratelimit-remaining-minute: 0     requests left in the current minute
//
// Nothing downstream reads them. The OpenAI SDK's own retry only understands `retry-after` /
// `retry-after-ms`, which Kong does not send, so it gives up and surfaces
// `429 status code (no body)`; pi then retries on a blind 2s·2^n backoff that has no relation
// to when the window actually reopens, and every one of those attempts lands in the transcript
// as a failed assistant turn. An agent doing real work issues far more than 10 requests a
// minute, so this is not an edge case — it is the steady state.
//
// This module wraps globalThis.fetch (the only interception point pi exposes: its OpenAI client
// resolves `fetch` from the global at construction) for requests to the LLM endpoint ONLY, and:
//
//   - waits out the advertised reset when a 429 comes back, then retries in place, so the
//     caller above never sees the error and no phantom turn is recorded;
//   - after any response that reports zero remaining in the window, holds the NEXT request
//     until the window reopens, so the common case costs one wait instead of one 429 per call.
//
// It deliberately does not swallow anything else: a 429 carrying no usable reset header, or one
// still arriving after BUDGET_MS of waiting, is returned untouched for pi's retry to handle as
// before — and the run is then labelled a harness failure rather than a model result.
import logger, { formatDuration } from "../logger.js";
import { resolveBaseUrl } from "./model.js";

/**
 * How long a single unbroken streak of rate-limited requests may go on before the 429 is handed
 * back to the caller.
 *
 * This is wall clock and it is shared across requests ON PURPOSE. Counting attempts per request
 * would be multiplied by the agent's own retry sitting above this one — seven tries here inside
 * nine tries there is sixty-three, and with an exhausted DAILY quota (whose reset is an hour
 * out, so every wait below expires early and finds the window still shut) that is most of an
 * afternoon spent re-confirming a number that will not change until tomorrow. A deadline cannot
 * be nested: whoever retries into it inherits the same one and the whole stack gives up on time.
 */
const BUDGET_MS = Number(process.env.LLM_RATE_LIMIT_BUDGET_MS ?? 900_000);
/**
 * Ceiling on any single wait. A reset further out than this belongs to a longer window (SAIA
 * publishes hour, day and month quotas alongside the minute), and sleeping it off blind would
 * hand the run to a timeout; waking early to re-check costs one request and keeps the budget
 * above in charge of when to stop.
 */
const MAX_WAIT_MS = Number(process.env.LLM_RATE_LIMIT_MAX_WAIT_MS ?? 180_000);
/** Added to every advertised reset: the window boundary is the provider's clock, not ours. */
const CLOCK_SKEW_MS = 1_000;

export interface RateLimitStats {
    /** 429s absorbed here — they never reached pi, so they never became failed turns. */
    absorbed: number;
    /** Requests held back because the previous response said the window was exhausted. */
    preemptiveWaits: number;
    /** Total time spent waiting for a window to reopen. */
    waitedMs: number;
    /** 429s this module could not resolve and passed through to pi's retry. */
    passedThrough: number;
    /** Streaks that ran out the budget — the signal that a longer quota window is shut. */
    budgetExhausted: number;
}

const stats: RateLimitStats = { absorbed: 0, preemptiveWaits: 0, waitedMs: 0, passedThrough: 0, budgetExhausted: 0 };

export const rateLimitStats = (): RateLimitStats => ({ ...stats });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * When the current window reopens, as an epoch ms, or 0 when it is not known to be closed.
 * Shared across requests: a per-minute quota is a property of the key, not of one call.
 */
let windowOpensAt = 0;

/**
 * When the current streak of rate-limited requests stops being worth waiting on, as an epoch ms,
 * or 0 when there is no streak. Set by the first 429 and cleared by the first response that is
 * not one, so "how long have we been stuck" survives across the retries layered above this.
 */
let streakEndsAt = 0;

/** Milliseconds left in the current streak's budget; Infinity when nothing is stuck. */
const remainingBudget = (): number => (streakEndsAt === 0 ? Infinity : streakEndsAt - Date.now());

/**
 * How long until the quota window resets, in ms, from whatever the provider was willing to say.
 * `ratelimit-reset` is Kong's (seconds); `retry-after` is the RFC spelling other gateways use.
 * Returns undefined when the response says nothing usable — the caller must not invent a delay.
 */
function resetDelayMs(headers: Headers): number | undefined {
    for (const name of ["ratelimit-reset", "retry-after", "x-ratelimit-reset-requests"]) {
        const raw = headers.get(name);
        if (raw === null) continue;
        const seconds = Number(raw.trim());
        // A `retry-after` may legally be an HTTP date rather than a delta.
        if (!Number.isFinite(seconds)) {
            const at = Date.parse(raw);
            if (Number.isFinite(at)) return Math.max(0, at - Date.now()) + CLOCK_SKEW_MS;
            continue;
        }
        if (seconds < 0) continue;
        return seconds * 1000 + CLOCK_SKEW_MS;
    }
    return undefined;
}

/** True when the response says this key has nothing left in the current window. */
function windowExhausted(headers: Headers): boolean {
    for (const name of ["x-ratelimit-remaining-minute", "ratelimit-remaining"]) {
        const raw = headers.get(name);
        if (raw !== null && Number(raw.trim()) === 0) return true;
    }
    return false;
}

async function waitFor(ms: number, why: string): Promise<void> {
    const capped = Math.min(ms, MAX_WAIT_MS);
    stats.waitedMs += capped;
    logger.info(`rate limit: ${why}, waiting ${formatDuration(capped)}`, { module: "ratelimit" });
    await sleep(capped);
}

/**
 * Wrap globalThis.fetch so requests to the LLM endpoint respect its published limits.
 * Returns the stats accessor. Safe to call once per process; a second call is a no-op.
 */
export function installRateLimitHandling(): () => RateLimitStats {
    if ((globalThis.fetch as any).__rateLimitWrapped) return rateLimitStats;

    const base = resolveBaseUrl();
    const inner = globalThis.fetch.bind(globalThis);

    const wrapped: typeof fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith(base)) return inner(input as any, init);

        for (;;) {
            // A window we already know to be closed: wait before spending the request, rather
            // than spending it to be told so again. Never past the budget — a hold that outlives
            // the deadline is the same stuck streak, just spent before the 429 instead of after.
            const holdMs = Math.min(windowOpensAt - Date.now(), remainingBudget());
            if (holdMs > 0) {
                stats.preemptiveWaits++;
                await waitFor(holdMs, "no requests left in this window");
            }
            windowOpensAt = 0;

            // A Request body can only be read once, so re-issuing needs a fresh clone.
            const response = await inner(input instanceof Request ? input.clone() : (input as any), init);

            if (response.status !== 429) {
                // The streak is over: this key is being served again, whatever happened before.
                streakEndsAt = 0;
                if (windowExhausted(response.headers)) {
                    const resetMs = resetDelayMs(response.headers);
                    if (resetMs !== undefined) windowOpensAt = Date.now() + resetMs;
                }
                return response;
            }

            const resetMs = resetDelayMs(response.headers);
            if (streakEndsAt === 0) streakEndsAt = Date.now() + BUDGET_MS;

            if (resetMs === undefined || remainingBudget() <= 0) {
                stats.passedThrough++;
                if (resetMs === undefined) {
                    logger.warn("rate limit: 429 with no reset header — leaving it to the agent's retry", {
                        module: "ratelimit",
                    });
                } else {
                    stats.budgetExhausted++;
                    logger.error(
                        `rate limit: still limited after ${formatDuration(BUDGET_MS)} of waiting ` +
                        `(provider says ${formatDuration(resetMs)} more) — a longer quota window is ` +
                        `shut, not a burst. Giving up on this request.`,
                        { module: "ratelimit" },
                    );
                }
                return response;
            }

            stats.absorbed++;
            await waitFor(
                resetMs,
                `429, window reopens (${formatDuration(remainingBudget())} of budget left)`,
            );
        }
    };

    (wrapped as any).__rateLimitWrapped = true;
    globalThis.fetch = wrapped;
    logger.info(
        `rate limit handling active for ${base} (${formatDuration(BUDGET_MS)} budget per stuck ` +
        `streak, ${formatDuration(MAX_WAIT_MS)} max per wait)`,
        { module: "ratelimit" },
    );
    return rateLimitStats;
}
