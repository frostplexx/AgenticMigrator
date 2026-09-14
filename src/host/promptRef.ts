/**
 * A fingerprint of everything the model was told before it started.
 *
 * Comparing two models is only a comparison of the models if both were given the same starting
 * information. That is easy to believe and hard to prove after the fact: the skill documents get
 * edited between runs, a flag changes what the prompt carries, and six months later a results
 * table says "qwen 70% / deepseek 64%" with no way to check the two rows are comparable.
 *
 * So each run records a hash over the reference documents plus the flags that change the prompt's
 * shape. Equal fingerprints mean equal starting information; different ones mean the rows need a
 * caveat, which is exactly the fact a reviewer would otherwise have to take on trust.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PromptRef {
    /** Hash over the skill documents the agent could consult. */
    docsHash: string;
    /** The documents that went into it, for a human reading the report. */
    docs: string[];
    /** Prompt-shape flags that change what the model was told. */
    includesOriginalSource: boolean;
    includesCompatFindings: boolean;
    includesStaticFindings: boolean;
    /** Bumped by hand when the prompt's structure changes in a way the hash cannot see. */
    builderVersion: number;
}

/** Bump when buildPrompt's structure changes materially. */
export const PROMPT_BUILDER_VERSION = 2;

function collectDocs(dir: string): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    const walk = (current: string, prefix: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(current).sort();
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(current, entry);
            const rel = prefix ? `${prefix}/${entry}` : entry;
            let stat;
            try {
                stat = statSync(full);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                walk(full, rel);
            } else if (entry.endsWith(".md")) {
                try {
                    out.push({ path: rel, text: readFileSync(full, "utf8") });
                } catch {
                    /* unreadable doc: excluded from the hash and from the listing */
                }
            }
        }
    };
    walk(dir, "");
    return out;
}

export function promptRef(opts: {
    skillsDir: string;
    includesOriginalSource: boolean;
    includesCompatFindings: boolean;
    includesStaticFindings: boolean;
}): PromptRef {
    const docs = collectDocs(opts.skillsDir);
    const hash = createHash("sha256");
    // Path and content both: a renamed document is a different reference set even if the prose
    // is identical, because the agent reaches it by name.
    for (const doc of docs) hash.update(doc.path).update("\0").update(doc.text).update("\0");
    return {
        docsHash: hash.digest("hex").slice(0, 16),
        docs: docs.map((d) => d.path),
        includesOriginalSource: opts.includesOriginalSource,
        includesCompatFindings: opts.includesCompatFindings,
        includesStaticFindings: opts.includesStaticFindings,
        builderVersion: PROMPT_BUILDER_VERSION,
    };
}

/** Do two runs share the same starting information? */
export function comparableRefs(a: PromptRef, b: PromptRef): boolean {
    return (
        a.docsHash === b.docsHash &&
        a.builderVersion === b.builderVersion &&
        a.includesOriginalSource === b.includesOriginalSource &&
        a.includesCompatFindings === b.includesCompatFindings &&
        a.includesStaticFindings === b.includesStaticFindings
    );
}
