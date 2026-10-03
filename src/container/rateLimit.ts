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
//
// One consequence of waiting INSIDE fetch has to be paid for explicitly, and it is the reason
// REQUEST_DEADLINE_MS below exists. The caller is an SDK request with a deadline of its own, and
// our sleep is spent against it. pi defaults that deadline to its httpIdleTimeoutMs (5 minutes),
// so two 3-minute waits used to overrun it: the SDK aborted mid-sleep and reported
// `APIConnectionTimeoutError: Request timed out.` — a phantom turn blamed on the model, for a
// request that never left the process, spending one of pi's retries per occurrence. The deadline
// and the wait budget cannot be chosen independently; whoever sets one must know the other.
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
/**
 * How long the model may take to answer once it is actually being served, on top of any waiting.
 *
 * Separate from the waiting so the deadline below reads as what it is: the budget plus one
 * response. A long agentic turn with thinking is minutes, not seconds.
 */
const GENERATION_SLACK_MS = Number(process.env.LLM_GENERATION_SLACK_MS ?? 600_000);
/**
 * The per-request deadline the caller must give its SDK, and the one this module waits against.
 *
 * It has to exceed BUDGET_MS, or waiting out a published window is not something a single request
 * can survive: the SDK aborts mid-wait and the run dies of a timeout that describes nothing. So it
 * is derived from the budget here rather than chosen over there, and runMigration.ts hands this
 * exact number to pi (`retry.provider.timeoutMs`) instead of inheriting pi's 5-minute default.
 *
 * Raising it does NOT make a hung request hang longer. A connection that goes quiet is still cut by
 * undici's own headersTimeout/bodyTimeout (300s each by default), which is the thing a short
 * deadline was really protecting against and is independent of this number — note that pi's
 * httpIdleTimeoutMs is NOT that guard here: pi only installs its dispatcher on its CLI path, and we
 * embed it as a library. What this deadline bounds is a request that is making progress, or one
 * legitimately waiting for a quota window with no socket open at all.
 */
export const REQUEST_DEADLINE_MS = Number(
    process.env.LLM_REQUEST_TIMEOUT_MS ?? BUDGET_MS + GENERATION_SLACK_MS,
);

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
    /**
     * Waits this module refused to start, or cut short, because the caller's request deadline
     * would have expired first. Non-zero means REQUEST_DEADLINE_MS and the wait budget disagree
     * — the misconfiguration that used to surface as "Request timed out".
     */
    deadlineHits: number;
    /**
     * When the provider says the current window reopens, as epoch ms, once a streak has proved a
     * LONGER window is shut (budget exhausted with a reset still in the future). Null otherwise.
     *
     * Read by the caller and reported upward: one container discovering a four-hour quota wall is
     * the only warning the batch above it will get, and without it every remaining extension pays
     * the full budget to rediscover the same number.
     */
    closedUntil: number | null;
    /**
     * Which quota windows were spent when the streak gave up, e.g. ["day (1000)", "month (3000)"].
     * Empty when the provider sends no per-window headers.
     */
    exhaustedWindows: string[];
}

const stats: RateLimitStats = {
    absorbed: 0,
    preemptiveWaits: 0,
    waitedMs: 0,
    passedThrough: 0,
    budgetExhausted: 0,
    deadlineHits: 0,
    closedUntil: null,
    exhaustedWindows: [],
};

export const rateLimitStats = (): RateLimitStats => ({ ...stats, exhaustedWindows: [...stats.exhaustedWindows] });

/**
 * Sleep, but wake at once if the caller gives up.
 *
 * An abort noticed only when the sleep ends is an abort noticed up to MAX_WAIT_MS late, and in the
 * meantime the wrapper holds a request its caller has already written off.
 */
function sleep(ms: number, signal: AbortSignal | null): Promise<"slept" | "aborted"> {
    if (signal?.aborted) return Promise.resolve("aborted");
    if (!signal) return new Promise((resolve) => setTimeout(() => resolve("slept"), ms));
    return new Promise((resolve) => {
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve("aborted");
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve("slept");
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/** The caller's cancellation, from wherever it put it. */
function signalOf(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): AbortSignal | null {
    return init?.signal ?? (input instanceof Request ? input.signal : null) ?? null;
}

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

/**
 * Which quota window is actually spent, from the per-window headers SAIA sends.
 *
 * `ratelimit-reset` reports whichever window is binding, so a 429 can mean "wait a minute" or "come
 * back next month" with nothing to tell them apart. These headers do:
 *
 *   x-ratelimit-limit-minute: 30     x-ratelimit-remaining-minute: 30
 *   x-ratelimit-limit-hour:  200     x-ratelimit-remaining-hour:  200
 *   x-ratelimit-limit-day:  1000     x-ratelimit-remaining-day:     0   <- spent
 *   x-ratelimit-limit-month:3000     x-ratelimit-remaining-month:   0   <- spent
 *
 * Named in the log because the answer changes what to do: a minute is worth waiting out, a month
 * means this key is finished until it resets and no amount of retrying will help.
 */
function exhaustedWindows(headers: Headers): string[] {
    const spent: string[] = [];
    for (const window of ["minute", "hour", "day", "month"]) {
        const remaining = headers.get(`x-ratelimit-remaining-${window}`);
        if (remaining === null || Number(remaining.trim()) !== 0) continue;
        const limit = headers.get(`x-ratelimit-limit-${window}`);
        spent.push(limit ? `${window} (${limit})` : window);
    }
    return spent;
}

/** True when the response says this key has nothing left in the current window. */
function windowExhausted(headers: Headers): boolean {
    for (const name of ["x-ratelimit-remaining-minute", "ratelimit-remaining"]) {
        const raw = headers.get(name);
        if (raw !== null && Number(raw.trim()) === 0) return true;
    }
    return false;
}

/**
 * Wait, and say whether the wait finished.
 *
 * "aborted" means the caller's request deadline expired (or it cancelled) while we slept: there is
 * no point retrying into a request nobody is waiting for, so the loop hands back what it has.
 */
async function waitFor(ms: number, why: string, signal: AbortSignal | null): Promise<"slept" | "aborted"> {
    const capped = Math.min(ms, MAX_WAIT_MS);
    logger.info(`rate limit: ${why}, waiting ${formatDuration(capped)}`, { module: "ratelimit" });
    const startedAt = Date.now();
    const outcome = await sleep(capped, signal);
    // Time actually spent, not time intended: an abort cuts the wait short, and a `waitedMs` that
    // counted the whole sleep would report waiting the run never did.
    const elapsed = Date.now() - startedAt;
    stats.waitedMs += elapsed;
    if (outcome === "aborted") {
        stats.deadlineHits++;
        logger.warn(
            `rate limit: the caller gave up ${formatDuration(elapsed)} into a ${formatDuration(capped)} ` +
            `wait — its request deadline is shorter than the wait budget (see REQUEST_DEADLINE_MS)`,
            { module: "ratelimit" },
        );
    }
    return outcome;
}

/**
 * The most a wait may last if the caller is to still be listening when it ends.
 *
 * A wait longer than this is a wait whose retry can never happen, so it is not worth spending: the
 * 429 goes back now, with its real reason, instead of in six minutes as a timeout.
 */
const roomBeforeDeadline = (deadlineAt: number): number => deadlineAt - Date.now();

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

        const signal = signalOf(input, init);
        // The caller's own deadline, which our waiting is spent against. Taken as REQUEST_DEADLINE_MS
        // from now because that is the number the caller was told to use (runMigration.ts hands it
        // to pi); `signal` is what makes this robust if it ever set a different one.
        const deadlineAt = Date.now() + REQUEST_DEADLINE_MS;

        for (;;) {
            // A window we already know to be closed: wait before spending the request, rather
            // than spending it to be told so again. Never past the budget — a hold that outlives
            // the deadline is the same stuck streak, just spent before the 429 instead of after.
            const holdMs = Math.min(windowOpensAt - Date.now(), remainingBudget());
            if (holdMs > 0) {
                stats.preemptiveWaits++;
                // An abort here needs no special case: nothing has been requested yet, so the
                // attempt below goes out with the aborted signal and fails on its own terms. The
                // warning waitFor logged is what makes the reason visible either way.
                await waitFor(holdMs, "no requests left in this window", signal);
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

            // A wait the caller will not be around for buys nothing, and spending it is how a
            // plain 429 turned into "Request timed out": the abort landed mid-sleep and the real
            // reason never reached the log. Better to hand the 429 up now, while it still says why.
            const room = roomBeforeDeadline(deadlineAt);
            const noRoom = resetMs !== undefined && Math.min(resetMs, MAX_WAIT_MS) > room;

            if (resetMs === undefined || remainingBudget() <= 0 || noRoom) {
                stats.passedThrough++;
                if (resetMs === undefined) {
                    logger.warn("rate limit: 429 with no reset header — leaving it to the agent's retry", {
                        module: "ratelimit",
                    });
                } else if (noRoom) {
                    stats.deadlineHits++;
                    logger.error(
                        `rate limit: ${formatDuration(Math.min(resetMs, MAX_WAIT_MS))} of waiting left to ` +
                        `do and only ${formatDuration(Math.max(0, room))} before this request's deadline ` +
                        `— handing the 429 back rather than sleeping into a timeout. Raise ` +
                        `LLM_REQUEST_TIMEOUT_MS above the ${formatDuration(BUDGET_MS)} wait budget.`,
                        { module: "ratelimit" },
                    );
                } else {
                    stats.budgetExhausted++;
                    // The one fact worth carrying out of this container: a window this long is not
                    // a burst, and every extension after this one will hit the same wall.
                    stats.closedUntil = Date.now() + resetMs;
                    const spent = exhaustedWindows(response.headers);
                    stats.exhaustedWindows = spent;
                    logger.error(
                        `rate limit: ${spent.length ? `${spent.join(" and ")} quota exhausted` : "still limited"} ` +
                        `after ${formatDuration(BUDGET_MS)} of waiting. The window reopens in ` +
                        `${formatDuration(resetMs)} (${new Date(Date.now() + resetMs).toISOString()}), which is ` +
                        `longer than waiting can cover, so this request is given up on.`,
                        { module: "ratelimit" },
                    );
                }
                return response;
            }

            stats.absorbed++;
            if (
                (await waitFor(
                    resetMs,
                    `429, window reopens (${formatDuration(remainingBudget())} of budget left)`,
                    signal,
                )) === "aborted"
            ) {
                // The caller is gone. Return the 429 it earned: if anything is still listening, a
                // rate limit is a far more useful thing to read than a timeout.
                return response;
            }
        }
    };

    (wrapped as any).__rateLimitWrapped = true;
    globalThis.fetch = wrapped;
    logger.info(
        `rate limit handling active for ${base} (${formatDuration(BUDGET_MS)} budget per stuck ` +
        `streak, ${formatDuration(MAX_WAIT_MS)} max per wait, ` +
        `${formatDuration(REQUEST_DEADLINE_MS)} request deadline)`,
        { module: "ratelimit" },
    );
    if (REQUEST_DEADLINE_MS <= BUDGET_MS) {
        // Said at startup rather than discovered six minutes into the first stuck streak.
        logger.warn(
            `rate limit: the request deadline (${formatDuration(REQUEST_DEADLINE_MS)}) is not longer ` +
            `than the wait budget (${formatDuration(BUDGET_MS)}), so a fully used budget cannot ` +
            `survive one request — expect 429s to surface as timeouts`,
            { module: "ratelimit" },
        );
    }
    return rateLimitStats;
}
