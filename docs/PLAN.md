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
| 1 | **Data layer** — D1 schema, migrations, TS types, unit tests | pending | Foundation for everything else. ~2 days. |
| 2 | **Kalshi client TS port** — RSA auth, REST, WS | pending | **RISKIEST** — Node crypto vs Python cryptography must be byte-exact. Verify against demo API. ~3 days. |
| 3 | **Live bot Durable Object** — WS connect with hibernation, 90-min cycle, position management | pending | State in `ctx.storage`, never instance vars. ~5 days. |
| 4 | **Strategy + models** — ONNX conversion of 4 .joblib models, feature engineering, strategy router | pending | `skl2onnx` one-shot helper. Parity tests against Python output. ~5 days, parallel with 3. |
| 5 | **Cron jobs** — scan, news, daily, train (4 Workers + Cron Triggers) | pending | Each runs <2 min. ~2 days. |
| 6 | **Status API + Telegram IM bridge** | pending | Telegram primary (works without the secondary channel), A secondary IM channel if a webhook URL is exposed. ~2 days. |
| 7 | **Dashboard (CF Pages)** — PnL, positions, signals, per-vertical breakdown, historical views | pending | Static site, polls `/status` and `/api/pm/*`. ~3 days. |
| 8 | **Model registry + shadow mode + hot-swap** | pending | Two DOs (live + shadow), model versioning in D1, R2 artifacts, promotion workflow. ~3 days. |
| 9 | **Real trading toggle + kill switch** | pending | After 1 week of paper validation. `TRADING_MODE=paper|real|off`, daily notional cap, isolated real creds. ~3 days. |

**Total MVP (chunks 0–6):** ~3 weeks
**Total v1.1 (chunks 0–8):** ~5 weeks
**Total including real trading (chunks 0–9):** ~6 weeks

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
