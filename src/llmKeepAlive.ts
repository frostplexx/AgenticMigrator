import logger from "./logger.js";

/**
 * Ollama keep_alive for OpenAI-compatible request bodies: how long the server keeps the model
 * loaded after a request before evicting it. Ollama honors `keep_alive` on /v1/chat/completions;
 * LLM_KEEP_ALIVE overrides it per request (without it the server falls back to its own default,
 * which evicts mid-migration when a run sits longer between turns than that default).
 *
 * Undefined for non-Ollama providers: strict OpenAI-compatible backends (vLLM/SAIA) may reject
 * unknown request fields, and keep_alive means nothing to them anyway.
 */
export function keepAliveFor(llmModelSpec: string): string | undefined {
    const slash = llmModelSpec.indexOf("/");
    const provider = slash === -1 ? "ollama" : llmModelSpec.slice(0, slash);
    return provider === "ollama" ? process.env.LLM_KEEP_ALIVE ?? "30m" : undefined;
}

// Ping cadence: the timer is topped to LLM_KEEP_ALIVE on every ping, so the eviction floor is
// LLM_KEEP_ALIVE minus this interval (30m - 2m = ~28m of headroom at all times).
const PING_INTERVAL_MS = 2 * 60_000;

/**
 * Pin the Ollama model in memory while the host runs, by topping its eviction timer up through
 * Ollama's native endpoint. Needed because ollama releases before ~0.25 ignore `keep_alive` on
 * the OpenAI-compatible /v1 endpoints — every agent turn resets the timer to the server's default
 * (5m) no matter what the request body asks — while /api/generate honors it. An empty prompt
 * returns done_reason "load" in well under a second: the request only updates the timer, it
 * generates nothing.
 *
 * Returns a stop function. No-op for non-Ollama providers.
 */
export function startOllamaKeepAlivePinger(llmModelSpec: string, llmBaseUrl: string): () => void {
    const keepAlive = keepAliveFor(llmModelSpec);
    if (!keepAlive) return () => undefined;
    const id = llmModelSpec.slice(llmModelSpec.indexOf("/") + 1);
    const base = llmBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

    const ping = async (): Promise<boolean> => {
        try {
            const res = await fetch(`${base}/api/generate`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model: id, keep_alive: keepAlive }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
            return true;
        } catch {
            return false;
        }
    };

    let warned = false;
    const onPing = (ok: boolean): void => {
        if (ok) {
            warned = false;
        } else if (!warned) {
            warned = true; // Ollama briefly down or restarting: warn once, then retry silently.
            logger.warn(`keep-alive pinger: ping against ${base} failed; retrying silently every ${PING_INTERVAL_MS / 1000}s`, { module: "llm" });
        }
    };

    void ping().then((ok) => {
        onPing(ok);
        if (ok) logger.info(`keep-alive pinger: pinning ${id} for ${keepAlive}, ping every ${PING_INTERVAL_MS / 1000}s`, { module: "llm" });
    });
    const timer = setInterval(() => void ping().then(onPing), PING_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}
