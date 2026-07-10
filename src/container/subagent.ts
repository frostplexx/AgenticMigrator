// Subagent support: a pi custom tool that spawns NESTED agent sessions to carry out delegated
// tasks. This restores the OpenHands orchestrator -> extension-transformer split
// (src/agents/subagents/) the pi way — the SDK's "custom tools that spawn sub-agents" pattern.
// The orchestrator session gets this tool and delegates instead of editing directly.
//
// The tool takes a BATCH of tasks and runs each in its own sub-session CONCURRENTLY, so
// independent files are migrated in parallel instead of one-at-a-time. The orchestrator must
// partition work so no two tasks touch the same file (parallel edits to one file would race).
import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import logger, { formatDuration } from "../logger.js";

export interface SubagentDeps {
    model: any;
    modelRegistry: any;
    authStorage: any;
    settingsManager: any;
    cwd: string;
}

interface TransformerTask {
    task: string;
    files?: string[];
}

/** Run a single delegated task in a fresh coding sub-session. Returns a labelled summary. */
async function runTransformer(deps: SubagentDeps, t: TransformerTask, idx: number): Promise<string> {
    const label = t.files?.length ? t.files.join(", ") : t.task.slice(0, 60);
    const started = Date.now();
    logger.info(`session: transformer[${idx}] → ${label}`, { module: "subagent" });
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
    const scope = t.files?.length
        ? `\n\nYou OWN only these files — edit only them, do not touch any others: ${t.files.join(", ")}.`
        : "";
    try {
        await session.prompt(t.task + scope);
    } catch (e) {
        logger.warn(`transformer[${idx}] ✗ ${label} — failed after ${formatDuration(Date.now() - started)}: ${e}`, { module: "subagent" });
        return `### Task ${idx} (${label})\nFAILED: ${e}`;
    } finally {
        session.dispose();
    }
    logger.success(`transformer[${idx}] ✓ ${label} — ${turns} turn(s), ${formatDuration(Date.now() - started)}`, { module: "subagent" });
    return `### Task ${idx} (${label})\n${last.trim() || "transformer finished"}\n(ran ${turns} turn(s))`;
}

/** Warn if two tasks claim the same file — parallel edits to one file race and corrupt it. */
function warnOverlaps(tasks: TransformerTask[]): void {
    const owner = new Map<string, number>();
    tasks.forEach((t, i) => {
        for (const f of t.files ?? []) {
            if (owner.has(f)) {
                logger.warn(
                    `subagent: file "${f}" claimed by tasks ${owner.get(f)} and ${i} — parallel edits may race`,
                    { module: "subagent" },
                );
            } else {
                owner.set(f, i);
            }
        }
    });
}

/**
 * Build the `extension_transformer` tool. A single call dispatches a batch of tasks, each in
 * its own sub-session, all running concurrently. Partition work by file so tasks are independent.
 */
export function makeTransformerTool(deps: SubagentDeps) {
    return defineTool({
        name: "extension_transformer",
        label: "Extension transformer subagents",
        description:
            "Delegate MV2->MV3 migration/fix work to coding sub-agents. Pass a `tasks` ARRAY: each " +
            "entry is one sub-agent that reads and edits files, and they all run IN PARALLEL. " +
            "Partition the work by file so each task owns a DISJOINT set of files (two tasks must " +
            "never edit the same file — parallel edits race). For each task give a precise, " +
            "self-contained `task` string and the `files` it owns. Each sub-agent has " +
            "read/edit/write/bash tools and returns a summary.",
        parameters: {
            type: "object",
            properties: {
                tasks: {
                    type: "array",
                    minItems: 1,
                    description: "Independent tasks to run in parallel. Each owns a disjoint set of files.",
                    items: {
                        type: "object",
                        properties: {
                            task: { type: "string", description: "The precise migration/fix task for this sub-agent." },
                            files: {
                                type: "array",
                                items: { type: "string" },
                                description: "The files this sub-agent owns (must not overlap other tasks).",
                            },
                        },
                        required: ["task"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["tasks"],
            additionalProperties: false,
        },
        execute: async (_toolCallId: string, params: { tasks: TransformerTask[] }) => {
            const tasks = params.tasks ?? [];
            const started = Date.now();
            logger.info(`dispatching ${tasks.length} transformer(s) in parallel:`, { module: "subagent" });
            warnOverlaps(tasks);
            const summaries = await Promise.all(tasks.map((t, i) => runTransformer(deps, t, i)));
            logger.success(`batch done — ${tasks.length} transformer(s) in ${formatDuration(Date.now() - started)}`, { module: "subagent" });
            return {
                content: [{ type: "text", text: summaries.join("\n\n") }],
                details: {},
            };
        },
    });
}
