/**
 * pi session logs, as extlens transcript entries.
 *
 * The agent writes `transcript.jsonl` per run (`session.exportToJsonl`, src/container/runMigration.ts):
 * one JSON record per line, in the pi session-export format. That format is pi's, not the
 * protocol's — it will change when the agent changes, and it is already on version 3 — so this is
 * the one place that knows it. Everything downstream (the client's viewer, the summary numbers)
 * sees the normalized entries from @extlens/protocol instead.
 *
 * What the format looks like, as of session v3:
 *
 *   {"type":"session","version":3,"timestamp":"<iso>","cwd":"/work"}
 *   {"type":"model_change","provider":"saia","modelId":"gemma-4-31b-it",...}
 *   {"type":"thinking_level_change","thinkingLevel":"medium",...}
 *   {"type":"compaction","summary":"...","tokensBefore":123,...}
 *   {"type":"message","timestamp":"<iso>","message":{role,content,...}}
 *
 * Message roles are `user`, `assistant` and `toolResult`. Content blocks are `text`, `thinking`
 * and `toolCall`; older exports also carried `toolResult` blocks inside an assistant message
 * rather than as their own record, and those still parse — a corpus contains runs from whichever
 * version of the agent was current that week, and dropping the old ones would silently shorten
 * the very transcripts most worth reading.
 */
import { readFileSync, statSync } from "node:fs";
import {
    TRANSCRIPT_BLOCK_LIMIT,
    truncateBlockText,
    transcriptTimestamp,
    type TranscriptBlock,
    type TranscriptEntry,
    type TranscriptUsage,
} from "extlens-sdk";

/** A record we could not read as JSON is not a reason to lose the rest of the file. */
interface ParseOutcome {
    entries: TranscriptEntry[];
    /** Lines that were not valid JSON. Surfaced so a corrupt tail is visible, not silent. */
    skipped: number;
}

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | null =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

function usageOf(raw: unknown): TranscriptUsage | null {
    const usage = asRecord(raw);
    if (!usage) return null;
    const int = (value: unknown): number =>
        typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    const cost = asRecord(usage.cost);
    const total = typeof cost?.total === "number" && Number.isFinite(cost.total) ? Math.max(0, cost.total) : null;
    return {
        input: int(usage.input),
        output: int(usage.output),
        cacheRead: int(usage.cacheRead),
        cacheWrite: int(usage.cacheWrite),
        total: int(usage.totalTokens ?? usage.total),
        costUsd: total,
    };
}

/** Tool arguments as text. Objects are pretty-printed; a string is already what the agent sent. */
function argumentsOf(raw: unknown): string {
    if (typeof raw === "string") return raw;
    if (raw === undefined || raw === null) return "";
    try {
        return JSON.stringify(raw, null, 2);
    } catch {
        return String(raw);
    }
}

/** Content blocks, as the protocol's blocks. Unknown block types are kept as their JSON. */
function blocksOf(content: unknown): { blocks: TranscriptBlock[]; toolResultText: string | null } {
    if (!Array.isArray(content)) return { blocks: [], toolResultText: null };
    const blocks: TranscriptBlock[] = [];
    let toolResultText: string | null = null;

    for (const item of content) {
        const block = asRecord(item);
        if (!block) continue;
        switch (block.type) {
            case "text": {
                const { text, truncated } = truncateBlockText(asString(block.text) ?? "");
                blocks.push({ type: "text", text, truncated });
                break;
            }
            case "thinking": {
                // pi writes the body under `thinking`; some builds use `text`.
                const body = asString(block.thinking) ?? asString(block.text) ?? "";
                const { text, truncated } = truncateBlockText(body);
                blocks.push({ type: "thinking", text, truncated });
                break;
            }
            case "toolCall": {
                const args = argumentsOf(block.arguments);
                const { text, truncated } = truncateBlockText(args);
                blocks.push({
                    type: "tool_call",
                    name: asString(block.name) ?? "?",
                    arguments: text,
                    callId: asString(block.id),
                    truncated,
                });
                break;
            }
            case "toolResult": {
                // The pre-v3 shape: a result inline in the message rather than its own record.
                // Returned separately so the caller can emit it as the tool entry it now is.
                const result = block.result;
                toolResultText = typeof result === "string" ? result : JSON.stringify(result ?? "", null, 2);
                break;
            }
            default: {
                // An unrecognised block is still evidence. Showing its JSON beats dropping it.
                const { text, truncated } = truncateBlockText(JSON.stringify(block, null, 2));
                blocks.push({ type: "text", text, truncated });
            }
        }
    }
    return { blocks, toolResultText };
}

/** An empty entry with every protocol default filled in, so each branch sets only what it knows. */
function baseEntry(index: number, at: string | null): TranscriptEntry {
    return {
        index,
        at,
        kind: "meta",
        role: null,
        blocks: [],
        toolName: null,
        callId: null,
        isError: false,
        model: null,
        provider: null,
        stopReason: null,
        error: null,
        usage: null,
        label: "",
        detail: "",
    };
}

function messageEntry(index: number, record: Json, message: Json): TranscriptEntry[] {
    // The record's timestamp is ISO; the message's is epoch milliseconds. Either can be missing,
    // and the message's is the more precise one when both are there.
    const at = transcriptTimestamp(message.timestamp) ?? transcriptTimestamp(record.timestamp);
    const entry = baseEntry(index, at);
    entry.kind = "message";

    const role = asString(message.role);
    const { blocks, toolResultText } = blocksOf(message.content);
    entry.blocks = blocks;

    if (role === "toolResult") {
        entry.role = "tool";
        entry.toolName = asString(message.toolName);
        entry.callId = asString(message.toolCallId);
        entry.isError = message.isError === true;
    } else {
        entry.role = role === "user" ? "user" : "assistant";
        entry.model = asString(message.model);
        entry.provider = asString(message.provider);
        entry.stopReason = asString(message.stopReason);
        entry.error = asString(message.errorMessage);
        entry.usage = usageOf(message.usage);
    }

    const entries = [entry];
    if (toolResultText !== null) {
        const legacy = baseEntry(index, at);
        legacy.kind = "message";
        legacy.role = "tool";
        const { text, truncated } = truncateBlockText(toolResultText);
        legacy.blocks = [{ type: "text", text, truncated }];
        entries.push(legacy);
    }
    return entries;
}

/** One pi record as entries. Most produce exactly one; a legacy tool result produces two. */
function entriesFor(index: number, record: Json): TranscriptEntry[] {
    const at = transcriptTimestamp(record.timestamp);
    const type = asString(record.type);

    if (type === "message") {
        const message = asRecord(record.message);
        if (message) return messageEntry(index, record, message);
    }

    const entry = baseEntry(index, at);
    switch (type) {
        case "session": {
            entry.label = "session";
            entry.detail = [
                record.version === undefined ? null : `v${String(record.version)}`,
                asString(record.cwd) ? `cwd ${asString(record.cwd)}` : null,
            ]
                .filter((part): part is string => part !== null)
                .join(" · ");
            break;
        }
        case "model_change": {
            entry.label = "model";
            entry.model = asString(record.modelId);
            entry.provider = asString(record.provider);
            entry.detail = [entry.provider, entry.model].filter(Boolean).join("/");
            break;
        }
        case "thinking_level_change": {
            entry.label = "thinking";
            entry.detail = asString(record.thinkingLevel) ?? "";
            break;
        }
        case "compaction": {
            // The history before this point was summarised away. Shown as its own kind because a
            // reader who mistakes the summary for the model's own words misreads everything after.
            entry.kind = "compaction";
            entry.label = "history compacted";
            const before = record.tokensBefore;
            entry.detail = typeof before === "number" ? `${before.toLocaleString()} tokens before` : "";
            const { text, truncated } = truncateBlockText(asString(record.summary) ?? "");
            entry.blocks = [{ type: "text", text, truncated }];
            break;
        }
        default: {
            entry.label = type ?? "record";
            const { text, truncated } = truncateBlockText(JSON.stringify(record, null, 2), 2_000);
            entry.detail = text + (truncated ? " …" : "");
        }
    }
    return [entry];
}

/** Parse a pi session export into protocol entries. Exported for tests. */
export function parsePiTranscript(jsonl: string): ParseOutcome {
    const entries: TranscriptEntry[] = [];
    let skipped = 0;

    for (const line of jsonl.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            // A run killed mid-write leaves a half line. The rest of the file is still the record.
            skipped++;
            continue;
        }
        const record = asRecord(parsed);
        if (!record) {
            skipped++;
            continue;
        }
        for (const entry of entriesFor(entries.length, record)) {
            entries.push({ ...entry, index: entries.length });
        }
    }

    return { entries, skipped };
}

/**
 * A run's transcript, cached until the file changes.
 *
 * Every page of a paged read re-parses the file otherwise, and a transcript is read a page at a
 * time by definition. Keyed by size and mtime so a running migration's growing transcript is
 * re-read rather than served stale.
 */
const cache = new Map<string, { sig: string; entries: TranscriptEntry[]; skipped: number }>();

export function readTranscript(path: string): ParseOutcome | null {
    let sig: string;
    try {
        const stat = statSync(path);
        sig = `${stat.size}:${stat.mtimeMs}`;
    } catch {
        return null;
    }
    const hit = cache.get(path);
    if (hit && hit.sig === sig) return { entries: hit.entries, skipped: hit.skipped };

    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        return null;
    }
    const outcome = parsePiTranscript(raw);
    cache.set(path, { sig, ...outcome });
    return outcome;
}

export { TRANSCRIPT_BLOCK_LIMIT };
