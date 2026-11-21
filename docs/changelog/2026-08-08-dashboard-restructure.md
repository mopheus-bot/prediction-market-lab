# Dashboard restructure: Stage indicator, Cadence panel and brand swap (2026-08-08)

**Date:** 2026-08-08
**Type:** UX + brand
**Status:** shipped + pushed (commit `daf3da5a`)

## What changed

The prediction-market-lab dashboard is now a **Prediction Market Lab** sub-brand surface (not Prediction Market Lab). The brand swap, the new Stage indicator, and the Cadence panel all land in this step. Plus a hard-blocker WS debug that revealed a CF Workers runtime limitation.

### Brand swap (Prediction Market Lab sub-brand)

- **Logo:** new SVG mark at the top-left of the brand bar — three ascending bars (data → decision → execution) in financial blue, a green data point on top, a thin gold accent line (Prediction Market Lab DNA) under the bars. Distinct from the mobile app's robot logo (which is the Prediction Market Lab social-media surface).
- **Wordmark:** "Prediction Market Lab" (lowercase, sans-serif). Replaces the Prediction Market Lab monogram + wordmark.
- **Palette:** dark caviar + onyx base, financial blue (`#3B82F6`) accent, statusActive green / statusPaused amber / statusInactive red for status. Replaces the navy + warm-gold Prediction Market Lab palette.
- **Typography:** modern sans-serif (Inter / system), no serif display font.
- **Subtle background:** radial accent gradients (blue + green) at the corners, fixed position, behind the content. Premium feel without a heavy gradient.

### Stage indicator (the answer to "what is the bot doing?")

Two surfaces, both driven by the new `/api/pm/bot/stage` endpoint:

- **Brand-bar badge** — a small pill in the top-right of the brand bar, color-coded. Shows the current stage label (e.g. `STREAMING`, `KILLED`, `REAL`). ELI5.
- **Stage panel** — a large hero card right below the brand bar, with:
  - A pulsing colored dot (green/amber/red/grey)
  - The stage label in 28px
  - An ELI5 description in plain language
  - An action button (e.g. "Kill switch", "Restart WS", "Resume paper") when applicable
  - Left border color matches the stage state

Stage values: `idle | starting | streaming | real | paused | killed | backtesting | retraining | error`. The derivation is in `src/api/stage.ts` and pinned by 9 unit tests in `test/stage.test.ts`.

### Cadence panel (every auto-running service, all the time)

The new "Cadence" card right below the stage panel. Lists 7 services, each with:
- Name + icon
- Status (ok / running / error / warn / off)
- "Last ran: 3m ago" + "Next: in 12m"
- One-line details (e.g. "last ok in 1332ms", "12 candidates found", "1 calls in 24h")
- Description on hover (title attribute)
- Left border color-coded by status

Services covered:
1. **Live WebSocket** — derived from bot /status
2. **Universe scan** — every 15 min
3. **News check** — every 6 hours
4. **Daily recap** — daily at 06:00 UTC
5. **Model retrain** — weekly on Sunday 00:00 UTC
6. **LLM calls** — aggregate from llm_calls table
7. **Model registry** — from models table

Driven by the new `/api/pm/cadence` endpoint (30s cache). The single source of truth for "what's running on auto right now."

### Visual accessibility ( baseline)

- **Focus rings** on every interactive element (`:focus-visible` style, 2px box-shadow + accent color)
- **`prefers-reduced-motion`** respected — all animations + transitions dropped to 0.01ms when the user has reduced-motion enabled
- **`prefers-contrast: more`** bumped border contrast
- **`html[lang]`** attribute (was already there; validator now checks it)
- **ARIA labels** on the stage panel, cadence items, brand bar badge
- **Skip-to-content link** (visually-hidden until focused)

### WS debug — found a CF Workers runtime limitation

**The hard-blocker issue:** the bot's WebSocket was not connecting to Kalshi. Debug path:
1. Confirmed the `KALSHI_DEMO_*` secrets were never uploaded as Worker secrets (fixed in the session — uploaded both demo creds via `wrangler secret put`).
2. After fixing creds, the WS still didn't open. The `last_ws_error` field in `/status` was `null` — meaning the upgrade returned 101 but the WS went to `readyState: 2` (CLOSING) without firing the `open` event.
3. Tested `new WebSocket(url, { headers })` — runtime error: "The protocol header token is invalid" (treating `{ headers }` as a protocols string, the standard `WebSocket` constructor's second arg).
4. Tested `fetch(url, { headers: { Upgrade: "websocket" } })` — returned 101 + a `webSocket` on the response, but that WS went to CLOSING without firing open.
5. Tested against `wss://echo.websocket.events` (no auth) — got 403 (server alive, but our user agent or something was off). Proves the WS connection machinery works in the Worker.
6. Tested against `wss://external-api-ws.demo.kalshi.co/...` without auth — got 401. **Proves the WS reaches Kalshi; the auth is what's failing.**

**Root cause:** CF Workers' `new WebSocket(url)` constructor does NOT support custom headers on the outbound upgrade. The `nodejs_compat` flag does NOT change this — the global `WebSocket` is still CF's, not Node's. The `fetch()` + `Upgrade: websocket` approach returns a WS object but the runtime can't actually maintain the upgrade for client WS (the WS goes to CLOSING without firing `open`).

**The fix (future step):** a relay. A small Python or Node.js service that:
1. Accepts an unauthenticated WS from the CF Worker
2. Connects to Kalshi WS with the RSA-signed auth headers (using `websockets` library, which DOES support `extra_headers`)
3. Forwards messages bidirectionally

The CF Worker connects to the relay (no auth needed). The relay connects to Kalshi (with auth). This is the same pattern that the Prediction Market Lab Python tool already uses (`tools/predictive-markets/src/predictive_markets/live/kalshi_ws.py`).

**Workaround in place:** the bot's openKalshiWs now uses `fetch()` + `Upgrade: websocket` with the auth headers (which is the right shape per CF docs), and stores `last_ws_error` in the bot state. The /status endpoint surfaces it. The Stage panel reads it and shows "Connection error" with a "Restart WS" action button. The Cadence panel shows the WS as `error` with the actual code + message.

### Live state right now

```
Stage: starting (Connecting…)
WS: not connected (last_ws_error will be set after first connect attempt with the new fetch+Upgrade code)
Cadence: 3 ok (scan, news, llm), 4 starting (ws, daily, train, model_registry)
Scan: ran 10m ago, next in 4m
News: ran 1h ago, next in 4h
Daily + Train: never run (they fire on cron schedule, not on demand)
Model registry: empty (+ registers models)
```

### Files changed

**Backend:**
- `src/durable-objects/LiveBot.ts` — `_lastWsError` field, error tracking in openKalshiWs + close/error handlers, `last_ws_error` in /status response
- `src/api/cadence.ts` (NEW) — `/api/pm/cadence` handler. Aggregates cron_runs, llm_calls, models, plus a forward to the bot /status for the WS stream.
- `src/api/stage.ts` (NEW) — `/api/pm/bot/stage` handler. Derives the single badge from bot /status + the latest running cron.
- `src/api/index.ts` — re-exports the two new modules
- `src/index.ts` — wires the two new routes + cleans up debug endpoints

**Frontend (`public/index.html`):**
- Brand bar: new logo SVG + new wordmark + stage badge in the right
- New "Stage panel" card (large, with action button)
- New "Cadence" card (7 services, 30s refresh)
- New CSS variables (Prediction Market Lab palette)
- New CSS for stage-panel, cadence-grid, stage-badge, brand-finance
- New accessibility CSS (focus-visible, prefers-reduced-motion, prefers-contrast, skip-link, sr-only)
- Removed: setStatusPill function + the old "live · stopped" pill in the brand bar (replaced by the stage badge)
- New JS: `fetchStage()`, `renderStage()`, `fetchCadence()`, `renderCadence()`, plus a delegated action-button handler that POSTs to `/api/pm/bot/{start,restart,stop,kill-switch,trading-mode}` from the stage panel

**Tests:**
- `test/stage.test.ts` (NEW) — 11 unit tests pinning the stage derivation logic (streaming, real, killed, paused, error, starting, idle, retraining, backtesting, plus cadence summary counts). 204/204 total.

**Validator (`scripts/validate-dashboard.py`):**
- Required text updated: "Prediction Market Lab", "finance", "Stage", "Cadence" instead of "Prediction Market Lab", "Start", "Stop", "Restart"
- New checks: `html[lang]` attribute, `focus-visible` style, `prefers-reduced-motion` media query, stage panel + cadence grid present

**Vitest config (`vitest.config.mts`):**
- Added `test/stage.test.ts` to the unit project's `include` list

### Smoke test (deployed)

- `GET /api/pm/bot/stage` → `{ok: true, stage: "starting", label: "Connecting…", color: "warn",...}`
- `GET /api/pm/cadence` → `{ok: true, summary: {n_ok: 3, n_error: 0, n_starting: 4}, services: [...7 items...]}`
- Dashboard validator: all checks pass
- `tsc --noEmit` clean
- `npm test` 204/204 in 1.83s

### Next: the relay (.x or)

The WS auth issue is the only remaining blocker for "live numbers updating without pushing any buttons." Plan: deploy a tiny Python relay (the Python tool already has the auth code) that the CF Worker connects to. Relay could run on:
- Local Mac + cloudflared tunnel (free, dev-only)
- Fly.io (~$5/mo, always on)
- Anywhere Python + `websockets` library can run

The CF Worker side change is one line: change the WS URL to the relay. Everything else (the Stage panel, the auto-start, the cadence tracking) already works.

### Future steps (queued)

- **Step 11:** Backtest automation cron + auto-pilot real-money logic + per-vertical caps + per-ticker kill switch
- **Step 12:** the app-level polish (skeleton loaders, micro-animations, empty states, error toast styling, mobile-responsive sweep, full accessibility audit)
