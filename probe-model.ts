// Probe: prove pi (0.80.3) can talk to an OpenAI-compatible Ollama endpoint.
// 0.80.3 ships registerProvider() directly on ModelRegistry (the pi.dev docs'
// resolveCliModel/extension route is unreleased), so we register + find directly.
// Run: nix develop ../spike --command npx tsx probe-model.ts
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const BASE = process.env.LLM_BASE_URL_V1 ?? "http://localhost:11434/v1";
const MODEL = process.env.LLM_MODEL_ID ?? "gemma4:31b-cloud";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

modelRegistry.registerProvider("ollama", {
  name: "Ollama",
  baseUrl: BASE,
  apiKey: "ollama", // dummy; ollama ignores it
  api: "openai-completions",
  authHeader: true,
  models: [
    {
      id: MODEL,
      name: MODEL,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 8192,
    },
  ],
});

const model = modelRegistry.find("ollama", MODEL);
console.log("registry.find(ollama, model):", model ? "FOUND" : "NOT FOUND");
if (!model) process.exit(1);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
  model,
  tools: ["read"],
});
console.log("model on session:", session.model?.id ?? "(none)");

let out = "";
session.subscribe((ev: any) => {
  if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta")
    out += ev.assistantMessageEvent.delta;
});
await session.prompt("Reply with exactly: READY");
console.log("\nMODEL REPLY:", JSON.stringify(out.trim()));
session.dispose();
