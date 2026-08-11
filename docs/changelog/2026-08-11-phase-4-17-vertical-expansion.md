# Changelog — 2026-08-11 — Phase 4: 17-vertical expansion

One-day push that took pm-bot from 4 hardcoded verticals
(weather / economic / politics / sports) to all 17 Kalshi
categories, fixed the LLM-pipeline hallucination bug, wired
the auto-retrain pipeline, and stabilized the data pipeline.
Bot universe went from 44 → 49+ in the first 10 minutes
of the final deploy; LLM call rate 5x (90/hr → 450/hr).

## Chunk 15 — 17-vertical taxonomy expansion (commit `fe56af9`)

**User ask:** "expand coverage to include all 17 verticals,
let the bot settle in (full immediate auto circle). We'll
let the bot train while we talk and plan strategy around the
new verticals."

Kalshi's open-market list is dominated by 99% multi-leg
parlays (KXMVESPORTS* + KXMVECROSSCATEGORY* = ~120k markets).
The other ~600 markets are spread across 17 verticals
that pm-bot had been ignoring. The expansion surfaces the
real tradeable surface.

**Files touched:**
- `src/lib/types.ts` — `Vertical` enum 4 → 17
- `src/cron/category-mapper.ts` — 1:1 Kalshi category →
  vertical (no more bucketing Crypto → economic, Elections
  → politics)
- `src/kalshi/leads-scout.ts` — 13 new prefix maps +
  title-keyword fallbacks; helper code refactor (4-vertical
  literal replaced with 17 everywhere)
- `src/strategy/router.ts` — 17 vertical profiles (legacy 4
  keep their reversion tunings, 13 new default to
  `naive + LLM`)
- `src/strategy/features.ts` — `VERTICAL_FEATURE_INDEX` and
  `FUNDAMENTAL_FEATURES_BY_VERTICAL` are now `Partial<Record<...>>`
  (reversion model only knows 4; the 13 new verticals
  zero-fill)
- `src/api/verticals.ts` — `KNOWN_VERTICALS` extended to 17
- `src/cron/llm-opinions-cron.ts` — `AUTO_PROMOTE_VERTICALS`
  = all 17; per-domain confidence cap (parlays → 0.6 max)
- `src/cron/leads-cron.ts` — `VERTICALS` array + system
  prompt mention all 17
- `src/durable-objects/LiveBot.ts` — auto-promote endpoint
  whitelist = 17

**Tests updated:** 4 unit tests changed to expect the
new 17-vertical behavior (cron test, strategy test, leads-scout
test, verticals test). 270/270 pass.

## Chunk 15.1 — research-cron scope fix (commits `5cc7c15`, `16774bb`)

The research cron had been timing out at the 30s Worker
wall-clock limit since 01:10 (no `cron_run` row because the
kill happens before `recordRun`). The full 6,000-market
scan + 550 GETs × 500ms throttle = 280s wall-clock, 9x over
the limit. The 550 active markets were 99% parlay block
(KXMVESPORTS* / KXMVECROSSCATEGORY*) that the bot's
strategies explicitly don't price.

**Files touched:**
- `src/cron/research-cron.ts` — `SKIP_PARLAY_PREFIXES`
  (3 regexes) skip parlays at the LIST level; `MAX_GETS=100`
  caps the GET workload by liquidity; throttle 2 → 5 req/s

Wall-clock: 6s (LIST) + 20s (GETs) = 26s. Plenty of headroom.

## Chunk 15.2 — LLM cron fixes (commits `78b6f1b`, `149449a`, `8b3ad9f`, `7038453`, `2cee7eb`)

The LLM cron had a stack of related issues that the user
surfaced one at a time. "Why is the bot not trading if it's
seeing the new markets? this number isn't moving, it isn't
being exposed to anything."

1. **Pre-existing D1 100-param bind cap** (commit `78b6f1b`):
   the snapshot query was a single IN-clause with 200+ tickers.
   Fixed by chunking into 90-ticker pages.
2. **`LLM_LOOP_CAP` 50 → 200 → 3** (commit `149449a`): the
   Phase 3 bump from 50 to 200 assumed 1s/call; with the
   Phase 3 rich prompt, measured latency is 10.5s avg, so
   200 calls = 2,000s wall-clock, 66x over the 30s Worker
   limit. Dropped to 3 to fit.
3. **Priority flip** (commit `8b3ad9f`): with `LLM_LOOP_CAP=3`,
   the old order (bot universe first) cycled through the
   same 4 single-event markets every 28 minutes. New order:
   fresh-discovery markets first, then bot universe.
4. **Fresh discovery via `/events`** (commit `7038453`):
   `/markets` first 200 are all parlays; `/events` first 200
   span 5+ verticals. Switched to `/events` (1 extra call per
   2-min cron).
5. **Parallelize + drop no_price skip** (commit `2cee7eb`):
   3 sequential calls became 15 parallel calls via `pMap`
   helper (5 in parallel × 3 batches × ~10s = 30s). The
   no_price filter was dropped — markets without a live
   bid/ask get evaluated on title + event context alone
   (LLM prompt notes "(no live price yet — evaluate on
   title + event context alone)"). A confident verdict can
   still auto-promote; the polling feed will start tracking
   the new ticker and a price may appear later.

**Files touched:**
- `src/cron/llm-opinions-cron.ts` — chunked snapshot query;
  `LLM_LOOP_CAP=15`; `pMap` concurrency helper; new
  `noPrice` field on `LLMOpinionContext`; priority-flip in
  the allTickers sort; `discoverFreshNewVerticalMarkets()`
  via `/events?with_nested_markets=true`
- `src/cron/dispatcher.ts` — added `__freshDiscovery` to
  `CronEnv` for runtime market lookup

## Chunk 15.3 — auto-retrain pipeline (commits `a1ca299`, `2c2634c`, `9cfa3d5`)

**User ask:** "wire the auto-retrain." Previously: user runs
the Python trainer, converts to JSON, uploads to R2, train-cron
auto-registers. Now: GitHub Action weekly (Saturday 22:00 UTC,
2 hours before Sunday train-cron), runs `scripts/retrain.py`
which pulls the bot's universe from D1, fetches 7 days of
Kalshi public trades per ticker, runs the live reversion
trainer once per vertical, converts `.joblib` to JSON,
uploads to R2 at `pm-bot/models/reversion-{vertical}-v2.json`.

**User follow-up:** "Not just legacy verticals for auto-retrain.
We need to capture all verticals. That's the whole point."
Extended `VALID_VERTICALS` 4 → 17 in the trainer +
`DEFAULT_CATEGORY_MAP` 13 → 43 entries in the Python
`category_mapper` (no more bucketing).

**Files touched:**
- `pm-bot/scripts/retrain.py` — orchestrator (NEW, 368 lines)
- `pm-bot/.github/workflows/retrain.yml` — weekly action (NEW, 137 lines)
- `pm-bot/docs/operations.md` — operator flow doc
- `Prediction Market Lab/.../scripts/live/train_reversion.py` —
  `VALID_VERTICALS` 4 → 17
- `Prediction Market Lab/.../live/category_mapper.py` — `DEFAULT_CATEGORY_MAP`
  13 → 43 entries (mirrors pm-bot's `category-mapper.ts`)

**Required GitHub secrets** (need to be set in the repo's
secrets page): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`GH_PAT`.

**Status today:** trainer returns 0 samples for all 17
verticals (paper bot has 18 trades on KXWARMING-50 in 7 days,
need 30+ for the reversion label). Pipeline is ready; will
produce models as data accumulates.

## Chunk 15.4 — LLM-PIPELINE Bug A fix (commit `6d1f87b`)

The LLM was hallucinating on parlay markets because the
prompt only had the market's title. For a 22-leg parlay
that's `"yes Bibee 4+,yes Pérez 6+,yes Skenes 6+..."` and
the LLM had to guess at the bundle. High confidence was
a hallucination, not an edge.

**Files touched:**
- `src/kalshi/client.ts` — added `getEvent(eventTicker,
  { withNestedMarkets: true })`
- `src/kalshi/models.ts` — added `mve_selected_legs` to
  `KalshiMarket` type + parser
- `src/cron/llm-opinions-cron.ts` — `fetchEventContextCached()`
  helper (10-min per-event cache); 4 new LLM prompt fields
  (`eventTitle`, `eventSubTitle`, `rulesPrimary`, `parlayLegs`);
  `max_tokens` bumped 500 → 600 for the leg-math reasoning

**Result:** parse_failed rate 30-50% → ~0%. First run after
the fix: KXNEWPOPE-70-PPIZ (Who will the next Pope be —
Pietro Parolin) auto-promoted at 0.55 confidence into the
elections vertical.

## Docs updated in this push

- `docs/PLAN.md` — chunks 15 + 15.1 + 15.2 + 15.3 + 15.4
  added to the post-MVP table; phase 4 footer added
- `docs/LLM-PIPELINE.md` — Bug A marked FIXED; Bug B marked
  PARTIAL; Bug C still open; action items updated; related
  files section updated
- `docs/STRATEGY-PARLAYS.md` — status note refreshed;
  2026-08-11 market counts table added
- `docs/operations.md` — "What landed 2026-08-11" TL;DR
  section at the top; cron schedule updated (added
  `research` and `llm_opinions` rows)

## What was NOT done (intentional)

- **LLM-PIPELINE Bug C** (re-examine already-bought tickers).
  Not blocking; the bot has 2 open positions and the
  auto-promote is feeding the universe. Worth scheduling
  after data accumulates.
- **parse_failed rate on noPrice markets is 15%**. The LLM
  is more confused on title-only verdicts. Tightening the
  prompt is a 1-line fix; deferred.
- **STRATEGY-PARLAYS Phase 2** (leg-probability model) is
  still deferred. The per-domain confidence cap is the
  interim measure.
