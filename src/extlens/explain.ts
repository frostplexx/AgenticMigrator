/**
 * analysis.explain for the agentic host: the SDK's explainer, completed by whatever model this
 * migrator is already configured with.
 *
 * The SDK defaults to Anthropic; this host talks to an OpenAI-compatible endpoint (Ollama or SAIA,
 * per LLM_MODEL / LLM_BASE_URL / LLM_API_KEY), so the completion is swapped through the seam the
 * SDK exposes and the prompt stays the SDK's — an explanation from this host reads the same as one
 * from any other.
 *
 * The migrator also knows things a plain corpus host does not: its own verification of the run
 * (report.json — runtime errors, which checks failed), which goes in as extra context.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createExplainer, explainerConfigured, type Explainer } from "extlens-sdk";

/** Plain chat completion against the configured OpenAI-compatible endpoint. */
async function completeOpenAi(system: string, user: string, model: string): Promise<string> {
    let base = (process.env.LLM_BASE_URL ?? "http://localhost:11434").replace(/\/+$/, "");
    if (!/\/v1$/.test(base)) base += "/v1";
    const apiKey = process.env.LLM_API_KEY || "ollama";
    const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            max_tokens: 1200,
            temperature: 0.2,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
        }),
    });
    if (!res.ok) throw new Error(`model endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("model returned no text");
    return text;
}

/**
 * The explainer for this host, or null when no model is configured.
 *
 * LLM_MODEL wins because it is what the migrations themselves run on; an ANTHROPIC_API_KEY alone
 * falls through to the SDK's default so a corpus reviewed on a laptop can still ask.
 */
export function makeExplainer(): Explainer | null {
    const spec = process.env.LLM_MODEL;
    if (spec) {
        const id = spec.includes("/") ? spec.slice(spec.indexOf("/") + 1) : spec;
        return createExplainer({ model: id, complete: completeOpenAi });
    }
    return explainerConfigured() ? createExplainer() : null;
}

interface RunReport {
    verdict?: string;
    reason?: string | null;
    errors?: unknown[];
    runtimeErrors?: unknown[];
    issues?: unknown[];
    behaviour?: { loaded?: boolean; checks?: { name: string; status: string; detail?: string }[]; error?: string | null };
}

/**
 * What the migrator's own verification saw, compressed to the parts that could explain a failure:
 * anything that errored, and any behaviour check that did not simply pass or not apply.
 */
export function runVerificationContext(runDir: string): { title: string; text: string } | null {
    const path = join(runDir, "report.json");
    if (!existsSync(path)) return null;
    let report: RunReport;
    try {
        report = JSON.parse(readFileSync(path, "utf8")) as RunReport;
    } catch {
        return null;
    }
    const lines: string[] = [];
    lines.push(`- verdict: ${report.verdict ?? "unknown"}${report.reason ? ` — ${report.reason}` : ""}`);
    const list = (label: string, items: unknown[] | undefined) => {
        if (!items?.length) return;
        lines.push(`- ${label}:`);
        for (const item of items.slice(0, 15)) {
            lines.push(`  - ${typeof item === "string" ? item : JSON.stringify(item)}`.slice(0, 500));
        }
    };
    list("static errors", report.errors);
    list("runtime errors", report.runtimeErrors);
    list("issues", report.issues);
    const failed = (report.behaviour?.checks ?? []).filter((c) => c.status !== "pass" && c.status !== "na");
    if (report.behaviour?.loaded === false) lines.push("- the migrated extension did not load in the verification browser");
    if (report.behaviour?.error) lines.push(`- verification error: ${report.behaviour.error}`);
    if (failed.length) {
        lines.push("- behaviour checks that did not pass:");
        for (const c of failed) lines.push(`  - ${c.name}: ${c.status}${c.detail ? ` — ${c.detail}` : ""}`);
    }
    return { title: "Migrator's automated verification of this run", text: lines.join("\n") };
}
