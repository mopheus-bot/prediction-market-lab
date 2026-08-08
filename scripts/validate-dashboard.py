#!/usr/bin/env python3
"""
pm-bot — dashboard validation (chunk 7).

Loads `public/index.html` in headless Chromium and checks:
- Page loads without console errors
- No 404s on any <img> / <link> / <script> / inline assets
- The brand bar, hero PnL, and bot controls render
- Critical text content is present (monogram, wordmark, section titles)

Serves the file from a temporary directory (so the relative
asset paths resolve) and runs the checks. Exits non-zero on
any failure.
"""

import sys
import tempfile
import http.server
import socketserver
import threading
import time
from pathlib import Path
from playwright.sync_api import sync_playwright


def serve_dir(directory: str) -> tuple[str, socketserver.TCPServer]:
    """Serve `directory` over HTTP on a free port. Returns
    (base_url, server). The server is a daemon thread; the
    caller is responsible for `server.shutdown()` when done."""

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

        def log_message(self, *args, **kwargs):
            pass  # silence

    class ReusableTCPServer(socketserver.TCPServer):
        allow_reuse_address = True

    httpd = ReusableTCPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    # Give the server a moment to actually start listening.
    import time as _time
    _time.sleep(0.1)
    return f"http://127.0.0.1:{port}/index.html", httpd


def main() -> int:
    here = Path(__file__).parent
    public = here.parent / "public"
    if not (public / "index.html").exists():
        print(f"FAIL: {public / 'index.html'} not found")
        return 1

    url, server = serve_dir(str(public))
    print(f"[validate-dashboard] serving {public} at {url}")

    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            context = browser.new_context()
            page = context.new_page()
            console_errors: list[str] = []
            failed_requests: list[str] = []

            page.on(
                "console",
                lambda msg: console_errors.append(msg.text)
                if msg.type == "error"
                else None,
            )
            page.on(
                "requestfailed",
                lambda req: failed_requests.append(
                    f"{req.url}: {req.failure}"
                ),
            )
            page.on(
                "response",
                lambda r: failed_requests.append(
                    f"{r.url}: HTTP {r.status}"
                )
                if r.status >= 400
                else None,
            )
            # POSTs to /api/pm/* return 501 from the static
            # server (it doesn't run the Worker). Track
            # them separately so we can filter both
            # `failed_requests` and the console error
            # "Failed to load resource" (which doesn't
            # include the URL).
            api_post_501s: list[str] = []

            page.goto(url, wait_until="networkidle", timeout=15000)
            time.sleep(0.5)  # let any JS settle

            # Critical text presence
            html = page.content()
            required_text = [
                "Prediction Market Lab",
                "finance",
                "pm-bot",
                "Account balance",
                "Total PnL",
                "Cadence",
                "Stage",
                "Trading mode",
                "Open positions",
                "Per-vertical breakdown",
                "Recent trades",
                "Recent signals",
                "Daily recap",
                "Cron runs",
            ]
            for txt in required_text:
                if txt not in html:
                    failures.append(f"missing required text: {txt!r}")

            # The Prediction Market Lab mark SVG must be present.
            mono = page.locator("svg.brand-mono").count()
            if mono < 1:
                failures.append("brand monogram SVG missing")

            # Stage panel + cadence panel must render.
            stage_panel = page.locator("#stage-panel").count()
            if stage_panel < 1:
                failures.append("stage panel missing")
            cadence_grid = page.locator("#cadence-grid").count()
            if cadence_grid < 1:
                failures.append("cadence grid missing")

            # Accessibility: page should have a lang attribute.
            if not page.locator("html[lang]").count():
                failures.append("missing html[lang] attribute")

            # Accessibility: focus-visible style rule must be present
            # in the page (it's the primary a11y pattern).
            if "focus-visible" not in html:
                failures.append("missing :focus-visible styles")

            # Accessibility: prefers-reduced-motion respected.
            if "prefers-reduced-motion" not in html:
                failures.append("missing prefers-reduced-motion media query")

            # No 4xx/5xx requests — but the static server doesn't
            # run the Worker, so /api/pm/* calls will 404. We
            # filter those out (they're expected for a static
            # page; the dashboard fetches them at runtime when
            # deployed).
            api_404s = [r for r in failed_requests if "/api/pm/" in r]
            real_failures = [
                r
                for r in failed_requests
                if ("HTTP 4" in r or "HTTP 5" in r) and "/api/pm/" not in r
            ]
            if real_failures:
                failures.append(f"HTTP failures: {real_failures}")
            if api_404s:
                print(
                    f"[validate-dashboard] (expected) {len(api_404s)} /api/pm/* "
                    f"404s — the static server doesn't run the Worker. "
                    f"Deploy to verify the API calls."
                )

            # No console errors (warning + log are OK). The
            # /api/pm/* 404s + 501s (POSTs) surface as console
            # errors via the browser; we filter them out because
            # they're a direct consequence of the static-only
            # test (no Worker running). When deployed, those
            # calls succeed and the errors disappear.
            real_console_errors = [
                e
                for e in console_errors
                if (
                    ("404" not in e and "501" not in e and "405" not in e)
                    or "api/pm" in e.lower()
                    or "/api/pm" in e
                )
            ]
            # Above is too coarse — any 404 console error is
            # almost certainly an /api/pm/* miss. Skip ALL 404
            # console errors; the HTTP filter above caught
            # the real asset 404s. Also filter 501s (POSTs to
            # /api/pm/* from the static-only test) and 405s
            # (method-not-allowed responses).
            real_console_errors = [
                e
                for e in console_errors
                if "404" not in e and "501" not in e and "405" not in e
            ]
            if real_console_errors:
                failures.append(f"console errors: {real_console_errors}")

            # The page title
            title = page.title()
            if "pm-bot" not in title:
                failures.append(f"title missing 'pm-bot': {title!r}")

            # Snapshot
            screenshot = public / "_validate-screenshot.png"
            page.screenshot(path=str(screenshot), full_page=True)
            print(f"[validate-dashboard] screenshot: {screenshot}")
        finally:
            browser.close()

    server.shutdown()

    if failures:
        print(f"\n[validate-dashboard] {len(failures)} FAILURE(S):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"\n[validate-dashboard] all checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
