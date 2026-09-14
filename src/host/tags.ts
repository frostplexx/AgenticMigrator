/**
 * Tags: a flat, countable vocabulary describing what happened to one extension.
 *
 * The old signals recorded only what the framework changed, which answers "how often did we
 * rewrite webRequest" but not "how often did we meet a webRequest we could not rewrite". Those
 * are the two halves of the same results table, and only one of them was being collected.
 *
 * Four kinds, because they answer different questions:
 *   applied — the framework made this change. What the pipeline does.
 *   skipped — the change was needed and did not happen. Where the pipeline stops.
 *   repair  — an LLM repair round made the change the first pass missed. What repair is worth.
 *   misc    — a property of the extension, not of the migration: UI surfaces it exposes,
 *             whether it is minified or bundled. What the sample is made of.
 */
import { buildChangeLedger, type ChangeRecord } from "./changes.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export type TagKind = "applied" | "skipped" | "repair" | "misc";

export interface Tag {
    /** Dotted identifier, stable enough to group by in a results table. */
    tag: string;
    kind: TagKind;
    /** Human wording for a summary line. */
    title: string;
    evidence?: { file: string; line?: number; snippet?: string }[];
}

/** Longest line before a file reads as minified rather than merely dense. */
const MINIFIED_LINE = 500;

function codeFiles(dir: string): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    const walk = (current: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(current);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry === "node_modules" || entry.startsWith(".")) continue;
            const full = join(current, entry);
            let stat;
            try {
                stat = statSync(full);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                walk(full);
                continue;
            }
            if (extname(entry).toLowerCase() !== ".js") continue;
            if (stat.size > 4_000_000) continue;
            try {
                out.push({ path: entry, text: readFileSync(full, "utf8") });
            } catch {
                /* unreadable: no evidence either way */
            }
        }
    };
    walk(dir);
    return out;
}

/**
 * Properties of the extension itself, which decide whether a failure says anything about the
 * model. A migration that fails on a 2MB minified webpack bundle is a different observation from
 * one that fails on 40 lines of readable source.
 */
export function miscTags(inputDir: string, surfaces: string[] = []): Tag[] {
    const tags: Tag[] = [];
    const files = codeFiles(inputDir);

    const minified = files.find((f) => f.text.split("\n").some((line) => line.length > MINIFIED_LINE));
    if (minified) {
        tags.push({
            tag: "source.minified",
            kind: "misc",
            title: "minified source",
            evidence: [{ file: minified.path, snippet: `line longer than ${MINIFIED_LINE} chars` }],
        });
    }

    const bundled = files.find((f) => /webpackJsonp|__webpack_require__|\bparcelRequire\b|System\.register/.test(f.text));
    if (bundled) {
        tags.push({
            tag: "source.bundled",
            kind: "misc",
            title: "bundler output",
            evidence: [{ file: bundled.path, snippet: "webpack/parcel runtime" }],
        });
    }

    // Hex-escaped identifier soup: obfuscation rather than ordinary minification.
    const obfuscated = files.find((f) => /_0x[0-9a-f]{4,}/.test(f.text));
    if (obfuscated) {
        tags.push({
            tag: "source.obfuscated",
            kind: "misc",
            title: "obfuscated identifiers",
            evidence: [{ file: obfuscated.path, snippet: "_0x… identifiers" }],
        });
    }

    for (const surface of surfaces) {
        tags.push({ tag: `surface.${surface}`, kind: "misc", title: `exposes ${surface.replace(/_/g, " ")}` });
    }

    return tags;
}

/** Applied/skipped tags implied by a change ledger. */
export function ledgerTags(records: ChangeRecord[]): Tag[] {
    const tags: Tag[] = [];
    for (const record of records) {
        if (record.needed && record.applied) {
            tags.push({ tag: `change.${record.id}`, kind: "applied", title: record.title });
        } else if (record.needed && !record.applied) {
            // The one the old tagging could not express: the framework met this and moved on.
            tags.push({
                tag: `skipped.${record.id}`,
                kind: "skipped",
                title: `${record.title} — needed but not applied`,
                evidence: record.evidence,
            });
        }
    }
    return tags;
}

/**
 * Changes that only became applied after a repair round.
 *
 * Computed by diffing the ledger taken before repair against the one after, which is the only way
 * to attribute a change to repair rather than to the first pass — the output tree alone cannot say
 * when something appeared.
 */
export function repairTags(before: ChangeRecord[], after: ChangeRecord[]): Tag[] {
    const wasApplied = new Map(before.map((r) => [r.id, r.applied]));
    return after
        .filter((record) => record.applied && wasApplied.get(record.id) === false)
        .map((record) => ({
            tag: `repair.${record.id}`,
            kind: "repair" as const,
            title: `${record.title} — applied during LLM repair`,
        }));
}

/** Everything known about one migration, as tags. */
export function buildTags(opts: {
    inputDir: string;
    outputDir: string;
    /** Ledger snapshot taken before any repair round, when there was one. */
    beforeRepair?: ChangeRecord[];
    surfaces?: string[];
    /** The agent declined to migrate a capability; recorded as a skip with its reason. */
    abstainReason?: string | null;
}): { tags: Tag[]; changes: ChangeRecord[] } {
    const changes = buildChangeLedger(opts.inputDir, opts.outputDir);
    const tags = [
        ...ledgerTags(changes),
        ...(opts.beforeRepair ? repairTags(opts.beforeRepair, changes) : []),
        ...miscTags(opts.inputDir, opts.surfaces ?? []),
    ];
    if (opts.abstainReason) {
        tags.push({
            tag: "skipped.agent_abstained",
            kind: "skipped",
            title: "agent declined to migrate a capability",
            evidence: [{ file: "ABSTAIN.md", snippet: opts.abstainReason.slice(0, 160) }],
        });
    }
    return { tags, changes };
}

/** Counts per kind, for a one-line summary. */
export function countByKind(tags: Tag[]): Record<TagKind, number> {
    const counts: Record<TagKind, number> = { applied: 0, skipped: 0, repair: 0, misc: 0 };
    for (const tag of tags) counts[tag.kind]++;
    return counts;
}
