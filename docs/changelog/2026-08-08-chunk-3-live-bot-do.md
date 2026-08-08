# Chunk 3 — Live bot Durable Object (2026-08-08)

The paper-trading engine lands as a Cloudflare Durable Object. 24/7
operation, WS hibernation for the control channel, 90-min cycle for
state refresh, full risk envelope, per-ticker state, D1 writes.

## What ships

### New modules

- `src/lib/fees.ts` — `kalshiTakerFeeCents()` and
  `isStructurallyUnprofitable()` (the user-flagged 2026-08-07
  guardrail that skips trades where the max gain is below the round-
  trip fee). Mirrors `paper_engine.py:kalshi_taker_fee_cents`.

- `src/strategy/signal.ts` — `Signal`, `SignalContext`,
  `SignalMarket`, `SignalOrderbook`, `SignalStrategy` interfaces plus
  the `FADE_THRESHOLD = 0.05` constant. Mirrors
  `sim/signal.py:Signal` + `sim/backtester.py:SignalContext`.

- `src/strategy/naive.ts` — `NaiveSignal` (fade moves > 5%).
  Class form of the legacy `naive_signal` function. The chunk-3
  placeholder for the chunk-4 ONNX models.

- `src/strategy/router.ts` — `VerticalStrategyRouter`. Dispatches on
  `market.vertical` to per-vertical profiles; multi-strategy profiles
  use the agreement-only stacker. Default profiles plug in
  `NaiveSignal` for all 4 verticals; chunk 4 swaps in the per-vertical
  reversion model where the 2026-08-04 sweep showed it wins.

- `src/risk/config.ts` — `RiskConfig` + `defaultRiskConfig()` +
  `validateRiskConfig()`. Six rules: 1% sizing, 3 concurrent cap,
  5% per-market cap, 10% drawdown pause, 3-loss cooldown, optional
  `max_contracts_per_trade` ceiling.

- `src/risk/state.ts` — `Position`, `ClosedTrade`, `RiskState` +
  `makeRiskState()` + helpers (`currentDrawdownPct`, `nOpenPositions`,
  `totalPnlCents`).

- `src/risk/engine.ts` — `RiskEngine` class with
  `canOpenPosition()`, `recordFill()`, `recordSettlement()`,
  `closePositionAtMark()`. The full circuit-breaker logic from
  `risk/engine.py`. All math in cents to avoid float rounding.

- `src/durable-objects/LiveBot.ts` — the main DO. Owns the
  outgoing Kalshi WS, per-ticker state (orderbook, price history,
  position, trade count), and the risk engine's state. Persists
  everything in `ctx.storage`. Hibernates the incoming control WS
  via `state.acceptWebSocket()`. Closes/reopens the Kalshi WS every
  90 minutes via `state.storage.setAlarm()`. Multi-tenant: addressed
  by `idFromName('user:${userId}')`.

- `src/strategy/index.ts`, `src/risk/index.ts` — barrel exports.

### Updated

- `src/kalshi/models.ts` — added `applyOrderbookDelta()` and
  `orderbookSnapshotToOb()` (the missing mutators from the chunk-2
  `KalshiOrderbook` type).

- `src/index.ts` — wired the `LIVE_BOT` DO binding into the routing.
  New endpoints: `/api/pm/bot/{start,stop,restart,status,ws}`.

- `wrangler.jsonc` — added `durable_objects.bindings` for `LiveBot`
  and the `migrations` block (required for new_sqlite_classes). Added
  `DEFAULT_TICKERS` and `DEFAULT_URL` vars.

- `test/fees.test.ts` — 11 new tests.
- `test/strategy.test.ts` — 9 new tests.
- `test/risk.test.ts` — 22 new tests.
- `test/live-bot.test.ts` — 7 new tests for the DO contract.
- `scripts/smoke-live-bot.mjs` — end-to-end smoke test for the
  deployed Worker.

## Hibernation model (the cost story)

Per the plan: "WebSocket hibernation is mandatory on the DO. State
in `ctx.storage`, never instance vars. Without hibernation, the DO
cost is $50-140/mo. With it, $0.10-0.50/mo."

The cost saving comes from TWO mechanisms:

1. **Incoming control WS** (clients connecting to the bot to issue
   commands like /start, /stop, /status) uses
   `state.acceptWebSocket(ws, ['control'])`. Between commands, the
   DO can hibernate. When a message arrives, the DO is woken up
   with `webSocketMessage()` and processes the command. After the
   command, it goes back to sleep.

2. **Outgoing Kalshi WS** is a regular long-lived WebSocket that
   the DO holds while processing. It's NOT hibernated. But the 90-
   minute cycle (via `state.storage.setAlarm(Date.now() + 90min)`)
   closes and reopens it. Between cycles, the DO can be evicted;
   on the next alarm, the engine reconstructs from `ctx.storage`.

The trade-off: any time the DO is awake (between cycles, when a
control command arrives, or when a Kalshi frame arrives) the DO
bills wall-clock time. The 90-min cycle limits the maximum awake
time per request. The per-ticker state and risk state persist
across evictions.

## Multi-tenant

`LIVE_BOT` is addressed by `idFromName('user:default')` for the single
default user. Adding a second user is a name change in the Worker
handler. All D1 writes scope to `state.user_id`. The
`LiveBotConfig` includes `user_id` so /start can flip it.

## What's still TODO (forward work)

- **Chunk 4 (ONNX models)**: swap `NaiveSignal` for the per-vertical
  `ReversionQualitySignal` in `src/strategy/router.ts`. The current
  router API stays the same.

- **Chunk 5 (cron jobs)**: the daily-recap cron will write a summary
  row. The /api/pm/cron/{scan,news,daily,train} endpoints don't
  exist yet.

- **Chunk 6 (status API + Telegram)**: Telegram bridge is deferred
  to a separate module that subscribes to the DO's events.

- **Chunk 7 (dashboard)**: the dashboard currently serves
  `public/index.html`; the PnL/positions/signals views land in
  chunk 7.

- **Realistic fill simulation**: the chunk-3 engine treats every
  signal as an immediate fill at the limit price. A more realistic
  fill model (order book queue, partial fills, walk-away) lands
  in a follow-up. The 2026-08-06 flip-filter logic IS implemented
  (rejection counter + log) — see `_record_trade` in the Python
  source for the full reference; the TS port has the conservative
  defaults (5c profit floor + 1.5x ratio).

- **Profit target / stop loss**: implemented in the per-trade
  handler. The defaults are off; pass `profit_target_pct` and
  `stop_loss_pct` in the /start config to enable.

- **Auto-close horizon**: implemented via `close_after_trades` in
  the /start config. Mirrors the backtest's `future_window=20` exit.

## Verification

- `npm run typecheck` — clean (0 errors).
- `npx vitest run test/fees.test.ts test/strategy.test.ts test/risk.test.ts test/auth.test.ts test/db.test.ts test/live-bot.test.ts` — 78/78 pass.
- `npx wrangler deploy --dry-run` — bindings look right; DO
  registered; assets bundled.
- `node scripts/smoke-live-bot.mjs` — exercises /status, /start,
  /status, /stop against the deployed Worker.

## Operational notes

- **Default URL is demo** (`wss://external-api-ws.demo.kalshi.co/...`).
  The first /start call can flip to production with
  `{"url": "wss://external-api-ws.kalshi.com/..."}`.

- **Credentials are bound via wrangler secret** (NOT yet configured):
  - `wrangler secret put KALSHI_DEMO_KEY_ID`
  - `wrangler secret put KALSHI_DEMO_PRIVATE_KEY` (PKCS#8 PEM)

- **Risk config override**: `wrangler secret put RISK_CONFIG_OVERRIDE`
  with a JSON-serialized `RiskConfig` (string). Allows per-deployment
  risk tuning without redeploying the Worker.

- **HEADS-UP (carried from AGENTS.md)**: the `` prefix
  is in flux. Before any DNS or routing change, ask the user "is
  `` still the right prefix?"
