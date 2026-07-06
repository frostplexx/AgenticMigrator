// verify.mjs — the CRITICAL proof of the container plan.
//
// Loads a Chrome extension into a HEADED Chromium (running on the container's Xvfb display)
// and checks whether its MV3 service worker registers. This is the exact risk we set out to
// retire: MV3 extensions do NOT load under --headless=new, so a self-rolled image must
// provide a real X display. If this prints PASS for the migrated extension and FAIL for the
// unmigrated one, the container + browser design is proven.
//
// Node-native equivalent of the current Python browser_session.py: Playwright's
// launchPersistentContext exposes context.serviceWorkers() directly, so no manual CDP.
//
// Usage: node verify.mjs <extension-dir>   (exit 0 = SW registered, 1 = not)

import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

const extDir = resolve(process.argv[2] ?? "fixtures/migrated-mv3");
const SW_TIMEOUT_MS = 15000;

function verdict(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

const userDataDir = mkdtempSync(join(tmpdir(), "cft-profile-"));
let context;
const loadErrors = [];

try {
  // Exact Chrome flags carried over from browser_session.py — they transfer 1:1 to
  // Playwright-Node. Headed is mandatory; --no-sandbox + --disable-dev-shm-usage are the
  // two Docker-specific must-haves.
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

  // Surface any page/worker errors that fire during load.
  context.on("weberror", (e) => loadErrors.push(String(e.error())));

  // MV3 background = a service worker. It may already be present, or arrive shortly after
  // launch. Check both.
  let [sw] = context.serviceWorkers();
  if (!sw) {
    sw = await context
      .waitForEvent("serviceworker", { timeout: SW_TIMEOUT_MS })
      .catch(() => null);
  }

  const browserVersion = context.browser()?.version() ?? "(persistent-context)";

  if (sw) {
    const extId = new URL(sw.url()).host;
    verdict({
      result: "PASS",
      extensionDir: extDir,
      serviceWorker: sw.url(),
      extensionId: extId,
      chromium: browserVersion,
      loadErrors,
    });
    await context.close();
    process.exit(0);
  } else {
    // No service worker registered within the window. For an MV2 (unmigrated) extension
    // this is the expected, correct failure — modern Chrome has no MV3 SW to register.
    verdict({
      result: "FAIL",
      reason: "no MV3 service worker registered within timeout",
      extensionDir: extDir,
      backgroundPages: context.backgroundPages().map((p) => p.url()),
      chromium: browserVersion,
      loadErrors,
    });
    await context.close();
    process.exit(1);
  }
} catch (err) {
  verdict({ result: "ERROR", extensionDir: extDir, error: String(err), loadErrors });
  try {
    await context?.close();
  } catch {}
  process.exit(2);
}
