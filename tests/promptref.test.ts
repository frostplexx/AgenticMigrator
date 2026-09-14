/**
 * The prompt fingerprint exists so a results table can prove two models were given the same
 * starting information, rather than asking a reader to take it on trust.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparableRefs, promptRef } from "../src/host/promptRef.js";

function skills(docs: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    for (const [path, text] of Object.entries(docs)) {
        const full = join(dir, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, text);
    }
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const flags = { includesOriginalSource: false, includesCompatFindings: true, includesStaticFindings: true };

test("identical documents produce identical fingerprints", () => {
    const a = promptRef({ skillsDir: skills({ "a/SKILL.md": "one" }), ...flags });
    const b = promptRef({ skillsDir: skills({ "a/SKILL.md": "one" }), ...flags });
    assert.equal(a.docsHash, b.docsHash);
    assert.ok(comparableRefs(a, b));
});

test("an edited reference document changes the fingerprint", () => {
    // The failure this catches: skills edited between two model runs, silently.
    const a = promptRef({ skillsDir: skills({ "a/SKILL.md": "one" }), ...flags });
    const b = promptRef({ skillsDir: skills({ "a/SKILL.md": "one, revised" }), ...flags });
    assert.notEqual(a.docsHash, b.docsHash);
    assert.equal(comparableRefs(a, b), false);
});

test("a renamed document is a different reference set", () => {
    // The agent reaches a skill by name, so the name is part of what it was told.
    const a = promptRef({ skillsDir: skills({ "a/SKILL.md": "one" }), ...flags });
    const b = promptRef({ skillsDir: skills({ "b/SKILL.md": "one" }), ...flags });
    assert.notEqual(a.docsHash, b.docsHash);
});

test("runs differing only in prompt shape are not comparable", () => {
    const dir = skills({ "a/SKILL.md": "one" });
    const without = promptRef({ skillsDir: dir, ...flags });
    const with_ = promptRef({ skillsDir: dir, ...flags, includesOriginalSource: true });
    assert.equal(without.docsHash, with_.docsHash);
    // Same documents, different task: "produce MV3" versus "port this".
    assert.equal(comparableRefs(without, with_), false);
});

test("the listing names the documents that went into the hash", () => {
    const ref = promptRef({ skillsDir: skills({ "a/SKILL.md": "one", "b/SKILL.md": "two" }), ...flags });
    assert.deepEqual(ref.docs, ["a/SKILL.md", "b/SKILL.md"]);
});
