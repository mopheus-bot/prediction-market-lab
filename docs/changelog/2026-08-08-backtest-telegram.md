# Backtest automation and Telegram alerts on a real fill (2026-08-08)

**Date:** 2026-08-08
**Type:** ops + UX
**Status:** shipped + pushed (commit pending)

## What changed

Two pieces of the "everything on auto" vision land in this step:
the backtest sweep runs automatically every Sunday, and the
operator gets a Telegram message the moment a real-money
trade fills.

### Backtest automation

A new `backtest` cron that runs every **Sunday at 01:00 UTC**
(after the train cron at 00:00 UTC). Pulls the last 7 days
of trades from D1, computes a model retrospective, and
registers the metrics as a `candidate` model in the
registry.

**What it computes:**
- `trade_count` — closed + open trades in the window
- `wins` / `losses` / `pending` — outcomes
- `win_rate` — wins / (wins + losses)
- `total_pnl_cents` + `avg_pnl_cents`
- `model_agreement_rate` — fraction of trades where
  `signal_p > 0.5` AND `pnl_cents > 0` (the model
  "predicted the right direction")
- Per-vertical breakdown

**Why a "retrospective" and not a full backtest?** The bot
doesn't have enough historical `market_snapshots` yet to
replay the strategy in real time. A retrospective gives
the same signal ("is the model good?") on real trades
the bot has actually made. When + accumulates
more historical data, this can evolve into a full
replay.

**Where it lives:**
- `src/lib/backtest.ts` — pure-function metrics math + the
  D1 query.
- `src/cron/backtest-cron.ts` — the cron job. Records
  `cron_runs` row + registers a candidate model named
  `backtest-{ts}` with the metrics in `train_metrics_json`.
- `src/cron/dispatcher.ts` — `backtest: "0 1 * * SUN"` in
  `CRON_TABLE`, wired into `JOBS`.
- `wrangler.jsonc` — `"0 1 * * SUN"` in `triggers.crons`.

**Dashboard surface:** the new candidate model is visible
via `GET /api/pm/models` and the cadence panel. The
`/api/pm/cron-runs?cron=backtest&limit=10` endpoint shows
the last 10 runs with the metrics in the `artifacts_json`.

**Operator workflow:** the operator sees the new
candidate model in the dashboard, reviews the metrics
(e.g. `trades=42 · wins=24 losses=18 · win_rate=57% ·
model_agreement=64% · pnl=$1.23`), and decides whether to
`POST /api/pm/models/promote` to make the model the
new active one. Auto-promote is OFF by default (
decision; the user has to opt in).

### Telegram on every real fill

In `LiveBot.maybeRecordTrade`, after the `open`
`writeTradeRow`, if `trading_mode === "real"`, post a
Telegram message with:
- Ticker
- Side, size, price
- Model probability (`signal_p` as %)
- Rationale (first 200 chars)
- Kalshi order id (if available)

**Why only `real`:** paper + off mode don't post (would be
noisy — every scan would spam). The user explicitly
opted into real-money mode; they want to know the moment
a real trade fills.

**Failure mode:** best-effort. If Telegram returns an
error, the trade is still recorded in D1 + the bot
continues. Just a `console.warn` log.

**Config:** uses the existing `TELEGRAM_BOT_TOKEN` +
`TELEGRAM_CHAT_ID` secrets (set in  for the
news + daily crons). No new secrets needed.

### Files changed

**New:**
- `src/lib/backtest.ts` — pure-function metrics + D1 query.
- `src/cron/backtest-cron.ts` — the cron job.
- `test/backtest.test.ts` — 8 unit tests for the metrics math
  (wins/losses, model_agreement_rate, window filtering,
  per-vertical aggregation, empty case).

**Modified:**
- `src/durable-objects/LiveBot.ts`:
  - `LiveBotEnv` extended with `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (already exist as secrets; just wiring them in).
  - `sendTelegramMessage` import.
  - New block at the end of `maybeRecordTrade`: when
    `trading_mode === "real"`, post a Telegram message
    with the trade details.
- `src/cron/dispatcher.ts`:
  - `backtest: "0 1 * * SUN"` in `CRON_TABLE`.
  - `backtest: runBacktestCron` in `JOBS`.
- `wrangler.jsonc` — `"0 1 * * SUN"` in `triggers.crons`.
- `vitest.config.mts` — added `test/backtest.test.ts`.
- `docs/operations.md` — added the backtest cron to the
  cadence table.

### Smoke test

```
221/221 tests pass
tsc --noEmit clean
wrangler deploy succeeds
5 cron schedules registered (was 4)
```

### What's next

: auto-pilot real money + per-vertical caps +
per-ticker kill switch. Auto-pilot stays OFF by default
(operator opts in via env var). Per-vertical caps cap
spending per vertical (weather, economic, politics,
sports). Per-ticker kill switch is a per-ticker ON/OFF
that blocks trades for just that ticker.
