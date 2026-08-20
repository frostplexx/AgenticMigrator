import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MigratorController, type MigratorOptions } from "../src/extlens/migrator.js";
import { Registry, type SourceEntry } from "../src/extlens/registry.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeSources(dir: string, ids: string[]): SourceEntry[] {
    const sourcesDir = join(dir, "sources");
    mkdirSync(sourcesDir, { recursive: true });
    return ids.map((id) => {
        const d = join(sourcesDir, id);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, "manifest.json"), JSON.stringify({ manifest_version: 2, name: id }));
        return { id, dir: d };
    });
}

/** Poll the controller until it returns idle (queue drained or stopped). */
async function waitForIdle(controller: MigratorController): Promise<Awaited<ReturnType<MigratorController["getStatus"]>>> {
    for (let i = 0; i < 200; i += 1) {
        const s = await controller.getStatus();
        if (s.state === "idle") return s;
        await sleep(25);
    }
    throw new Error("controller never went idle");
}

test("host.startAll runs every outstanding source in sequence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrator-queue-"));
    const sources = makeSources(dir, ["ext-a", "ext-b"]);
    const runRoot = join(dir, "run");
    const registry = new Registry(runRoot);
    const options: MigratorOptions = { runRoot, sources, cwd: process.cwd(), command: ["sh", "-c", "exit 0"] };
    const controller = new MigratorController(options, registry);
    try {
        const status = await controller.startAll();
        assert.equal(status.state, "running");
        assert.equal(status.extensionId, "ext-a");

        const idle = await waitForIdle(controller);
        // The fake command writes no report.json, so every run counts as failed.
        assert.equal(idle.state, "idle");
        assert.equal(idle.phase, "failed");
        assert.match(idle.message ?? "", /0 of 2 migrated, 2 failed/);
        assert.equal(registry.getRun("ext-a")?.phase, "failed");
        assert.equal(registry.getRun("ext-b")?.phase, "failed");
    } finally {
        controller.dispose();
        registry.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("host.startAll skips sources with a successful run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrator-skip-"));
    const sources = makeSources(dir, ["ext-a", "ext-c"]);
    const runRoot = join(dir, "run");
    const registry = new Registry(runRoot);
    // ext-c already migrated successfully.
    registry.startRun("ext-c", sources[1].dir, new Date().toISOString());
    registry.finishRun("ext-c", "done", null, { passed: true, reason: null });

    const options: MigratorOptions = { runRoot, sources, cwd: process.cwd(), command: ["sh", "-c", "exit 0"] };
    const controller = new MigratorController(options, registry);
    try {
        const idle = await waitForIdleAfterStart(controller);
        assert.equal(idle.phase, "failed");
        assert.match(idle.message ?? "", /0 of 1 migrated, 1 failed/);
        assert.equal(registry.getRun("ext-c")?.phase, "done");
    } finally {
        controller.dispose();
        registry.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

async function waitForIdleAfterStart(controller: MigratorController) {
    await controller.startAll();
    return waitForIdle(controller);
}

test("host.stop aborts the current child and drops the remaining queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrator-stop-"));
    const sources = makeSources(dir, ["ext-a", "ext-b"]);
    const runRoot = join(dir, "run");
    const registry = new Registry(runRoot);
    // First child sleeps so the queue cannot advance before stop.
    const options: MigratorOptions = { runRoot, sources, cwd: process.cwd(), command: ["sh", "-c", "sleep 5"] };
    const controller = new MigratorController(options, registry);
    try {
        const status = await controller.startAll();
        assert.equal(status.extensionId, "ext-a");
        await sleep(100);
        await controller.stop();

        const idle = await waitForIdle(controller);
        assert.equal(idle.phase, "stopped");
        assert.equal(registry.getRun("ext-a")?.phase, "stopped");
        // ext-b never started.
        assert.equal(registry.getRun("ext-b"), null);
    } finally {
        controller.dispose();
        registry.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("host.startAll with nothing outstanding reports done immediately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrator-none-"));
    const sources = makeSources(dir, ["ext-a"]);
    const runRoot = join(dir, "run");
    const registry = new Registry(runRoot);
    registry.startRun("ext-a", sources[0].dir, new Date().toISOString());
    registry.finishRun("ext-a", "done", null, { passed: true, reason: null });

    const options: MigratorOptions = { runRoot, sources, cwd: process.cwd(), command: ["sh", "-c", "exit 0"] };
    const controller = new MigratorController(options, registry);
    try {
        const status = await controller.startAll();
        assert.equal(status.state, "idle");
        assert.equal(status.phase, "done");
        assert.equal(status.message, "all extensions already migrated");
    } finally {
        controller.dispose();
        registry.close();
        rmSync(dir, { recursive: true, force: true });
    }
});