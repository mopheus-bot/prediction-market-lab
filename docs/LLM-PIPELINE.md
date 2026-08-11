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

**What the research worker SHOULD feed the LLM (not yet wired):**
- The full `event_ticker` rules_url (Kalshi's resolution rules text)
- The component markets of a parlay (the individual YES legs)
- Price history (last 1h, last 24h) so the LLM can see trend
- Orderbook depth (is the 5¢ price a real two-sided quote or a stale
  pull?)
- Volume profile (vol_24h distribution across the day)
- A confidence cap that's lower for parlays (e.g. max 0.6 for
  KXMVECROSSCATEGORY/* and KXMVESPORTSMULTIGAME/* since the LLM can't
  reason about them)

**What the user said:** "the research worker needs to feed the llm data.
llm hallucinates."

### Bug B — LLM cron doesn't scan the entire Kalshi market (only 50 of 2,184)

**Symptom:** the LLM cron caps at 50 tickers per run (`LLM_LOOP_CAP=50`).
With 2,184 markets in `live_market_snapshots` and the cron firing every
2 min, the LLM gets through 50 × 30 = 1,500 verdicts/hour = 36,000/day.
That sounds like a lot but it's a flat loop over the same 50 — the other
2,134 markets never get evaluated unless they cycle into the top-50
(by volume / OI) and the cycle rolls them in over ~1.5 days.

**What the research worker DOES:** scans the entire 6,000-market catalog
every 15 min and writes `live_market_snapshots` for everything. So the
DATA is comprehensive; it's the LLM call that's throttled.

**What the user said:** "we should have updated it to scan the entire
kalshi market." The research worker is fine. The LLM cron is the
bottleneck.

**Constraint:** every LLM call costs ~$0.001 (1K input + 500 output
tokens at GPT-4o-mini rates). 50 calls per 2 min = $0.05/min = $36/day
= $1,080/mo. The cap is there to stay under the $50/mo LLM budget.
To scan all 2,184 markets every 2 min, either (a) bump the budget to
~$4,000/mo, (b) use a cheaper model (e.g. gpt-4o-nano at $0.025/1M input),
or (c) cycle through them in waves (50/run × 2 min = ~1.5 days to cover
the full set; auto-promote handles the long tail).

**The current auto-promote pipeline is the (c) solution but it has
holes:** the cap is 50, the auto-promote gate is conf > 0.5, and a
parlay-market LLM hallucination easily clears 0.5 (as the 0.85 verdict
above demonstrates). So the long tail of "real" markets with 0.5-0.6
LLM confidence is being auto-promoted by hallucinated verdicts.

### Bug C — bot doesn't re-examine already-bought tickers

**Symptom:** the bot has 2 open positions (KXWARMING-50, KXMVECROSSCAT-
...CE50C27) that it opened at $2-12 notional. After my judge-fix
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
- [ ] **Bug B**: bump the LLM_LOOP_CAP from 50 to 200 and add a
      priority queue (tickers with no fresh verdict first), OR
      switch to a cheaper model, OR run a backfill cron overnight.
      Need operator decision on cost tradeoff.
- [ ] **Bug C**: add ADD path on matching high-conf verdicts.
      Reduce close-to-flip cooldown from 6h to 1h for high-conf
      (>= 0.85) opposing verdicts. The 6h stays for the "LLM is
      just refreshing at the same confidence" case.

## Related files

- `src/cron/llm-opinions-cron.ts` — the LLM cron (caller of the
  LLM, cap at 50)
- `src/cron/research-cron.ts` — the research worker (writer of
  `live_market_snapshots`, the LLM's only data source)
- `src/strategy/llm-opinion.ts` — LLMOpinionSignal, the strategy
  that reads `llm_opinions` and emits a Signal
- `src/durable-objects/LiveBot.ts` — the polling feed + flip-filter
  + judge wiring (lines 2370-2470 for the flip-filter, 2440-2480
  for the judge + recentClosed)
- `src/risk/engine.ts:judgeSize` — the judge implementation
- `docs/EVENT-DRIVEN-UI.md` — SSE event vocabulary + render contract
- `docs/STRATEGY-PARLAYS.md` — parlay strategy doc (mentions LLM
  hallucination as a known issue at line 75)
