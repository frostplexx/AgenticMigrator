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
