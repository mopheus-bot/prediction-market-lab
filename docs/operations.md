# prediction-market-lab — operations runbook

This is the rules-of-engagement for everything prediction-market-lab does
in production. Read this before changing cron intervals, the
LLM call pattern, or the data feed strategy.

## What landed 2026-08-11 (Phase 4 — 17-vertical expansion)

The bot went from 4 hardcoded verticals to all 17 Kalshi
categories in one day. The relevant commits:

- **steps 15 + 15.1** — `Vertical` enum 4 → 17; prefix maps +
  title-keyword fallbacks for 13 new categories; `category-mapper`
  1:1 Kalshi category → vertical; strategy router profiles for
  all 17 (default `naive + LLM`); `AUTO_PROMOTE_VERTICALS` = all
  17; leads-cron + LiveBot auto-promote whitelist updated.
  Research-cron scope fix: skips KXMVESPORTS* /
  KXMVECROSSCATEGORY* at the LIST level + caps GETs to top 100
  by volume + bumps throttle 2 → 5 req/s. 30s wall-clock (was
  5+ min timeout).
- **** — LLM cron parallelized + cap bumped 3 → 15
  (5 in parallel via pMap × 3 batches). Dropped the no_price
  filter (LLM now evaluates title + event context alone for
  markets without live bid/ask). Fresh-discovery switched from
  `/markets` (200 parlays) to `/events` (200 events spanning
  5+ verticals).
- **** — Auto-retrain pipeline wired: GitHub Action
  weekly (Saturday 22:00 UTC) + `scripts/retrain.py` orchestrator
  + Python trainer `VALID_VERTICALS` 4 → 17 + Python
  `category_mapper` 13 → 43 entries. Sunday train-cron
  auto-registers; operator promotes via Dev page.
- ** (LLM-PIPELINE Bug A)** — `client.getEvent()`
  added; LLM prompt now includes `eventTitle`, `eventSubTitle`,
  `rulesPrimary`, `parlayLegs` (capped at 10 legs). Per-domain
  confidence cap on parlays (0.6 max) was already in place from
. parse_failed rate 30-50% → ~0%.

**Observed result (within 10 min of the parallelize+drop-no_price
deploy):**
- Universe size: 44 → 49+ in 10 minutes
- 5 new auto-promotes across 4 new verticals: KXELONMARS-99
  (world, 0.75), KXNEWPOPE-70-PPIZ (elections, 0.55),
  KXRAMPBREX-40-RAMP (financials, 0.55), KXCOLONIZEMARS-50
  (science_technology, 0.72), KXFUSION-30 (science_technology, 0.65)
- LLM call rate: 90/hour → 450/hour (5x)
- The 9,610-event catalog now cycles through the LLM in ~21 hours

**Open / not done:**
- **LLM-PIPELINE Bug C** (bot doesn't re-examine already-bought
  tickers; 6h flip-filter blocks re-evaluation). Not blocking —
  the bot has 2 open positions and the per-vertical auto-promote
  is feeding the universe. Worth scheduling after data
  accumulates.
- **parse_failed rate on noPrice markets is 15%** (up from 0% on
  priced markets). The LLM is more confused on title-only
  verdicts. Tightening the prompt is a 1-line fix; deferred
  until the universe stabilizes.
- **STRATEGY-PARLAYS Phase 2** (leg-probability model) is still
  deferred. The per-domain confidence cap is the interim.

## What landed later 2026-08-11 (dashboard live-data + PnL fix)

Same day, after Phase 4. Four commits that fixed the dashboard
showing stale data and the "24h PnL" being stuck. **Full
changelog:** [`docs/changelog/2026-08-11-dashboard-live-pnl-fixes.md`](./changelog/2026-08-11-dashboard-live-pnl-fixes.md).

**TL;DR:**

- **Dashboard not live** — `Cache-Control: public, max-age=30`
  on `/api/pm/bot/balance`, `/api/pm/verticals`, `/api/pm/cadence`
  was being honored by browser + CF edge, so the 5s dashboard
  poll was getting cached responses. Switched to `no-store`
  on all three. `cf-analytics` / `cost` stay at `max-age=60`.

- **Research cron 37s** — universe grew to 53 tickers and the
  3b universe pass was adding them on top of the `MAX_GETS=100`
  LIST cap, so total GETs=153. Restructured: universe pass
  BEFORE the cap, sort (universe first, then LIST by
  liquidity), cap total at 100. Extracted to a pure function
  `sortAndCapSnapshots(markets, cap)` and added a real ticker
  tiebreaker. Wall-clock now bounded at ~22s regardless of
  universe size.

- **"24h PnL" stuck at $1.35 all day** — `handleSummary` was
  reading the R2 daily-recap as the source of truth. The R2
  file is overwritten at 06:00 UTC every day with the
  06:00-to-06:00 window, so the dashboard's "24h PnL" was
  frozen at the previous daily run's value for 24h. **Fix:**
  `handleSummary` now always uses the live rolling-24h
  aggregate from D1. The R2 file is kept as a pure archive
  (daily-cron still writes it; `readDailyRecap` stays exported
  for any historical caller).

**Lesson (worth remembering for future API design):** if a
data source is overwritten on a schedule, that's the
effective freshness — even if the response shape suggests
"live". The dashboard label said "24h PnL" (rolling), so the
data source has to be rolling too. Reading an anchored daily
snapshot for a rolling KPI is the kind of bug that's invisible
until you compare the actual rolling value against the
displayed value.

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
*/15 * * * *  → scan         (every 15 min, 0/15/30/45)
5,20,35,50 * * * *  → research   (every 15 min, offset 5 min from scan)
0 */6 * * *   → news         (every 6 hours, 00/06/12/18 UTC)
30 */6 * * *  → leads        (every 6 hours +30min, 00:30/06:30/12:30/18:30 UTC; 2026-08-09 tightened from daily 02:00 UTC)
*/2 * * * *   → llm_opinions (every 2 min — LLM verdicts + auto-promote)
30 5 * * *    → auto_pilot   (daily 05:30 UTC, default off)
0 6 * * *     → daily        (daily 06:00 UTC)
0 7 * * *     → heartbeat    (daily 07:00 UTC)
0 0 * * SUN   → train        (Sunday 00:00 UTC; registers new R2 artifacts from weekly GitHub Action)
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
| `news_verdict`  | news-cron              | every 6h, per open position | 4h per ticker       |
| `daily_recap`   | daily-cron             | 1/day at 06:00 UTC         | 24h                 |
| `leads_cron`    | leads-cron           | every 6h                  | 24h (next run supersedes) |
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
- `wrangler tail prediction-market-lab` — live Worker logs.

---

## Auto-retrain pipeline (2026-08-11, weekly)

**What it does:** every Saturday 22:00 UTC, the GitHub Action
`.github/workflows/retrain.yml` runs `scripts/retrain.py` to:

1. Pull the bot's current ticker universe from D1 (via wrangler).
2. Fetch the last 7 days of Kalshi public trades for each ticker
   (paginated `GET /markets/trades`).
3. Write per-ticker JSONL files in the format the Python trainer
   expects.
4. Run the live reversion trainer (Prediction Market Lab's
   `scripts/live/train_reversion.py`) once per ALL 17
   Kalshi verticals (weather / economic / politics /
   sports / elections / financials / entertainment /
   science_technology / crypto / companies /
   commodities / mentions / social / world / health /
   transportation / uncategorized). Walk-forward
   validation (3 folds, 20-sample embargo). The 4
   legacy verticals have actual trade data; the 13
   new verticals will produce models as the bot
   accumulates trades in them.
5. Convert each `.joblib` to the JSON tree format the TS port
   consumes via `scripts/convert-models-to-json.py`.
6. Upload each `<vertical>-v2.json` to R2 at
   `prediction-market-lab/models/reversion-<vertical>-v2.json` via
   `wrangler r2 object put`.

The Sunday 00:00 UTC `train-cron` (`src/cron/train-cron.ts`)
then auto-registers the new R2 artifact in the D1 `models`
table with `status=candidate`. **Operator promotes** via
the Dev page (`/pm/models` → click Promote on the new
version) or via `POST /api/pm/models/:version/promote`.

**Operator flow after the Saturday run:**

1. **Wait for Sunday 00:30 UTC** (when the train-cron has
   finished) — the cadence panel shows the cron run.
2. **Open `/pm/models`** — the new `v2` row appears for
   each vertical the trainer produced output for. The
   model card shows: train accuracy, test accuracy, top
   feature importances, walk-forward metrics.
3. **Compare to v1** — if v2's walk-forward test accuracy
   is better than v1's, click Promote. If worse, leave
   v1 active. (Promotion is a D1 update; the next
   LiveBot poll picks up the new model_version.)
4. **The Sunday night polling** uses the new model. The
   model's first real-money trades are paper by default.

**When auto-retrain returns 0 samples (current state):**

The paper bot only has ~18 public trades on KXWARMING-50
(the only single-event market with real activity in the
last 7 days). The reversion trainer needs `lookback +
future_window` samples (30 + 20 = 50 minimum) to produce
a model. The script handles this gracefully:
- Logs `RuntimeError: Live training produced 0 samples`
  for the affected vertical.
- Skips that vertical (no `.joblib` produced, no
  upload).
- Continues with the other verticals.
- Exits 0 if any vertical succeeded, 2 if all failed.

**Expected behavior over time:** as the bot accumulates
real trades (paper or real), the trainer will start
producing models. Estimate: 200+ trades per vertical
needed for a useful model. At 10 trades/day across
all verticals (current pace), that's ~3 weeks per
vertical. **The pipeline is wired but currently
idle on the data side** — same as before, just
without the manual trainer invocation step.

**Manual trigger:** `gh workflow run retrain.yml` (or the
Actions tab → "Run workflow"). Useful for ad-hoc
retraining when trade data spikes (e.g. after a
sharp regime change) or when you change the trainer
hyperparameters and want to test them on fresh data.

**Required GitHub secrets:**

- `CLOUDFLARE_API_TOKEN` — scoped to D1 read + R2
  write on the prediction-market-lab account. **Do not reuse the
  deploy token** (broader scope than this needs).
- `CLOUDFLARE_ACCOUNT_ID` — the prediction-market-lab account ID
  (`8c995c329fee2ee6ab33d9d3d6a30e55`).
- `GH_PAT` — Personal Access Token with `repo` scope
  on `` (the action checks
  out the Prediction Market Lab repo as a sibling to run the
  Python trainer).

**Cost:** ~280 Kalshi API calls (7 pages × 40 tickers)
+ 4 trainer runs (~5s each, 20s total) + 4 R2 uploads
+ 5 min wall-clock on a GitHub-hosted runner. Well
under the free tier.
