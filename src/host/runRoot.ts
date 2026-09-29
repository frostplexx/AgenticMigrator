/**
 * One model per run root.
 *
 * Run directories are keyed by extension id and cleared before each attempt, so a second model
 * pointed at the same root does two destructive things at once: it SKIPS every extension the first
 * model migrated successfully, leaving that model's output in place to be mistaken for this one's,
 * and it DELETES the output, report, tags and transcript of every extension the first model
 * failed. The result is half one model and half another with nothing recording which is which —
 * and the first model's failures, which are the interesting half, are gone.
 *
 * Cross-model questions are answered from the outcomes table, not by sharing a directory.
 */

/**
 * Is a recorded model the same model as the one about to run?
 *
 * Outcomes were recorded as the bare model id (`deepseek-v4-flash-0731`) while LLM_MODEL carries the
 * provider too (`saia/deepseek-v4-flash-0731`), so plain equality called every resume a model change
 * and refused it — the guard fired on exactly the case it exists to allow. Rows written from now on
 * carry the full spec; a bare one is matched tolerantly so existing run roots stay resumable.
 *
 * The tolerance is one-directional on purpose: two specs that BOTH name a provider must agree on it,
 * or `ollama/gemma4:31b` and `saia/gemma4:31b` would be allowed to share a root and overwrite each
 * other's results, which is the loss this module exists to prevent.
 */
function sameModel(existing: string, current: string): boolean {
    if (existing === current) return true;
    if (existing.includes("/")) return false;
    return current.slice(current.lastIndexOf("/") + 1) === existing;
}

/** The problem with running `current` here, or null when there is none. */
export function mixedModelError(existing: string[], current: string): string | null {
    if (existing.length === 0 || existing.some((e) => sameModel(e, current))) return null;
    return (
        `run root already holds results from ${existing.join(", ")}, and LLM_MODEL is ${current}. ` +
        `A second model would skip what the first migrated and delete what it failed. ` +
        `Use a separate --out per model (e.g. --out ../run_${current.split("/").pop()}), ` +
        `or set ALLOW_MIXED_MODELS=1 to override.`
    );
}
