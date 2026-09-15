// Verify a migrated extension by loading it into headed Chromium (on the container's Xvfb
// display) and checking the MV3 service worker registers. TS port of the proven spike
// verify.mjs / the Python browser_session.py.
//
// A broken extension (bad manifest/rules.json) makes Chrome pop an "Error Loading Extension"
// modal that hangs launchPersistentContext until timeout. Like the Python version we bound
// the launch and read Chrome's --log-file for the REAL load error, so the fix loop gets an
// actionable reason instead of an opaque Playwright timeout.
import { chromium, type BrowserContext } from "playwright";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackedExtensionId } from "./extensionId.js";

export interface VerifyReport {
    passed: boolean;
    serviceWorker?: string;
    extensionId?: string;
    reason?: string;
    errors: string[];
    /** Errors the service worker/pages logged AFTER a successful registration. */
    runtimeErrors?: string[];
}

const LAUNCH_TIMEOUT_MS = 15000; // healthy load is ~2-3s; a hung modal is capped here
const LOG_FILE = "/tmp/chrome-verify.log";
const MAX_LAUNCH_ATTEMPTS = Number(process.env.VERIFY_ATTEMPTS ?? 2);
// Time to let a freshly-registered worker run its top-level code and first events before we
// decide it is healthy. Long enough to catch immediate throws, short enough not to slow the loop.
const SETTLE_MS = Number(process.env.VERIFY_SETTLE_MS ?? 2500);

function readLoadErrors(): string[] {
    try {
        const text = readFileSync(LOG_FILE, "utf8");
        return text
            .split(/\r?\n/)
            .filter((l) => /extension|manifest|rules|declarative|Failed to load|Invalid/i.test(l))
            .map((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim())
            .filter(Boolean)
            .slice(-8);
    } catch {
        return [];
    }
}

/**
 * Chrome flags for loading one unpacked extension. Shared with behaviour.ts so the two harnesses
 * cannot drift into loading the extension under different conditions and disagreeing for that
 * reason alone. Callers add their own logging/feature flags.
 */
export function chromeArgs(extDir: string): string[] {
    return [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
    ];
}

/**
 * Does the migrated extension declare a service worker?
 *
 * The question decides what "verified" means, and getting it wrong had teeth. `passed` used to be
 * "an MV3 service worker registered", full stop — so an extension that never had a background at
 * all could not pass, and the fix loop told the model so in as many words. The model did the
 * obvious thing: it invented one. In the DeepSeek run, a content-script-only extension came back
 * with a new background.js whose own comment read "No background work is required, but an MV3
 * extension must register a service worker" — which is false, and which our failure message taught
 * it. 22 of the 49 extensions in that corpus have no background, so nearly half were exposed to a
 * harness that rewarded adding code the original never had.
 */
function declaresServiceWorker(extDir: string): boolean {
    try {
        const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8")) as {
            background?: { service_worker?: string };
        };
        return Boolean(manifest.background?.service_worker);
    } catch {
        // Unreadable manifest is a load failure, which the launch path reports with Chrome's own
        // reason. Requiring a worker here would only mask it.
        return false;
    }
}

/**
 * Is the extension installed at all?
 *
 * Its own pages are reachable exactly when Chrome accepted it, so this is the load check for an
 * extension with nothing else to look at — and it is the one thing worth asserting about every
 * migration regardless of shape.
 */
async function installed(context: BrowserContext, extDir: string): Promise<boolean> {
    const page = await context.newPage();
    try {
        const res = await page.goto(`chrome-extension://${unpackedExtensionId(extDir)}/manifest.json`, {
            timeout: 10_000,
        });
        return Boolean(res && res.status() === 200);
    } catch {
        return false;
    } finally {
        await page.close().catch(() => { });
    }
}

async function launchOnce(extDir: string, swTimeoutMs: number): Promise<VerifyReport> {
    const userDataDir = mkdtempSync(join(tmpdir(), "cft-profile-"));
    const errors: string[] = [];
    let context;
    try {
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            timeout: LAUNCH_TIMEOUT_MS,
            args: [...chromeArgs(extDir), "--enable-logging", `--log-file=${LOG_FILE}`],
        });
        context.on("weberror", (e) => errors.push(String(e.error())));

        let [sw] = context.serviceWorkers();
        if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: swTimeoutMs }).catch(() => undefined as any);

        if (sw) {
            const extId = new URL(sw.url()).host;
            // Registering is not the same as working: a worker that throws on its first event,
            // or calls a chrome.* API it lacks permission for, registers fine and then fails at
            // runtime. Settle briefly and collect what it logs, so those defects reach the agent
            // instead of being reported as a clean pass.
            const runtimeErrors: string[] = [];
            sw.on("console" as any, (msg: any) => {
                if (msg.type() === "error") runtimeErrors.push(`service worker console: ${msg.text()}`);
            });
            context.on("console", (msg) => {
                if (msg.type() === "error") runtimeErrors.push(`page console: ${msg.text()}`);
            });
            // Uncaught page exceptions already arrive via the "weberror" handler above.
            await new Promise((r) => setTimeout(r, SETTLE_MS));
            await context.close();
            const swErrors = [...new Set([...runtimeErrors, ...errors])].slice(0, 10);
            return {
                passed: true,
                serviceWorker: sw.url(),
                extensionId: extId,
                errors: swErrors,
                runtimeErrors: swErrors,
            };
        }
        // No worker — but only an extension that DECLARES one owes us a worker. For the rest, the
        // question is whether Chrome accepted it and whether anything threw.
        if (!declaresServiceWorker(extDir)) {
            const runtimeErrors: string[] = [];
            context.on("console", (msg) => {
                if (msg.type() === "error") runtimeErrors.push(`page console: ${msg.text()}`);
            });
            const ok = await installed(context, extDir);
            await new Promise((r) => setTimeout(r, SETTLE_MS));
            const loadErrsNoBg = readLoadErrors();
            await context.close();
            const collected = [...new Set([...runtimeErrors, ...errors, ...loadErrsNoBg])].slice(0, 10);
            return ok
                ? {
                      passed: true,
                      extensionId: unpackedExtensionId(extDir),
                      errors: collected,
                      runtimeErrors: collected,
                  }
                : {
                      passed: false,
                      reason:
                          "Chrome did not install the extension (no background declared, so no worker is expected)" +
                          (collected.length ? ` — ${collected[collected.length - 1]}` : ""),
                      errors: collected,
                  };
        }

        const bg = context.backgroundPages().map((p) => p.url());
        const loadErrs = readLoadErrors();
        await context.close();
        return {
            passed: false,
            reason:
                "no MV3 service worker registered" +
                (bg.length ? ` (found MV2 background page: ${bg[0]})` : ""),
            errors: [...errors, ...loadErrs],
        };
    } catch (err) {
        // Launch timed out/failed — almost always Chrome rejecting the extension at load
        // (invalid manifest.json or a malformed declarativeNetRequest rules.json). Pull the
        // concrete reason from Chrome's log.
        try { await context?.close(); } catch { }
        const loadErrs = readLoadErrors();
        const isTimeout = /Timeout .* exceeded/.test(String(err));
        return {
            passed: false,
            reason:
                (isTimeout
                    ? "Chrome rejected the extension at load time (invalid manifest.json or rules.json)"
                    : `browser error: ${String(err)}`) +
                (loadErrs.length ? ` — ${loadErrs[loadErrs.length - 1]}` : ""),
            errors: [...errors, ...loadErrs],
        };
    }
}

export async function verify(extDir: string, swTimeoutMs = 12000): Promise<VerifyReport> {
    let last: VerifyReport = { passed: false, reason: "verify did not run", errors: [] };
    for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt++) {
        // Clear per attempt so a stale line from a prior launch cannot mask
        // whether THIS launch produced an actionable error.
        rmSync(LOG_FILE, { force: true });
        last = await launchOnce(extDir, swTimeoutMs);
        if (last.passed) return last;
        // A hung launch (timeout) with no actionable Chrome log line is the only
        // transient case worth retrying; deterministic load errors (bad
        // manifest/rules/CSP) carry a log line and return immediately.
        const hungWithoutReason =
            /Chrome rejected the extension at load time/.test(last.reason ?? "") &&
            last.errors.length === 0;
        if (!hungWithoutReason) return last;
    }
    return last;
}
