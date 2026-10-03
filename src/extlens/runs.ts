/**
 * Runs, from the client: create one, list them, switch between them, delete one.
 *
 * The host used to serve a single directory of migrated extensions with a model fixed by its
 * environment, which made the model an invisible property of whatever was in there. A run is now a
 * named directory with a manifest (see host/runs.ts), created on demand, and this file is what lets
 * the client work with several of them over one long-lived server.
 *
 * The awkward part, and the reason this is a module rather than a field on the controller: switching
 * run is a change of RUN ROOT. Every run keeps its own, because two runs sharing one would let the
 * second skip what the first migrated and delete what it failed (host/runRoot.ts). So selecting swaps
 * the registry, the controller and the backend built over them — while the websocket server, which
 * captured a backend when it was constructed, keeps running.
 *
 * That is what `switchableBackend` is for: a façade whose every member reads through to the CURRENT
 * session, so the server holds one stable object while the thing behind it is rebuilt. Optional
 * members are getters that vanish when the live backend lacks them, because the SDK decides whether
 * to answer -32601 by testing the property.
 *
 * An invariant worth stating: whenever the host has any runs, exactly one is active and served. The
 * active run therefore cannot be deleted, which is also the honest answer — tearing down what is on
 * screen from underneath the client is worse than asking it to select another first.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ErrorCodes, RpcError, type Backend } from "extlens-sdk";
import type { ModelsListResult, RunCreateParams, RunsListResult } from "@extlens/protocol";
import { collectSources, makeAgenticBackend } from "./adapter.js";
import { MigratorController } from "./migrator.js";
import { Registry, type SourceEntry } from "./registry.js";
import { collect } from "../host/blobs.js";
import { readRunReport } from "../host/runReport.js";
import { listRunsOnDisk, manifestFor, readRunManifest, writeRunManifest, type RunManifest } from "../host/runs.js";
import logger from "../logger.js";

/** Everything belonging to one run: where it writes, what indexes it, what serves it. */
interface Session {
    manifest: RunManifest;
    runDir: string;
    sources: SourceEntry[];
    registry: Registry;
    host: MigratorController;
    backend: Backend;
}

export interface RunSwitch {
    /** The stable object to hand `createExtlensServer`; it follows the active run. */
    backend: Backend;
    list(): RunsListResult;
    create(params: RunCreateParams): RunsListResult;
    select(id: string): RunsListResult;
    remove(id: string): RunsListResult;
    /** The active run's directory, or null when the root has no runs yet. */
    activeRunDir(): string | null;
    dispose(): void;
}

function switchableBackend(
    current: () => Backend | null,
    runs: {
        list: () => RunsListResult;
        create: (params: RunCreateParams) => RunsListResult;
        select: (id: string) => RunsListResult;
        remove: (id: string) => RunsListResult;
        models: () => Promise<ModelsListResult>;
    },
): Backend {
    /**
     * Before the first run exists there is nothing to serve.
     *
     * A host pointed at an empty runs root is a normal state — it is what you get the moment you make
     * one — and the client's job there is to show the new-run form. So the list answers empty and the
     * per-extension calls fail with an unknown id, rather than the whole host looking broken.
     */
    const need = (): Backend => {
        const live = current();
        if (!live) throw new RpcError(ErrorCodes.UNKNOWN_EXTENSION, "no run selected: create one first");
        return live;
    };

    return {
        // Attached here rather than spread over the result: `{...facade}` would evaluate the getters
        // below once, freezing the first session's controller into the object the server keeps — so a
        // switch would change nothing the client can see.
        listModels: () => runs.models(),
        listRuns: async () => runs.list(),
        createRun: async (params) => runs.create(params),
        selectRun: async (id) => runs.select(id),
        deleteRun: async (id) => runs.remove(id),

        listExtensions: async (params) => {
            const live = current();
            if (!live) {
                return {
                    extensions: [],
                    stats: { total: 0, analyzed: 0, withMv3: 0, avgScore: 0 },
                    page: params.page,
                    pageSize: params.pageSize,
                    totalPages: 1,
                };
            }
            return live.listExtensions(params);
        },
        getExtension: (id) => need().getExtension(id),
        getFiles: (id) => need().getFiles(id),
        getReport: (id) => need().getReport(id),
        submitReport: (report) => need().submitReport(report),
        get listReports() {
            const live = current();
            if (!live) return async () => [];
            return live.listReports ? () => live.listReports!() : undefined;
        },
        get host() {
            return current()?.host;
        },
        get explainFailure() {
            const live = current();
            return live?.explainFailure ? (id: string) => live.explainFailure!(id) : undefined;
        },
        get getTranscript() {
            const live = current();
            return live?.getTranscript ? (params: never) => live.getTranscript!(params) : undefined;
        },
    };
}

export function createRunSwitch(opts: {
    /** The runs root: a directory of run directories, plus `blobs/`. */
    root: string;
    /** Corpus a new run gets when it does not name one — what the host was started with. */
    defaultCorpus: string | null;
    /** Repo root the migration child runs from. */
    cwd: string;
    /** The provider's model list, for models.list. */
    models: () => Promise<ModelsListResult>;
    /** Override the migration command (tests); passed to every session's controller. */
    command?: string[];
}): RunSwitch {
    const root = resolve(opts.root);
    const blobs = join(root, "blobs");

    const open = (manifest: RunManifest): Session => {
        const runDir = join(root, manifest.id);
        // Each run has its own corpus, so the sources are the run's, not the host's.
        const sources = collectSources(manifest.corpus, null);
        const registry = new Registry(runDir);
        registry.syncSources(sources);
        registry.seedRunsFromDisk();
        // The manifest holds the resolved environment minus the key; the key comes from the live
        // process, so a run is reproducible from its manifest without a secret ever being stored.
        const env = {
            ...manifest.settings,
            ...(process.env.LLM_API_KEY ? { LLM_API_KEY: process.env.LLM_API_KEY } : {}),
        };
        const host = new MigratorController(
            {
                runRoot: runDir,
                sources,
                cwd: opts.cwd,
                env,
                // Dedupe each finished extension into the store. Per extension rather than per run so
                // a long batch gives space back as it goes, and only ever after its container exited.
                blobs,
                ...(opts.command ? { command: opts.command } : {}),
            },
            registry,
        );
        return { manifest, runDir, sources, registry, host, backend: makeAgenticBackend(runDir, registry, host) };
    };

    const onDisk = listRunsOnDisk(root);
    let session: Session | null = onDisk[0] ? open(onDisk[0]) : null;
    if (session) {
        logger.info(`run: ${session.manifest.id} (${session.manifest.model}) over ${session.manifest.corpus}`, {
            module: "runs",
        });
    } else {
        logger.info(`no runs in ${root} yet; create one from the client`, { module: "runs" });
    }

    /** Progress through one run, counted from disk so it answers for every run, not just the open one. */
    const counts = (runDir: string): { extensions: number; passed: number; reviewed: number } => {
        let extensions = 0;
        let passed = 0;
        let reviewed = 0;
        let entries: string[] = [];
        try {
            entries = readdirSync(runDir);
        } catch {
            return { extensions, passed, reviewed };
        }
        for (const entry of entries) {
            const dir = join(runDir, entry);
            if (!existsSync(join(dir, "out", "manifest.json"))) continue;
            extensions++;
            /*
             * Three different facts, and counting the wrong one flatters a run badly.
             *
             * `passed` is the harness's own check: Chrome loaded the MV3 build and its service worker
             * registered. It is NOT a human review, and it is not the mere existence of a report —
             * counting the file made a run where every verification failed read as fully verified,
             * which is exactly what a batch killed by a shut quota window looks like on disk.
             */
            if (readRunReport(dir)?.passed === true) passed++;
            // A human's review. submitReport writes it here as well as to the registry.
            if (existsSync(join(dir, "report.manual.json"))) reviewed++;
        }
        return { extensions, passed, reviewed };
    };

    const list = (): RunsListResult => ({
        defaultCorpus: opts.defaultCorpus,
        runs: listRunsOnDisk(root).map((manifest) => ({
            id: manifest.id,
            model: manifest.model,
            corpus: manifest.corpus,
            label: manifest.label,
            createdAt: manifest.createdAt,
            active: manifest.id === session?.manifest.id,
            ...counts(join(root, manifest.id)),
            settings: manifest.settings,
        })),
    });

    const assertIdle = (what: string): void => {
        if (session?.host.busy()) {
            throw new RpcError(
                ErrorCodes.HOST_BUSY,
                `a migration is running (${session.host.runningExtension() ?? "?"}); stop it before ${what}`,
            );
        }
    };

    const activate = (manifest: RunManifest): void => {
        const previous = session;
        session = open(manifest);
        if (previous) {
            previous.host.dispose();
            previous.registry.close();
        }
    };

    const api: RunSwitch = {
        backend: switchableBackend(() => session?.backend ?? null, {
            list: () => list(),
            create: (params) => api.create(params),
            select: (id) => api.select(id),
            remove: (id) => api.remove(id),
            models: opts.models,
        }),
        list,
        activeRunDir: () => session?.runDir ?? null,

        create(params: RunCreateParams): RunsListResult {
            // Creating switches to the new run, so the same rule applies as to selecting one.
            assertIdle("creating another run");
            const corpus = params.corpus ?? opts.defaultCorpus;
            if (!corpus) {
                throw new RpcError(ErrorCodes.INVALID_PARAMS, "this host has no default corpus; a run must name one");
            }
            if (!existsSync(corpus)) {
                throw new RpcError(ErrorCodes.INVALID_PARAMS, `no such corpus directory: ${corpus}`);
            }

            let manifest: RunManifest;
            try {
                manifest = manifestFor({ ...params, corpus }, corpus);
            } catch (e) {
                // A bad model string or an unset key variable: the client's to fix, said now rather
                // than as a 401 twenty minutes into the first container.
                throw new RpcError(ErrorCodes.INVALID_PARAMS, e instanceof Error ? e.message : String(e));
            }
            // Ids carry seconds, so a collision means two creates inside one second. Suffixed rather
            // than reused: writing into an existing run would mix two runs' results.
            let id = manifest.id;
            for (let n = 2; existsSync(join(root, id)); n++) id = `${manifest.id}-${n}`;
            manifest = { ...manifest, id };

            writeRunManifest(join(root, id), manifest);
            logger.info(`created run ${id} (${manifest.model}) over ${manifest.corpus}`, { module: "runs" });
            activate(manifest);
            return list();
        },

        select(id: string): RunsListResult {
            if (id === session?.manifest.id) return list();
            const manifest = readRunManifest(join(root, id));
            if (!manifest) throw new RpcError(ErrorCodes.UNKNOWN_EXTENSION, `unknown run: ${id}`);
            // Swapping the served root under a migration writing into it would put two runs' output in
            // one place, which is what the per-run layout exists to prevent.
            assertIdle("switching run");
            activate({ ...manifest, id });
            logger.info(`switched to run ${id} (${manifest.model}); serving ${session?.runDir}`, { module: "runs" });
            return list();
        },

        remove(id: string): RunsListResult {
            if (!readRunManifest(join(root, id))) {
                throw new RpcError(ErrorCodes.UNKNOWN_EXTENSION, `unknown run: ${id}`);
            }
            if (id === session?.manifest.id) {
                throw new RpcError(
                    ErrorCodes.INVALID_PARAMS,
                    `run ${id} is the one being served; select another run before deleting it`,
                );
            }
            assertIdle("deleting a run");
            rmSync(join(root, id), { recursive: true, force: true });
            // Its blobs are unreferenced now unless another run shares them; link counts say which.
            const collected = collect(blobs);
            logger.info(
                `deleted run ${id}` +
                (collected.removed > 0
                    ? `; freed ${(collected.freedBytes / 1e6).toFixed(1)} MB from ${collected.removed} blob(s)`
                    : ""),
                { module: "runs" },
            );
            return list();
        },

        dispose(): void {
            session?.host.dispose();
            session?.registry.close();
        },
    };
    return api;
}
