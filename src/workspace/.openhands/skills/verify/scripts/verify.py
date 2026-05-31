#!/usr/bin/env python3
"""Verify a migrated Manifest V3 Chrome extension.

Launches Chromium (the one bundled in the container) with the extension loaded, waits
for its service worker to register, exercises the extension's pages, and captures
runtime errors from:
  - the extension service worker (Runtime.exceptionThrown, console error/warning)
  - the extension's own pages (popup/options): console errors + uncaught page errors

Playwright is used to launch and drive the browser; the service worker is observed via
the Chrome DevTools Protocol over the remote-debugging port (Playwright's high-level
service_workers list is unreliable for event-driven MV3 workers).

Usage:
    verify.py <extension-dir> [report-path]

Writes a JSON report and exits non-zero if the extension failed to load or any errors
were captured.
"""

import json
import os
import shutil
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

try:
    import websocket  # websocket-client
except ImportError:  # pragma: no cover - dependency is installed by provisioning
    websocket = None

DEBUG_PORT = 9222
LOAD_TIMEOUT_S = 20
COLLECT_S = 5

_CHROME_CANDIDATES = (
    os.environ.get("CHROME_BIN"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
)


def find_chrome() -> str:
    for cand in _CHROME_CANDIDATES:
        if cand and (os.path.isfile(cand) or shutil.which(cand)):
            return cand
    raise SystemExit("No Chromium/Chrome binary found in the container.")


def http_json(path: str):
    with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}{path}", timeout=5) as r:
        return json.loads(r.read())


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: verify.py <extension-dir> [report-path]", file=sys.stderr)
        return 2

    extension_dir = os.path.abspath(sys.argv[1])
    report_path = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else "/workspace/test_report.json"
    chrome = find_chrome()

    errors: list[dict] = []
    warnings: list[dict] = []
    logs: list[dict] = []

    def record(bucket, source, text):
        if text:
            bucket.append({"source": source, "text": str(text)})

    report = {
        "chromeVersion": None,
        "extensionId": None,
        "loaded": False,
        "errors": errors,
        "warnings": warnings,
        "logs": logs,
    }

    user_data_dir = "/tmp/verify-profile"
    shutil.rmtree(user_data_dir, ignore_errors=True)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            executable_path=chrome,
            headless=False,  # extensions require non-headless or --headless=new
            args=[
                "--headless=new",
                f"--remote-debugging-port={DEBUG_PORT}",
                # Allow the local CDP WebSocket connection (Chrome blocks it otherwise).
                f"--remote-allow-origins=http://127.0.0.1:{DEBUG_PORT}",
                f"--disable-extensions-except={extension_dir}",
                f"--load-extension={extension_dir}",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
        )

        try:
            report["chromeVersion"] = http_json("/json/version").get("Browser")
        except Exception:
            pass

        # Capture errors from any extension page (popup/options) Playwright knows about.
        def wire_page(page):
            def on_console(msg):
                if msg.type == "error":
                    record(errors, "page.console", msg.text)
                elif msg.type == "warning":
                    record(warnings, "page.console", msg.text)
            page.on("console", on_console)
            page.on("pageerror", lambda exc: record(errors, "page.error", str(exc)))

        context.on("page", wire_page)
        for pg in context.pages:
            wire_page(pg)

        # Locate the extension service worker target via CDP (reliable for MV3).
        sw_target = None
        deadline = time.time() + LOAD_TIMEOUT_S
        while time.time() < deadline:
            try:
                targets = http_json("/json")
            except Exception:
                targets = []
            sw = [
                t for t in targets
                if t.get("type") == "service_worker"
                and str(t.get("url", "")).startswith("chrome-extension://")
            ]
            if sw:
                sw_target = sw[0]
                break
            time.sleep(0.5)

        ws = None
        if sw_target:
            report["loaded"] = True
            report["extensionId"] = sw_target["url"].split("/")[2]

            if websocket is not None and sw_target.get("webSocketDebuggerUrl"):
                try:
                    ws = websocket.create_connection(
                        sw_target["webSocketDebuggerUrl"], timeout=5
                    )
                    ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
                    ws.send(json.dumps({"id": 2, "method": "Log.enable"}))
                except Exception as e:
                    record(warnings, "harness", f"Could not attach to service worker: {e}")
                    ws = None

        # Exercise the extension's own pages to wake the service worker and surface
        # errors that only occur once the extension actually runs.
        manifest = {}
        try:
            with open(os.path.join(extension_dir, "manifest.json")) as f:
                manifest = json.load(f)
        except Exception as e:
            record(errors, "manifest", f"Could not read manifest.json: {e}")

        ext_id = report["extensionId"]
        if ext_id:
            pages_to_open = []
            action = manifest.get("action") or manifest.get("browser_action") or {}
            if action.get("default_popup"):
                pages_to_open.append(action["default_popup"])
            if manifest.get("options_page"):
                pages_to_open.append(manifest["options_page"])
            options_ui = manifest.get("options_ui") or {}
            if options_ui.get("page"):
                pages_to_open.append(options_ui["page"])

            for rel in pages_to_open:
                try:
                    pg = context.new_page()
                    pg.goto(f"chrome-extension://{ext_id}/{rel}", timeout=8000)
                    pg.wait_for_timeout(1000)
                except Exception as e:
                    record(warnings, "harness", f"Could not open {rel}: {e}")

        # Drain service-worker CDP events for a short window.
        if ws is not None:
            end = time.time() + COLLECT_S
            ws.settimeout(1.0)
            while time.time() < end:
                try:
                    raw = ws.recv()
                except Exception:
                    continue
                if not raw:
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                method = msg.get("method")
                params = msg.get("params", {})
                if method == "Runtime.exceptionThrown":
                    d = params.get("exceptionDetails", {})
                    text = (d.get("exception") or {}).get("description") or d.get("text")
                    record(errors, "service_worker.exception", text)
                elif method == "Runtime.consoleAPICalled":
                    text = " ".join(
                        str(a.get("value", a.get("description", "")))
                        for a in params.get("args", [])
                    )
                    t = params.get("type")
                    if t == "error":
                        record(errors, "service_worker.console", text)
                    elif t in ("warning", "warn"):
                        record(warnings, "service_worker.console", text)
                    else:
                        record(logs, f"service_worker.console.{t}", text)
                elif method == "Log.entryAdded":
                    entry = params.get("entry", {})
                    lvl = entry.get("level")
                    if lvl == "error":
                        record(errors, "service_worker.log", entry.get("text"))
                    elif lvl == "warning":
                        record(warnings, "service_worker.log", entry.get("text"))
            try:
                ws.close()
            except Exception:
                pass
        else:
            time.sleep(2)

        if not report["loaded"]:
            record(
                errors,
                "harness",
                "Extension service worker never registered — the extension failed to "
                "load. Check manifest.json (manifest_version, background.service_worker) "
                "and look for top-level errors in the service worker.",
            )

        context.close()

    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    passed = report["loaded"] and not errors
    print(
        f"Extension verify {'PASSED' if passed else 'FAILED'} — "
        f"loaded={report['loaded']}, errors={len(errors)}, warnings={len(warnings)}"
    )
    for e in errors:
        print(f"  [error] ({e['source']}) {e['text']}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
