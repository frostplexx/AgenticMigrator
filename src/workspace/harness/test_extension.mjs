// Smoke-test harness for a migrated (Manifest V3) Chrome extension.
//
// Usage:
//   node test_extension.mjs <extension-dir> <chrome-binary> <report-path> [collect-seconds]
//
// Loads the unpacked extension into the given Chromium/Chrome binary, waits for the
// extension's service worker to register, and collects errors from:
//   - the extension service worker (Runtime.exceptionThrown, console error/warning, Log)
//   - a blank page (console errors/warnings, uncaught page errors)
//
// Writes a structured JSON report and exits non-zero if the extension failed to load
// or any errors were captured, so a terminal caller sees pass/fail directly.

import { writeFileSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const DEBUG_PORT = 9222;
const LAUNCH_TIMEOUT_MS = 120000;

// Launch Chrome ourselves with an explicit remote-debugging port and connect over the
// WebSocket transport. This is more robust than puppeteer.launch()'s default pipe (file
// descriptor) transport, which can fail to connect in containerized/emulated environments.
async function launchChrome(chromeBinary, extensionDir) {
  const userDataDir = mkdtempSync(resolve(tmpdir(), "cft-profile-"));
  const proc = spawn(
    chromeBinary,
    [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  // Poll the DevTools HTTP endpoint until it reports a WebSocket URL (or we time out).
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) {
        const info = await res.json();
        const browser = await puppeteer.connect({
          browserWSEndpoint: info.webSocketDebuggerUrl,
          protocolTimeout: 180000,
        });
        return { browser, proc };
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  throw new Error(
    `Chrome DevTools endpoint did not come up within ${LAUNCH_TIMEOUT_MS}ms`,
  );
}

const [, , extArg, chromeArg, reportArg, collectArg] = process.argv;

if (!extArg || !chromeArg || !reportArg) {
  console.error(
    "Usage: node test_extension.mjs <extension-dir> <chrome-binary> <report-path> [collect-seconds]",
  );
  process.exit(2);
}

const extensionDir = resolve(extArg);
const chromeBinary = resolve(chromeArg);
const reportPath = resolve(reportArg);
const collectMs = (Number(collectArg) || 6) * 1000;

const errors = [];
const warnings = [];
const logs = [];

function record(bucket, source, text) {
  if (!text) return;
  bucket.push({ source, text: String(text) });
}

const report = {
  chromeVersion: null,
  extensionId: null,
  loaded: false,
  errors,
  warnings,
  logs,
};

let browser;
let chromeProc;
try {
  ({ browser, proc: chromeProc } = await launchChrome(chromeBinary, extensionDir));

  report.chromeVersion = await browser.version();

  // Attach to the extension service worker (the MV3 background context) so we can
  // capture exceptions and console output emitted there.
  const wireServiceWorker = async (target) => {
    if (target.type() !== "service_worker") return;
    const url = target.url() || "";
    if (!url.startsWith("chrome-extension://")) return;

    if (!report.extensionId) {
      report.extensionId = url.split("/")[2] || null;
      report.loaded = true;
    }

    try {
      const session = await target.createCDPSession();
      await session.send("Runtime.enable");
      await session.send("Log.enable");

      session.on("Runtime.exceptionThrown", (e) => {
        const d = e.exceptionDetails;
        const text =
          d?.exception?.description || d?.text || "Unknown service worker exception";
        record(errors, "service_worker.exception", text);
      });

      session.on("Runtime.consoleAPICalled", (e) => {
        const text = (e.args || [])
          .map((a) => a.value ?? a.description ?? "")
          .join(" ");
        if (e.type === "error") record(errors, "service_worker.console", text);
        else if (e.type === "warning") record(warnings, "service_worker.console", text);
        else record(logs, `service_worker.console.${e.type}`, text);
      });

      session.on("Log.entryAdded", (e) => {
        const entry = e.entry || {};
        if (entry.level === "error") record(errors, "service_worker.log", entry.text);
        else if (entry.level === "warning") record(warnings, "service_worker.log", entry.text);
        else record(logs, "service_worker.log", entry.text);
      });
    } catch (err) {
      record(warnings, "harness", `Could not attach to service worker: ${err.message}`);
    }
  };

  browser.on("targetcreated", wireServiceWorker);
  for (const target of browser.targets()) {
    await wireServiceWorker(target);
  }

  // Watch a blank page for console errors and uncaught exceptions.
  const page = await browser.newPage();
  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "error") record(errors, "page.console", msg.text());
    else if (type === "warning") record(warnings, "page.console", msg.text());
  });
  page.on("pageerror", (err) => record(errors, "page.error", err.message));
  await page.goto("about:blank");

  // Give the service worker time to register and run its startup code.
  await new Promise((r) => setTimeout(r, collectMs));

  if (!report.loaded) {
    record(
      errors,
      "harness",
      "Extension service worker never registered — the extension failed to load. " +
        "Check manifest.json (manifest_version, background.service_worker).",
    );
  }
} catch (err) {
  record(errors, "harness", `Failed to launch Chrome / load extension: ${err.message}`);
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
  if (chromeProc) {
    try {
      chromeProc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

writeFileSync(reportPath, JSON.stringify(report, null, 2));

const passed = report.loaded && errors.length === 0;
console.log(
  `Extension test ${passed ? "PASSED" : "FAILED"} — ` +
    `loaded=${report.loaded}, errors=${errors.length}, warnings=${warnings.length}`,
);
if (!passed) {
  for (const e of errors) console.log(`  [error] (${e.source}) ${e.text}`);
}
process.exit(passed ? 0 : 1);
