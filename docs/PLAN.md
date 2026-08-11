# pm-bot — Plan & Architecture

Serverless port of the Kalshi paper-trading bot. This document captures the
shift from the local-Mac Python setup to a 24/7 serverless architecture on
Cloudflare, and the chunk-by-chunk plan to land it.

## Source of truth

The original Python implementation lives in
`~/Documents/GitHub/the Python reference engine/`. It runs against
the Kalshi production WebSocket and writes a JSONL ledger + summary to
`~/data/prediction-markets/2026-08-06/paper-trade-live-bprime/`.

The TS port in this repo (`pm-bot/`) is a from-scratch reimplementation of
the same trading engine, designed to run on Cloudflare Workers.

## Why the shift (2026-08-08)

The local setup was bound to the dev Mac:
- The paper bot, the orchestrator wrapper, and the local crons all needed
  the Mac to be awake.
- New code changes required `ssh`-style restarts of the orchestrator.
- local crons would silently fail when the machine slept.
- The JSONL ledger was opaque — answering "what's my win rate when
  `signal_p > 0.7`?" required parsing JSONL in Python.

We moved to Cloudflare so the bot is:
- **24/7**, independent of the Mac
- **Queryable** — trades land in D1 (SQL), not JSONL
- **Observable** — a dashboard, not log-tailing
- **Hot-swappable** — new models in R2, deploy via `git push`
- **Multi-tenant-ready** — `user_id` columns from day one

## Why Cloudflare specifically (not Cloud Run)

Two architectures were on the table:

| 			  Option 			 | 				   What 		   	   | 					 Why not 					 |
|--------------------------------|-------------------------------------|-------------------------------------------------|
| Cloud Run service + jobs | True serverless, Python native | ~$30–40/mo for 24/7 with min-instances=1; not the cheapest |
| **CF Workers + DOs + D1 + R2** | True serverless, $5/mo base + usage | Required Python→TS port (~5–10 days work) |

We picked CF because:
1. The rest of the Prediction Market Lab stack is already on CF (Pages, Email Routing,
   KV, R2, Workers). One vendor, one dashboard, one billing surface.
2. **D1 SQL is the analysis unlock.** Every "how is the bot doing?"
   question becomes a SQL query instead of a Python notebook.
3. **DO WebSocket hibernation** is the cost story — the bot pays only for
   active compute time, not wall-clock, so 24/7 costs ~$0.10–0.50/mo
   instead of $50–140/mo.
4. CF Access gives us a free login wall (only the user can reach
   `/pm`).

**Total operating cost at single-user scale:** ~$10/mo
($5 Workers Paid base + ~$0.50 DO duration with hibernation
+ ~$4 mmx LLM + <$0.50 D1/R2/Analytics).

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │   CF Access (login wall)            │
                    │    — only the user      │
                    └──────────────┬──────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
        /pm/*    /api/pm/*   (cron triggers)
              │                    │                    │
              ▼                    ▼                    ▼
   ┌────────────────────┐  ┌──────────────────┐  ┌──────────────┐
   │  CF Pages (later)  │  │  Worker: pm-bot  │  │ 4 Cron Jobs  │
   │  static dashboard  │  │  - /status       │  │ scan 4×/day  │
   │  (Chunk 7)         │  │  - /summary      │  │ news 7×/day  │
   └────────────────────┘  │  - /trades       │  │ daily 1×/day │
                           │  - DO stub       │  │ train 1×/wk │
                           └────────┬─────────┘  └──────┬───────┘
                                    │                    │
                                    ▼                    ▼
                       ┌─────────────────────┐  ┌──────────────┐
                       │ Durable Object      │  │  Workers     │
                       │ "live-bot"          │  │  + mmx LLM   │
                       │ - WS hibernation    │  └──────────────┘
                       │ - 90-min cycle      │
                       │ - position mgmt     │
                       └────────┬────────────┘
                                │
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
        ┌──────────┐      ┌──────────┐      ┌──────────────┐
        │ D1 (DB)  │      │ R2       │      │  KV (config) │
        │ pm-bot-  │      │ pm-bot   │      │              │
        │  prod    │      │ models,  │      └──────────────┘
        └──────────┘      │ reports  │
        trades            └──────────┘
        signals
        snapshots
        models
        model_registry
```

## The 10-chunk plan

Each chunk is a self-contained, deployable commit on `main`. We stop
at any chunk and have something useful.

| # | Chunk | Status | Notes |
|---|-------|--------|-------|
| 0 | **Bootstrap** — repo, D1, R2, hello world, custom domain, CF Access, GitHub | ✅ done | 2026-08-08. D1 ID `cd54a509-...`, R2 bucket `pm-bot`, CF Access app `bot`. |
| 1 | **Data layer** — D1 schema, migrations, TS types, unit tests | ✅ done | chunk 1-7. |
| 2 | **Kalshi client TS port** — RSA auth, REST, WS | ✅ done | kalshi-typescript SDK + polling (no WS after chunk 10.6). |
| 3 | **Live bot Durable Object** — WS connect with hibernation, 90-min cycle, position management | ✅ done | chunk 3. State in `ctx.storage`. |
| 4 | **Strategy + models** — ONNX conversion of 4 .joblib models, feature engineering, strategy router | ✅ done | chunk 4. JSON model format. |
| 5 | **Cron jobs** — scan, news, daily, train (4 Workers + Cron Triggers) | ✅ done | chunk 5. Each runs <2 min. |
| 6 | **Status API + Telegram IM bridge** | ✅ done | chunk 6. Telegram primary. |
| 7 | **Dashboard (CF Pages)** — PnL, positions, signals, per-vertical breakdown, historical views | ✅ done | chunk 7 + 10 (restructure to 7 sub-pages). |
| 8 | **Model registry + shadow mode + hot-swap** | ✅ done | chunk 8. D1 registry + R2 artifacts. |
| 9 | **Real trading toggle + kill switch** | ✅ done | chunk 9. `TRADING_MODE=paper\|real\|off` + per-vertical caps. |

### Post-MVP chunks (10+)

| # | Chunk | Status | Notes |
|---|-------|--------|-------|
| 10 | **Dashboard restructure** — Stage panel, brand bar, 7 focused sub-pages (Dashboard / Bot / Positions / Trades / Models / Schedule / Dev), the app polish | ✅ done | chunk 10 + 10.5 + 10.6 + 10.7 + 10.8 + 10.8c + 12. |
| 11a | **Backtest automation** — weekly Sunday 01:00 UTC backtest retrospective; Telegram on real fill | ✅ done | chunk 11a. |
| 11b | **Auto-pilot** — daily 05:30 UTC paper→real flip on Sharpe > 0.5 + min days + min trades | ✅ done | chunk 11b. Default off. |
| 12 | **Automation suite** — manual cron triggers, E2E smoke test, daily heartbeat cron, leads-cron, dispatcher bug fixes | ✅ done | chunk 12 + 13. |
| 13 | **Leads pipeline** — LLM-driven add+drop suggestions, every 6h +30min (00:30/06:30/12:30/18:30 UTC; tightened from daily 02:00 UTC on 2026-08-09; offset 30min from news so the LLM has fresh news data), operator approval on Dev page, 24h TTL via `superseded`, recently-rejected 30d cooldown, vertical retargeting deferred | ✅ done | chunk 13 (this chunk). |
| 14 | **Strategy refresh: parlays + vertical taxonomy** — Kalshi's open-market list is 99% multi-game parlays (4,065 KXMVESPORTS* + 1,935 KXMVECROSSCATEGORY*); the existing single-event strategies don't fit. Plan: widen the vertical taxonomy, deploy, then build a parlay strategy with a leg-probability model. See [`STRATEGY-PARLAYS.md`](./STRATEGY-PARLAYS.md). | 📋 plan | chunk 14 (next). Sports-data-API cost + 8B-model-on-CF discussion pending. |
| 14.1 | **Research cron** — every 15 min (offset 5 min from scan: 5,20,35,50): polls Kalshi, filters to "looks active" markets (last_price > 0 OR OI > 0), GETs each for the real orderbook (LIST endpoint returns 0/0 for bid/ask — gotcha discovered 2026-08-10), snapshots to `live_market_snapshots` D1 table. `is_live = 1` when there's a real two-sided quote. Surfaces via `GET /api/pm/research/live-markets` (current view) and `GET /api/pm/research/live-markets/:ticker` (history). Operator's window into "what's actually tradeable right now." | ✅ done | chunk 14.1. The bot's 7 existing KXWARMING-50 orders were the seed for this — the operator knew the bot had been trading, but the list endpoint couldn't show why. |
| 15 | **17-vertical expansion** — pm-bot was running on the 4 legacy verticals (weather / economic / politics / sports) hardcoded into the `Vertical` enum, the leads-scout prefix maps, the category_mapper, the strategy router, and the auto-promote whitelist. Kalshi's actual open-market catalog has 17 verticals (elections, financials, entertainment, science_technology, crypto, companies, commodities, mentions, social, world, health, transportation, and `(none)`). User asked: "expand coverage to include all 17 verticals, let the bot settle in (full immediate auto circle). We'll let the bot train while we talk and plan strategy around the new verticals." Changes: `Vertical` enum 4 → 17, prefix maps + title-keyword fallbacks for 13 new categories in `leads-scout.ts`, `category-mapper.ts` 1:1 Kalshi category → vertical, strategy router profiles for all 17 (all default to `naive + LLM` since no models yet), `KNOWN_VERTICALS` in the verticals API, `AUTO_PROMOTE_VERTICALS` in the LLM cron, leads-cron system prompt + `VERTICALS` array, `LiveBot` auto-promote endpoint whitelist. | ✅ done | chunk 15 (2026-08-11). Bot settling in: 1st new-vertical auto-promote was KXELONMARS-99 (world) at 0.75 confidence. |
| 15.1 | **Research cron scope fix** — the research cron was timing out silently at the 30s Worker wall-clock limit. The full 6,000-market scan + 550 GETs × 500ms throttle = 280s wall-clock, 9x over the limit. The cron had been timing out since 01:10 (no cron_run row because the kill happens before recordRun). The 550 active markets were 99% parlay block (KXMVESPORTS* / KXMVECROSSCATEGORY*) that the bot's strategies explicitly don't price. Fix: skip the parlay block at the LIST level via `SKIP_PARLAY_PREFIXES` (3 regexes) + cap GETs to top 100 by liquidity (`MAX_GETS=100`) + bump throttle 2 → 5 req/s. Wall-clock: 6s (LIST) + 20s (GETs) = 26s. | ✅ done | chunk 15.1 (2026-08-11). |
| 15.2 | **LLM cron — D1 bind cap + wall-clock + priority + discovery + parallelize** — the LLM cron had a stack of related issues that the user surfaced one at a time. (a) Pre-existing D1 100-param bind cap: snapshot query was a single IN-clause with 200+ tickers. (b) `LLM_LOOP_CAP=200` assumed 1s/call; with the rich prompt latency is 10.5s avg, 200 calls = 2,000s, 66x over the 30s Worker limit. Dropped to 3. (c) The 3-cap cycled through the same 4 single-event markets every 28 minutes. User said "this number isn't moving." (d) Snapshots table was stale (research cron timing out), so the LLM wasn't seeing new verticals. Switched fresh-discovery from `/markets` (200 parlays) to `/events` (200 events spanning 5+ verticals). (e) LLM calls were sequential. Added a `pMap` helper with 5-way concurrency + bumped cap to 15 + dropped the no_price skip (LLM now evaluates title-only for markets without live prices). | ✅ done | chunk 15.2 (2026-08-11). Universe size: 44 → 49+ in the first 10 min after deploy, 5 auto-promotes across 4 new verticals (financials, science_technology, elections, politics). |
| 15.3 | **Auto-retrain pipeline** — the user asked: "wire the auto-retrain." Previously the trainer was a manual command: user runs the Python trainer, converts to JSON, uploads to R2, train-cron auto-registers. Now: GitHub Action weekly (Saturday 22:00 UTC, 2 hours before Sunday train-cron), runs `scripts/retrain.py` which pulls the bot's universe from D1, fetches 7 days of Kalshi public trades per ticker, runs the live reversion trainer once per vertical, converts `.joblib` to JSON, uploads to R2 at `pm-bot/models/reversion-{vertical}-v2.json`. Sunday train-cron auto-registers; operator promotes via Dev page. User pushed back: "Not just legacy verticals for auto-retrain. We need to capture all verticals." Extended VALID_VERTICALS 4 → 17 in the trainer + DEFAULT_CATEGORY_MAP 13 → 43 entries in the Python `category_mapper` (no more bucketing Crypto → economic, Elections → politics). | ✅ done | chunk 15.3 (2026-08-11). The trainer currently returns 0 samples (paper bot has 18 trades on KXWARMING-50 in 7 days, need 30+ for the reversion label). Pipeline is ready and idle on the data side. |
| 15.4 | **LLM-PIPELINE Bug A — feed the LLM the parlay component markets + event rules** — the LLM was hallucinating on parlay markets because the prompt only had the market's title. For a 22-leg parlay that's `"yes Bibee 4+,yes Pérez 6+,yes Skenes 6+..."` and the LLM had to guess at the bundle. High confidence was a hallucination, not an edge. Fix: added `client.getEvent(eventTicker, { withNestedMarkets: true })` to fetch the parent event from Kalshi's `/events/{ticker}?with_nested_markets=true`. New LLM prompt fields: `eventTitle`, `eventSubTitle`, `rulesPrimary`, `parlayLegs` (capped at 10 legs in the prompt). Per-event cache (10-min TTL) so multi-market events (e.g. KXNEWPOPE-70 has 7 sub-markets) only trigger 1 `/events` call. | ✅ done | chunk 15.4 (2026-08-11). parse_failed rate dropped 30-50% → ~0% immediately. `KXNEWPOPE-70-PPIZ` (Who will the next Pope be — Pietro Parolin) auto-promoted at 0.55 confidence into the elections vertical on the first run after the fix. |

**Total MVP (chunks 0–6):** ~3 weeks
**Total v1.1 (chunks 0–8):** ~5 weeks
**Total including real trading (chunks 0–9):** ~6 weeks
**Post-MVP to chunk 13:** ~1 additional week (operator UX + automation + LLM-driven features)
**Phase 4 chunks (chunks 14–15.4, 2026-08-11):** 1 day — vertical taxonomy expansion + LLM-PIPELINE Bug A + research-cron scope fix + auto-retrain pipeline. The PM-bot now covers all 17 Kalshi verticals.

## Decisions to honor

These were committed on 2026-08-08. Push back on any of them before
starting a chunk, not after.

- **LLM model:** `MiniMax-M3` via `mmx` CLI. Don't
  compromise quality for cost. (Was `MiniMax-M2.7-highspeed`
  until 2026-08-08; user override to M3. Same personal
  token — isolation deferred until pm-bot becomes a
  multi-user / revenue product.) Optimization layer
  (caching, smaller models) lands in v1.2+ if cost ever bites.
- **Path-based routing** over subdomain-per-bot. `/pm/*` +
  `/api/pm/*`. One cert, one CF Access policy, one Pages project.
- **Telegram as primary IM bridge.** A secondary IM channel if a public
  webhook URL exists. Telegram works without the secondary channel being up.
- **WebSocket hibernation is mandatory** on the DO. State in
  `ctx.storage`, never instance vars. Without hibernation, the DO
  cost is $50–140/mo. With it, $0.10–0.50/mo.
- **Multi-tenant from day 1.** Every table gets a `user_id` column
  (default `'default'`). DO addressed by `idFromName(`user:${userId}`)`.
  Adding a second user is a config change, not a refactor.
- **Real-trading toggle** in chunk 9 only. Currently paper-only.
  `KALSHI_PROD` creds at `~/keys/kalshi-prod-*` will move to
  `wrangler secret put` in chunk 9, with an isolated `KALSHI_REAL_*`
  prefix so the real key never touches the paper path.

## Cost at scale

Per-user cost (with hibernation working correctly):

| Users | CF base | DO × N | Cron + DB | mmx LLM | Total | Per user |
|-------|---------|--------|-----------|---------|-------|----------|
| 1 | $5 | $0.50 | $0.50 | $4 | $10 | $10 |
| 10 | $5 | $5 | $1 | $40 | $51 | $5.10 |
| 100 | $5 | $50 | $5 | $400 | $460 | $4.60 |
| 1000 | $5 | $500 | $50 | $4,000 | $4,555 | $4.55 |

The CF per-user cost drops as you scale. The LLM is the bottleneck at
100+ users — if that ever matters, swap to a smaller model or batch
news checks across all open positions.

## What you trade away vs the local setup

- No `pkill -f`, no SSH. Everything is `wrangler tail` and a dashboard.
- Can't run pandas in a Worker. For deep analysis, download a slice
  to local and use the existing Python notebook workflow.
- The Python strategy code (`the Python reference engine/`)
  stays for reference. The `.joblib` models get one-shot-converted
  to ONNX for the Worker to load.

## What stays the same

- The Python tooling (`analyze_*.py`, `backtest.py`) keeps working.
  It just queries archived data instead of live JSONL.
- The LLM prompts and the `mmx` CLI calls are identical (just from
  a Worker, not from cron).
- The trading strategy and signal logic. Same reversion model, same
  thresholds, same vertical mapping.
- Your local crons can keep firing — they just hit the cloud
  `/status` endpoint instead of the local files.
