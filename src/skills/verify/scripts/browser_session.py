"""Launch and drive Chromium for extension verification.

Runs **headed** against the container's X server (the bundled `--headless=new` does not
exercise the extension the way real use does, and the container provides an X11 display).
The extension service worker is observed via the Chrome DevTools Protocol over the
remote-debugging port — Playwright's high-level `service_workers` list is unreliable for
event-driven MV3 workers.
"""

import json
import os
import shutil
import time
import urllib.request

from playwright.sync_api import sync_playwright

try:
    import websocket  # websocket-client
except ImportError:  # pragma: no cover - dependency installed by provisioning
    websocket = None

DEBUG_PORT = 9222
LOAD_TIMEOUT_S = 20
USER_DATA_DIR = "/tmp/verify-profile"
# Chrome writes extension load failures (bad manifest, invalid rules.json, etc.) here.
LOG_FILE = "/tmp/verify-chrome.log"

# Markers Chrome uses when it refuses to load an unpacked extension. We surface the
# matching log line verbatim so the agent gets the actual reason (e.g. the offending
# rules.json key) instead of a vague "service worker never registered".
_LOAD_ERROR_MARKERS = (
    "Failed to load extension",
    "Could not load manifest",
    "Manifest file is missing or unreadable",
    "Manifest is not valid JSON",
    "Invalid value for",
)

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


def capture_load_errors(report) -> int:
    """Scan Chrome's log for extension load failures and add them to ``report``.

    When an unpacked extension is rejected (bad manifest, invalid declarativeNetRequest
    rules.json, etc.) the service worker never registers, so the only place the actual
    reason exists is Chrome's own log. We surface the matching line verbatim. Safe to call
    even if Chrome never started (the log may still hold the reason). Returns the number of
    load errors found.
    """
    try:
        with open(LOG_FILE, encoding="utf-8", errors="replace") as f:
            content = f.read()
    except OSError:
        return 0

    seen: set[str] = set()
    for line in content.splitlines():
        if not any(marker in line for marker in _LOAD_ERROR_MARKERS):
            continue
        # Trim Chrome's log prefix ("[pid:tid:ts:ERROR:file] ") to the message itself.
        msg = line.split("] ", 1)[-1].strip()
        if msg and msg not in seen:
            seen.add(msg)
            report.error("extension.load", msg)
    return len(seen)


class BrowserSession:
    """Headed Chromium with the extension loaded, wired for error capture."""

    def __init__(self, extension_dir: str, report):
        self.extension_dir = extension_dir
        self.report = report
        self._pw_cm = None
        self._pw = None
        self.context = None
        self._ws = None

    def __enter__(self) -> "BrowserSession":
        # Use the container's X server (set by the VNC stack). Headed so content scripts,
        # popups and event handlers actually run as they would in real use.
        os.environ.setdefault("DISPLAY", ":1")
        shutil.rmtree(USER_DATA_DIR, ignore_errors=True)
        # Start from a clean log so we only read load errors from this run.
        try:
            os.remove(LOG_FILE)
        except OSError:
            pass

        self._pw_cm = sync_playwright()
        self._pw = self._pw_cm.__enter__()
        self.context = self._pw.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            executable_path=find_chrome(),
            headless=False,
            args=[
                f"--remote-debugging-port={DEBUG_PORT}",
                # Allow the local CDP WebSocket connection (Chrome blocks it otherwise).
                f"--remote-allow-origins=http://127.0.0.1:{DEBUG_PORT}",
                f"--disable-extensions-except={self.extension_dir}",
                f"--load-extension={self.extension_dir}",
                # Log extension load failures to a file we can read back.
                "--enable-logging",
                f"--log-file={LOG_FILE}",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )

        self.context.on("page", self.wire_page)
        for pg in self.context.pages:
            self.wire_page(pg)

        try:
            self.report.chrome_version = http_json("/json/version").get("Browser")
        except Exception:
            pass
        return self

    def __exit__(self, *exc):
        if self._ws is not None:
            try:
                self._ws.close()
            except Exception:
                pass
        if self.context is not None:
            try:
                self.context.close()
            except Exception:
                pass
        if self._pw_cm is not None:
            self._pw_cm.__exit__(*exc)

    def wire_page(self, page) -> None:
        """Capture console errors/warnings and uncaught exceptions from a page (this also
        catches content-script errors, which surface in the host page)."""
        def on_console(msg):
            if msg.type == "error":
                self.report.error("page.console", msg.text)
            elif msg.type == "warning":
                self.report.warn("page.console", msg.text)

        page.on("console", on_console)
        page.on("pageerror", lambda exc: self.report.error("page.error", str(exc)))

    def new_page(self):
        """Create a page that is guaranteed to be wired for error capture."""
        page = self.context.new_page()
        self.wire_page(page)
        return page

    def wait_for_service_worker(self) -> None:
        """Poll CDP for the extension's service-worker target; on success mark the report
        loaded, record the extension id, and attach a CDP session for error capture."""
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

        if not sw_target:
            # The extension didn't come up. Pull the concrete reason from Chrome's log
            # (e.g. an invalid rules.json key) so the failure is actionable.
            self._capture_load_errors()
            return

        self.report.loaded = True
        self.report.extension_id = sw_target["url"].split("/")[2]

        if websocket is not None and sw_target.get("webSocketDebuggerUrl"):
            try:
                self._ws = websocket.create_connection(
                    sw_target["webSocketDebuggerUrl"], timeout=5
                )
                self._ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
                self._ws.send(json.dumps({"id": 2, "method": "Log.enable"}))
            except Exception as e:
                self.report.warn("verify", f"Could not attach to service worker: {e}")
                self._ws = None

    def _capture_load_errors(self) -> None:
        capture_load_errors(self.report)

    def drain_service_worker(self, seconds: float) -> None:
        """Read buffered service-worker CDP events (exceptions, console, log) into the
        report. Call after exercising so use-time errors are captured."""
        if self._ws is None:
            time.sleep(min(seconds, 2))
            return

        end = time.time() + seconds
        self._ws.settimeout(1.0)
        while time.time() < end:
            try:
                raw = self._ws.recv()
            except Exception:
                continue
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            self._handle_cdp_event(msg.get("method"), msg.get("params", {}))

    def _handle_cdp_event(self, method, params) -> None:
        if method == "Runtime.exceptionThrown":
            d = params.get("exceptionDetails", {})
            text = (d.get("exception") or {}).get("description") or d.get("text")
            self.report.error("service_worker.exception", text)
        elif method == "Runtime.consoleAPICalled":
            text = " ".join(
                str(a.get("value", a.get("description", "")))
                for a in params.get("args", [])
            )
            t = params.get("type")
            if t == "error":
                self.report.error("service_worker.console", text)
            elif t in ("warning", "warn"):
                self.report.warn("service_worker.console", text)
            else:
                self.report.log(f"service_worker.console.{t}", text)
        elif method == "Log.entryAdded":
            entry = params.get("entry", {})
            lvl = entry.get("level")
            if lvl == "error":
                self.report.error("service_worker.log", entry.get("text"))
            elif lvl == "warning":
                self.report.warn("service_worker.log", entry.get("text"))
