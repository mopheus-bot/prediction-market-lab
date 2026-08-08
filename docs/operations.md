# pm-bot — operations runbook (chunk 10.5)

This is the rules-of-engagement for everything pm-bot does
in production. Read this before changing cron intervals, the
LLM call pattern, or the WS connection strategy.

## The cadence (every auto-running service)

| Service        | Cadence              | What it does                                          | Where the math lives              |
| -------------- | -------------------- | ----------------------------------------------------- | --------------------------------- |
| Live WebSocket | continuous           | Stream orderbook + trade + ticker data from Kalshi    | `src/durable-objects/LiveBot.ts`  |
| Universe scan  | every 15 min         | Fetch Kalshi markets, rank by volume, write top N     | `src/cron/scan-cron.ts`           |
| News check     | every 6 hours        | For every open position, ask LLM for breaking news     | `src/cron/news-cron.ts`           |
| Daily recap    | daily at 06:00 UTC   | Aggregate 24h of trades + PnL, write R2, post Telegram | `src/cron/daily-cron.ts`          |
| Model retrain  | Sunday 00:00 UTC     | Poll R2 for new model artifacts, register in registry  | `src/cron/train-cron.ts`          |
| Model registry | on every /start      | Read active model_version from D1 per vertical         | `src/durable-objects/LiveBot.ts`  |
| LLM calls      | on news + daily cron | Per-call rate limit + dedup window                    | `src/llm/index.ts`                |
| CF Analytics   | on dashboard poll    | 60-90s, no CF cost (GraphQL is free)                  | `src/api/cf-analytics.ts`         |
| Cost estimate  | on dashboard poll    | 60s, combines CF + D1 + R2 + MMX + Fly.io             | `src/api/cost.ts`                 |

## Rate limits (the rules)

### Kalshi REST (2 req/s, hardcoded in `src/kalshi/client.ts`)

- **2 requests per second** default. Set `requestsPerSecond: 0` to disable.
- Kalshi's published rate limit is **30 reads/second + 30 writes/second** for Premier tier. The 2 req/s is well under that — it's conservative because we don't have a Premier key.
- The scan cron fires every 15 min and does ~5 requests per scan (markets + 1-2 detail fetches + 1 batch history). At 5 requests per scan, that's 0.3 req/min average — vastly under the limit.
- The news cron fires every 6 hours and does 1 LLM call per open position. At 5 open positions, that's 5 calls per 6h = 20 calls/day.
- The daily cron fires once at 06:00 UTC and does ~10 requests (trades + signals + summary + write R2 + post Telegram).
- The train cron fires weekly and does 1-5 R2 listing calls + ~10 model registry calls.
- **The WS is NOT rate-limited** (push feed, not polling). It's a single persistent connection that the bot reconnects on.

### LLM calls (per-call rate limit + dedup)

- The news cron uses LLM with a `purpose: 'news_verdict'` and a per-ticker dedup window of 4 hours (don't call twice within 4h for the same ticker).
- The daily cron uses LLM with `purpose: 'daily_recap'`. 1 call per day.
- The model retrain does NOT call LLM.
- **Token budget**: at ~$0.10/$0.40 per M tokens (MMX M2.7-highspeed), and ~2K input + 1K output per call, the news cron is ~$0.0006/call. 5 open positions × 4 calls/day = $0.012/day ≈ $0.36/month from news alone.
- The daily recap is ~5K input + 2K output = $0.002/call = $0.06/month.

### CF Workers (10M requests + 30M CPU-ms included)

- The dashboard polls 14 endpoints on a 5-30s cadence. At one page load + auto-refresh every 5-30s, that's ~3,000-18,000 requests/day.
- At the current usage (chunk 10: ~12 requests/24h, way under the 10M/mo limit), we're at ~0% of the monthly included amount.
- The CF Analytics GraphQL is free (no rate limit cost).

### D1 (5M reads + 100K writes/day included)

- The bot writes to `trades` only when a fill happens. With 25c/trade cap and 150c/day cap, max 6 trades/day = 6 writes.
- The bot writes to `signals` on every signal. With 1 ticker and the bot's conservative strategy, ~10 signals/day.
- Cron jobs write to `cron_runs` and `llm_calls` on each fire. 4 cron jobs × 1 entry per fire + 5 LLM calls/day = ~10 writes/day from crons.
- Total writes/day: ~25. At 100K/day free, we're at 0.025%.
- Reads: every status API call does ~5 D1 queries. At 18K requests/day × 5 reads = 90K reads/day. At 5M/day free, we're at 1.8%.

### R2 (10GB storage + 10M Class B reads/month)

- Models: ~1MB total (4 verticals × 250KB).
- Daily recap: ~1KB/day × 30 days = 30KB.
- Total storage: ~1MB. At 10GB free, we're at 0.01%.
- Reads: rare. The bot reads models on /start, daily recap on dashboard load. <100 reads/day.

### Fly.io relay (chunk 11+)

- The relay runs on `shared-cpu-1x` (1GB RAM) at $1.94/mo.
- 24/7 uptime = $1.94/mo. With $0.83 free credit, the first ~12 days are free.
- The user can shut it down via `fly machines stop` to pause the cost.

## Order of operations (what runs when)

1. **Worker starts**: serves dashboard + API endpoints.
2. **Dashboard auto-start on page load**: hits `POST /api/pm/bot/auto-start`, which opens the WS if not already open.
3. **WS opens**: signs the path with the demo creds, subscribes to `orderbook_delta + trade + ticker + market_lifecycle_v2` for every ticker in `config.tickers`.
4. **Every 90 min (alarm)**: the bot's main cycle fires (check positions, maybe signal, maybe exit).
5. **Every 15 min**: scan cron fires, updates `scans` table.
6. **Every 6 hours**: news cron fires, asks LLM for each open position, posts Telegram on AT RISK / BROKEN.
7. **Every day at 06:00 UTC**: daily cron fires, writes R2 recap, posts Telegram summary.
8. **Every Sunday at 00:00 UTC**: train cron fires, polls R2 for new model artifacts, registers in D1.

## When things go wrong (recovery)

- **WS not connecting**: check `last_ws_error` in `/api/pm/bot/status`. The error code + message points to the failure mode (auth_sign_failed, missing_creds, http_xxx, ws_open_failed).
- **Cron not firing**: check `/api/pm/cron-runs?limit=10`. If the last run is older than the expected interval, the cron is stuck. CF will retry on the next scheduled tick.
- **Cost spiking**: check `/api/pm/cost` → `cf_monthly` + `fly_relay` sections. If a bar is >80%, you're approaching the limit. If the bar is red (>100%), you're being billed.
- **Bot placing bad trades**: check the kill switch — flip to "Killed" via the trading-mode panel. The engine will refuse all new trades.

## Memory rule: the bot's edge has to exceed the bill

For a personal trading bot on a $9.73 Kalshi account, the bar is:
- CF: $0-2/mo (under free tier)
- Fly.io: $1.94/mo
- MMX: $0.40/mo
- **Total: $2-4/mo**

The bot has to make at least $2-4/mo in net PnL after fees, or we have no product. The current caps ($0.25/trade + $1.50/day) mean the bot can lose at most $0.75/day, or ~$22/mo — way more than the bill. If the bot's edge is real, even a 5% win rate at these caps covers the cost 10x over.

## When in doubt

- `GET /api/pm/bot/status` — the bot's current state.
- `GET /api/pm/cost` — usage + projected monthly cost.
- `GET /api/pm/cadence` — every service with last-ran + next-scheduled.
- `GET /api/pm/bot/stage` — single badge: what is the bot doing right now.
- `wrangler tail pm-bot` — live Worker logs.
- `fly logs --app pm-bot-relay` — live relay logs.
