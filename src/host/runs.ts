/**
 * A run: one model's attempt at one corpus, as a first-class thing on disk.
 *
 * The host used to serve a single directory of migrated extensions, which made the model an
 * invisible property of whatever happened to be in there. Two models meant two directories and a
 * guard to stop the second eating the first (runRoot.ts), and nothing in the results recorded which
 * was which. So a run is now named, described by a manifest beside its output, and created on demand:
 *
 *   <root>/                                  the runs root, what extlens serves
 *     runs.db                                index across runs
 *     blobs/                                 content-addressed store (see blobs.ts)
 *     2026-09-29-1432-deepseek-v4-flash/     one run
 *       run.json                             model, corpus, settings, when
 *       <ext-id>/{out,report.json,...}
 *       migrator.db
 *
 * A new run always starts empty, even over a corpus and model that have been run before. Seeding it
 * from an earlier run's successes would make the two indistinguishable in the results while being
 * only a time saving, and the whole point of a run is that it is one measurement.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** What the client chooses when it creates a run. Everything but the model has a fallback. */
export interface RunSettings {
    /**
     * The model, as the client typed it or picked it.
     *
     * A bare id is qualified with the default provider, so "deepseek-v4-flash-0731" and
     * "saia/deepseek-v4-flash-0731" name the same thing — the client offers a list of ids from the
     * provider and a free-text box, and neither should have to know about the prefix.
     */
    model: string;
    /** MV2 corpus. Defaults to the one the host was started with. */
    corpus?: string;
    /** Free text shown in the runs list, for "same model, new prompt" runs. */
    label?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    numCtx?: number;
    thinking?: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxFixAttempts?: number;
    /** Escape hatch for anything the container reads that this interface does not name. */
    env?: Record<string, string>;
}

/** A run as recorded in its own directory. The manifest is the provenance of its results. */
export interface RunManifest {
    id: string;
    /** Fully qualified `provider/id`. A results table that cannot name its model is not a result. */
    model: string;
    corpus: string;
    label: string | null;
    createdAt: string;
    /**
     * The environment its containers get, with the API key omitted.
     *
     * Recorded because "which model" is not the whole story — a context window or thinking level
     * explains a difference between two runs of the same model, and six weeks later nothing else
     * remembers. Never the key: this file is read by the client and copied around.
     */
    settings: Record<string, string>;
}

export const DEFAULT_PROVIDER = "saia";

/** `provider/id`, adding the default provider to a bare id. */
export function qualifyModel(model: string, provider = DEFAULT_PROVIDER): string {
    const trimmed = model.trim();
    return trimmed.includes("/") ? trimmed : `${provider}/${trimmed}`;
}

/** The id half of a `provider/id` spec. */
export function modelId(model: string): string {
    return model.slice(model.lastIndexOf("/") + 1);
}

/**
 * A directory name from a model id.
 *
 * Model ids carry `/`, `:` and `.` (`saia/qwen3.5-122b-a10b`, `ollama/gemma4:31b-cloud`) and two of
 * those cannot appear in a path component.
 */
export function slugify(model: string): string {
    const slug = modelId(model)
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return slug === "" ? "model" : slug;
}

/**
 * A run id: sortable, readable, and unique without a counter.
 *
 * Time first so `ls` and the runs list agree on order, then the model, because "which model" is the
 * question asked of a run directory far more often than "when". The seconds are in it: two runs of
 * one model started in the same minute are a real thing to do when a prompt is being iterated on.
 */
export function runId(model: string, at: Date = new Date()): string {
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp =
        `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
        `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
    return `${stamp}-${slugify(model)}`;
}

const asNumber = (value: unknown, what: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${what} must be a number, got ${JSON.stringify(value)}`);
    }
    return value;
};

/**
 * The environment a run's containers get: settings first, then the host's own, then the same
 * defaults a single run has always used.
 *
 * Stated in one place so a run created from the client and one started from a shell cannot silently
 * differ in anything but the model. `LLM_API_KEY` is resolved here from `apiKeyEnv` (default
 * `LLM_API_KEY`) so a missing key is an error at creation rather than a 401 twenty minutes in.
 */
export function resolveRunEnv(
    settings: RunSettings,
    processEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
    const model = qualifyModel(settings.model);
    if (modelId(model) === "") throw new Error("a run needs a model");

    const num = (value: number | undefined, envValue: string | undefined, fallback: number, what: string): string =>
        String(value !== undefined ? asNumber(value, what) : Number(envValue ?? fallback));

    const env: Record<string, string> = {
        LLM_MODEL: model,
        LLM_BASE_URL: settings.baseUrl ?? processEnv.LLM_BASE_URL ?? "http://host.docker.internal:11434",
        LLM_NUM_CTX: num(settings.numCtx, processEnv.LLM_NUM_CTX, 65_536, "numCtx"),
        LLM_THINKING: settings.thinking ?? processEnv.LLM_THINKING ?? "off",
        LLM_TEMPERATURE: num(settings.temperature, processEnv.LLM_TEMPERATURE, 1, "temperature"),
        LLM_TOP_P: num(settings.topP, processEnv.LLM_TOP_P, 0.95, "topP"),
        LLM_TOP_K: num(settings.topK, processEnv.LLM_TOP_K, 20, "topK"),
        MAX_FIX_ATTEMPTS: num(settings.maxFixAttempts, processEnv.MAX_FIX_ATTEMPTS, 6, "maxFixAttempts"),
    };

    const keyVar = settings.apiKeyEnv ?? "LLM_API_KEY";
    const key = processEnv[keyVar];
    if (key) env.LLM_API_KEY = key;
    else if (settings.apiKeyEnv !== undefined) {
        throw new Error(`apiKeyEnv is ${keyVar}, but ${keyVar} is not set in the host's environment`);
    }

    return { ...env, ...(settings.env ?? {}) };
}

/** The key is in the live environment, never in the manifest the client can read. */
function redact(env: Record<string, string>): Record<string, string> {
    const { LLM_API_KEY: _omitted, ...rest } = env;
    return rest;
}

export function writeRunManifest(runDir: string, manifest: RunManifest): void {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify(manifest, null, 2));
}

/** Build a run's manifest from what the client asked for. Throws on unusable settings. */
export function manifestFor(settings: RunSettings, corpus: string, at: Date = new Date()): RunManifest {
    const env = resolveRunEnv(settings);
    return {
        id: runId(env.LLM_MODEL, at),
        model: env.LLM_MODEL,
        corpus: resolve(corpus),
        label: settings.label?.trim() ? settings.label.trim() : null,
        createdAt: at.toISOString(),
        settings: redact(env),
    };
}

export function readRunManifest(runDir: string): RunManifest | null {
    try {
        const parsed = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunManifest;
        return typeof parsed?.id === "string" && typeof parsed?.model === "string" ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Is this a runs root — a directory OF runs — rather than a single flat run directory?
 *
 * The flat layout (extension dirs directly under the root) is what every existing run on disk looks
 * like and it keeps working untouched: the host serves it exactly as before and offers no runs UI.
 * The discriminator is a manifest, not a name, so a root becomes a runs root the moment one run is
 * created in it and never by accident.
 */
export function isRunsRoot(root: string): boolean {
    if (!existsSync(root)) return false;
    if (existsSync(join(root, "runs.db"))) return true;
    for (const entry of readdirSync(root)) {
        const dir = join(root, entry);
        try {
            if (statSync(dir).isDirectory() && existsSync(join(dir, "run.json"))) return true;
        } catch {
            // Raced with a delete; it is simply not evidence either way.
        }
    }
    return false;
}

/** Every run in a runs root, newest first — the order the list is read in. */
export function listRunsOnDisk(root: string): RunManifest[] {
    if (!existsSync(root)) return [];
    const runs: RunManifest[] = [];
    for (const entry of readdirSync(root)) {
        if (entry === "blobs") continue;
        const manifest = readRunManifest(join(root, entry));
        // Trust the directory over the manifest's own id: a copied or renamed run dir is served
        // under the name it actually has, or the client would ask for a path that is not there.
        if (manifest) runs.push({ ...manifest, id: entry });
    }
    return runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
