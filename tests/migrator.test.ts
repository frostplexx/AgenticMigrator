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
/*
 * The failure this exists for: a quota window shut for weeks, and a queue that walked the whole
 * corpus anyway. Each extension spends the container's full wait budget (fifteen minutes) to be told
 * the same thing, so a 200-extension run is two days of producing nothing but harness failures.
 */
test("host.startAll stops the queue when a run reports a shut quota window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrator-quota-"));
    const sources = makeSources(dir, ["ext-a", "ext-b", "ext-c"]);
    const runRoot = join(dir, "run");
    const registry = new Registry(runRoot);
    const reopensAt = Date.now() + 27 * 24 * 3600_000;
    // The first child writes the report a rate-limited container writes: a failure carrying when the
    // provider said its window reopens.
    const report = JSON.stringify({
        passed: false,
        reason: "the provider never answered",
        label: "HARNESS_FAILURE",
        provider: { rateLimit: { closedUntil: reopensAt } },
    });
    const options: MigratorOptions = {
        runRoot,
        sources,
        cwd: process.cwd(),
        command: ["sh", "-c", `mkdir -p "$2" && printf '%s' '${report}' > "$2/report.json"; exit 1`],
    };
    const controller = new MigratorController(options, registry);
    try {
        await controller.startAll();
        const idle = await waitForIdle(controller);
        assert.equal(idle.phase, "failed");
        assert.match(idle.message ?? "", /quota is exhausted until/);
        // The point: b and c were never attempted.
        assert.equal(registry.getRun("ext-b"), null);
        assert.equal(registry.getRun("ext-c"), null);
    } finally {
        controller.dispose();
        registry.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a quota wall does not poison the next batch, since the window may have reopened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "migrator-quota-reset-"));
    const sources = makeSources(dir, ["ext-a", "ext-b"]);
    const runRoot = join(dir, "run");
    const registry = new Registry(runRoot);
    const past = JSON.stringify({ passed: false, provider: { rateLimit: { closedUntil: Date.now() + 3600_000 } } });
    const controller = new MigratorController(
        {
            runRoot,
            sources,
            cwd: process.cwd(),
            command: ["sh", "-c", `mkdir -p "$2" && printf '%s' '${past}' > "$2/report.json"; exit 1`],
        },
        registry,
    );
    try {
        await controller.startAll();
        await waitForIdle(controller);
        // Starting again is the user saying "try now". It must not inherit the previous verdict.
        const status = await controller.startAll();
        assert.equal(status.state, "running", "a new batch starts rather than refusing");
        // Let it finish: a child still running when the registry closes writes to a closed database.
        await waitForIdle(controller);
    } finally {
        controller.dispose();
        registry.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
