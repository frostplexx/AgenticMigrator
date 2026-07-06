// Verify a migrated extension by loading it into headed Chromium (on the container's Xvfb
// display) and checking the MV3 service worker registers. TS port of the proven spike
// verify.mjs / the Python browser_session.py. Returns a report instead of exiting.
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface VerifyReport {
  passed: boolean;
  serviceWorker?: string;
  extensionId?: string;
  reason?: string;
  errors: string[];
}

export async function verify(extDir: string, swTimeoutMs = 15000): Promise<VerifyReport> {
  const userDataDir = mkdtempSync(join(tmpdir(), "cft-profile-"));
  const errors: string[] = [];
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      timeout: 30000,
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    context.on("weberror", (e) => errors.push(String(e.error())));

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: swTimeoutMs }).catch(() => undefined as any);

    if (sw) {
      const extId = new URL(sw.url()).host;
      await context.close();
      return { passed: true, serviceWorker: sw.url(), extensionId: extId, errors };
    }
    const bg = context.backgroundPages().map((p) => p.url());
    await context.close();
    return {
      passed: false,
      reason: "no MV3 service worker registered within timeout" + (bg.length ? ` (found background page: ${bg[0]})` : ""),
      errors,
    };
  } catch (err) {
    try { await context?.close(); } catch {}
    return { passed: false, reason: `browser error: ${String(err)}`, errors };
  }
}
