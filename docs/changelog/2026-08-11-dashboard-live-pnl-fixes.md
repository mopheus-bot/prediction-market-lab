# Dashboard live-data and PnL fix (2026-08-11)

Post-Phase-4 bug-fix push. Four commits, no behavior changes
beyond making the dashboard reflect the actual real-time state
of the system.

| # | Commit    | What                                                              |
|---|-----------|-------------------------------------------------------------------|
| 1 | `a85d8ba` | Drop `max-age=30` cache on live data APIs; cap research-cron total GETs at MAX_GETS with universe priority |
| 2 | `fc7a312` | Polish — extract `sortAndCapSnapshots`, tighten comments, add tests |
| 3 | `688bcb3` | `handleSummary` legacy alias fix (intermediate; superseded by 0557905) |
| 4 | `0557905` | `handleSummary` — drop R2 read, always use live rolling-24h aggregate |

## User-reported symptoms

1. **Dashboard numbers not live.** Stage panel + leads updated
   every 5s, but bankroll, per-vertical PnL, and the schedule
   grid were frozen.
2. **Research cron hitting 37s** (over the 30s Worker limit;
   CF was letting it complete, but it was fragile). Universe
   had grown to 53 tickers.
3. **"24h PnL" hero KPI stuck at $1.35** all day, even though
   the rolling-24h value from D1 was different. (Caught by
   the user, not the model — "wait why do we overwrite the
   file daily?")

## Root causes

### 1. Dashboard not live — `Cache-Control: public, max-age=30` on three endpoints

The `bot/balance`, `verticals`, and `cadence` endpoints set
`Cache-Control: public, max-age=30`. The dashboard polls every
5s, but the browser + CF edge both honored the 30s cache and
served the same response back, so the JS was calling fetch
every 5s but the data was stale.

**Fix:** change those three endpoints to `no-store` (real-time
data — bankroll changes on every fill, schedule changes every
cron run, per-vertical PnL changes on every close). The
`cf-analytics` and `cost` endpoints stay at `max-age=60` (1m-delayed
CF metrics; 60s is fine for the Dev page).

**Files:** `src/api/balance.ts`, `src/api/verticals.ts`,
`src/api/cadence.ts`. Three one-line header changes, each
with a 3-line comment.

### 2. Research cron 37s — universe overran the cap

The research-cron was doing the LIST pass, then capping at
`MAX_GETS=100`, then the 3b universe pass was adding the bot's
universe ON TOP of that. Universe=53, total GETs=153, 5 req/s
× 200ms = 30s for GETs + 6s LIST = 37s wall-clock. Over the
30s Worker limit.

**Fix:** move the universe pass to BEFORE the cap, then sort
(universe first, then LIST by liquidity) and cap the TOTAL
at `MAX_GETS=100`. Universe is always prioritized — the bot
is actively trading on those, a missing snapshot is a
correctness bug, not just a freshness issue.

After fix: 100 GETs max regardless of universe size, wall-clock
~22s. Universe can grow without breaking the limit.

**Files:** `src/cron/research-cron.ts`. Restructured the
3b pass + the sort+cap into an exported pure function
`sortAndCapSnapshots(markets, cap)` so it's testable without
a mock KalshiClient.

**Polished in `fc7a312`:** extracted `liquidityScore()`
helper (matches the leads-scout heuristic; OI is weighted
5x because it represents a tradeable book while volume_24h
can be skewed by a single large print). Added a real ticker
tiebreaker to the sort comparator (the previous comparator
claimed a "stable secondary key is ticker" but actually only
sorted by liquidity, so equal-liquidity entries were
non-deterministic). Added 6 tests.

### 3. "24h PnL" stuck at $1.35 — R2 daily-overwrite (root cause: `daily-cron`)

The `daily-cron` runs at 06:00 UTC every day and writes
`daily-recap/YYYY-MM-DD.json` to R2. `handleSummary` was
reading that file first and falling back to a live aggregate
only when the file was missing. The R2 file's window is
06:00-to-06:00 (anchored), but the dashboard's label is "24h
PnL" (rolling). So the dashboard showed the 06:00 snapshot
for the next 24h until the next daily run.

**Fix:** `handleSummary` now always uses the live rolling-24h
aggregate from D1. The R2 file remains a pure archive
(`daily-cron` still writes it; useful as a historical record
and for the telegram content; `readDailyRecap` is still
exported for any future historical caller). The summary
endpoint just doesn't drive the live dashboard off it anymore.

**Why the legacy-aliases commit (`688bcb3`) is intermediate,
not the final fix:** the R2 recap uses
`{trades: {n_total, realized_pnl_cents}}` while the dashboard
reads `n_trades_24h` / `last_24h_cents` / `realized_cents`.
`688bcb3` added the aliases so the dashboard could read the
R2 shape. But that was papering over the real problem (the
R2 file shouldn't have been the source of truth for the live
dashboard). `0557905` drops the R2 read entirely; the live
aggregate has the right shape natively and the aliases are
still in place as belt-and-suspenders.

**Files:** `src/api/status.ts`. Removed the `readDailyRecap`
read branch (kept the live aggregate path only). The
`readDailyRecap` helper remains exported from
`src/api/daily-recap.ts` for any future historical caller.

## Test changes

- `test/research-cron.test.ts` — 6 new tests for
  `sortAndCapSnapshots` (universe-first ordering,
  liquidity-desc, ticker tiebreak, mixed-cap-with-universe-
  larger-than-cap-fit, no-mutation, no-op-under-cap).
- `test/api-status.test.ts` — replaced the "R2 recap" tests
  (now dead code in the endpoint) with a "always uses the
  live rolling-24h aggregate, never R2" test.

Test count: 369 → 377 → 376. tsc clean.

## Verified in production (post-deploy)

```
GET /api/pm/bot/balance     → cache-control: no-store
GET /api/pm/verticals       → cache-control: no-store
GET /api/pm/cadence         → cache-control: no-store
GET /api/pm/summary         → source: live
                            → n_trades_24h: 11
                            → last_24h_cents: 95    (was 135, frozen at 06:00 UTC)
```

Research cron manual trigger: 17,832ms (was 37,328ms). Universe
always prioritized, total bounded at 100.

## Side effects / collateral

- `.gitignore` — added `daily-recap/`. `wrangler r2 object get`
  writes the downloaded object to `./<key>` by default, so
  investigating the R2 file left a stray empty
  `daily-recap/latest.json` that got auto-committed. Cleaned
  up + added the dir to.gitignore.
- Removed `import { readDailyRecap } from "./daily-recap.js"`
  from `src/api/status.ts` (no longer used in that file).

## What was NOT done (deferred)

- **Update `verticals` endpoint** to also return the per-vertical
  `n_open` lifetime (the live aggregate's per-vertical has
  `n_open` but the verticals API's per-vertical doesn't). Not
  blocking — the per-vertical display works from the
  verticals API directly.
- **STRATEGY-PARLAYS Phase 2 / LLM-PIPELINE Bug C** — same as
  the Phase 4 changelog. Still deferred.
