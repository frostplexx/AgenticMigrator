// Behavioural verification: does the extension still DO what it did, not merely load.
//
// verify.ts answers "Chrome accepted this and a service worker registered". That is a necessary
// condition and a weak one: an MV3 port whose worker registers and whose every feature is dead
// passes it. MV3 makes exactly that failure easy (a rewritten background loses its listeners, a
// DNR ruleset is declared but never enabled, state vanishes when the worker is torn down), so a
// load-only harness systematically overstates the success rate.
//
// This module runs the same set of checks against the ORIGINAL MV2 extension and against the
// migrated MV3 one. The MV2 run is the baseline: a check the original already fails is not
// evidence about the migration, and an original that fails everything is an invalid instance that
// must leave the denominator entirely rather than count as a model failure. The score is then
// the fraction of baseline-passing checks that still pass — partial behaviour preservation,
// instead of a binary that has to call a half-working port either a success or a total loss.
import { chromium, type BrowserContext, type Page } from "playwright";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromeArgs } from "./verify.js";

export type CheckStatus = "pass" | "fail" | "na";

export interface CheckResult {
    name: string;
    status: CheckStatus;
    /** Why it failed, or why it does not apply. */
    detail?: string;
}

export interface BehaviourReport {
    /** False when Chrome never gave us a usable extension context; every check is then `na`. */
    loaded: boolean;
    extensionId?: string;
    manifestVersion?: number;
    checks: CheckResult[];
    error?: string;
}

export interface BehaviourScore {
    /** Fraction of baseline-passing checks that still pass, or null when the baseline is empty. */
    score: number | null;
    /** Checks the ORIGINAL passed: the denominator. */
    denominator: number;
    passed: number;
    /** Checks the original passed and the migration does not — the actual behaviour lost. */
    regressions: string[];
}

const PAGE_TIMEOUT_MS = Number(process.env.BEHAVIOUR_PAGE_TIMEOUT_MS ?? 8000);
const SW_TIMEOUT_MS = Number(process.env.BEHAVIOUR_SW_TIMEOUT_MS ?? 12000);

/**
 * Chrome's unpacked-extension id: the first 16 bytes of SHA-256 over the absolute path, each
 * nibble mapped into a-p. Deterministic, so extension-page checks work even for an extension that
 * has no background context to read the id from (an MV2 popup-only extension, or a migration
 * whose worker died on start).
 */
export function unpackedExtensionId(extDir: string): string {
    const digest = createHash("sha256").update(resolve(extDir)).digest("hex").slice(0, 32);
    return [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function readManifest(extDir: string): any {
    try {
        return JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
    } catch {
        return {};
    }
}

/** A page served over http so content scripts (which never match file:// or chrome-extension://) run. */
async function serveBlank(): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><html><body><p>behaviour check</p></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    return {
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

/** Match patterns broad enough that our local page is in scope. */
const BROAD_MATCH = /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*|https?:\/\/127\.0\.0\.1\/)/;

/** Does the extension declare a content script that would run on a plain local http page? */
function broadContentScript(manifest: any): boolean {
    const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
    return scripts.some((cs: any) => Array.isArray(cs?.matches) && cs.matches.some((m: any) => typeof m === "string" && BROAD_MATCH.test(m)));
}

/** Open an extension page and report whether it rendered anything without erroring. */
async function checkPage(context: BrowserContext, extId: string, path: string, name: string): Promise<CheckResult> {
    const errors: string[] = [];
    let page: Page | undefined;
    try {
        page = await context.newPage();
        page.on("pageerror", (e) => errors.push(String(e)));
        page.on("console", (m) => {
            if (m.type() === "error") errors.push(m.text());
        });
        await page.goto(`chrome-extension://${extId}/${path.replace(/^\/+/, "")}`, {
            timeout: PAGE_TIMEOUT_MS,
            waitUntil: "domcontentloaded",
        });
        // `globalThis as any` rather than DOM lib types: this file runs under Node's lib set, and
        // the callback is serialised into the page, so the page's own globals are what apply.
        const [body, html] = await page.evaluate(() => {
            const d = (globalThis as any).document;
            return [d?.body?.innerText?.trim().length ?? 0, d?.body?.innerHTML?.trim().length ?? 0];
        });
        if (errors.length) return { name, status: "fail", detail: errors[0] };
        // A popup that renders nothing at all is broken even when nothing threw — the usual
        // shape of an MV3 port whose popup script died silently.
        if (!body && !html) return { name, status: "fail", detail: "page rendered empty" };
        return { name, status: "pass" };
    } catch (e) {
        return { name, status: "fail", detail: String(e).split("\n")[0] };
    } finally {
        await page?.close().catch(() => { });
    }
}

/**
 * One browser session: load the extension, run every applicable check, return the results.
 * Never throws — a harness failure is reported as `loaded: false` with every check `na`, because
 * "our harness broke" and "the extension is broken" must not be the same datum.
 */
export async function runBehaviourChecks(extDir: string): Promise<BehaviourReport> {
    const manifest = readManifest(extDir);
    const mv = typeof manifest.manifest_version === "number" ? manifest.manifest_version : undefined;
    const extId = unpackedExtensionId(extDir);
    const checks: CheckResult[] = [];
    const userDataDir = mkdtempSync(join(tmpdir(), "behaviour-"));
    let context: BrowserContext | undefined;
    let http: { url: string; close: () => Promise<void> } | undefined;

    try {
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            timeout: 20000,
            // MV2 is disabled by default in current Chrome, so the BASELINE would fail to load for
            // reasons that have nothing to do with the extension. Re-enabling it is what makes the
            // MV2 and MV3 runs comparable at all.
            args: [...chromeArgs(extDir), "--disable-features=ExtensionManifestV2Disabled,ExtensionManifestV2Unsupported"],
        });

        // 1. Background context alive — MV3 service worker or MV2 background page. Version-agnostic
        //    on purpose: the question is "does its background code run", not "how".
        let sw = context.serviceWorkers()[0];
        if (!sw && mv === 3) sw = await context.waitForEvent("serviceworker", { timeout: SW_TIMEOUT_MS }).catch(() => undefined as any);
        const bgPage = context.backgroundPages()[0];
        const hasBackground = Boolean(sw || bgPage);
        const declaresBackground = Boolean(manifest.background);
        checks.push(
            !declaresBackground
                ? { name: "background_alive", status: "na", detail: "no background declared" }
                : hasBackground
                    ? { name: "background_alive", status: "pass" }
                    : { name: "background_alive", status: "fail", detail: "no service worker or background page" },
        );

        // 2. Extension pages render.
        const action = manifest.action ?? manifest.browser_action ?? manifest.page_action ?? {};
        const popup = action.default_popup;
        checks.push(popup ? await checkPage(context, extId, popup, "popup_renders") : { name: "popup_renders", status: "na", detail: "no popup" });

        const options = manifest.options_page ?? manifest.options_ui?.page;
        checks.push(options ? await checkPage(context, extId, options, "options_renders") : { name: "options_renders", status: "na", detail: "no options page" });

        const newtab = manifest.chrome_url_overrides?.newtab;
        checks.push(newtab ? await checkPage(context, extId, newtab, "newtab_renders") : { name: "newtab_renders", status: "na", detail: "no newtab override" });

        // 3. Storage round-trips from an extension context. Cheap, and it catches a whole class of
        //    MV3 ports that lost their permissions or moved state into a worker global that dies.
        checks.push(await checkStorage(context, extId, manifest));

        // 4. Content script injection, when one would match a plain local page.
        if (broadContentScript(manifest)) {
            http = await serveBlank();
            checks.push(await checkContentScript(context, http.url));
        } else {
            checks.push({ name: "content_script_injects", status: "na", detail: "no content script matching a local page" });
        }

        // 5. Declared DNR rulesets are actually enabled. A migration that writes rules.json and
        //    forgets to wire it up loads perfectly and blocks nothing.
        checks.push(await checkDnr(sw, manifest));

        // 6. Service worker survives termination. This is where MV3 ports break in the wild and
        //    where a load-only harness is blind: the worker is torn down after ~30s idle and must
        //    come back with its listeners intact.
        checks.push(await checkWorkerRestart(context, sw, mv));

        const loaded = hasBackground || checks.some((c) => c.status === "pass");
        return { loaded, extensionId: extId, manifestVersion: mv, checks };
    } catch (e) {
        return {
            loaded: false,
            manifestVersion: mv,
            checks: checks.length ? checks : [],
            error: String(e).split("\n")[0],
        };
    } finally {
        await context?.close().catch(() => { });
        await http?.close().catch(() => { });
    }
}

async function checkStorage(context: BrowserContext, extId: string, manifest: any): Promise<CheckResult> {
    const perms: string[] = [...(manifest.permissions ?? [])].filter((p: unknown) => typeof p === "string");
    if (!perms.includes("storage")) return { name: "storage_roundtrip", status: "na", detail: "no storage permission" };
    // Any packaged page gives us an extension context to run in; the manifest is guaranteed to exist.
    const page = await context.newPage();
    try {
        await page.goto(`chrome-extension://${extId}/manifest.json`, { timeout: PAGE_TIMEOUT_MS });
        const ok = await page.evaluate(async () => {
            const c = (globalThis as any).chrome;
            if (!c?.storage?.local) return false;
            await c.storage.local.set({ __behaviour_probe: 42 });
            const got = await c.storage.local.get("__behaviour_probe");
            await c.storage.local.remove("__behaviour_probe");
            return got.__behaviour_probe === 42;
        });
        return ok ? { name: "storage_roundtrip", status: "pass" } : { name: "storage_roundtrip", status: "fail", detail: "value did not survive a set/get" };
    } catch (e) {
        return { name: "storage_roundtrip", status: "fail", detail: String(e).split("\n")[0] };
    } finally {
        await page.close().catch(() => { });
    }
}

/**
 * Content scripts run in an isolated world we cannot reach from `page.evaluate`, so injection is
 * observed through CDP instead: Chromium announces the isolated execution context it creates for
 * the extension. No CDP (or no context) means we cannot tell, which is `na`, not a failure.
 */
async function checkContentScript(context: BrowserContext, url: string): Promise<CheckResult> {
    const name = "content_script_injects";
    const page = await context.newPage();
    try {
        const client = await context.newCDPSession(page);
        let isolated = false;
        client.on("Runtime.executionContextCreated" as any, (ev: any) => {
            if (ev?.context?.auxData?.type === "isolated") isolated = true;
        });
        await client.send("Runtime.enable");
        await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: "load" });
        await page.waitForTimeout(1500); // document_idle scripts land after load
        return isolated ? { name, status: "pass" } : { name, status: "fail", detail: "no isolated world created on a matching page" };
    } catch (e) {
        return { name, status: "na", detail: `could not observe injection: ${String(e).split("\n")[0]}` };
    } finally {
        await page.close().catch(() => { });
    }
}

async function checkDnr(sw: any, manifest: any): Promise<CheckResult> {
    const name = "dnr_rulesets_enabled";
    const declared = manifest.declarative_net_request?.rule_resources;
    if (!Array.isArray(declared) || !declared.length) return { name, status: "na", detail: "no static rulesets declared" };
    if (!sw) return { name, status: "fail", detail: "no service worker to query rulesets from" };
    try {
        const enabled: string[] = await sw.evaluate(async () => {
            const c = (globalThis as any).chrome;
            return c?.declarativeNetRequest ? await c.declarativeNetRequest.getEnabledRulesets() : [];
        });
        return enabled.length
            ? { name, status: "pass" }
            : { name, status: "fail", detail: `${declared.length} ruleset(s) declared, none enabled` };
    } catch (e) {
        return { name, status: "fail", detail: String(e).split("\n")[0] };
    }
}

/**
 * Kill the worker and make it come back. `ServiceWorker.stopAllWorkers` is the same teardown
 * Chrome performs on idle, so this is the real lifecycle, not a simulation of it.
 */
async function checkWorkerRestart(context: BrowserContext, sw: any, mv: number | undefined): Promise<CheckResult> {
    const name = "worker_survives_restart";
    if (mv !== 3) return { name, status: "na", detail: "not an MV3 service worker" };
    if (!sw) return { name, status: "fail", detail: "no service worker to restart" };
    const page = await context.newPage();
    try {
        const client = await context.newCDPSession(page);
        await client.send("ServiceWorker.enable");
        await client.send("ServiceWorker.stopAllWorkers" as any);
        // Waking it: any extension page load re-dispatches events into the worker.
        await page.goto(`${sw.url().replace(/\/[^/]*$/, "")}/manifest.json`, { timeout: PAGE_TIMEOUT_MS }).catch(() => { });
        const deadline = Date.now() + SW_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const [alive] = context.serviceWorkers();
            if (alive) {
                try {
                    // Not just present: responsive, with its API surface intact.
                    const ok = await alive.evaluate(() => Boolean((globalThis as any).chrome?.runtime?.id));
                    if (ok) return { name, status: "pass" };
                } catch { /* still starting */ }
            }
            await page.waitForTimeout(300);
        }
        return { name, status: "fail", detail: "worker did not come back after termination" };
    } catch (e) {
        return { name, status: "na", detail: `could not drive worker termination: ${String(e).split("\n")[0]}` };
    } finally {
        await page.close().catch(() => { });
    }
}

/**
 * Behaviour-preservation score. Only checks the ORIGINAL passed are counted, so an extension that
 * never had a working popup cannot be marked down for still not having one, and a check our
 * harness cannot run (`na`) is excluded from both sides rather than guessed at.
 */
export function scoreBehaviour(baseline: BehaviourReport, post: BehaviourReport): BehaviourScore {
    const postByName = new Map(post.checks.map((c) => [c.name, c]));
    const expected = baseline.checks.filter((c) => c.status === "pass");
    const regressions: string[] = [];
    let passed = 0;
    for (const b of expected) {
        const p = postByName.get(b.name);
        if (p?.status === "pass") passed++;
        // An `na` post-check for something the original did is a lost capability, not a free pass:
        // "no popup declared any more" is exactly the silent-removal failure we are looking for.
        else regressions.push(b.name);
    }
    return {
        score: expected.length ? passed / expected.length : null,
        denominator: expected.length,
        passed,
        regressions,
    };
}

/** Human-readable one-liner per check, for the fix prompt. */
export function formatBehaviour(report: BehaviourReport, baseline?: BehaviourReport): string {
    const baseByName = new Map((baseline?.checks ?? []).map((c) => [c.name, c]));
    const lines: string[] = [];
    for (const c of report.checks) {
        const base = baseByName.get(c.name);
        // Only regressions are actionable: a check the original also failed is out of scope.
        if (baseline && base?.status !== "pass") continue;
        if (c.status === "pass") continue;
        lines.push(`- ${c.name}: ${c.status.toUpperCase()}${c.detail ? ` — ${c.detail}` : ""}`);
    }
    if (!lines.length) return "";
    return [
        baseline
            ? "## Behaviour lost in migration\n\nThe ORIGINAL extension passed these checks and the migrated one does not. Fix each:"
            : "## Behaviour checks failing\n",
        "",
        ...lines,
        "",
    ].join("\n");
}

/** True when the original extension is not gradeable, so the instance must leave the denominator. */
export function isInvalidInstance(baseline: BehaviourReport): boolean {
    return !baseline.loaded || baseline.checks.every((c) => c.status !== "pass");
}
