# Venue analysis: what the Kalshi data showed, and what a different venue would need

> **Status:** analysis complete. Kalshi paper-trading was stopped on 2026-08-12.
> The port to a different venue was scoped but **not started**. This document is
> kept because the reasoning is the deliverable: it documents how a live,
> instrumented system produced a negative result, and what that result implies.

## TL;DR

We had 3.7 days of Kalshi paper data. The only strategy with a
demonstrably-clean track record was `replay_flip` on **sports**, with
5 wins / 0 losses / 1 zero across 6 closes (+$1.35 net realized).
Everything else was break-even (most closes at $0) or net-negative
(`-$19.53` on KXOAIANTH-40-OAI financials). Kalshi's binary-tick
movement is too slow and spread-too-wide to make the LLM signals
profitable at the cadence we can afford to run them. The bot is a
decent classroom, but not a trading venue.

**Conclusion: stop Kalshi paper-trading.** The architecture transfers; the venue
does not. The same LiveBot, D1 schema, risk engine and LLM gating would work
against a venue with sub-penny spreads and a stable instrument universe. Porting
was scoped but not started — see *Requirements for a venue port* below for what it
would take.

## The data that drove the decision

### Per-strategy P&L (all-time, paper)

| signal_rationale       | n   | wins | losses | zeros | realized  | notes                            |
|------------------------|-----|------|--------|-------|-----------|----------------------------------|
| `replay_flip` (sports)  | 6   | 5    | 0      | 1     | **+$1.35** | 100% win rate on non-zero closes |
| `replay_flip` (other)   | 8   | 0    | 1      | 7     | -$0.00    | 7 break-even, 1 loss             |
| `replay_flip` (financials) | 1 | 0 | 1     | 0     | -$19.53   | KXOAIANTH-40-OAI fade-down bleed |
| `naive_*_fade_*` (all) | 7   | 0    | 0      | 0     | $0.00     | 7 opens, 0 closes                |
| `llm_*` (all)           | 10  | 0    | 0      | 0     | $0.00     | 10 opens, 0 closes               |

Only `replay_flip` on sports has actually closed at a non-zero
P&L with a non-zero sample. Everything else is "the LLM opened
a position, the price moved a bit, the position closed for $0."
The KXOAIANTH loss is the one real number with teeth — a $19.53
realized loss on a 651-contract fade-down that never bounced. That
single trade wiped out the entire sports edge.

### The LLM signal

Across 10,299 calls (8.3M input + 4.0M output tokens, $48.50 over
3.7 days, **$13/day at the previous cadence**):

- 89% `hold 0.30` (no edge, low confidence)
- 9% `no` verdicts
- 2% `yes` verdicts

The LLM is conservative by design (the prompt tells it to default
to `hold` if it has no strong view), and 89% of the time it has
no strong view. The 11% non-hold rate is mostly "mild opinion,
low confidence" — which gets filtered out by the LLMOpinionSignal
strategy's 0.6 confidence gate. The actual entries that fire are
a small subset of a small subset, and they've been break-even.

After the cost fix (hourly cadence + 3 local gates: staleness
skip, one-sided-quote skip, daily cap), the new run rate is
~50-100 calls/day instead of ~2,774. That drops the LLM
cost to ~$1-3/day. But the signal quality is unchanged — the
LLM is the bottleneck, not the venue.

### Why Kalshi is the wrong venue

1. **Spread eats the edge.** Kalshi's 1¢ minimum tick + 2¢ typical
   spread means every "profitable" trade is actually 0-1¢ net of
   spread, which the replay_flip data confirms (5 wins, but only
   +$0.38 each, because the spread takes most of the move).
2. **Volume is thin.** KXMVECROSSCATEGORY parlays trade 5-50
   contracts/hour on a good day. Even if the LLM had a real edge,
   the bot would get filled on a fraction of the size it wants.
3. **Ticker rotation.** Markets expire daily, weekly, or by-event.
   The bot's universe rotates constantly. Each new ticker is a
   cold start — no history, no LLM verdicts, no price data until
   the research cron catches up.
4. **IP throttling.** Kalshi's 75-min 429 window is real and
   interrupts the scan cron. The 4h backoff + exp cap fixed it
   but it's a constant operational tax.

### What a different venue would need to provide

1. **Tighter spreads.** Liquid equities trade with sub-penny
   spreads. A "real" edge isn't eaten by market microstructure.
2. **24h price action as a real signal.** Equities move on
   news, earnings, macro and sentiment. An LLM can read a 1-day
   price chart and form a directional view, then act on it.
3. **A stable universe.** SPY is SPY tomorrow. No ticker rotation,
   no cold-start, no expiry cliffs.
4. **Paper trading with a clean API.** A paper API with no IP
   throttling, no fees, and the same order types as real money
   lets the signal quality be validated in isolation from
   market microstructure.
5. **Existing quant frameworks.** backtrader, zipline, vectorbt,
   QuantConnect — all stock-first, all free. Strategies can be
   backtested on 20 years of minute data without paying for it.

## What the port would look like

Same shape as the Kalshi bot, just a different broker:

```
CF Worker
  ├── cron: 0 * * * *        llm_opinions (every hour, with the 3 gates)
  ├── cron: */5 * * * *     broker_quote (every 5 min, refresh prices)
  ├── cron: */15 * * * *    signal_loop (was scan — drives the
  `tickers` config)
```

The Durable Object, the D1 schema, the risk engine, the LLM gating and the
dashboard all transfer unchanged. Only the broker adapter is venue-specific.

## Teardown (Kalshi side)

Done 2026-08-12:

- [x] Live bot set to `trading_mode: "off"` via `/api/pm/bot/start`
- [x] All 10 Kalshi-related local crons deleted (heartbeat,
      daily recap, news check, scan refresh, state write, retrain,
      dashboard keepalive, research verification, live status,
      live ticker)
- [x] Cost-monitoring reminder deleted (it would have
      fired tomorrow but the question it asks is moot now)
- [x] Launchd plist for the train pipeline unloaded
- [x] Open positions left to resolve via
      their natural exit logic — Kalshi positions don't need
      manual close, and the bot's polling feed keeps them
      until they hit the existing flip / profit-target / stop-loss
      paths.
- [x] This document written. The Kalshi code is left in place
      (deprecation note in `src/kalshi/client.ts`) so a future
      venue adapter can reference the existing patterns — wire
      formats, auth, polling, order placement, error handling.
      Cheaper to mirror than to invent.

## Requirements for a venue port

Scoped, not started. The work items, in dependency order:

1. **Add `src/<broker>/`:** mirror the `src/kalshi/` structure.
   - `client.ts` — REST + WebSocket client
   - `models.ts` — asset, position and order shapes
   - `auth.ts` — API key auth
   - a scout — likely unnecessary; the universe is config-driven
2. **Update LiveBot:** swap the broker client in the
   polling feed + order placement paths. Same DO, same
   router, same LLM gating.
3. **Update strategies:** rewrite `naive.ts` for equities
   (momentum/reversion on close prices, not on binary ticks).
   `llm-opinion.ts` stays the same.
4. **New default tickers:** start with 5-10 large-caps and add
   from there based on signal quality.
5. **Backtest the LLM signal on paper** for 2 weeks
   with the same cost gates already shipped. If the LLM has
   no edge on equities either, the conclusion is "LLM is the
   bottleneck, not the venue" — and the next move is a real ML
   model rather than a prompt.
6. **Real money only after 4+ weeks of paper profits.** Prove
   the edge in paper first.

## What we keep

- The entire CF Worker architecture (Workers + DOs + D1 + R2)
- The D1 schema (trades, signals, models, cron_runs,
  llm_calls, etc. — a `venue` column would disambiguate
  trades across brokers)
- The LLM cron + 3 local gates (staleness / one-sided / cap)
- The model registry, shadow mode, and the ONNX-style JSON
  tree format
- The dashboard, the SSE event bus, and the operator controls

## What we lose

- A working Kalshi integration, which was the only venue with
  real order placement in production
- The accumulated 3.7 days of paper-trading data (retained in
  the research reports, not in the live tables)

## What we learn

1. **Spread and cadence decide viability, not the model.** The
   strategy was fine; the venue was not.
2. **A negative result is a real result.** The decision to stop
   was made on 3.7 days of instrumented data rather than on a
   hunch — which is the entire point of building the telemetry
   first.
3. **The LLM was never the constraint.** It is 89% "no view" and
   ~$13/day. Cheapening it did not change signal quality. The
   bottleneck is a genuine predictive edge, and no amount of
   infrastructure substitutes for one.
4. **Measurement infrastructure is reusable across venues.**
   The risk engine, the ledger, the cost accounting and the
   dashboard are venue-agnostic and survived the pivot intact.

## Status

- **Kalshi:** bot off, crons deleted, code deprecated in place.
- **Venue port:** scoped, not started.
- The architecture, the risk model and the research harness are
  intact and documented.

## Why this document exists

The Kalshi decision is a strategic conclusion, not a tactical one. Anyone
reading this repository needs to know:

- We tried a venue, instrumented it, and got the data.
- The data said the venue did not work.
- The architecture was not the problem and was kept.
- The honest conclusion is a negative result, and it is documented rather than
  quietly rewritten as a success.
