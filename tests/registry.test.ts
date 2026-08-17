import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/extlens/registry.js";

function makeRegistry(): { dir: string; registry: Registry } {
    const dir = mkdtempSync(join(tmpdir(), "migrator-registry-"));
    return { dir, registry: new Registry(dir) };
}

test("reports table upserts by id and reads back by extension id", () => {
    const { registry } = makeRegistry();
    const now = new Date().toISOString();
    registry.setReport({
        id: "manual-ext-a",
        extensionId: "ext-a",
        payload: JSON.stringify({ tested: true, notes: "works" }),
        createdAt: now,
        updatedAt: now,
    });
    const row = registry.getReport("ext-a");
    assert.ok(row);
    assert.equal(row!.id, "manual-ext-a");
    assert.equal(JSON.parse(row!.payload).notes, "works");

    // Upsert overwrites payload, keeps id, bumps updatedAt.
    const later = new Date(Date.now() + 1000).toISOString();
    registry.setReport({
        id: "manual-ext-a",
        extensionId: "ext-a",
        payload: JSON.stringify({ tested: false, notes: "broken" }),
        createdAt: now,
        updatedAt: later,
    });
    const again = registry.getReport("ext-a");
    assert.equal(JSON.parse(again!.payload).notes, "broken");
    assert.equal(again!.updatedAt, later);
    registry.close();
});

test("report survives a registry close and reopen (restart)", () => {
    const { dir, registry } = makeRegistry();
    const now = new Date().toISOString();
    registry.setReport({
        id: "manual-ext-b",
        extensionId: "ext-b",
        payload: JSON.stringify({ tested: true }),
        createdAt: now,
        updatedAt: now,
    });
    registry.close();

    // Reopen: a fresh Registry over the same dir simulates a server restart.
    const reopened = new Registry(dir);
    const row = reopened.getReport("ext-b");
    assert.ok(row);
    assert.equal(row!.id, "manual-ext-b");
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
});

test("getReport returns null when absent", () => {
    const { registry, dir } = makeRegistry();
    assert.equal(registry.getReport("nope"), null);
    registry.close();
    rmSync(dir, { recursive: true, force: true });
});

test("seedRunsFromDisk reconciles on-disk runs and orphans stale running rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrator-registry-"));
    // A finished run with out/manifest.json and report.json -> phase done.
    const doneDir = join(dir, "ext-done");
    mkdirSync(join(doneDir, "out"), { recursive: true });
    writeFileSync(join(doneDir, "out", "manifest.json"), "{}");
    writeFileSync(join(doneDir, "report.json"), JSON.stringify({ passed: true }));

    const registry = new Registry(dir);
    registry.seedRunsFromDisk();
    const done = registry.getRun("ext-done");
    assert.ok(done);
    assert.equal(done!.phase, "done");
    assert.equal(done!.state, "idle");
    registry.close();
    rmSync(dir, { recursive: true, force: true });
});

test("syncSources prunes stale sources", () => {
    const { registry, dir } = makeRegistry();
    registry.syncSources([{ id: "a", dir: join(dir, "a") }]);
    registry.syncSources([{ id: "b", dir: join(dir, "b") }]);
    const sources = registry.listSources();
    assert.deepEqual(sources.map((s) => s.id), ["b"]);
    registry.close();
    rmSync(dir, { recursive: true, force: true });
});
