# Event-Driven UI Plan

**Status:** Phase 1 in progress. This doc is the locked-in plan — the rest of the phases follow once Phase 1 is solid.

**Why this exists:** the current UI is timer-polling (5s fast / 30s slow via `setInterval` in `public/app/app.js`). The user has flagged: (a) graphs look "static" because the cumulative PnL chart only re-renders on closed trades, (b) no percentages on any metric, (c) sections that should swap by `trading_mode` (paper vs real) don't, (d) every metric needs to be live-fed without manual refresh.

The timer-poll architecture can't fix this. We need a real push channel from the LiveBot DO to every open dashboard page.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser (any open dashboard page)                         │
│  ────────────────────────────────                         │
│  EventSource('/api/pm/stream')  ←─── SSE  ←───┐         │
│       │                                       │         │
│       ▼                                       │         │
│  DOM update in place (no refresh)              │         │
│  Mode-aware sections swap on mode_change evt  │         │
│  % always next to $ (one render, not two)     │         │
└──────────────────────────────────────────────────────────┘
                            │
                            │ text/event-stream
                            ▼
┌──────────────────────────────────────────────────────────┐
│  Worker: GET /api/pm/stream (SSE endpoint)                │
│  ─────────────────────────────────────────                │
│  Forwards events from the LiveBot DO via a                │
│  ReadableStream. Single subscriber per page,              │
│  the DO fans events out to all subscribers.               │
│  CF Access sits in front (same as other /api/pm/*).       │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│  Durable Object: LiveBot (one per user)                   │
│  ─────────────────────────────────────                    │
│  Internal event bus. _sseClients: Set<controller>.        │
│  Existing methods (pollTick, maybeRecordTrade,            │
│  closeAtMarkInternal, killSwitch, autoPromote, etc.)      │
│  emit events as side effects. The polling feed            │
│  emits `poll` every 1.5s/ticker; trades emit              │
│  `trade_open` / `trade_close` / `signal`; etc.            │
└──────────────────────────────────────────────────────────┘
```

**Key insight:** the polling feed is already event-driven (1.5s alarm on the DO). We just need to *expose* the events instead of *polling for them on the client side*. Same source of truth, different transport.

## Event vocabulary (DO → SSE → browser)

| Event | When | Payload | Where it lands in the UI |
|---|---|---|---|
| `init` | On connect | `{ status: <full /api/pm/bot/status body> }` | Hero KPIs, mode banner, all panels |
| `mode_change` | POST /trading-mode | `{ trading_mode, previous_mode }` | Top-of-page banner, hero labels, "real_order_id" column visibility |
| `kill_switch` | POST /kill-switch | `{ on: bool }` | Status pill, freezes new-trade buttons |
| `poll` | Every 1.5s/ticker | `{ ticker, mid, has_book, ts }` | Per-ticker row, price-history for charts |
| `signal` | Strategy fires | `{ ticker, side, price, p, rationale, size, judge_size, judge_reasoning }` | Signal toast / log; chart markers; the trades-page "live signal" stream |
| `trade_open` | Position opens | `{ ticker, side, size, entry_price, judge_size, judge_reasoning }` | Positions table, "open" badge |
| `trade_close` | Position closes | `{ ticker, side, size, entry_price, exit_price, pnl_cents, hold_ms, rationale }` | Trades table, PnL chart point, KPIs |
| `unrealized_pnl` | Every N polls per position | `{ ticker, mark, unrealized_cents }` | Position-row uPnL cell, hero "open PnL" KPI |
| `risk` | On change | `{ daily_notional_cents, daily_cap_cents, drawdown_pct, consecutive_losses, kill_switch_on }` | Risk panel, kill-switch pill |
| `auto_promote` | llm-opinions-cron adds a ticker | `{ ticker, vertical, confidence }` | Universe-health list, toast |
| `universe` | /start, /auto-promote, /remove | `{ tickers, ticker_verticals }` | Universe list refresh |

The full schema lives in `src/durable-objects/LiveBot.ts` as a TypeScript union (so the DO is the source of truth — the UI derives the rendering rules from `data-trading-mode` / `data-kill-switch` etc.).

## Mode-aware UI

The page reads `trading_mode` from the `init` event (or the first /status poll as a fallback). Every panel that has a paper/real flavor swaps its label, color, and visibility.

| Section | Paper | Real |
|---|---|---|
| Top banner | "PAPER TRADING · no real money at risk" (blue) | "REAL TRADING · real money on the line" (amber/red) |
| `real_order_id` column in trades table | hidden | visible |
| Hero "open PnL" KPI | blue (unrealized, marked to current) | amber (real mark) |
| Hero "fees" | hidden (paper has no fees) | visible |
| Settings → "go real" button | disabled with tooltip "in real mode" | enabled |
| Settings → "go paper" button | enabled | enabled |
| "place test order" button | enabled | disabled (real money — operator should use /place-test-order with care) |

The mode is set once and tracked in a `data-trading-mode` attribute on the `<body>`. CSS swaps the visible elements. JS updates the attribute on `mode_change` events. No re-render needed.

## Percentages everywhere

Every dollar value renders as `$X.XX (+Y.YY% of bankroll)` or `$X.XX (Y.YY% return)`. The format is one render function, applied everywhere a money value is shown:

```js
function fmtCentsPct(cents, bankrollCents, ctx) {
  const dollars = (cents / 100).toFixed(2);
  const pct = (cents / bankrollCents * 100).toFixed(2);
  const sign = cents < 0 ? '−' : cents > 0 ? '+' : '';
  return `${sign}$${Math.abs(dollars)} (${sign}${Math.abs(pct)}%)`;
}
```

KPIs:
- PnL (realized + unrealized) → `+$0.20 (+0.002%)` against $10k bankroll
- Daily PnL → `+$0.20 (+0.002% today)`
- Bankroll → `$9,945.81 (-0.54% from peak $10,000)`
- Open position uPnL → `+$8.60 (+0.086%)` of bankroll
- Trade PnL → `+$0.20 per contract, 20 contracts = +$4.00 (+0.04% bankroll)`

Trade table rows show both the absolute `$X.XX` and the percentage-of-bankroll. Hero KPIs show absolute + percentage. PnL chart tooltips show full breakdown including signal confidence.

## Live charts (no more "static" feel)

The PnL chart updates in real-time on:
- `trade_close` event → add a new point to the line
- `unrealized_pnl` event → update the dashed "open" overlay
- `mode_change` event → re-color the line (paper = blue, real = green/red by direction)

Other live charts:
- **Per-ticker price history** — streamed as `poll` events arrive, the price_history is a 60-point moving window. A small inline sparkline next to each position row updates on every poll.
- **Risk gauges** — daily-notional-used bar, drawdown bar. Updated on `risk` events.
- **Signal-rate sparkline** — last 30 min of signal volume, updated on `signal` events.

## Phases

### Phase 1 — SSE foundation + DO event bus (this week)
- [ ] Add `_sseClients: Set<ReadableStreamDefaultController>` to LiveBot
- [ ] Add `GET /api/pm/bot/stream` handler that subscribes to the DO and returns a streaming Response
- [ ] Wire `pollTick`, `maybeRecordTrade`, `closeAtMarkInternal`, `killSwitch`, `autoPromote` to emit events
- [ ] Tests: LiveBot event bus unit tests (mock the controller, verify emit-on-action)
- [ ] Smoke test: open `curl -N /api/pm/bot/stream` and trigger a trade; verify the SSE shows `signal` + `trade_open` events

### Phase 2 — Trades page live-feed (this week)
- [ ] Replace `setInterval` poll with EventSource on trades.html
- [ ] Wire `init`, `poll`, `signal`, `trade_close`, `risk` to render the page in place
- [ ] Add PnL percentage formatter to every money value on the page
- [ ] Wire `mode_change` to swap the top banner + the `real_order_id` column visibility
- [ ] Add a "live signal" stream (the most recent N signals with judge reasoning)

### Phase 3 — Other pages (next week)
- [ ] Bot page (the main hero KPIs)
- [ ] Positions page
- [ ] Dev page (the auto-promote decisions + lead suggestions)
- [ ] Schedule / cost / models pages

### Phase 4 — Live charts everywhere
- [ ] PnL chart auto-update on `trade_close`
- [ ] Per-position sparklines on `poll`
- [ ] Risk gauges on `risk`
- [ ] Signal-rate sparkline on `signal`

### Phase 5 — Mode-aware everywhere
- [ ] Audit every page for paper/real visual differences
- [ ] Audit the API responses for mode-specific fields (real_order_id, etc.)
- [ ] Document the rendering contract (which attrs the UI looks for)

## Files this touches

- `src/durable-objects/LiveBot.ts` — event bus + emit hooks
- `src/api/stream.ts` — new SSE endpoint (or in `src/index.ts` if it stays small)
- `public/app/app.js` — `EventSource` client, dispatch table, percent formatter
- `public/app/app.css` — mode-aware classes (`body[data-trading-mode="paper"]` / `[data-trading-mode="real"]`)
- `public/app/*.html` — wire each page to the new client

## Safety

- SSE connections count against the Worker's connection limit (6 simultaneous on free, 1k+ on paid). Each open dashboard tab = 1 connection. Acceptable for a single-operator dashboard.
- The DO fan-out is `for (controller of _sseClients) controller.enqueue(...)` — try/catch each enqueue, drop clients that throw. Old/dead connections get cleaned up on the next emit.
- SSE auto-reconnects on the browser side (EventSource behavior). The `Last-Event-ID` header would be used for replay if we want at-most-once on disconnect; for now, the next connect just gets a fresh `init` event.

## What I am NOT going to do

- WebSockets. SSE is the right fit for one-way push from server to client. The client doesn't need to send events back over the same channel.
- Replacing the existing JSON `/api/pm/bot/*` endpoints. They stay. The SSE stream is additive.
- A framework like React/Vue. The current vanilla JS pattern is fine for this scale; the EventSource + DOM-update pattern is what the existing app.js already does (just with a different transport).

## Phase 5 — Mode-aware rendering contract

The UI looks different in paper vs real mode. The contract:

### Body attributes (set by SSE `init` / `mode_change` / `kill_switch` handlers)

- `body[data-trading-mode="paper"]` — default. Blue mode banner, kill switch desaturated, no real-money warning.
- `body[data-trading-mode="real"]` — amber mode banner + red real-money warning strip, kill switch pulses, "Go live" button has an amber outline.
- `body[data-trading-mode="off"]` — gray banner, "no new signals" copy.
- `body[data-kill-switch="true"]` — red banner, "KILL SWITCH ON" badge in the banner, real-money warning text becomes "KILL SWITCH ACTIVE".

### CSS classes

- `.paper-only` — visible only in paper mode. Use for "(simulated)", "(hypothetical)", etc.
- `.real-only` — visible only in real mode. Use for "real money", "live order" callouts.
- `.real-only-col` — hidden in paper mode. Use for `<td>` cells that show `real_order_id` or other real-mode-only fields.
- `.real-money-warning` — shown only in real mode (CSS). The text is updated by `setModeBannerState()` based on mode + kill switch.

### Hero KPI copy

The label and sub-line flip per `trading_mode`:
- `bankroll`: paper="Paper bankroll (simulated capital)" / real="Real bankroll (real money on Kalshi)" / off="Bankroll (paused)"
- `pnl-24h`: paper / real / off variants
- `fees`: paper="Paper fees paid (simulated Kalshi fees)" / real="Real fees paid (Kalshi taker fees)" / off="fees paid (paused)"

The implementation lives in `public/app/index.html` (DASH_KPI_COPY) and `public/app/bot.html` (KPI_COPY). Both must stay in sync.

### Per-page guidance

- **trades.html**: trade detail drawer shows `real_order_id`. In paper mode, the value is always `—` (no real orders are placed). The cancel-button column is hidden in paper mode because no real orders exist to cancel.
- **bot.html**: kill switch is always visible. The `data-trading-mode` CSS makes it more prominent (pulse animation) in real mode. The "Go live" button is disabled in real mode (you can't "go live" twice — use the kill switch to return to paper).
- **positions.html**: the close-position button is always visible. The trade's `real_order_id` (if any) is shown in the trade detail drawer; in paper mode it's always `—`.
- **dev.html**: no mode-aware changes beyond the global mode banner. The endpoint list is the same for both modes; the operator can POST to `/trading-mode` or `/kill-switch` from dev regardless of mode.

### Connection status chip

In the top nav: a small chip that shows the SSE connection state.
- Green pulsing dot + "live" — EventSource is connected, the DO is sending events.
- Amber dot + "reconnecting…" — EventSource lost the connection, auto-reconnect with exponential backoff (1s → 30s).
- Red dot + "disconnected" — connection failed, the fallback poll takes over.

This is the operator's "is the live feed working" indicator. The data updates only when this is green.

### Implementation rules

- **Don't use JavaScript conditionals for mode-aware rendering.** CSS selectors on `body[data-trading-mode=...]` are the source of truth. JS only updates the attribute. This keeps the rendering logic out of every renderer.
- **Don't re-render the whole page on mode change.** Just set the attribute; CSS does the rest.
- **Percentages are non-negotiable.** Every dollar value in any KPI, hero, table cell, or detail row gets a `(±Y.YY%)` next to it (% of bankroll). The `fmtCentsPct()` helper in `app.js` does this.
- **Live data over cached data.** Every page renders a 30s fallback poll for the historical tables. The SSE handlers drive the live updates. If SSE is down, the page still works (stale, but works).


## Phase 5 audit log

The Phase 5 spec called for: (a) audit every page for paper/real visual differences, (b) audit API responses for mode-specific fields, (c) document the rendering contract. The audit + fixes below happened on 2026-08-11, after the initial Phase 5 commit (`842b297`).

### Audit findings

1. **SAFETY BUG — body attribute depended on SSE only.** The `data-trading-mode` + `data-kill-switch` attrs on `<body>` were only written by SSE event handlers (`init`, `mode_change`, `kill_switch` in `app.js`). If the EventSource dropped while in real mode, the polling `refresh()` was still returning `botStatus.config.trading_mode = "real"`, but the body attribute was never set — so the CSS rule `body[data-trading-mode="real"] .real-money-warning` never fired, and the operator lost the "real money on the line" visual while trades were actually live.

   **Fix:** `renderTradingControls(status)` in `app.js` now writes the body attributes on every polling refresh (and on SSE, for symmetry). Defense-in-depth: SSE-down no longer hides the warning.

2. **FOUC on 5 of 6 pages.** Only `trades.html` had `data-trading-mode="paper" data-kill-switch="false"` set on the initial `<body>` tag. The other five (`bot.html`, `positions.html`, `dev.html`, `index.html`, `models.html`, `schedule.html`) had plain `<body>`. The CSS rule `body[data-trading-mode="real"] .real-money-warning` couldn't match until the SSE `init` event fired (a few hundred ms), so a real-mode page render had a brief flash of "no warning."

   **Fix:** all six pages now have `data-trading-mode="paper" data-kill-switch="false"` on the initial `<body>`. The SSE `init` event then overwrites the attribute with the actual values.

3. **Money renderings without `% of bankroll`.** The contract says "every `$X.XX` value in any KPI, hero, table cell, or detail row gets a `(±Y.YY%)` next to it." The audit found 11 places in `positions.html` + 4 in `bot.html` + 3 in `index/models/dev` that rendered raw `$X.XX` via `(cents/100).toFixed(2)` or template strings, without the percent suffix:

   - `positions.html:435` (total exposure), `445` (largest exposure), `509` (per-vertical exposure), `541` (per-position value), `711` (bankroll / peak)
   - `bot.html:468` (per-trade cap), `528` (bankroll), `533` (daily deployed), `569` (peak bankroll)
   - `index.html:416` (live Kalshi balance — converted from dollar string to cents)
   - `models.html:220` (vertical cap), `259`/`262`/`269` (max-notional, daily-cap, daily-used)
   - `dev.html:945`/`948`/`949`/`955` (config: bankroll, max-notional, daily-cap, daily-used)

   **Fix:** every one now calls `fmtCentsPct()` from `app.js` (the global, script-scope-shared helper).

4. **Duplicated `fmtCentsShort` in `positions.html`.** The inline script had its own 11-line local copy of the percent-aware formatter. Trades/bot were using the global `fmtCentsPct` from `app.js`; positions was using its local clone. Two sources of truth for the same render.

   **Fix:** local `fmtCentsShort` deleted from `positions.html`; all 9 call sites switched to `fmtCentsPct`.

5. **API audit — clean.** Every endpoint the pages consume carries the mode-aware fields the contract expects:
   - `/api/pm/bot/status` returns `config.trading_mode` + `config.kill_switch` (LiveBot.ts:411, 1019).
   - `/api/pm/bot/positions` returns `real_order_id` per open position.
   - `/api/pm/trades` returns `real_order_id` + `trading_mode` per trade (D1 `trades` table has both columns; queries use `SELECT *`).
   - `/api/pm/bot/stream` emits `mode_change` + `kill_switch` events when those flip.

   No API changes were needed.

### Verification

- `npx tsc --noEmit` — clean
- `npx vitest run --project unit` — 269/269 pass
- Manual SSE smoke: `curl -N api/pm/bot/stream` returns `init` frame with `config.trading_mode="paper"`, `config.kill_switch=false`, followed by `poll` + `unrealized_pnl` events for KXWARMING-50 + KXMVECROSSCAT-...CE50C27.

### Per-page audit summary

| Page | Body attr | Mode banner | Connection chip | fmtCentsPct everywhere | Status |
|---|---|---|---|---|---|
| `index.html` | ✓ (audit fix) | ✓ (DASH_KPI_COPY per-mode) | ✓ (injectAppNav) | ✓ (audit fix on balance) | ready |
| `bot.html` | ✓ (audit fix) | ✓ (inline `#mode-banner`) | ✓ (injectAppNav) | ✓ (audit fix on bankroll/deployed/peak/cap) | ready |
| `positions.html` | ✓ (audit fix) | ✓ (injectModeBanner) | ✓ (injectAppNav) | ✓ (audit fix + dedup) | ready |
| `trades.html` | ✓ (had from Phase 2) | ✓ (inline `#trades-mode-banner`) | ✓ (injectAppNav) | ✓ (had from Phase 2) | ready |
| `dev.html` | ✓ (audit fix) | ✓ (injectModeBanner) | ✓ (injectAppNav) | ✓ (audit fix on config panel) | ready |
| `models.html` | ✓ (audit fix) | ✓ (injectModeBanner) | ✓ (injectAppNav) | ✓ (audit fix on cap + config) | ready |
| `schedule.html` | ✓ (audit fix) | ✓ (injectModeBanner) | ✓ (injectAppNav) | n/a (no $ values rendered) | ready |

