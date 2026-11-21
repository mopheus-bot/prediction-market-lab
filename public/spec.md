# prediction-market-lab Dashboard — Design Spec

A live trading dashboard for the Kalshi paper-trading bot.
Served at `/pm/*` (CF Access protected, single user).

## Brand

**Prediction Market Lab.** Per the user memory: navy gradient
(`#0a2854 → #0b3a6f → #133b6e`), monogram SVG in top-left
at ~32pt, "Prediction Market Lab" wordmark below, accent-colored
left border on the document-title block. The same brand
elements apply to the dashboard (we override the
landing-page-builder skill's generic "no blue" rule for
Prediction Market Lab products — the brand is navy).

**Monogram:** two-letter "MC" in a clean geometric style.
The M is a four-stroke zig-zag; the C is a partial ring
interlocked with the M. Inlined as inline SVG (no asset
request on first paint). White on navy background.

**Wordmark:** "Prediction Market Lab" in a clean sans-serif. Below
the monogram, with a subtle warm-gold underline accent.

**Background:** navy gradient from `#0a2854` (top-left) to
`#133b6e` (bottom-right). The content panels float on this
with a semi-transparent card style (white at 4% opacity
+ a 1px white/10% border + backdrop-blur for the glass
effect).

**Accent palette:**
- Primary: `#0a2854` (deep navy)
- Secondary: `#0b3a6f` (mid navy)
- Accent: `#d4af37` (warm gold — for the underline, the
  active tab indicator, the positive-PnL numbers)
- Positive: `#22c55e` (green)
- Negative: `#ef4444` (red)
- Neutral text: `#e5e7eb` (light grey on dark)
- Muted text: `#9ca3af` (medium grey)

**Typography:**
- Sans-serif: `Inter` (system fallback `-apple-system,
  BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`)
- Monospace: `JetBrains Mono` (system fallback
  `ui-monospace, "SF Mono", Consolas, monospace`)
- Display: same as sans, weight 700, tighter letter-spacing
  for the hero PnL number

**Layout grid:** 12-column CSS grid with 24px gutters.
Card padding: 24px. Card border-radius: 12px.

## Sections (top to bottom)

1. **Header / hero bar** — Prediction Market Lab monogram + wordmark
   in top-left, "prediction-market-lab" title, live status indicator
   (green dot = WS connected, amber = cycling, red =
   stopped), model version badge, current bankroll.

2. **Live PnL hero** — large single number (24h + total PnL
   in cents), with the warm-gold accent. Below: a tiny
   "last 24h" label and a delta vs yesterday.

3. **Open positions** — card list. Each position: ticker,
   side, entry price, current mark (from latest orderbook),
   unrealized PnL. If a ticker is being actively watched
   (we have a live book), show the mark in green/red.

4. **Per-vertical breakdown** — table: vertical | n_trades
   | realized_pnl | n_open. Color the PnL cells green/red.

5. **Recent trades** — list of latest 20 trades. Each row:
   timestamp, ticker, side, action, price, size, PnL
   (close only).

6. **Recent signals** — list of latest 20 signals. Each
   row: timestamp, ticker, side, signal_p, model_version,
   was_filled (yes/no).

7. **Daily recap** — the most recent `daily-recap/*.json`
   from R2. Shown as a collapsible card with a "Generate
   today" button (manual trigger;  will move this
   to a CF Workflow).

8. **Cron runs** — list of the latest cron runs (last 10).
   Each row: cron name, status (color-coded), duration, error.

9. **Bot controls** — bottom-right floating action bar with
   Start / Stop / Restart buttons. POSTs to the
   `/api/pm/bot/*` endpoints. Confirmation dialog before
   Restart/Stop (those are state-mutating).

**Footer:** "prediction-market-lab · Prediction Market Lab · " in muted text.

## Tech

- Pure HTML + CSS + vanilla JS (no React build pipeline).
- 0 third-party deps. Inline critical CSS, lazy-load the
  rest.
- Auto-refresh: poll `/api/pm/status` every 5s for the
  header + every 30s for the rest. Pause when the tab is
  hidden.
- All fetch calls go to `/api/pm/*` (relative). CF Access
  auth uses the browser cookie.
- Mobile-responsive: at < 768px, the cards stack vertically
  and the bot controls collapse into a bottom sheet.
- Dark theme only (the brand is dark navy; light mode
  doesn't fit).

## Asset Protocol

- 0 image files (the dashboard is text + the inline SVG
  monogram).
- 0 video files (no hero video — this is a data dashboard,
  not a marketing page; a hero video would be misleading
  for a tool).
- 1 SVG monogram, inlined directly in the HTML.

## File layout

- `public/index.html` — the dashboard. Served at `/pm/`,
  `/pm/index.html`, and any `/pm/*` subpath via the existing
  ASSETS binding + the `src/index.ts` routing logic (which
  rewrites `/pm` → `/index.html`).
