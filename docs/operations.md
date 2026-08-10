# pm-bot — operations runbook

This is the rules-of-engagement for everything pm-bot does
in production. Read this before changing cron intervals, the
LLM call pattern, or the data feed strategy.

## The cadence (every auto-running service)

| Service        | Cadence              | What it does                                          | Where the math lives              |
| -------------- | -------------------- | ----------------------------------------------------- | --------------------------------- |
| Data feed      | 1.5s round-robin     | Pull orderbook + ticker from Kalshi via REST polling  | `src/durable-objects/LiveBot.ts`  |
| Universe scan  | every 15 min         | Fetch Kalshi markets, rank by volume, write top N     | `src/cron/scan-cron.ts`           |
| News check     | every 6 hours        | For every open position, ask LLM for breaking news     | `src/cron/news-cron.ts`           |
| Daily recap    | daily at 06:00 UTC   | Aggregate 24h of trades + PnL, write R2, post Telegram | `src/cron/daily-cron.ts`          |
| **Auto-pilot** | daily 05:30 UTC      | If Sharpe is past threshold, flip paper→real. Default off. | `src/cron/auto-pilot-cron.ts`|
| **Heartbeat**  | daily 07:00 UTC      | Passive LLM + Telegram health check; Telegrams on failure only | `src/cron/heartbeat-cron.ts` |
| **Leads suggestions** | every 6 hours +30min (00:30/06:30/12:30/18:30 UTC) | LLM-driven add+drop suggestions for the ticker universe; operator approves/rejects on the Dev page. Uses the Kalshi scout (real market snapshot, event_ticker prefix classification, per-ticker verify, universe-health auto-drops for tickers no longer in Kalshi's open list). See [`STRATEGY-PARLAYS.md`](./STRATEGY-PARLAYS.md) for the broader strategy refresh context. | `src/cron/leads-cron.ts`     |
| Model retrain  | Sunday 00:00 UTC     | Poll R2 for new model artifacts, register in registry  | `src/cron/train-cron.ts`          |
| Backtest       | Sunday 01:00 UTC     | Run the backtest retrospective on the latest trade ledger | `src/cron/backtest-cron.ts`    |
| Model registry | on every /start      | Read active model_version from D1 per vertical         | `src/durable-objects/LiveBot.ts`  |
| LLM calls      | on news + daily cron | Per-call rate limit + dedup window                    | `src/llm/index.ts`                |
| CF Analytics   | on dashboard poll    | 60-90s, no CF cost (GraphQL is free)                  | `src/api/cf-analytics.ts`         |
| Cost estimate  | on dashboard poll    | 60s, combines CF + D1 + R2 + MMX                      | `src/api/cost.ts`                 |

### Cron schedule (must match `wrangler.jsonc` `triggers.crons`)

```
*/15 * * * *  → scan         (every 15 min)
0 */6 * * *   → news         (every 6 hours, 00/06/12/18 UTC)
30 */6 * * *  → leads        (every 6 hours +30min, 00:30/06:30/12:30/18:30 UTC; 2026-08-09 tightened from daily 02:00 UTC)
30 5 * * *    → auto_pilot   (daily 05:30 UTC, default off)
0 6 * * *     → daily        (daily 06:00 UTC)
0 7 * * *     → heartbeat    (daily 07:00 UTC)
0 0 * * SUN   → train        (Sunday 00:00 UTC)
0 1 * * SUN   → backtest     (Sunday 01:00 UTC)
```

The order matters: backtest (01:00) finishes before leads (02:00)
so the leads prompt sees fresh backtest metrics on Sundays;
leads (02:00) finishes before auto_pilot (05:30) so the new
ticker universe is in place before the day starts; daily recap
(06:00) writes the previous day's PnL after auto_pilot; heartbeat
(07:00) catches any of the above silently breaking.

## Rate limits (the rules)

### Kalshi REST (2 req/s, hardcoded in `src/kalshi/client.ts`)

- **2 requests per second** default. Set `requestsPerSecond: 0` to disable.
- Kalshi's published rate limit is **30 reads/second + 30 writes/second** for Premier tier. The 2 req/s is well under that — it's conservative because we don't have a Premier key.
- The scan cron fires every 15 min and does ~5 requests per scan (markets + 1-2 detail fetches + 1 batch history). At 5 requests per scan, that's 0.3 req/min average — vastly under the limit.
- The news cron fires every 6 hours and does 1 LLM call per open position. At 5 open positions, that's 5 calls per 6h = 20 calls/day.
- The daily cron fires once at 06:00 UTC and does ~10 requests (trades + signals + summary + write R2 + post Telegram).
- The train cron fires weekly and does 1-5 R2 listing calls + ~10 model registry calls.
- **The polling feed** is rate-limited by the SDK's 2 req/s throttle. With 1 ticker polled at 1.5s = 0.67 req/s, well under the limit.

### LLM calls (per-call rate limit + dedup)

The `llm_calls` D1 table records every LLM call with a `purpose` column so the cadence + cost panels can group by intent. The full set of purposes:

| Purpose         | Caller                           | Frequency                  | Dedup window        |
| --------------- | -------------------------------- | -------------------------- | ------------------- |
| `news_verdict`  | news-cron (chunk 6)              | every 6h, per open position | 4h per ticker       |
| `daily_recap`   | daily-cron (chunk 6)             | 1/day at 06:00 UTC         | 24h                 |
| `leads_cron`    | leads-cron (chunk 11+)           | every 6h                  | 24h (next run supersedes) |
| `llm_test`      | `/api/pm/bot/llm-test`           | manual (operator)          | none                |
| `smoke_test`    | `/api/pm/bot/smoke-test`         | manual (operator) + heartbeat-cron (passive) | none |

- The model retrain does NOT call LLM.
- **Token budget**: at ~$0.10/$0.40 per M tokens (MMX M3, last-verified on M2.7-highspeed pricing — recheck if M3 rates differ), and ~2K input + 1K output per call, the news cron is ~$0.0006/call. 5 open positions × 4 calls/day = $0.012/day ≈ $0.36/month from news alone.
- The daily recap is ~5K input + 2K output = $0.002/call = $0.06/month.
- The leads cron is ~3K input + 1.5K output (M3 think block + JSON) = ~$0.0012/call × 1/day = ~$0.04/month.
- Manual `llm-test` / `smoke-test` calls add to the cost — operator should be aware but the cost is in the $0.001/call range.

### CF Workers (10M requests + 30M CPU-ms included)

- The dashboard polls 14 endpoints on a 5-30s cadence. At one page load + auto-refresh every 5-30s, that's ~3,000-18,000 requests/day.
- At the current usage (~12 requests/24h, way under the 10M/mo limit), we're at ~0% of the monthly included amount.
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

## Order of operations (what runs when)

1. **Worker starts**: serves dashboard + API endpoints.
2. **Dashboard auto-start on page load**: hits `POST /api/pm/bot/auto-start`, which kicks off the polling loop.
3. **Polling loop starts**: 1.5s round-robin REST poll via the kalshi-typescript SDK, scheduled via the DO's `setAlarm` (durable across evictions). Each tick: pick the next ticker, call `getOrderbook(ticker)`, update `state.tickers[ticker].book` + price history, run the strategy.
4. **Every 15 min**: scan cron fires, updates `scans` table.
5. **Every 6 hours**: news cron fires, asks LLM for each open position, posts Telegram on AT RISK / BROKEN.
6. **Every day at 06:00 UTC**: daily cron fires, writes R2 recap, posts Telegram summary.
7. **Every Sunday at 00:00 UTC**: train cron fires, polls R2 for new model artifacts, registers in D1.

## When things go wrong (recovery)

- **Polling not running**: check `last_poll_error` in `/api/pm/bot/status`. The error code + message points to the failure mode (missing_creds, sdk_init_failed, poll_failed, state_load_failed).
- **Cron not firing**: check `/api/pm/cron-runs?limit=10`. If the last run is older than the expected interval, the cron is stuck. CF will retry on the next scheduled tick.
- **Cost spiking**: check `/api/pm/cost` → `cf_monthly` section. If a bar is >80%, you're approaching the limit. If the bar is red (>100%), you're being billed.
- **Bot placing bad trades**: check the kill switch — flip to "Killed" via the trading-mode panel. The engine will refuse all new trades.

## Memory rule: the bot's edge has to exceed the bill

For a personal trading bot on a $9.73 Kalshi account, the bar is:
- CF: $0-2/mo (under free tier)
- MMX: $0.40/mo
- **Total: $0.40-2.40/mo**

The bot has to make at least $0.40-2.40/mo in net PnL after fees, or we have no product. The current caps ($0.25/trade + $1.50/day) mean the bot can lose at most $0.75/day, or ~$22/mo — way more than the bill. If the bot's edge is real, even a 5% win rate at these caps covers the cost 10x over.

## When in doubt

- `GET /api/pm/bot/status` — the bot's current state.
- `GET /api/pm/cost` — usage + projected monthly cost.
- `GET /api/pm/cadence` — every service with last-ran + next-scheduled.
- `GET /api/pm/bot/stage` — single badge: what is the bot doing right now.
- `wrangler tail pm-bot` — live Worker logs.
