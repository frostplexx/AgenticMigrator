import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSources } from "../src/extlens/adapter.js";

/** True when a job dir already holds a successful migration report (mirrors cli.ts). */
function isMigrated(jobDir: string): boolean {
    const reportPath = join(jobDir, "report.json");
    if (!existsSync(reportPath)) return false;
    try {
        const r = JSON.parse(readFileSync(reportPath, "utf8")) as { passed?: boolean };
        return r.passed === true;
    } catch {
        return false;
    }
}

test("collectSources detects a corpus of extensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-sources-"));
    const a = join(dir, "ext-a");
    const b = join(dir, "ext-b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "manifest.json"), JSON.stringify({ manifest_version: 2, name: "A" }));
    writeFileSync(join(b, "manifest.json"), JSON.stringify({ manifest_version: 2, name: "B" }));

    const sources = collectSources(dir, null);
    assert.deepEqual(sources.map((s) => s.id).sort(), ["ext-a", "ext-b"]);
    rmSync(dir, { recursive: true, force: true });
});

test("collectSources treats a single extension dir as one target", () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-single-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifest_version: 2, name: "A" }));

    const sources = collectSources(dir, null);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].dir, dir);
    rmSync(dir, { recursive: true, force: true });
});

test("a successful migration report marks a target done (skip on re-run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-skip-"));
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "out"), { recursive: true });
    writeFileSync(join(dir, "out", "manifest.json"), "{}");
    writeFileSync(join(dir, "report.json"), JSON.stringify({ passed: true }));
    assert.equal(isMigrated(dir), true);

    // A failed or missing report means the target still needs migration.
    writeFileSync(join(dir, "report.json"), JSON.stringify({ passed: false }));
    assert.equal(isMigrated(dir), false);
    rmSync(dir, { recursive: true, force: true });
});
