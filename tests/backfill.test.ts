import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { CHANGE_TITLES } from "../src/host/changes.js";
import {
    backfillReport,
    manifestTags,
    parseTail,
    toolEvents,
    type TranscriptEntry,
} from "../scripts/backfill_tags.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Raw pi jsonl (as written on disk) → the export's flattened entry shape. */
function entriesFromJsonl(path: string): TranscriptEntry[] {
    return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const row = JSON.parse(line);
            if (row.type !== "message") return { kind: row.type, role: null, callId: null, blocks: [] };
            const m = row.message;
            return {
                kind: "message",
                role: m.role === "toolResult" ? "tool" : m.role,
                callId: m.toolCallId ?? null,
                isError: Boolean(m.isError),
                blocks: (m.content ?? []).map((b: any) =>
                    b.type === "toolCall"
                        ? { type: "tool_call", name: b.name, callId: b.id, arguments: JSON.stringify(b.arguments) }
                        : { type: b.type === "thinking" ? "thinking" : "text", text: b.text ?? b.thinking },
                ),
            };
        });
}

describe("backfill_tags", () => {
    it("CHANGE_TITLES covers every ChangeId and every one is reverse-mappable", () => {
        const ids = Object.keys(CHANGE_TITLES);
        assert.equal(ids.length, 16);
        for (const id of ids) assert.ok(CHANGE_TITLES[id as keyof typeof CHANGE_TITLES].length > 0, id);
    });

    it("parseTail maps skip lines with reasons, repair lines and the summary verbatim", () => {
        const tail = [
            "junk line",
            "12:00:00 INFO     migrate │ changes: 6/8 applied, 2 skipped · tags: 6 applied, 2 skipped (1 platform, 0 limited, 0 abstained, 1 unexplained), 0 repair, 1 spurious, 7 misc",
            "12:00:00 INFO     migrate │ skipped (platform): remotely hosted code removed or bundled — left out: MV3 cannot express it",
            "12:00:00 WARN     migrate │ skipped (unexplained): string evaluation (eval / new Function) removed — needed but not applied",
            "12:00:00 WARN     migrate │ spurious: global variables in background → chrome.storage — applied but never needed",
            "12:00:00 INFO     migrate │ repair: LLM repair edited the manifest",
            "12:00:00 INFO     migrate │ repair: background.persistent removed — applied during LLM repair",
            "08:32:09 SUCCESS      cli │ Migrated extension in /home/dinama/run_test/x/out",
        ].join("\n");
        const parsed = parseTail(tail);
        assert.equal(parsed.tagLines.length, 5);
        assert.equal(parsed.unmappedTitles.length, 0);
        assert.equal(parsed.counts?.applied, 6);
        assert.equal(parsed.counts?.needed, 8);
        assert.equal(parsed.counts?.skipped, 2);
        assert.equal(parsed.runDir, "/home/dinama/run_test/x/out");
        const tags = parsed.tags.map((t) => t.tag).sort();
        assert.deepEqual(tags, [
            "repair.background_persistent_removed",
            "repair.manifest_edited",
            "skipped.eval_removed",
            "skipped.remote_code_removed",
            "spurious.storage_over_dom_state",
        ]);
        const skipReasons = Object.fromEntries(parsed.tags.filter((t) => t.reason).map((t) => [t.tag, t.reason]));
        assert.equal(skipReasons["skipped.remote_code_removed"], "platform");
        assert.equal(skipReasons["skipped.eval_removed"], "unexplained");
    });

    it("parseTail maps the generic abstention tag and flags unmapped titles", () => {
        const tail = "12:00:00 WARN     migrate │ skipped (abstained): agent declined to migrate a capability\n12:00:00 WARN     migrate │ skipped (platform): a title that does not exist — left out: whatever";
        const parsed = parseTail(tail);
        assert.equal(parsed.tags[0].tag, "skipped.agent_abstained");
        assert.equal(parsed.tags[0].reason, "abstained");
        assert.equal(parsed.unmappedTitles.length, 1);
    });

    it("manifest replay reproduces the real migrated fixture (extension_mv2)", () => {
        const entries = entriesFromJsonl(join(ROOT, "run/extension_mv2/transcript.jsonl"));
        const out = JSON.parse(readFileSync(join(ROOT, "run/extension_mv2/out/manifest.json"), "utf8"));
        const { tags } = manifestTags(toolEvents(entries));
        const derived = Object.fromEntries(tags.map((t) => [t.tag, true]));
        // The tag exists iff the real migrated manifest has the feature.
        assert.equal(Boolean(derived["state.manifest_version"]), out.manifest_version === 3);
        assert.equal(Boolean(derived["state.background_service_worker"]), Boolean(out.background?.service_worker));
        assert.equal(Boolean(derived["state.action_rename"]), Boolean(out.action && !out.browser_action && !out.page_action));
    });

    it("corpus fixture abnlpg: replay agrees with its actual out tree", () => {
        const exportData = JSON.parse(readFileSync(join(ROOT, "data/extlens-reports-2026-10-12.json"), "utf8"));
        const report = exportData.reports.find((r: any) => r.report?.extensionId === "abnlpgnoijoannioldehkdjfofbpnfad");
        assert.ok(report, "fixture extension is in the export");
        const out = JSON.parse(readFileSync(join(ROOT, "run/abnlpgnoijoannioldehkdjfofbpnfad/out/manifest.json"), "utf8"));
        const backfill = backfillReport(report, null, null); // null tail: force transcript path
        const derived = Object.fromEntries(backfill.tags.filter((t) => t.provenance === "transcript").map((t) => [t.tag, true]));
        assert.equal(Boolean(derived["state.manifest_version"]), out.manifest_version === 3);
        assert.equal(Boolean(derived["state.background_service_worker"]), Boolean(out.background?.service_worker));
        assert.equal(
            Boolean(derived["state.host_permissions_split"]),
            Array.isArray(out.host_permissions) && out.host_permissions.length > 0,
        );
    });

    it("corpus invariants: every tail line maps, and abstained runs carry the abstention tag", () => {
        const db = new Database(join(ROOT, "data/migrator.db"), { readonly: true });
        const runs = db.prepare("SELECT id, tail FROM runs").all() as { id: string; tail: string }[];
        const outcomes = db.prepare("SELECT extension, abstained FROM outcomes").all() as any[];
        db.close();

        let unmapped = 0;
        const abstainedRuns = new Set(outcomes.filter((o) => o.abstained).map((o) => o.extension));
        const taggedRuns = new Set<string>();
        for (const run of runs) {
            const parsed = parseTail(run.tail ?? "");
            unmapped += parsed.unmappedTitles.length;
            if (parsed.tags.some((t) => t.tag === "skipped.agent_abstained")) taggedRuns.add(run.id);
        }
        assert.equal(unmapped, 0, "every tail title maps to a ChangeId");
        // The log line and the outcome flag are two views of the same abstention: they must agree.
        for (const id of taggedRuns) assert.ok(abstainedRuns.has(id), `${id}: tag line says abstained, outcome does not`);
        for (const id of abstainedRuns) assert.ok(taggedRuns.has(id), `${id}: outcome says abstained, no tag line (tolerated only if tail is truncated)`);
    });
});
