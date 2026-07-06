"""Tier A: manifest-driven exerciser.

Actively drives the extension along the surface declared in its manifest so that use-time errors (not just load-time
ones) surface and get captured:

  - content scripts: navigate to a page matching each `content_scripts[].matches` pattern (served synthetically via
    request interception, so it works offline and deterministically)
  - popup / options pages: open them and click their interactive controls
  - web_accessible_resources: load each literal resource

It does not assert behavior. Errors are captured by the BrowserSession's page/service-worker wiring.
"""

import json
import os
from urllib.parse import urlparse

_SYNTHETIC_HTML = (
    "<!doctype html><html><head><title>verify</title></head>"
    "<body><h1>verify fixture</h1></body></html>"
)


def match_pattern_to_url(pattern: str) -> str | None:
    """Turn a content-script match pattern into a concrete URL to visit.

    e.g. `<all_urls>` -> https://example.com/, `https://*.lmu.de/*` -> https://www.lmu.de/,
    `*://example.com/*` -> https://example.com/.
    """
    if not pattern or pattern in ("<all_urls>", "*://*/*"):
        return "https://example.com/"
    try:
        scheme, rest = pattern.split("://", 1)
    except ValueError:
        return None
    if scheme in ("*", "http", "https"):
        scheme = "https"
    elif scheme not in ("http", "https"):
        return None  # file:, ftp:, etc. — skip
    host = rest.split("/", 1)[0]
    if host in ("*", ""):
        host = "example.com"
    elif host.startswith("*."):
        host = "www." + host[2:]
    return f"{scheme}://{host}/"


def exercise(session, extension_dir: str, ext_id: str) -> None:
    """Drive the extension's declared surface. `session` is a BrowserSession."""
    report = session.report
    manifest = {}
    try:
        with open(os.path.join(extension_dir, "manifest.json")) as f:
            manifest = json.load(f)
    except Exception as e:
        report.error("manifest", f"Could not read manifest.json: {e}")
        return

    _exercise_content_scripts(session, manifest)
    _exercise_extension_pages(session, manifest, ext_id)


def _exercise_content_scripts(session, manifest: dict) -> None:
    """Visit a synthetic page for each content-script match pattern so the scripts run."""
    seen_urls: set[str] = set()
    for entry in manifest.get("content_scripts", []) or []:
        for pattern in entry.get("matches", []) or []:
            url = match_pattern_to_url(pattern)
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            _visit_synthetic(session, url)


def _visit_synthetic(session, url: str) -> None:
    host = urlparse(url).netloc
    # Fulfill every request on this host with a minimal page so content scripts inject
    # (injection matches on URL, not response body) without touching the real network.
    matcher = lambda u, _host=host: urlparse(u).netloc == _host
    session.context.route(
        matcher,
        lambda route: route.fulfill(
            status=200, content_type="text/html", body=_SYNTHETIC_HTML
        ),
    )
    try:
        page = session.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=8000)
            page.wait_for_timeout(800)
        finally:
            page.close()
    except Exception as e:
        session.report.warn("exerciser", f"Could not visit {url}: {e}")
    finally:
        try:
            session.context.unroute(matcher)
        except Exception:
            pass


def _exercise_extension_pages(session, manifest: dict, ext_id: str) -> None:
    """Open the extension's own pages (popup, options, web-accessible resources) and click
    through their interactive controls to trigger handlers."""
    rels: list[str] = []

    action = manifest.get("action") or manifest.get("browser_action") or {}
    if action.get("default_popup"):
        rels.append(action["default_popup"])
    if manifest.get("options_page"):
        rels.append(manifest["options_page"])
    options_ui = manifest.get("options_ui") or {}
    if options_ui.get("page"):
        rels.append(options_ui["page"])

    for war in manifest.get("web_accessible_resources", []) or []:
        resources = war.get("resources", []) if isinstance(war, dict) else [war]
        for res in resources:
            if res and "*" not in res:  # skip globs we can't resolve to one URL
                rels.append(res)

    for rel in dict.fromkeys(rels):  # de-dupe, preserve order
        _open_and_click(session, ext_id, rel)


def _open_and_click(session, ext_id: str, rel: str) -> None:
    url = f"chrome-extension://{ext_id}/{rel.lstrip('/')}"
    try:
        page = session.new_page()
    except Exception as e:
        session.report.warn("exerciser", f"Could not open page for {rel}: {e}")
        return
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=8000)
        page.wait_for_timeout(500)
        # Click interactive controls to fire their handlers (best-effort).
        selector = "button, input[type=button], input[type=submit], input[type=checkbox], a[href]"
        elements = page.query_selector_all(selector)
        for el in elements[:25]:
            try:
                el.click(timeout=1000, force=True, no_wait_after=True)
                page.wait_for_timeout(150)
            except Exception:
                continue  # broken/disabled control; the resulting error is captured
        page.wait_for_timeout(500)
    except Exception as e:
        session.report.warn("exerciser", f"Could not exercise {rel}: {e}")
    finally:
        try:
            page.close()
        except Exception:
            pass
