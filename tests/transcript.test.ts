/**
 * The pi session format is the agent's, not ours: it is on version 3, a corpus holds runs written
 * by several of those versions, and a reader that drops what it does not recognise would quietly
 * shorten exactly the transcripts worth reading. So these tests are mostly about tolerance — old
 * shapes, missing fields, half-written lines — plus the two numbers a reader actually acts on:
 * what the run cost, and where it failed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TranscriptEntrySchema } from "@extlens/protocol";
import { summarizeTranscript } from "extlens-sdk";
import { parsePiTranscript, readTranscript } from "../src/extlens/transcript.js";

const line = (record: unknown): string => JSON.stringify(record);

test("reads a session export into messages, tool calls and tool results", () => {
    const jsonl = [
        line({ type: "session", version: 3, timestamp: "2026-08-23T11:17:22.675Z", cwd: "/work" }),
        line({ type: "model_change", provider: "saia", modelId: "gemma-4-31b-it", timestamp: "2026-08-23T11:17:23.000Z" }),
        line({ type: "message", timestamp: "2026-08-23T11:17:24.000Z", message: { role: "user", content: [{ type: "text", text: "migrate it" }] } }),
        line({
            type: "message",
            message: {
                role: "assistant",
                model: "gemma-4-31b-it",
                provider: "saia",
                stopReason: "toolCall",
                timestamp: 1787146465000,
                usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 15, cost: { total: 0.25 } },
                content: [
                    { type: "thinking", thinking: "the background page is the problem" },
                    { type: "toolCall", id: "call-1", name: "ls", arguments: { path: "/work/run/out" } },
                ],
            },
        }),
        line({
            type: "message",
            message: { role: "toolResult", toolCallId: "call-1", toolName: "ls", isError: false, timestamp: 1787146465786, content: [{ type: "text", text: "manifest.json" }] },
        }),
    ].join("\n");

    const { entries, skipped } = parsePiTranscript(jsonl);
    assert.equal(skipped, 0);
    assert.equal(entries.length, 5);
    // Every entry has to satisfy the wire schema or the host fails its own validation.
    for (const entry of entries) assert.ok(TranscriptEntrySchema.safeParse(entry).success);

    const [session, model, user, assistant, tool] = entries;
    assert.equal(session!.kind, "meta");
    assert.equal(session!.label, "session");
    assert.equal(model!.model, "gemma-4-31b-it");

    assert.equal(user!.role, "user");
    assert.deepEqual(user!.blocks, [{ type: "text", text: "migrate it", truncated: false }]);

    assert.equal(assistant!.role, "assistant");
    assert.equal(assistant!.blocks[0]!.type, "thinking");
    const call = assistant!.blocks[1]!;
    assert.equal(call.type === "tool_call" && call.name, "ls");
    // Arguments arrive as text the client displays, never as a structure it has to interpret.
    assert.equal(call.type === "tool_call" && JSON.parse(call.arguments).path, "/work/run/out");
    assert.equal(call.type === "tool_call" && call.callId, "call-1");
    assert.deepEqual(assistant!.usage, { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, total: 15, costUsd: 0.25 });

    assert.equal(tool!.role, "tool");
    assert.equal(tool!.toolName, "ls");
    assert.equal(tool!.callId, "call-1");
    assert.equal(tool!.isError, false);

    // Epoch milliseconds and ISO strings both end up as ISO; nothing renders as "1787146465786".
    assert.equal(user!.at, "2026-08-23T11:17:24.000Z");
    assert.equal(assistant!.at, new Date(1787146465000).toISOString());
});

test("keeps a failed turn and a failed tool apart", () => {
    const jsonl = [
        line({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "500 Internal Server Error", timestamp: 1787146478402 } }),
        line({ type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "c2", isError: true, content: [{ type: "text", text: "curl: (6)" }] } }),
    ].join("\n");

    const summary = summarizeTranscript(parsePiTranscript(jsonl).entries);
    // One run breaking, one tool doing its job and reporting failure: different facts, counted apart.
    assert.equal(summary.errors, 1);
    assert.equal(summary.toolErrors, 1);
});

test("summarises the whole run: model, counts and cost", () => {
    const jsonl = [
        line({ type: "model_change", provider: "saia", modelId: "first-model", timestamp: "2026-08-19T13:34:20.000Z" }),
        line({ type: "message", message: { role: "assistant", model: "first-model", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.5 } }, content: [{ type: "toolCall", name: "ls", arguments: {} }], timestamp: Date.parse("2026-08-19T13:34:25.000Z") } }),
        line({ type: "compaction", summary: "earlier history", tokensBefore: 1234, timestamp: "2026-08-19T13:35:00.000Z" }),
        line({ type: "message", message: { role: "assistant", model: "second-model", usage: { input: 3, output: 1, totalTokens: 4, cost: { total: 0.25 } }, content: [{ type: "text", text: "done" }], timestamp: Date.parse("2026-08-19T13:36:00.000Z") } }),
        line({ type: "session", version: 3, cwd: "/work", timestamp: "2026-08-19T13:40:00.000Z" }),
    ].join("\n");

    const { entries } = parsePiTranscript(jsonl);
    const summary = summarizeTranscript(entries);
    assert.equal(summary.messages, 2);
    assert.equal(summary.toolCalls, 1);
    assert.equal(summary.compactions, 1);
    // The model that finished the run, not the one that started it: the output was its work.
    assert.equal(summary.model, "second-model");
    assert.equal(summary.usage!.total, 6);
    assert.equal(summary.usage!.costUsd, 0.75);
    // The span is the earliest and latest stamp, not the first and last record: the session line
    // above is written at export time, and reading the ends of the list would date the run to it.
    assert.equal(summary.startedAt, "2026-08-19T13:34:20.000Z");
    assert.equal(summary.endedAt, "2026-08-19T13:40:00.000Z");
});

test("survives a half-written line without losing the rest of the file", () => {
    const jsonl = [
        line({ type: "message", message: { role: "user", content: [{ type: "text", text: "one" }] } }),
        '{"type":"message","message":{"role":"assist',
        line({ type: "message", message: { role: "user", content: [{ type: "text", text: "two" }] } }),
    ].join("\n");

    const { entries, skipped } = parsePiTranscript(jsonl);
    assert.equal(skipped, 1);
    assert.equal(entries.length, 2);
    // Indexes stay contiguous, so a paged reader sees one sequence rather than a gap.
    assert.deepEqual(entries.map((e) => e.index), [0, 1]);
});

test("reads a pre-v3 tool result carried inside the assistant message", () => {
    const jsonl = line({
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: "{}" }, { type: "toolResult", result: "file contents" }] },
    });
    const { entries } = parsePiTranscript(jsonl);
    assert.equal(entries.length, 2);
    assert.equal(entries[1]!.role, "tool");
    assert.equal(entries[1]!.blocks[0]!.type === "text" && entries[1]!.blocks[0]!.text, "file contents");
});

test("cuts an enormous block and says so", () => {
    const huge = "x".repeat(25_000);
    const { entries } = parsePiTranscript(line({ type: "message", message: { role: "user", content: [{ type: "text", text: huge }] } }));
    const block = entries[0]!.blocks[0]!;
    assert.equal(block.type === "text" && block.text.length, 20_000);
    assert.equal(block.truncated, true);
});

test("parses the transcripts this repo actually produced", (t) => {
    // The fixture is a real export; if the agent's format moves, this is what notices.
    const sample = join(import.meta.dirname, "..", "scripts", "transcript.jsonl");
    if (!existsSync(sample)) return t.skip("no sample transcript checked in");
    const parsed = readTranscript(sample);
    assert.ok(parsed);
    assert.ok(parsed!.entries.length > 0);
    assert.equal(parsed!.skipped, 0);
    for (const entry of parsed!.entries) assert.ok(TranscriptEntrySchema.safeParse(entry).success);
    // A real run always names its model somewhere.
    assert.ok(summarizeTranscript(parsed!.entries).model);
});
