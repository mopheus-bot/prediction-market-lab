# Chunk 7 — Dashboard (2026-08-08)

The dashboard lands. A single-page Prediction Market Lab–branded
HTML at `public/index.html`, served at `/pm/*`
by the existing ASSETS binding. Fetches the 6 status
endpoints (chunk 6) for live state. Bot control actions
(Start / Stop / Restart) POST to the chunk-3 endpoints.

## What ships

### New: `public/index.html` (the dashboard)

A 1200px-max single-page dashboard. 9 sections:

1. **Brand bar** — Prediction Market Lab monogram (inlined SVG, no
   asset request) + wordmark with gold gradient + live
   status pill (green/amber/red) + model version badge.

2. **Hero PnL** — large gold-toned display of total realized
   PnL + 24h delta. Subtle gold left-border accent.

3. **Counts card** — n_trades / n_signals / n_open in a tight
   3-stat block.

4. **Open positions** — per-ticker card list with side badge,
   size, entry, opened-time, unrealized PnL (filled in
   when the bot status returns per-position marks — chunk 7+
   enhancement; the table is wired and ready).

5. **Per-vertical breakdown** — 4-row table (weather /
   economic / politics / sports) with n_trades, realized
   PnL, n_open. PnL cells are color-coded.

6. **Recent trades** — 20-row table, latest first.

7. **Recent signals** — 20-row table with P (model
   confidence), source, was_filled.

8. **Daily recap** — the latest R2 `daily-recap/*.json`
   rendered as a stat block. Shows "no recap yet" until
   06:00 UTC fires the cron.

9. **Cron runs** — 10-row table with status (color-coded),
   duration, when.

Plus a **floating action bar** bottom-right with the Start
/ Restart / Stop bot controls. Confirmation dialogs on
Stop/Restart. Toast notification on success/failure.

### Brand (Prediction Market Lab)

Per the user memory: navy gradient
(`#0a2854 → #0b3a6f → #133b6e`), monogram in top-left at
~44px (chunk-0 used 32pt for the PDF cover; the dashboard
uses a larger monogram because the viewport is bigger),
"Prediction Market Lab" wordmark below with gold gradient + warm-gold
underline accent. We deliberately override the
landing-page-builder skill's generic "no blue" rule for
Prediction Market Lab products — the brand IS navy. (The skill's
constraint is for "generic SaaS blue"; a product with an
established brand palette is exempt.)

### New: `scripts/validate-dashboard.py`

Pre-deploy integrity check. Spins up a local static server
on a free port, loads the page in headless Chromium, and
asserts:

- No 4xx/5xx on any non-`/api/pm/*` asset (the static
  server doesn't run the Worker, so `/api/pm/*` calls
  return 404 — that's expected and we filter them out).
- No console errors (other than the API 404s).
- All required text is present (Prediction Market Lab, pm-bot,
  section titles, button labels).
- The monogram SVG is rendered.
- Page title is correct.

Takes a screenshot of the rendered page (saved to
`public/_validate-screenshot.png`; gitignored).

### New: `public/spec.md`

The design spec for the dashboard. Documents the brand,
layout, sections, and asset protocol. Acts as the
blueprint for any future dashboard redesigns.

### Updated: `.gitignore`

Ignore the validation screenshot artifact.

## Tech

- Pure HTML + CSS + vanilla JS (no React build pipeline).
- 0 third-party deps. Inline critical CSS in the head.
- Auto-refresh: every 5s for the header + every 30s for the
  rest. Pauses when the tab is hidden.
- All fetch calls go to `/api/pm/*` (relative). CF Access
  auth is via the browser session cookie.
- Mobile-responsive: at < 768px, cards stack vertically
  and the bot controls collapse into a bottom sheet.
- Dark theme only (the brand is dark navy; light mode
  doesn't fit).
- The monogram is an inlined SVG — no asset request, no
  flash, no CORS issue.

## Asset count

- 0 image files
- 0 video files
- 1 inline SVG (the monogram)

This is a data dashboard, not a marketing page. The
landing-page-builder skill's hero-video philosophy doesn't
apply here.

## Why a static page (not a CF Pages Function)

The dashboard is just data + auto-refresh. No SSR needed.
A static HTML file served by the existing ASSETS binding is
the fastest + cheapest path: 0 Worker CPU, 0 D1 reads on
the dashboard's own request, only the status API calls
(which the browser makes from the user's session).

When the dashboard needs SSR (per-vertical charts, server-
side aggregation, etc.) the upgrade is a Pages Function
with the same status API in front of it. For chunk 7 the
static page is enough.

## Verification

- `tsc --noEmit` — clean.
- `npm test` — 164/164 pass (no test changes for chunk 7;
  the dashboard is a static page, not exercised by the unit
  tests).
- `wrangler deploy --dry-run` — bindings + DO + cron
  triggers + assets registered.
- `python3 scripts/validate-dashboard.py` — all checks
  pass. Screenshot confirms the rendered page matches the
  spec.

## What ships in the user's first session

1. `git add` + `git commit` + (optionally) `git push` to
   ``.
2. `wrangler deploy` — the dashboard is served at
   `/pm/` (and `/pm/index.html`, `/pm/anything`
   via the existing `src/index.ts` routing).
3. CF Access is already protecting `/pm/*` (the path
   policy was set in chunk 0). The user just hits
   `/pm/`, logs in, sees the live dashboard.
4. Without a `bot start`, the dashboard shows the default
   state (no positions, no trades, no PnL). With `bot
   start`, the live state populates within 5s.

## Open follow-ups (forward work)

- **Per-position marks:** the open-positions list shows
  entry price but not the live mark (the bot's
  `/api/pm/bot/status` doesn't expose per-position marks
  today). A chunk-7+ enhancement: add a `marks` field to
  the bot status endpoint, then compute unrealized PnL
  on the client. The UI is already wired.
- **Charts:** the per-vertical breakdown is a flat table.
  Chunk 7+ could add a small inline SVG sparkline per
  vertical. Deferred to keep chunk 7's scope tight.
- **Light mode:** explicitly not planned (the brand is
  dark). The Prediction Market Lab PDF recipe uses light backgrounds
  but the dashboard is a tool, not a document.
- **Historical views:** the per-vertical + PnL cards show
  the last 24h. Chunk 8 (model registry) can add a 7d/30d
  time-range picker; chunk 9 (real trading toggle) can
  toggle between paper and real PnL.
