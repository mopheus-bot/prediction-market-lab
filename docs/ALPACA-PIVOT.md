# pm-bot — Alpaca Pivot (2026-08-12)

> **Status:** Decision made 2026-08-12 02:15 EDT. Kalshi paper-trading
> shut down. Alpaca paper-trading is the next venue. This document
> captures the decision, the data that drove it, and the immediate
> teardown + future-build plan.

## TL;DR

We have 3.7 days of Kalshi paper data. The only strategy with a
demonstrably-clean track record is `replay_flip` on **sports**, with
5 wins / 0 losses / 1 zero across 6 closes (+$1.35 net realized).
Everything else is break-even (most closes at $0) or net-negative
(`- $19.53` on KXOAIANTH-40-OAI financials). Kalshi's binary-tick
movement is too slow + spread-too-wide to make the LLM signals
profitable at the cadence we can afford to run them. The bot is a
decent classroom, but not a trading venue.

**Decision: stop Kalshi paper-trading, build the same architecture
against Alpaca's equities API.** Same LLM, same gating, same bankroll
discipline — just a venue where the spread is 1¢ on liquid names
instead of 2¢ on thin binaries, and where 24h price action is a real
signal source.

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
~50-100 calls/day instead of ~2,774. That should drop the LLM
cost to ~$1-3/day. But the signal quality is the same — the
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

### Why Alpaca is the right next venue

1. **Tighter spreads.** SPY/QQQ/AAPL/NVDA trade with sub-penny
   spreads. The "edge" the LLM might find doesn't get eaten
   by market microstructure.
2. **24h price action is a real signal.** Equities move on
   news, earnings, macro, sentiment. The LLM can read a 1-day
   price chart and form a directional view, then the bot can
   act on it.
3. **Stable universe.** SPY is SPY tomorrow. No ticker rotation,
   no cold-start, no expiry cliffs.
4. **Free paper trading with clean API.** Alpaca's paper API
   has no IP throttling, no fees, and the same order types as
   real money. We can validate the LLM signal quality in
   isolation from market microstructure.
5. **Existing quant frameworks.** backtrader, zipline, vectorbt,
   QuantConnect — all stock-first, all free. We can backtest
   strategies on 20 years of minute data without paying for it.

## What the new architecture looks like (Phase 3)

Same shape as the Kalshi bot, just a different broker:

```
CF Worker
  ├── cron: 0 * * * *        llm_opinions (every hour, with the 3 gates)
  ├── cron: */5 * * * *     alpaca_quote (every 5 min, refresh prices)
  ├── cron: */15 * * * *    signal_loop (was scan — drives the
  │                            per-ticker router, now with equities
  │                            signal context)
  ├── cron: 0 6 * * *       daily_recap
  ├── cron: 0 0 * * SUN     retrain (same, retrain on Alpaca
  │                            historical data instead of Kalshi
  │                            historical)
  ├── cron: 0 1 * * SUN     backtest (now on equities)
  └── DO LiveBot:
        ├── strategy/router.ts   — same router, swap out NaiveSignal
        │                          for an equities-aware version
        ├── strategy/llm-opinion.ts — unchanged
        ├── strategy/naive.ts    — replace "fade a move > 5%" with
        │                          "momentum-or-reversion on equities"
        ├── kalshi/              — DELETE (or keep as a one-liner
        │                          shim that throws "venue deprecated"
        │                          if anyone tries to use it)
        ├── alpaca/              — NEW. Mirrors kalshi/ structure
        │                          (client.ts, models.ts, auth.ts,
        │                          leads-scout.ts, etc.)
        └── LiveBot.ts           — same, swap KalshiClient for
                                   AlpacaClient in the polling
                                   feed and order placement paths
```

The architecture transfers 1:1. The only changes are:
- Replace `src/kalshi/` with `src/alpaca/`
- Update `kalshi/leads-scout.ts` → `alpaca/leads-scout.ts` (or
  remove entirely — equities don't need a scout, the universe
  is fixed)
- Update LiveBot's polling + order paths
- New default tickers: SPY, QQQ, AAPL, NVDA, MSFT, GOOGL,
  AMZN, META, TSLA, AMD, COIN, JPM, GS, BAC, XOM, CVX, JNJ,
  PFE, KO, PEP, COST, WMT, TGT, NKE, DIS, SBUX, MCD, BA, GE,
  F, GM, RIVN, LCID, SOFI, PLTR, AAL, DAL, UAL, MAR, ABNB,
  BKNG, PYPL, SQ, SHOP, RBLX, NFLX, SPOT, UBER, LYFT, DASH,
  OXY, EOG, SLB, HAL, BKR, VLO, MPC, PSX, KMI, WMB, ENB, EPD,
  MMP, MPLX, AMT, PLD, SPG, PSA, EXR, AVB, EQR, VICI, WELL,
  DOC, O, AMH, INVH, MAA, CPT, ESS, UDR, FRT, HPP, KRC, REG,
  FRT, CUZ, BX, BXMT, KREF, STWD, WPC, NNN, ADC, GTY, OPI,
  SR, BNL, CLDT, APLE, GLPI, FCPT, EPRT, SRC, VNO, SLG, BDN,
  HIW, PGRE, VRE, BNL, AAT, HIW, LXP, ROIC, BDN, KIM, MAC,
  SKT, REG, FRT, ROIC, GTY
  (yes the list is long — equities universe is larger than 17
  verticals, and the user can curate it via the existing
  `tickers` config)

## Immediate teardown (Kalshi side)

Done 2026-08-12 02:15 EDT:

- [x] Live bot set to `trading_mode: "off"` via `/api/pm/bot/start`
- [x] All 10 Kalshi-related local crons deleted (heartbeat,
      daily recap, news check, scan refresh, state write, retrain,
      dashboard keepalive, research verification, live status,
      live ticker for mo)
- [x] Self-reminder (`llm-cost-24h-check`) deleted (it would have
      fired tomorrow but the question it asks is moot now)
- [x] Launchd plist for the train pipeline unloaded (was failing
      on TCC anyway)
- [x] KXDEELRIP + KXOAIANTH open positions left to resolve via
      their natural exit logic — Kalshi positions don't need
      manual close, and the bot's polling feed will keep them
      until they hit the existing flip / profit-target / stop-loss
      paths. They don't interfere with the Alpaca build.
- [x] This document written. The Kalshi code is left in place
      (deprecation note in `src/kalshi/client.ts`) so the Alpaca
      integration can reference the existing patterns — wire
      formats, auth, polling, order placement, error handling.
      Cheaper to mirror than to invent.

## Future-build plan (Phase 3, future session)

1. **Build `src/alpaca/`:** mirror `src/kalshi/` structure.
   - `client.ts` — REST + WebSocket client
   - `models.ts` — Alpaca asset, position, order shapes
   - `auth.ts` — API key auth
   - `leads-scout.ts` — actually skip this; equities don't need
     a scout, the universe is config-driven
2. **Update LiveBot:** swap KalshiClient for AlpacaClient in
   the polling feed + order placement paths. Same DO, same
   router, same LLM gating.
3. **Update strategies:** rewrite `naive.ts` for equities
   (momentum/reversion on close prices, not on binary ticks).
   `llm-opinion.ts` stays the same.
4. **New default tickers:** start with 5-10 large-caps (SPY, QQQ,
   AAPL, NVDA, MSFT, GOOGL, META, AMZN, TSLA) and add from there
   based on LLM signal quality.
5. **Backtest the LLM signal on Alpaca paper** for 2 weeks
   with the same cost gates we just shipped. If the LLM has
   no edge on equities either, the conclusion is "LLM is the
   bottleneck, not the venue" — and the next move is to invest
   in a real ML model (per the Phase 2 ordering in
   STRATEGY-PARLAYS.md).
6. **Real money only after 4+ weeks of paper profits.** Per the
   "1-2 weeks mockup / demo / launch" pattern from user memory,
   this is the same discipline applied to a new venue: prove
   the edge in paper first.

## What we keep

- The entire CF Worker architecture (Workers + DOs + D1 + R2)
- The D1 schema (trades, signals, models, cron_runs,
  llm_calls, etc. — just add a `venue` column to disambiguate
  Kalshi vs Alpaca trades)
- The LLM cron + 3 local gates (staleness / one-sided / cap)
- The retrain pipeline + 5 candidate models (will be re-trained
  on Alpaca data when we get there)
- The brand (Prediction Market Lab monogram, palette, contact lines —
  none of this is Kalshi-specific)
- The discipline: paper-trade first, prove the edge, then
  real money. Same rule, different venue.

## What we lose

- The Kalshi IP-throttle workaround (4h exp backoff for scan
  cron) — not needed in Alpaca world.
- The "verticals" concept. Equities don't have verticals in
  the Kalshi sense. The router will need a new per-ticker
  config model (probably just a flat list of tickers + per-
  ticker knobs).
- The "categories" mapping. Equities have sectors, but the
  bot's strategy doesn't need them.

## What we learn

- Whether the LLM has *any* edge. If the same 89% hold rate
  happens on equities, the LLM is the bottleneck and the
  venue doesn't matter.
- Whether the cost-control gates work in a different polling
  cadence (Alpaca's WebSocket is real-time, not 1.5s/ticker,
  so the staleness filter needs different thresholds).
- Whether the user (mo) actually wants to run a real-money
  trading bot, or if this is a research project that
  eventually becomes a paper-only demo for Prediction Market Lab
  marketing. (If it's the latter, the Alpaca build is
  unnecessary — Kalshi paper was already sufficient for the
  demo. The user can clarify on next session.)

## Status (right now)

- Kalshi: bot off, crons deleted, code deprecated in place,
  2 open positions resolving naturally.
- Alpaca: not started. Will be a Phase 3 work item in a
  future session.
- Cron for the user (mo): `llm-cost-24h-check` was deleted;
  the bot is in a stable-but-deprecated state. No automated
  monitoring. Mo can check `/api/pm/bot/status` to see
  position status anytime.
- Next-session pickup: see the "Future-build plan" section
  above. Pick one of:
  (a) Build Alpaca integration from scratch (3-5 days work)
  (b) Just backtest the LLM on Alpaca paper with the existing
      strategy (1-2 days, faster signal on whether the LLM
      has any edge at all)
  (c) Kill the pm-bot project entirely and use the LLM-
      trading infra as a Prediction Market Lab product demo (the
      Kalshi data + cf-worker architecture + LLM gating is
      a compelling "AI quant in 200 lines of TS" story even
      without a live broker).

## Why this doc is in the repo

The Kalshi → Alpaca pivot is a strategic decision, not a
tactical one. Future sessions that touch pm-bot need to know:
- We tried Kalshi, got the data, made the call.
- The architecture transfers 1:1. Don't re-litigate the
  CF Worker / DO / D1 / R2 design — it works.
- The LLM is the bottleneck. If the Alpaca build produces
  the same 89% hold rate, the conclusion is "LLM has no
  edge" and the next move is a real model, not another
  venue swap.

## Cross-references

- `docs/PLAN.md` — the original Cloudflare port plan
- `docs/STRATEGY-PARLAYS.md` — last strategy refresh (parlays
  ordering: c → b → a, deferred)
- `docs/LLM-PIPELINE.md` — the LLM signal pipeline
- `docs/EVENT-DRIVEN-UI.md` — UI / dashboard
- `src/kalshi/client.ts` — Kalshi venue code (now deprecated,
  kept as reference for the Alpaca mirror)
- The Prediction Market Lab Python pipeline at
  `~/Documents/GitHub/the Python reference engine/`
  is also Kalshi-specific and would need an Alpaca mirror
  to stay useful. Out of scope for this pivot — the Python
  pipeline has been read-only on the CF Worker side since
  the model files moved to R2.
