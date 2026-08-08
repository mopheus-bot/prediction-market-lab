# Chunk 11b — Per-vertical caps + blocklist + auto-pilot real money

**Date:** 2026-08-08
**Type:** ops + UI
**Status:** shipped + pushed (commit pending)

## What changed

Three things that complete the "full automation" vision:
per-vertical spending caps, a per-ticker blocklist, and
the auto-pilot real-money mode that flips the bot from
paper to real once the edge is proven.

### Per-vertical caps (chunk 11b)

The bot's `max_notional_cents_per_trade` is now overridable
per vertical. Useful because weather is more predictable
than politics — you can cap politics at 5¢/trade while
keeping 25¢/trade on weather.

```bash
curl -X POST 'api/pm/bot/start' \
  -H "Content-Type: application/json" \
  -d '{
    "per_vertical_max_notional_cents": {
      "weather": 25,
      "economic": 25,
      "politics": 5,
      "sports": 5
    }
  }'
```

The check in `maybeRecordTrade`:
1. Look up the signal's vertical in `per_vertical_max_notional_cents`.
2. If found, use that cap.
3. Else fall back to the global `max_notional_cents_per_trade`.

### Per-ticker blocklist (chunk 11b)

A `disabled_tickers: string[]` array in the bot config.
The bot skips every signal for a ticker on the blocklist
even when the global kill switch is OFF. Useful for
"I don't want to trade KXTICKER because the model isn't
reliable for it" without flipping the global kill switch.

Dashboard surface: a "Blocklist" section in the Caps
& today card. Each ticker is a tag with an × button to
remove. There's an input + Add button to add new tickers.
On add/remove, the dashboard PATCHes `/api/pm/bot/start`
with the updated `disabled_tickers` array (other config
fields preserved).

The maybeRecordTrade check:
```typescript
if (state.config.disabled_tickers?.includes(ticker)) {
  state.last_reject = {
    ts_ms: Date.now(),
    ticker,
    code: "ticker_blocklisted",
    message: `ticker ${ticker} is on the blocklist`,
  };
  return;
}
```

### Auto-pilot real money (chunk 11b)

A new `auto_pilot` cron at `30 5 * * *` (05:30 UTC daily,
before the daily recap). When `AUTO_PILOT_ENABLED=true`
(default `false`), it checks the bot's edge:

- **Days of paper trading** ≥ 7 (configurable via `AUTO_PILOT_MIN_DAYS`)
- **Closed trades** ≥ 30 (configurable via `AUTO_PILOT_MIN_TRADES`)
- **Annualized Sharpe** > 0.5 (configurable via `AUTO_PILOT_MIN_SHARPE`)

If all three pass, it POSTs `/api/pm/bot/trading-mode`
with `{trading_mode: "real"}`. Then it sends a Telegram
message: `🟢 AUTO-PILOT: flipped paper → real · trades=42 ·
days=8 · sharpe=0.62 · pnl=$1.23`.

**Why opt-in (default off):** the user committed to "edge
first, real money second." Auto-pilot on by default would
silently start placing real orders, which is the highest-
stakes action the bot can take. Keeping it off by default
means the operator has to explicitly set `AUTO_PILOT_ENABLED=true`
to enable it.

**The Sharpe math** (`src/lib/sharpe.ts`):
- For each closed trade, `return = pnl_cents / (entry_price_cents × size)` (bounded -1..+1).
- `Sharpe = mean(returns) / stddev(returns) × √(annualization)`.
- Annualization: `√(252 / days_elapsed)` — assume the window repeats 252/days_elapsed times per year.
- Floating-point tolerance: when stddev is below 1e-9 (essentially zero, e.g. all trades have the same return), Sharpe is undefined (NaN).
- 8 unit tests pin: empty list, single trade, all-same-returns, positive/negative Sharpe, min_trades, min_days, null pnl_cents filtering.

**Where it lives:**
- `src/lib/sharpe.ts` — pure-function Sharpe.
- `src/cron/auto-pilot-cron.ts` — the cron job. Reads bot
  status via the DO, pulls trades from D1, computes
  Sharpe, optionally flips, sends Telegram.
- `src/cron/dispatcher.ts` — `auto_pilot: "30 5 * * *"`
  in `CRON_TABLE`, wired into `JOBS`.
- `wrangler.jsonc` — `"30 5 * * *"` in `triggers.crons`.

### Kalshi-specific ELI5 blurbs (chunk 11b UI)

Per user feedback ("the ELI5 wording was meant in reference
to what these metrics mean for the prediction market on
Kalshi"), every card-blurb on the dashboard now explains
its metric in Kalshi context:

- **Stage panel** — "On Kalshi, every market is a binary question: YES resolves at 100¢, NO at 0¢. The bot buys YES or NO contracts at a market price..."
- **Cadence** — explains WS, 4 cron jobs, LLM, model registry in Kalshi terms
- **Trading mode** — "paper = log only, real = place actual orders on Kalshi's exchange with your $9.73 account..."
- **Caps & today** — "per-trade cap = max cents the bot will deploy on a single fill (default 25¢ — about 1 share at 25¢, or 0.5 shares at 50¢)..."
- **Last 5 trades** — "On Kalshi, a 'fill' happens when the bot's order matches a counterparty..."
- **Open positions** — explains entry/mark/unrealized PnL math for binary options

### Files changed

**New:**
- `src/lib/sharpe.ts` — pure-function Sharpe computation.
- `src/cron/auto-pilot-cron.ts` — the cron job.
- `test/sharpe.test.ts` — 8 unit tests.

**Modified:**
- `src/durable-objects/LiveBot.ts`:
  - `LiveBotConfig`: `per_vertical_max_notional_cents?` + `disabled_tickers?`.
  - `LiveBotState.config`: same fields, with defaults `null`.
  - `buildDefaultState()`: defaults both to `null`.
  - `start()`: merge both fields from the request (with
    the `!== undefined` check so callers can explicitly
    clear them by passing `null`).
  - `maybeRecordTrade()`: blocklist check (skip if ticker
    in `disabled_tickers`).
  - `/place-test-order`: per-vertical cap check.
- `src/cron/dispatcher.ts`:
  - `CRON_TABLE.auto_pilot = "30 5 * * *"`.
  - `JOBS.auto_pilot = runAutoPilotCron`.
- `wrangler.jsonc`:
  - `"30 5 * * *"` in `triggers.crons` (6 schedules now).
- `vitest.config.mts` — `test/sharpe.test.ts` in the unit project.
- `public/index.html`:
  - All card-blurbs rewritten in Kalshi context.
  - Caps & today card: new "Per-vertical overrides" + "Blocklist" rows.
  - Blocklist input + tags with × buttons.
  - `updateBlocklist()` function: PATCH `/api/pm/bot/start`
    with the updated `disabled_tickers` array.
  - `renderTradingControls()`: displays per-vertical caps
    as tags + blocklist as tags.
- New CSS: `.vertical-cap-tag`, `.blocklist-wrap`, `.blocklist-tags`, `.blocklist-tag`, `.blocklist-remove`, `.blocklist-input-row`, `.blocklist-input`.

### Smoke test

```
229/229 tests pass
tsc --noEmit clean
6 cron schedules registered (was 5)
dashboard validator passes
```

### What's next

Chunk 12: the app-level polish (skeleton loaders, micro-animations,
empty states, error toast styling, hero typography,
mobile-responsive sweep, full accessibility audit). These
are the "make it feel production-quality" items. After
that, the bot is feature-complete for the core plan.
