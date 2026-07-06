// run-migration.mjs — pi SDK skeleton proving the framework imports, constructs a session,
// registers a custom tool, and wires the event stream INSIDE the container. It does not need
// a live LLM to prove viability: without credentials it stops before the first model call
// and reports the SDK surface it reached. With LLM_MODEL + a key it runs one real turn.
//
// This is the in-container half of Path B: the process that would drive the migration,
// spawn the extension-transformer subagent (a custom tool), then hand off to verify.mjs.

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";

function log(...a) {
  console.log("[run-migration]", ...a);
}

// A stand-in for the real extension-transformer subagent: in the full rewrite this custom
// tool would spawn a nested createAgentSession() to do the file edits. Here it just proves a
// custom tool registers and is callable.
const spawnTransformer = defineTool({
  name: "spawn_transformer",
  label: "Spawn transformer subagent",
  description: "Delegate the mechanical MV2->MV3 edits to a sub-session (stub).",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => ({
    content: [{ type: "text", text: "transformer stub: would migrate /work/extension" }],
    details: {},
  }),
});

async function main() {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const available = await modelRegistry.getAvailable().catch((e) => {
    log("getAvailable() failed:", String(e));
    return [];
  });
  log(`SDK loaded. models with usable creds: ${available.length}`);

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    tools: ["read", "bash", "edit", "write", "spawn_transformer"],
    customTools: [spawnTransformer],
  });
  log("session constructed:", session.sessionId);

  // Prove the event stream is subscribable (the hook we'd use for the trace + metrics).
  let turns = 0;
  session.subscribe((ev) => {
    if (ev.type === "turn_end") turns++;
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(ev.assistantMessageEvent.delta);
    }
  });

  if (available.length === 0) {
    log("no LLM creds in-container — SDK surface proven, skipping live prompt.");
    session.dispose();
    return;
  }

  log("running one live turn...");
  await session.prompt("Reply with the single word: ready");
  log(`\ndone. turns=${turns}`);
  session.dispose();
}

main().catch((e) => {
  console.error("[run-migration] fatal:", e);
  process.exit(1);
});
