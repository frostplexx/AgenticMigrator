// Subagent support: a pi custom tool that spawns a NESTED agent session to carry out a
// delegated task. This restores the OpenHands orchestrator -> extension-transformer split
// (src/agents/subagents/) the pi way — the SDK's "custom tools that spawn sub-agents"
// pattern. The orchestrator session gets this tool and delegates instead of editing directly.
import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";

export interface SubagentDeps {
    model: any;
    modelRegistry: any;
    authStorage: any;
    settingsManager: any;
    cwd: string;
    log?: (...a: unknown[]) => void;
}

/** Build the `extension_transformer` tool: each call runs a fresh coding sub-session. */
export function makeTransformerTool(deps: SubagentDeps) {
    const log = deps.log ?? (() => { });
    return defineTool({
        name: "extension_transformer",
        label: "Extension transformer subagent",
        description:
            "Delegate a concrete MV2->MV3 migration or fix task to a coding sub-agent that reads " +
            "and edits the extension files. Provide a precise, self-contained `task` (which files " +
            "to change and how). The sub-agent has read/edit/write/bash tools and returns a summary.",
        parameters: {
            type: "object",
            properties: {
                task: { type: "string", description: "The precise migration/fix task for the sub-agent to perform." },
            },
            required: ["task"],
            additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: { task: string }) => {
            log("subagent: spawning transformer for task:", params.task.slice(0, 80));
            const { session } = await createAgentSession({
                cwd: deps.cwd,
                sessionManager: SessionManager.inMemory(deps.cwd),
                settingsManager: deps.settingsManager,
                authStorage: deps.authStorage,
                modelRegistry: deps.modelRegistry,
                model: deps.model,
                tools: ["read", "bash", "edit", "write", "ls", "grep", "find"],
            });
            let last = "";
            let turns = 0;
            session.subscribe((ev: any) => {
                if (ev.type === "turn_end") turns++;
                if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta")
                    last += ev.assistantMessageEvent.delta;
            });
            try {
                await session.prompt(params.task);
            } finally {
                session.dispose();
            }
            log(`subagent: transformer done in ${turns} turn(s)`);
            return {
                content: [{ type: "text", text: (last.trim() || "transformer finished") + `\n(sub-agent ran ${turns} turn(s))` }],
                details: {},
            };
        },
    });
}
