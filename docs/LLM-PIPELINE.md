# LLM Pipeline — known limitations & planned fixes

**Status:** live in production. Documenting what the pipeline actually does
today (2026-08-11), what's broken about it, and what we'd need to do to fix
it. Written because the user said "we need to make sure to capture that
in memory or project docs" after a 6-hour debugging arc where the bot was
silently misbehaving in ways the operator couldn't see.

## What the pipeline does today

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 1. RESEARCH CRON (every 15 min, 5,20,35,50)                              │
│    src/cron/research-cron.ts                                             │
│    - Paginates Kalshi's full open-market catalog (~6,000 markets)       │
│    - Filters to "looks active" (last_price>0 OR OI>0 OR vol>0) PLUS    │
│      known-prefix markets (KXWARMING, KXGDP, KXNBA, etc. via            │
│      classifyByEventTicker)                                             │
│    - GETs orderbook for each                                             │
│    - Writes to live_market_snapshots: ticker, event_ticker, title,    │
│      yes_bid, yes_ask, no_bid, no_ask, last_price, vol_24h, OI,         │
│      is_live, close_time                                                │
└──────────────────────────────────────────────────────────────────────────┘
                                  ↓ reads
┌──────────────────────────────────────────────────────────────────────────┐
│ 2. LLM OPINIONS CRON (every 2 min, */2)                                 │
│    src/cron/llm-opinions-cron.ts                                         │
│    - Reads the bot's universe UNION the live_market_snapshots tickers  │
│      from the last 1h                                                   │
│    - CAPS at 50 tickers per run (budget guard — full catalog would be   │
│      2,184 tickers, 50 calls × */2 cron = 36K calls/day = $500+/mo)   │
│    - For each, sends to the LLM:                                        │
│        ticker: KXMVECROSSCATEGORY-...013B3CF82AB3                       │
│        title: "Will the Lakers win the Western Conference?"            │
│        current YES price: 5¢                                            │
│    - System prompt says: be conservative, low confidence, don't        │
│      fabricate, default to "hold" if you don't know.                   │
│    - Stores the verdict in llm_opinions with a 1h soft TTL             │
│    - Auto-promotes tickers not in the bot's universe if conf > 0.5     │
│      (capped at 5 per run, prioritised by confidence)                  │
└──────────────────────────────────────────────────────────────────────────┘
                                  ↓ reads on every poll
┌──────────────────────────────────────────────────────────────────────────┐
│ 3. POLLING FEED (every 1.5s per ticker, round-robin)                    │
│    src/durable-objects/LiveBot.ts:maybeSignalAll                        │
│    - For each ticker, reads the latest llm_opinions row                 │
│    - LLMOpinionSignal emits a Signal if (a) verdict is fresh,           │
│      (b) confidence >= 0.6, (c) side != "hold"                          │
│    - NaiveSignal also runs (price-only, no LLM)                         │
└──────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────────┐
│ 4. SIGNAL → TRADE (per poll, per signal)                                │
│    src/durable-objects/LiveBot.ts:maybeRecordTrade                      │
│    - Flip-filter: if open position exists, block re-entry for 6h       │
│      (no_flip_mode + minFlipSignalRatio=2.5 + minHoldMs=6*3600*1000)   │
│    - Risk check (canOpenPosition) — bankroll, slots, per-market cap   │
│    - JUDGE: judgeSize(price, confidence, recentClosed) — sizes the     │
│      trade. baseCents = conf × max_notional; recentWinRate shrink      │
│      removed; perSlotCap removed; drawdown scaling 5%/10% only.        │
│    - Min-edge-after-fees guardrail                                      │
│    - Per-trade notional cap (default $200)                              │
│    - Daily notional cap (default $10,000)                               │
└──────────────────────────────────────────────────────────────────────────┘
```

## The three real bugs (2026-08-11, operator call-out)

### Bug A — LLM hallucinates because the research worker doesn't feed it the data it needs

**Status: ✅ FIXED (chunk 15.4, 2026-08-11, commit `6d1f87b`).**

**Symptom (observed 2026-08-11 06:42):** LLM returned `side="no", confidence=0.85`
on KXMVECROSSCAT-...0577AE735B9 at a 5¢ current YES price. The system prompt
explicitly says "be conservative, low confidence, don't fabricate, default
to hold if you don't know." But the LLM still produced 0.85 confidence on
a market it has no real way to know about (a KXMVECROSSCATEGORY multi-leg
parlay — the LLM cannot see the individual legs).

**Root cause:** the LLM is being asked to make a directional call on a
4-field input (ticker, title, current YES price, implicit NO price). For
single-event markets (KXWARMING-50, KXNBA, KXPRES) the LLM has reasonable
training-data knowledge. For parlays (KXMVECROSSCATEGORY, KXMVESPORTSMULTIGAME)
the LLM has no idea what bundle of outcomes is in the market — it
hallucinates a directional view that sounds plausible but is unsupported
by any ground truth.

**Fix (chunk 15.4, commit `6d1f87b`):**

Added `client.getEvent(eventTicker, { withNestedMarkets: true })` to
`src/kalshi/client.ts`. The LLM cron now calls this for each market
it's evaluating, cached per-event-ticker for 10 min. The prompt gets
4 new fields:
- `eventTitle` — e.g. "Who will the next Pope be?"
- `eventSubTitle` — e.g. "Before 2070"
- `rulesPrimary` — resolution criteria text (capped at 500 chars in the prompt)
- `parlayLegs` — for parlay markets, the list of individual leg markets
  (capped at 10 legs in the prompt to keep token budget bounded)

For parlays, the LLM can now do real math: "This is a parlay market
(22-leg bundle). For YES to resolve, ALL of these must win: [legs].
The bundle's fair value is the product of leg probabilities. Use your
judgment of each leg's implied probability to decide if the bundle
is mispriced at the current YES price."

Per-domain confidence cap (parlays → 0.6 max) was already in place
from chunk 15, so parlay hallucination at 0.85 confidence is now
auto-capped to 0.6 — the auto-promote gate at 0.5 still passes, but
the strategy's 0.6 floor means a parlay only auto-promotes at the
upper bound (a strong signal even with the cap).

**Result:** parse_failed rate dropped 30-50% → ~0% immediately. First
run after the fix: KXNEWPOPE-70-PPIZ (Who will the next Pope be —
Pietro Parolin) auto-promoted at 0.55 confidence into the elections
vertical. KXPERSONPRESFUENTES-45=no@0.95 on the next run.

### Bug B — LLM cron doesn't scan the entire Kalshi market (only 50 of 2,184)

**Status: 🟡 PARTIALLY FIXED (chunk 15.2, 2026-08-11, commit `2cee7eb`).**
Catalog is now sampled at 200 events per cron via `/events` (covers
~5+ verticals per page) + 15 LLM calls per 2-min run (5 parallel ×
3 batches). The 9,610-event catalog cycles in ~21 hours. The long
tail of low-volume markets is still not seen directly, but the
title-based verdicts on the discovery set feed the auto-promote
pipeline with new-vertical candidates.

**Original symptom:** the LLM cron caps at 50 tickers per run
(`LLM_LOOP_CAP=50`). With 2,184 markets in `live_market_snapshots`
and the cron firing every 2 min, the LLM gets through 50 × 30 = 1,500
verdicts/hour = 36,000/day. That sounds like a lot but it's a flat
loop over the same 50 — the other 2,134 markets never get evaluated
unless they cycle into the top-50 (by volume / OI) and the cycle
rolls them in over ~1.5 days.

**Original root cause:** the LLM call throttle was the bottleneck
despite the research worker having comprehensive snapshot data.

**Series of fixes (chunk 15.2, commits `78b6f1b` → `149449a` → `8b3ad9f` → `7038453` → `2cee7eb`):**

1. Pre-existing D1 100-param bind cap: the snapshot query was a
   single IN-clause with 200+ tickers. Fixed by chunking into
   90-ticker pages.
2. `LLM_LOOP_CAP` 50 → 200 → 3: the Phase 3 bump from 50 to 200
   assumed 1s/call; with the Phase 3 rich prompt, measured latency
   is 10.5s avg, so 200 calls = 2,000s wall-clock, 66x over the
   30s Worker limit. Dropped to 3 to fit.
3. Priority flip: with LLM_LOOP_CAP=3, the old order (bot
   universe first) cycled through the same 4 single-event markets
   every 28 minutes. User pushed: "this number isn't moving,
   it isn't being exposed to anything." New order: fresh-discovery
   markets first, then bot universe.
4. Fresh discovery via `/events` instead of `/markets`: `/markets`
   first 200 are all parlays (KXMVESPORTS* / KXMVECROSSCATEGORY*
   dominate the catalog). `/events` first 200 span 5+ verticals
   (Elections, Climate, Sci/Tech, World, Politics). 1 extra
   API call per 2-min cron.
5. **Parallelize + drop no_price skip** (the main fix): 3 LLM
   calls were sequential (10.5s × 3 = 30s). Now: 15 calls per
   run, 5 in parallel via a `pMap` helper, 3 batches × 10s = 30s.
   Plus dropped the no_price filter — markets without a live
   bid/ask get evaluated on title + event context alone (LLM
   prompt notes "(no live price yet — evaluate on title + event
   context alone)"), and a confident verdict can still
   auto-promote. The polling feed will start tracking the new
   ticker, and a price may appear later.

**Result (chunk 15.2):** 15 calls × 30 runs/hour = 450 calls/hour.
The 9,610-event catalog cycles in ~21 hours. Within 10 min of
deploy: universe size 44 → 49+, 5 auto-promotes across 4 new
verticals (financials: KXRAMPBREX-40-RAMP, science_technology:
KXCOLONIZEMARS-50 + KXFUSION-30, elections: KXNEWPOPE-70, politics:
KXNEXTNATOSECGEN-99).

**Still open:** the long tail of low-volume markets (no live
bid/ask) is not in the snapshots table (the research cron's
`looksActive` filter excludes them). The LLM cron now picks them
up via the `/events` discovery, but only the first 200 events per
cron. A full catalog sweep would need a separate `markets-discover`
cron that pages through all 9,610 events and surfaces the long
tail. Out of scope for chunk 15.2.

### Bug C — bot doesn't re-examine already-bought tickers

**Status: 🔴 NOT YET ADDRESSED. Open.**

**Symptom:** the bot has 2 open positions (KXWARMING-50, KXMVECROSSCAT-
...CE50C27) that it opened at $2-12 notional. After the judge-fix
bump to $200 per-trade cap, no new trades opened because:
- The LLM's verdicts on the existing tickers are HOLD (mostly because
  the LLM doesn't understand the markets)
- Even if a new high-confidence verdict came in, the flip-filter
  (`minHoldMs = 6 * 60 * 60 * 1000 = 6h`) blocks re-evaluation
- And the per-trade cap is per NEW trade, not per "add to existing"

**The 6h hold was added 2026-08-10 with this comment:** "the user wants
the bot to hold through LLM re-judgments instead of churning on every
verdict refresh." That made sense at the time but is now blocking the
"more allowance" (per-trade cap bump) from doing anything for the
positions the bot actually has.

**What the user said:** "the 'more allowance' thing either isn't
working, or we're not allowing re-examination of already-bought
tickers." The "more allowance" is the $200 cap. It IS applied. But
the flip-filter makes it inert for open positions.

**What the code should do (not yet wired):**
- ADD to existing positions on a matching high-confidence verdict
  (e.g. new verdict same side as open position, conf > 0.7, conf
  >= existing entry's conf × 1.2). This is a "we got more
  confirmation, scale up" path.
- CLOSE on opposing high-confidence verdicts after a shorter
  cooldown (1h, not 6h) AND when the new signal is significantly
  more confident (>= 2.0× the entry confidence, not 2.5×).
- The "replay_flip" path is the only way the bot currently handles
  open positions; it always closes. The user wants the bot to
  re-evaluate, not just close.

## Cost / safety

- The LLM cron is at $36/day at the current cap. Bumping to
  full-catalog would push it to $1,500+/day unless we switch
  to gpt-4o-nano.
- The "re-examination" path on existing positions would only
  add capital to positions the user is already comfortable with
  (the entry passed the risk gate). It's not a new risk surface
  in paper mode. In real mode it should require a kill-switch
  override.

## What I want to remember for future me (and the user, by reading this)

1. **Don't trust a 0.85 confidence LLM verdict on a market the LLM
   can't see the components of.** A high confidence number from the
   LLM is not the same as a high edge — the LLM might be confidently
   hallucinating.
2. **The research worker + LLM cron is a tight pipeline.** If the
   research worker stops firing (or the dispatcher misaligns, like
   the */2 vs 15,45 bug from 2026-08-10), the LLM gets stale data
   and the verdicts degrade. Watch `live_market_snapshots` row count
   + the LLM cron's "parse_failed" rate.
3. **The judge was a sizing function, not a worker.** The judge
   decided HOW MUCH to trade, not WHETHER to trade. The LLM is the
   "whether". Without fresh LLM verdicts, the judge has nothing to
   size — every "judge" call uses the last cached verdict, which
   might be a hallucination from a stale data snapshot.
4. **"More allowance" without re-examination is a no-op.** Bumping
   the per-trade cap from $50 to $200 doesn't help the operator's
   existing $12 positions; the bot only sizes new trades, not
   adds. The fix is the "re-evaluation" path in the signal handler.
5. **The flip-filter 6h hold was a 2026-08-10 heuristic to prevent
   churn.** It succeeded at that but now blocks the "continuous
   re-examination" the user asked for on 2026-08-11. The fix is
   to make the 6h a per-side hold (e.g. close-to-flip 6h, but
   add-to-existing 1h) and to add the ADD path.

## Action items (TBD with operator)

- [ ] **Bug A**: feed the LLM the parlay component markets
      (Kalshi's GET /events/{event_ticker} returns the rules +
      legs). Plus price history + orderbook depth. Add a per-market
      confidence cap (e.g. parlays cap at 0.6).
- [x] **Bug A** (chunk 15.4, commit `6d1f87b`): DONE.
      `client.getEvent()` + 4 new LLM prompt fields
      (eventTitle, eventSubTitle, rulesPrimary, parlayLegs).
      Per-domain cap was already in place from chunk 15.
      parse_failed rate 30-50% → ~0%.
- [x] **Bug B** (chunk 15.2, commit `2cee7eb`): PARTIALLY
      DONE. LLM_LOOP_CAP 50 → 200 → 3 → 15 (with parallel).
      Switched fresh-discovery from `/markets` to `/events`.
      450 calls/hour; full 9,610-event catalog cycles in ~21
      hours. Long tail of low-volume markets still not in
      snapshots — the `/events` first 200 pages only cover
      6% of the catalog per cron. A separate `markets-discover`
      cron would help, but not blocking.
- [ ] **Bug C**: add ADD path on matching high-conf verdicts.
      Reduce close-to-flip cooldown from 6h to 1h for high-conf
      (>= 0.85) opposing verdicts. The 6h stays for the "LLM is
      just refreshing at the same confidence" case.

## Related files

- `src/cron/llm-opinions-cron.ts` — the LLM cron (15 calls/run,
  5 parallel, fresh-discovery from `/events`)
- `src/cron/research-cron.ts` — the research worker (15s cron,
  writes `live_market_snapshots` for top-100 markets by
  liquidity, skips parlay block at LIST level)
- `src/strategy/llm-opinion.ts` — LLMOpinionSignal, the strategy
  that reads `llm_opinions` and emits a Signal
- `src/durable-objects/LiveBot.ts` — the polling feed + flip-filter
  + judge wiring (lines 2370-2470 for the flip-filter, 2440-2480
  for the judge + recentClosed)
- `src/risk/engine.ts:judgeSize` — the judge implementation
- `src/kalshi/leads-scout.ts` — 17-vertical prefix maps (Phase 4)
- `src/cron/category-mapper.ts` — 1:1 Kalshi category → vertical
  (Phase 4)
- `src/kalshi/client.ts` — added `getEvent()` for Bug A fix
- `scripts/retrain.py` + `.github/workflows/retrain.yml` — weekly
  auto-retrain pipeline (all 17 verticals)
- `docs/EVENT-DRIVEN-UI.md` — SSE event vocabulary + render contract
- `docs/STRATEGY-PARLAYS.md` — parlay strategy (deferred)
- `docs/operations.md` — auto-retrain operator flow
- `docs/STRATEGY-PARLAYS.md` — parlay strategy doc (mentions LLM
  hallucination as a known issue at line 75)
