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

/** The problem with running `current` here, or null when there is none. */
export function mixedModelError(existing: string[], current: string): string | null {
    if (existing.length === 0 || existing.includes(current)) return null;
    return (
        `run root already holds results from ${existing.join(", ")}, and LLM_MODEL is ${current}. ` +
        `A second model would skip what the first migrated and delete what it failed. ` +
        `Use a separate --out per model (e.g. --out ../run_${current.split("/").pop()}), ` +
        `or set ALLOW_MIXED_MODELS=1 to override.`
    );
}
