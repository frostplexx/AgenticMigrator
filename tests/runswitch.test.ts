/**
 * Creating, switching and deleting runs from the client.
 *
 * The failure mode worth testing is a switch that appears to work: the list moves, the status names
 * the new run, and the served corpus, the report store or the lifecycle controller are still the
 * previous run's. That is why the façade in extlens/runs.ts delegates per call rather than being
 * spread into a new object — a distinction with no visible symptom until two runs' results have
 * already been mixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunSwitch } from "../src/extlens/runs.js";
import type { ModelsListResult } from "@extlens/protocol";

const NO_MODELS: ModelsListResult = {
    models: [],
    provider: "saia",
    endpoint: null,
    fetchedAt: null,
    error: null,
};

/** A corpus of MV2 extensions, which is all the run machinery needs to be real. */
function corpusOf(root: string, ids: string[]): string {
    const corpus = join(root, "corpus");
    for (const id of ids) {
        mkdirSync(join(corpus, id), { recursive: true });
        writeFileSync(
            join(corpus, id, "manifest.json"),
            JSON.stringify({ manifest_version: 2, name: id, version: "1" }),
        );
    }
    return corpus;
}

function harness(opts: { command?: string[] } = {}) {
    const base = mkdtempSync(join(tmpdir(), "runs-"));
    const corpus = corpusOf(base, ["ext-one"]);
    const root = join(base, "runs");
    const sw = createRunSwitch({
        root,
        defaultCorpus: corpus,
        cwd: base,
        models: async () => NO_MODELS,
        ...(opts.command ? { command: opts.command } : {}),
    });
    return {
        base,
        root,
        corpus,
        sw,
        cleanup: () => {
            sw.dispose();
            rmSync(base, { recursive: true, force: true });
        },
    };
}

test("an empty runs root serves nothing rather than failing", async () => {
    const h = harness();
    try {
        // This is the state right after pointing the client at a fresh directory, and its job there is
        // to show the new-run form — not to look like a broken host.
        assert.deepEqual(h.sw.list().runs, []);
        assert.equal(h.sw.activeRunDir(), null);
        const listed = await h.sw.backend.listExtensions({ page: 1, pageSize: 50, sort: "name" });
        assert.deepEqual(listed.extensions, []);
        assert.equal(listed.stats.total, 0);
        assert.equal(h.sw.backend.host, undefined, "no run, so nothing to start");
    } finally {
        h.cleanup();
    }
});

test("creating a run qualifies a bare model name and makes it active", () => {
    const h = harness();
    try {
        const listed = h.sw.create({ model: "deepseek-v4-flash-0731" });
        assert.equal(listed.runs.length, 1);
        const [run] = listed.runs;
        // The client types an id; the host owns the provider prefix.
        assert.equal(run.model, "saia/deepseek-v4-flash-0731");
        assert.equal(run.active, true);
        assert.equal(run.corpus, h.corpus);
        assert.match(run.id, /^\d{8}-\d{6}-deepseek-v4-flash-0731$/);
        assert.equal(h.sw.activeRunDir(), join(h.root, run.id));
        assert.ok(existsSync(join(h.root, run.id, "run.json")));
    } finally {
        h.cleanup();
    }
});

test("an explicit provider is kept as given", () => {
    const h = harness();
    try {
        const [run] = h.sw.create({ model: "ollama/gemma4:31b-cloud" }).runs;
        assert.equal(run.model, "ollama/gemma4:31b-cloud");
        // ':' cannot appear in a path component on every filesystem we care about.
        assert.match(run.id, /-gemma4-31b-cloud$/);
    } finally {
        h.cleanup();
    }
});

test("records the settings a run used, without the key", () => {
    const h = harness();
    const saved = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "sk-secret";
    try {
        const [run] = h.sw.create({ model: "m", thinking: "medium", numCtx: 131072 }).runs;
        assert.equal(run.settings.LLM_THINKING, "medium");
        assert.equal(run.settings.LLM_NUM_CTX, "131072");
        // Which model does not explain a difference between two runs of the same model; this does.
        assert.equal(run.settings.LLM_MODEL, "saia/m");
        // The manifest is read by the client and copied around. The key never goes into it.
        assert.equal(run.settings.LLM_API_KEY, undefined);
        assert.ok(!JSON.stringify(run).includes("sk-secret"));
    } finally {
        saved === undefined ? delete process.env.LLM_API_KEY : (process.env.LLM_API_KEY = saved);
        h.cleanup();
    }
});

test("two runs of the same model over the same corpus stay separate", () => {
    const h = harness();
    try {
        const first = h.sw.create({ model: "m", label: "before prompt change" }).runs[0];
        const second = h.sw.create({ model: "m", label: "after prompt change" }).runs[0];
        assert.notEqual(first.id, second.id, "a new run is never an existing one");
        assert.equal(h.sw.list().runs.length, 2);
        // Newest first: the list is read top-down, and the newest run is the one being worked on.
        assert.equal(h.sw.list().runs[0].label, "after prompt change");
    } finally {
        h.cleanup();
    }
});

// The trap: `{...facade}` evaluates the delegating getters once, so the server would keep the first
// run's controller and report store forever while the list cheerfully showed the new run.
test("the backend handed to the server follows the active run rather than freezing", async () => {
    const h = harness();
    try {
        const backend = h.sw.backend;
        h.sw.create({ model: "model-a" });
        const before = backend.host;
        assert.equal((await before!.getStatus()).model, "saia/model-a");

        h.sw.create({ model: "model-b" });

        assert.notEqual(backend.host, before, "same backend object, different controller behind it");
        assert.equal((await backend.host!.getStatus()).model, "saia/model-b");
        // Optional members must still be routed, not lost in the swap.
        assert.equal(typeof backend.listReports, "function");
        assert.equal(typeof backend.getTranscript, "function");
        assert.equal(typeof backend.listRuns, "function");
    } finally {
        h.cleanup();
    }
});

test("selecting an earlier run re-points what is served", () => {
    const h = harness();
    try {
        const first = h.sw.create({ model: "model-a" }).runs[0];
        h.sw.create({ model: "model-b" });
        const listed = h.sw.select(first.id);
        assert.equal(listed.runs.find((r) => r.id === first.id)?.active, true);
        assert.equal(listed.runs.filter((r) => r.active).length, 1, "exactly one active run");
        assert.equal(h.sw.activeRunDir(), join(h.root, first.id));
    } finally {
        h.cleanup();
    }
});

test("refuses an unknown run instead of silently keeping the current one", () => {
    const h = harness();
    try {
        const run = h.sw.create({ model: "m" }).runs[0];
        assert.throws(() => h.sw.select("20260101-000000-nope"), /unknown run/);
        assert.throws(() => h.sw.remove("20260101-000000-nope"), /unknown run/);
        assert.equal(h.sw.list().runs.find((r) => r.active)?.id, run.id);
    } finally {
        h.cleanup();
    }
});

test("refuses a corpus that is not there, and a model that is empty", () => {
    const h = harness();
    try {
        assert.throws(() => h.sw.create({ model: "m", corpus: join(h.base, "nope") }), /no such corpus/);
        assert.throws(() => h.sw.create({ model: "   " }), /needs a model/);
    } finally {
        h.cleanup();
    }
});

test("will not delete the run it is serving", () => {
    const h = harness();
    try {
        const run = h.sw.create({ model: "m" }).runs[0];
        // The host always serves one run; pulling it from under the client is worse than asking.
        assert.throws(() => h.sw.remove(run.id), /select another run before deleting/);
        assert.ok(existsSync(join(h.root, run.id)));
    } finally {
        h.cleanup();
    }
});

test("deletes a run that is not being served, and its directory with it", () => {
    const h = harness();
    try {
        const first = h.sw.create({ model: "model-a" }).runs[0];
        h.sw.create({ model: "model-b" });
        const listed = h.sw.remove(first.id);
        assert.equal(listed.runs.length, 1);
        assert.equal(existsSync(join(h.root, first.id)), false);
    } finally {
        h.cleanup();
    }
});

test("counts each run's progress from disk, so the list answers for runs it never opened", () => {
    const h = harness();
    try {
        const run = h.sw.create({ model: "m" }).runs[0];
        h.sw.create({ model: "other" });
        const extDir = join(h.root, run.id, "ext-one");
        mkdirSync(join(extDir, "out"), { recursive: true });
        writeFileSync(join(extDir, "out", "manifest.json"), "{}");
        writeFileSync(join(extDir, "report.json"), "{}");
        writeFileSync(join(extDir, "report.manual.json"), "{}");

        const info = h.sw.list().runs.find((r) => r.id === run.id)!;
        assert.equal(info.extensions, 1);
        assert.equal(info.migrated, 1);
        assert.equal(info.reviewed, 1);
        // Zero is the informative value for a run nobody has started.
        assert.equal(h.sw.list().runs.find((r) => r.id !== run.id)!.extensions, 0);
    } finally {
        h.cleanup();
    }
});

// The guard that matters most: re-pointing the served root while a container writes into the old one
// would put two runs' output where only one belongs.
test("refuses to create, switch or delete while a migration is running", async () => {
    const h = harness({ command: ["sleep", "30"] });
    try {
        const first = h.sw.create({ model: "model-a" }).runs[0];
        h.sw.create({ model: "model-b" });
        h.sw.select(first.id);

        await h.sw.backend.host!.start("ext-one");
        assert.throws(() => h.sw.create({ model: "model-c" }), /migration is running/);
        assert.throws(() => h.sw.select(h.sw.list().runs[0].id), /migration is running/);
        assert.throws(() => h.sw.remove(h.sw.list().runs[0].id), /migration is running/);
        assert.equal(h.sw.list().runs.find((r) => r.active)?.id, first.id);

        // `stop` asks the child to exit and returns "stopping": the controller stays busy until the
        // process is really gone, so a client has to wait for idle before switching.
        await h.sw.backend.host!.stop();
        const deadline = Date.now() + 5000;
        while (h.sw.backend.host!.busy() && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
        }
        assert.equal(h.sw.backend.host!.busy(), false, "child should have exited after stop");
        assert.doesNotThrow(() => h.sw.create({ model: "model-c" }));
    } finally {
        h.cleanup();
    }
});

test("reopens the newest run when the server restarts against an existing root", () => {
    const h = harness();
    try {
        h.sw.create({ model: "model-a" });
        const newest = h.sw.create({ model: "model-b" }).runs[0].id;
        h.sw.dispose();

        const reopened = createRunSwitch({
            root: h.root,
            defaultCorpus: h.corpus,
            cwd: h.base,
            models: async () => NO_MODELS,
        });
        try {
            assert.equal(reopened.list().runs.find((r) => r.active)?.id, newest);
        } finally {
            reopened.dispose();
        }
    } finally {
        h.cleanup();
    }
});
