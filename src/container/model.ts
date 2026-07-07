// Model wiring: register the configured LLM as a pi custom provider and return the Model +
// registry. Mirrors src/utils/llm_factory.py's env contract (LLM_MODEL, LLM_BASE_URL) but
// speaks pi's OpenAI-completions provider API (proven against Ollama in probe-model.ts).
//
// LLM_MODEL forms:
//   ollama/<id>   -> OpenAI-compatible endpoint at LLM_BASE_URL (default host.docker.internal:11434)
//   openai/<id>   -> generic OpenAI-compatible endpoint at LLM_BASE_URL, key from LLM_API_KEY
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface ResolvedModel {
  model: any;
  modelRegistry: any;
  authStorage: any;
  provider: string;
  id: string;
}

export function resolveModel(): ResolvedModel {
  const spec = process.env.LLM_MODEL ?? "ollama/gemma4:31b-cloud";
  const slash = spec.indexOf("/");
  const provider = slash === -1 ? "ollama" : spec.slice(0, slash);
  const id = slash === -1 ? spec : spec.slice(slash + 1);

  // Normalize base URL to an OpenAI-compatible /v1 root.
  let base = process.env.LLM_BASE_URL ?? "http://host.docker.internal:11434";
  base = base.replace(/\/+$/, "");
  if (!/\/v1$/.test(base)) base += "/v1";

  const apiKey = process.env.LLM_API_KEY || (provider === "ollama" ? "ollama" : "");

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  modelRegistry.registerProvider(provider, {
    name: provider,
    baseUrl: base,
    apiKey: apiKey || "unused",
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Number(process.env.LLM_NUM_CTX ?? 65536),
        maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 8192),
      },
    ],
  });

  const model = modelRegistry.find(provider, id);
  if (!model) throw new Error(`could not resolve model ${provider}/${id}`);
  return { model, modelRegistry, authStorage, provider, id };
}
