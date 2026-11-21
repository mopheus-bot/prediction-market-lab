# Real trading toggle (2026-08-08)

The paper-only door is open. The LiveBot can now place real
orders on Kalshi via the new `trading_mode` + `kill_switch`
flags, behind conservative safety caps. The dashboard shows
real vs paper PnL separately. End-to-end verified with a
1-contract real-money test trade on KXWARMING-50.

## What ships

### Schema: `migrations/0002_real_trading_columns.sql`

Two new columns on `trades`:

- `real_order_id TEXT` — Kalshi's order id for real trades;
  NULL for paper. Lets the dashboard link a D1 row back to
  the actual Kalshi order.
- `trading_mode TEXT NOT NULL DEFAULT 'paper'` — `"paper" |
  "real" | "off"`. The engine mode at the time of fill. The
  dashboard splits paper vs real PnL on this column.

Plus two indexes:

- `idx_trades_trading_mode` on `(user_id, trading_mode, ts)` —
  fast filter for "show me all my real trades".
- `idx_trades_real_order_id` (partial, `WHERE real_order_id IS
  NOT NULL`) — fast lookup by Kalshi order id.

The migration is backwards-compatible: existing rows get
`trading_mode = 'paper'` and `real_order_id = NULL` (the
column default). All -8 test fixtures and call sites
continue to work without changes — the new columns are
optional on insert, defaulting to paper + null.

### `src/lib/types.ts` — `TradeRow` + `NewTrade` extension

`TradeRow` adds:

- `trading_mode: "paper" | "real" | "off"`
- `real_order_id: string | null`

`NewTrade` makes both **optional** (`trading_mode?:...,
real_order_id?: string | null`) so legacy callers (steps
1-8) compile unchanged. The `trades.insert` binding in
`src/lib/db.ts` defaults both to paper + null when the
caller omits them. This keeps backward compat with every
existing test fixture and call site.

### `src/risk/state.ts` — sliding 24h notional window

Two new pure helpers + one new state field:

- `RiskState.daily_notional_history: Array<{ts_ms, cents}>` —
  bounded at 1,000 entries (FIFO).
- `dailyNotionalCents(state, now?)` — sums entries whose
  `ts_ms` is within the last 24h. Stale entries are filtered
  on read; no separate cleanup job.
- `recordNotionalCents(state, cents, now?)` — trims stale
  entries, appends the new one, caps at 1,000, returns
  `{history, total}`.

The `LiveBot` persists this array in `ctx.storage` alongside
the rest of `risk_state`, so a 24h cap survives DO eviction
+ resume.

### `src/durable-objects/LiveBot.ts` —  wiring

The big one. Engine config (`LiveBotConfig` + `LiveBotState.config`)
gains four fields:

- `trading_mode: "paper" | "real" | "off"` (default `"paper"`)
- `max_notional_cents_per_trade: number` (default `100` = $1.00)
- `daily_notional_cents_cap: number` (default `1000` = $10.00)
- `kill_switch: boolean` (default `false`)

`maybeRecordTrade` (the engine's per-signal hot path) now:

1. Refuses all new trades when `kill_switch` is on (reason
   code `kill_switch_active`).
2. Computes notional = `price_cents * size` (YES) or
   `(100 - price_cents) * size` (NO).
3. Refuses if `notional > max_notional_cents_per_trade`
   (reason `per_trade_cap_exceeded`).
4. Refuses if the 24h notional total + this trade would
   exceed `daily_notional_cents_cap` (reason
   `daily_cap_exceeded`).
5. When `trading_mode === "off"`, returns immediately —
   no D1 write, no position change. The WS keeps running
   so the operator still sees state.
6. When `trading_mode === "real"`, places a live order on
   Kalshi FIRST via the new `placeKalshiOrder` helper. If
   Kalshi rejects (insufficient balance, market closed,
   etc.), the entire fill is aborted — no D1 write, no
   bankroll debit, no position. The local log and the live
   book stay in sync.
7. When `trading_mode === "paper"`, the existing 
   behavior — just record the D1 row.

The `placeKalshiOrder` helper uses Kalshi's V2 endpoint
(`/portfolio/events/orders`) with the new V2 body shape:

- `side: "bid" | "ask"` (bid = buy YES, ask = sell YES)
- `count: "1.00"` (fixed-point string)
- `price: "0.0100"` (fixed-point dollar string; we convert
  from internal cents)
- `time_in_force: "good_till_canceled"`
- `self_trade_prevention_type: "taker_at_cross"`

The V1 endpoint (`/portfolio/orders`) was deprecated by
Kalshi in 2026-05 and returns `deprecated_v1_order_endpoint`
if hit directly. This was a surprise caught during the step-9
deploy; the V2 migration is in `src/kalshi/client.ts:placeOrder`.

### New endpoints in `LiveBot.fetch()`

Three new DO routes (all wired through `src/index.ts`):

- `POST /trading-mode` (body: `{trading_mode: "paper" |
  "real" | "off"}`) — flip the mode, persist.
- `POST /kill-switch` (body: `{on: bool}`, default `true`) —
  toggle the kill switch, persist. The engine refuses all
  new trades while the switch is on.
- `POST /place-test-order` (body: `{ticker, side, price_cents,
  size}`) — manual operator trigger. Bypasses the engine's
  signal pipeline. Enforces the per-trade cap. Returns the
  Kalshi `order_id`. Stamps the resulting D1 row with
  `trading_mode="real"` regardless of the current engine
  mode.

`/status` now surfaces:

- `config.trading_mode`
- `config.max_notional_cents_per_trade`
- `config.daily_notional_cents_cap`
- `config.kill_switch`
- `risk.daily_notional_cents` (live 24h total)
- `risk.daily_notional_cap_cents`
- `risk.daily_notional_history_len`

### `src/index.ts` — bot route forwarders

Three new lines:

- `POST /api/pm/bot/trading-mode` → DO `/trading-mode`
- `POST /api/pm/bot/kill-switch` → DO `/kill-switch`
- `POST /api/pm/bot/place-test-order` → DO `/place-test-order`

### Test fixtures + helpers

- `test/helpers/migrations.ts` — new shared helper that
  splits migration SQL on `--> statement-breakpoint` AND
  filters out comment-only steps (the migration files have
  a docstring header that lands in the first split step;
  without filtering, `applyD1Migrations` fails with "SQL
  code did not contain a statement"). Replaces the inline
  split + filter logic that was duplicated in 4 test files.
- All 4 integration tests (`db.test.ts`, `live-bot.test.ts`,
  `api-status.test.ts`, `models-api.test.ts`) now apply BOTH
  migration 0001 + 0002.

### Tests

15 new tests:

- `test/risk.test.ts` — 7 new tests for the daily notional
  helpers (init, single insert, sum multiple, drop stale
  24h+ entries, trim-on-insert, 1000-entry cap, persistence
  round-trip).
- `test/live-bot.test.ts` — 8 new tests for the step 9
  endpoints (`/trading-mode` set/validate, `/kill-switch`
  toggle, `/place-test-order` cap enforcement + kill-switch
  refusal, `/status` exposes daily notional counters,
  `/start` accepts new config fields).

`trades.insert` and `writeTradeRow` defaults preserve
backward compat — all -8 test fixtures pass without
edits.

## Verification (2026-08-08 07:16)

- `tsc --noEmit` clean.
- `npm test` 185/185 in ~1.1s. Up from 170 before.
- `wrangler deploy --dry-run` shows all bindings (LIVE_BOT,
  SHADOW_BOT, DB, BUCKET, ASSETS) + 4 cron triggers + 3 new
  routes registered.
- Migration 0002 applied to D1 local + remote
  (`prediction-market-lab`, `cd54a509-...`). 5 commands executed in
  1.11ms on remote.
- KALSHI_PROD_KEY_ID + KALSHI_PROD_PRIVATE_KEY set as
  Worker secrets (read from `~/keys/kalshi-prod-*.txt` via
  stdin).
- `wrangler deploy` succeeded; 4 cron schedules registered
  (the cron for `train` was using `0 0 * * 0` which
  wrangler 4.120.0 rejects; changed to `0 0 * * SUN` and
  updated `CRON_TABLE` in `src/cron/dispatcher.ts` to match).
- `/api/pm/bot/place-test-order` with `{ticker:
  "KXWARMING-50", side: "yes", price_cents: 1, size: 1}`
  returned a real Kalshi order id
  `951d423a-ee85-4be9-a2bd-417f2db0300a` and a corresponding
  D1 row with `trading_mode="real"`, `is_paper=0`,
  `real_order_id="951d423a-..."`, `rationale="manual_test_order"`.
- The bot's `trading_mode` was reset to `"paper"` after the
  test (the test order was a one-off operator action, not a
  signal-driven trade).

## Safety caps rationale

The default caps are conservative by design:

- `max_notional_cents_per_trade: 100` ($1.00 per trade) — a
  bad signal can lose at most $1.00 in fees + max payout gap.
- `daily_notional_cents_cap: 1000` ($10.00 per 24h) — caps
  the worst-case loss from a series of bad signals.
- `kill_switch: false` (default) — but the toggle is one
  HTTP call away. Operators flip to `true` when they see
  trouble.

Operators can bump the caps via `/start`:

```bash
curl -X POST api/pm/bot/start \
  -H "Content-Type: application/json" \
  -d '{
    "trading_mode": "real",
    "max_notional_cents_per_trade": 500,
    "daily_notional_cents_cap": 5000
  }'
```

## What's NOT in  (deferred)

- **Auto-close on kill switch.** When `kill_switch` is on,
  the engine refuses NEW trades but does NOT auto-close
  existing open positions. A `POST /kill-switch {on: true,
  close_open: true}` variant that closes all open positions
  at the next mark is a small follow-up. Out of scope for
  the initial ship.
- **ShadowBot real-trading path.** The shadow DO
  () is still paper-only. Wiring a shadow to place
  real orders on a candidate model is a + effort
  (multi-tenant risk; needs separate creds + caps).
- **Live dashboard for trading_mode toggle.** The 
  dashboard shows the new state (it's just a column on
  `/api/pm/status` / `/api/pm/bot/status`) but doesn't have
  a "flip to real" button yet. A small follow-up; the API
  is the source of truth for now.

## Open follow-ups (any session can pick up)

- Per-ticker `kill_switch` (e.g., flip off weather only).
- Auto-pause when daily PnL hits a configurable floor
  (e.g., -$5 in 24h = automatic kill switch).
- Per-vertical caps (e.g., weather 50% of daily, economic
  30%, etc.).
- Wire a Telegram alert on every real fill ( has
  the bridge; just needs a `chat` arg in `maybeRecordTrade`).
