/**
 * What the LLM endpoint says it serves, for the new-run form's model picker.
 *
 * Advisory only. The form also takes free text and the host runs whatever it is given, because a
 * provider's list goes stale exactly when a newly published model is the thing worth trying, and
 * because SAIA has answered this call with a 401 for a perfectly good key more than once. So a
 * failure here produces an empty list and a reason, never an error that blocks creating a run.
 *
 * Cached for the process, since the answer changes about as often as the provider deploys and the
 * form is opened far more often than that. `refresh` exists for when that is not good enough.
 */
import { resolveBaseUrl } from "../container/model.js";
import { DEFAULT_PROVIDER } from "../host/runs.js";
import logger from "../logger.js";

export interface ProviderModels {
    models: { id: string; name: string }[];
    provider: string;
    endpoint: string | null;
    fetchedAt: string | null;
    error: string | null;
}

/** How long a successful answer is reused. A failure is not cached: the next open retries. */
const TTL_MS = 10 * 60 * 1000;

let cached: { at: number; value: ProviderModels } | null = null;

/**
 * Read an OpenAI-style model list tolerantly.
 *
 * The shape is `{ data: [{ id }] }` on every OpenAI-compatible gateway, but Kong deployments have
 * been seen to answer `{ models: [...] }` and to use `name` instead of `id`, and this is a menu
 * rather than a contract — dropping an entry because a field was called something else would hide a
 * model the user can plainly see in the provider's own UI.
 */
function parseModels(body: unknown): { id: string; name: string }[] {
    const root = body as { data?: unknown; models?: unknown } | null;
    const list = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
    const models: { id: string; name: string }[] = [];
    for (const entry of list) {
        if (typeof entry === "string") {
            models.push({ id: entry, name: entry });
            continue;
        }
        const record = entry as { id?: unknown; name?: unknown } | null;
        const id = typeof record?.id === "string" ? record.id : typeof record?.name === "string" ? record.name : null;
        if (id === null || id === "") continue;
        models.push({ id, name: typeof record?.name === "string" && record.name !== "" ? record.name : id });
    }
    // Sorted and deduplicated: a menu in the provider's arbitrary order is hard to scan, and the
    // same id twice looks like a bug in the form.
    const seen = new Set<string>();
    return models
        .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
        .sort((a, b) => a.id.localeCompare(b.id));
}

export async function providerModels(options: { refresh?: boolean } = {}): Promise<ProviderModels> {
    if (!options.refresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;

    const endpoint = `${resolveBaseUrl()}/models`;
    const key = process.env.LLM_API_KEY;
    const base: ProviderModels = {
        models: [],
        provider: DEFAULT_PROVIDER,
        endpoint,
        fetchedAt: null,
        error: null,
    };

    try {
        const response = await fetch(endpoint, {
            headers: {
                Accept: "application/json",
                ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
            // The form is waiting on this; a provider that needs longer than this to list its own
            // models is one the user should be typing a name into instead.
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => "")).slice(0, 200);
            throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
        }
        const value: ProviderModels = {
            ...base,
            models: parseModels(await response.json()),
            fetchedAt: new Date().toISOString(),
        };
        cached = { at: Date.now(), value };
        logger.debug(`provider models: ${value.models.length} from ${endpoint}`, { module: "models" });
        return value;
    } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        logger.warn(`could not list models from ${endpoint}: ${error}`, { module: "models" });
        // Deliberately uncached, and deliberately not thrown: the form still works by typing a name.
        return { ...base, error };
    }
}
