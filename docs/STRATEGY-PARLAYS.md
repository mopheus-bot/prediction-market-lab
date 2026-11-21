# prediction-market-lab — Strategy Refresh: Parlays, Verticals, and the 8B Model Path

> **Status (2026-08-11):** Phase 1 SHIPPED (steps 15 + 15.1 + 15.2 +
> 15.3 + 15.4). prediction-market-lab now covers all 17 Kalshi verticals (not just
> the 4 legacy). The taxonomy expansion + research-cron scope fix +
> LLM-PIPELINE Bug A + auto-retrain pipeline landed. Phase 2 (parlay
> strategy with leg-probability model) is still deferred — the
> per-domain confidence cap on parlays is the interim measure.
>
> **Kalshi market counts on 2026-08-11 (vs 2026-08-09):**
> The 4-vertical "only 1 tradeable market" problem is solved.
> The 17-vertical catalog has 9,610 open events; the LLM cron
> auto-promotes 5+ per hour into the bot's universe, with 5
> verticals now represented (sports 40 + elections 3 + politics
> 2 + science_technology 2 + world/weather/financials 1 each).
>
> **Decision status (2026-08-11, refreshed):**
> - **Phase 1 (widen verticals + deploy):** ✅ DONE (steps 15
>   + 15.1 + 15.2). User said: "expand coverage to include all
>   17 verticals, let the bot settle in (full immediate auto
>   circle). We'll let the bot train while we talk and plan
>   strategy around the new verticals."
> - **Phase 2 (parlay strategy) ordering is committed: (c) → (b) → (a).**
>   Start with the naive baseline (zero data cost), escalate to the
>   8B model on Cloudflare Workers AI (modest serving cost, free
>   training data from Kalshi history + public sports sources), and
>   only fall back to a paid external API ($200-300/mo) if both
>   prior tiers fail to produce a backtest-positive edge.
> - **Strategy model costs are a separate budget line** from the
>   existing $10/mo infrastructure. Hard cap: $50/mo on strategy
>   spend until backtest + paper-trade P&L proves the model is worth
>   the cost.

---

## 1. The finding (why this doc exists)

On 2026-08-09 we ran a full sweep of Kalshi's open-market list using the
demo credentials. The result completely reframes the bot's strategy work:

**2026-08-09 (pre-expansion):**

| Vertical (intended) | Kalshi markets on 2026-08-09 | Strategy fit |
|---|---|---|
| `weather` (reversion) | **1** — `KXWARMING-50` | ✓ works, low volume |
| `economic` (reversion) | **0** — elections/BLS/Fed all off-cycle | n/a |
| `politics` (naive) | **0** — midterms are 3 months out | n/a |
| `sports` (naive) | **4,065** — but they're multi-game parlays, not single-event | ✗ doesn't fit the naive-near-certainty strategy |
| (uncategorized) `cross_category` | **1,935** — Kalshi's own docs say "not suitable for single-event strategies" | ✗ excluded by design |
| **total** | **~6,000** | the bot has ~1 tradeable market |

**2026-08-11 (post-17-vertical expansion, 9,610 open events):**

| Vertical (prediction-market-lab) | Open events | Auto-promoted tickers in bot universe |
|---|---|---|
| `weather` | 106 | 1 (KXWARMING-50) |
| `economic` | 375 | 0 (thin data) |
| `politics` | 503 | 2 (KXNEXTNATOSECGEN-99, KXPERSONPRESFUENTES-45) |
| `sports` | 4,976 | 40 (mostly KXMVECROSSCATEGORY parlays, no live bid/ask) |
| `elections` | 2,172 | 3 (KXNEWPOPE-70 markets) |
| `financials` | 544 | 1 (KXRAMPBREX-40-RAMP) |
| `entertainment` | 509 | 0 |
| `science_technology` | 137 | 2 (KXCOLONIZEMARS-50, KXFUSION-30) |
| `crypto` | 106 | 0 |
| `companies` | 75 | 0 |
| `commodities` | 44 | 0 |
| `mentions` | 38 | 0 |
| `social` | 9 | 0 |
| `world` | 7 | 1 (KXELONMARS-99) |
| `health` | 6 | 0 |
| `transportation` | 1 | 0 |
| `uncategorized` | 1 | 0 |
| **total** | **9,610** | **49+** (growing) |

The "99% parlays" problem is real but contained — the research cron
skips KXMVESPORTS* and KXMVECROSSCATEGORY* at the LIST level, and the LLM's per-domain confidence cap
(KXMVECROSSCATEGORY/* and KXMVESPORTSMULTIGAME/* cap at 0.6)
prevents parlay hallucination from auto-promoting ( +
15.4). The 13 newly-expanded verticals are where the new
opportunities live.

Key constraint: Kalshi's `/markets` wire format does **not** expose a
`category` field on individual markets. The category is encoded in the
`event_ticker` prefix:
- `KXWARMING*` → weather (1 market)
- `KXMVESPORTSMULTIGAMEEXTENDED*` → multi-game sports parlays (4,065)
- `KXMVECROSSCATEGORY*` → cross-category parlays (1,935)
- Everything else (`KXGDP`, `KXCPI`, `KXFED`, `KXPRES`, `KXSENATE`,
  `KXTARGETPRICE`, etc.) is currently **0** — markets are off-cycle or
  not yet listed

The bot's existing strategies (reversion on weather/economic, naive
near-certainty on politics/sports) were designed for single-event
markets. **The product Kalshi is currently selling is almost entirely
multi-game parlays.** The strategies don't fit the product.

This is a structural product–market-fit issue, not a code bug. The leads
pipeline is correct; the strategies need to be re-grounded in the actual
market landscape.

Memory: see the "Kalshi market data shape" entry in agent memory for
the full data shape and verification trail.

---

## 2. Goals (what "done" looks like)

**Primary goal:** the bot is healthy, observable, and trades profitably
(or at least paper-trades meaningfully) on Kalshi's actual product mix.

**Secondary goals:**
- The leads pipeline surfaces real, vertical-relevant markets when Kalshi
  lists them (not just `KXWARMING-50`)
- The operator gets a clear "what does Kalshi actually have" view
  every cron run, not hallucinated suggestions
- The bot has a path to trading Kalshi's main product (parlays) without
  requiring a giant ML effort upfront

**Non-goals (for now):**
- Profitable live trading — paper only until the strategy is proven
- Real-money wallet — separate from this work
- A "general-purpose" trading bot — this stays a Kalshi paper bot
- Replacing the existing reversion/naive strategies wholesale — they
  still work on `KXWARMING-50`; we're adding to them, not deleting

---

## 3. The plan — four phases, with Phase 1 fully fleshed out

### Phase 1 — Widen the vertical taxonomy + deploy (combine 2 + 3 from the design chat)
**Goal:** the bot knows about every Kalshi market type and surfaces them
correctly, even if the strategy doesn't yet exist for the new verticals.
Deploy with what we have so the operator sees the real landscape and the
cron's auto-drop surface starts cleaning up the fake current universe.

**Why this is the right next step:** the cron + verify + auto-drops
already work. The scout needs to be widened to capture the parlay
markets. With the wider taxonomy, the bot is *observably* aware of what
Kalshi has. New single-event markets will surface naturally as Kalshi
lists them (off-cycle economic, midterms in 3 months, etc.).

### Phase 2 — Parlay strategy (sketch, follow-up)
**Goal:** estimate leg probabilities for sports parlays, compute the
joint probability, find mispriced parlays, paper-trade them.

**This is the strategic bet.** Without a leg-probability model, the
bot has no edge on the 4,065 sports markets that make up 68% of
Kalshi's catalog.

### Phase 3 — 1-leg subset pilot (sketch, optional)
**Goal:** if Phase 2 is too big, find a smaller subset of parlays
(those with one dominant leg) and treat them as single-event
markets with a slight complication.

### Phase 4 — Continuous wait for new single-event markets (always on)
**Goal:** as Kalshi's catalog rotates (new economic releases, new
elections, new single-game sports markets), the leads cron surfaces
them automatically. No code changes needed — the scout already
handles new listings.

---

## 4. Phase 1 — Widen verticals + deploy (STEPS)

### Step 1.1 — Update the vertical taxonomy

**Goal:** the bot's vertical model reflects Kalshi's actual product
mix, not the original single-event taxonomy.

**Scope:**
- Add a new vertical type to the codebase: `parlay` (for the
  KXMVESPORTS* multi-game markets)
- Add `cross_category` as an observation-only category (excluded
  from trading per Kalshi's own docs, but tracked for completeness)
- Refactor the vertical type to allow more categories. Current code
  has a 4-element union: `weather | economic | politics | sports`.
  Need to extend it.

**Approach:**
- Update `src/lib/types.ts` `Vertical` type to:
  ```ts
  export type Vertical =
    | "weather"        // single-event weather (KXWARMING*)
    | "economic"       // single-event economic (KXGDP*, KXCPI*, KXFED*,...)
    | "politics"       // single-event politics (KXPRES*, KXSENATE*,...)
    | "sports"         // single-event sports (hypothetical — currently 0)
    | "parlay"         // multi-game parlays (KXMVESPORTS*)
    | "cross_category" // cross-category parlays (KXMVECROSSCATEGORY* — observation only)
  ```
- Add the same to the leads-scout's `VERTICAL_PREFIXES` map with
  appropriate prefix regexes
- Update the cron + API to know about the new verticals
- Update the LLM prompt to mention the new verticals and the
  observation-only status of `cross_category`

**Files to touch:**
- `src/lib/types.ts` — extend `Vertical` union + `VERTICALS` array
- `src/kalshi/leads-scout.ts` — add prefix regexes for `parlay` and
  `cross_category`; update classification logic
- `src/cron/leads-cron.ts` — update the hardcoded `weather/economic/
  politics/sports` references in the prompt and the vertical-spread
  warning
- `src/api/suggest-leads.ts` — same prompt updates
- `test/leads-scout.test.ts` — add tests for parlay + cross_category
  classification
- `docs/operations.md` — update vertical list

**Tests:**
- New: each vertical prefix matches its category
- New: cross_category is *observed* (in the all_markets list for
  universe-health check) but NOT a candidate for ADD suggestions
- Existing: all 228 unit tests still pass

**Exit criteria:**
- All 6 verticals classified correctly
- The bot's cron logs surface `n_per_vertical: {weather, economic,
  politics, sports, parlay, cross_category}` so the operator can see
  the distribution
- LLM prompt instructs the model that `cross_category` is
  observation-only (don't suggest, don't drop)

**Est. effort:** half a day (most of it is updating the LLM prompt to
handle the new verticals + writing the prefix tests)

---

### Step 1.2 — Wire the per-vertical distribution into cron artifacts

**Goal:** every cron run reports how many open Kalshi markets it saw
in each vertical, surfaced in the cadence / Dev-page artifacts.

**Scope:**
- The cron already has `n_add`, `n_drop`, `n_expired_drops` in
  artifacts. Add `n_per_vertical: { weather: 1, economic: 0,... }`
  so the Dev page can show "Kalshi currently has 1 weather market,
  0 economic, 0 politics, 30 sports (parlay) shown, 30 cross_category
  (obs only)" — the operator can see at a glance.
- Same for the `expired_drops` list — bucket by which vertical the
  expired ticker was originally in (if we know it from the bot's
  `ticker_verticals` config).

**Approach:**
- Add a vertical counter to `fetchAndFilterMarkets` output
- In `runLeadsCron`, populate the artifact with the counter
- Update the Dev page (`public/app/dev.html`) to render the
  per-vertical distribution as a small bar chart or table

**Files to touch:**
- `src/kalshi/leads-scout.ts` — add `markets_per_vertical` to
  `ScoutResult`
- `src/cron/leads-cron.ts` — surface the counter in artifacts
- `src/api/leads.ts` — surface in `last_run` summary for the Dev
  page
- `public/app/dev.html` — render the per-vertical bar
- (no test changes for this step — it's just plumbing)

**Tests:**
- Existing tests should pass without modification (the new artifact
  field is additive)

**Exit criteria:**
- The Dev page shows "Kalshi has X markets in each vertical" as a
  small UI element
- Every cron run logs the per-vertical distribution in its artifacts

**Est. effort:** quarter day (mostly HTML/CSS in the Dev page)

---

### Step 1.3 — Update the LLM prompt to know about the new verticals

**Goal:** the LLM understands `parlay` and `cross_category` and
behaves correctly — suggests real parlays, doesn't suggest
cross_category, knows that `parlay` markets are structurally
different from single-event markets.

**Scope:**
- Update `SYSTEM_PROMPT` in `leads-cron.ts` and `suggest-leads.ts`:
  - Add a section on parlay markets (multi-leg, each leg is a
    condition, joint probability is the product of leg
    probabilities)
  - Add a note that `cross_category` is observation-only — do NOT
    suggest, even if the snapshot shows them
  - The "we should be looking for new things" framing now includes
    "new parlay markets" not just "new single-event markets"
- Update the user-prompt template to include the per-vertical
  distribution explicitly so the LLM knows what's available

**Files to touch:**
- `src/cron/leads-cron.ts` — `SYSTEM_PROMPT` and `buildPromptInner`
- `src/api/suggest-leads.ts` — same

**Tests:**
- No new tests; rely on the dry-run test
  (`test/leads-dry-run.test.ts`) to confirm the prompt still parses
  and the LLM still produces a sensible response

**Exit criteria:**
- Dry-run shows the LLM correctly handling the new verticals
  (e.g. suggesting 0 from cross_category, considering parlays but
  flagging them as "needs a parlay strategy")
- The prompt is roughly the same length (don't blow up the input
  token cost)

**Est. effort:** half day (one focused prompt-engineering session,
verified with the dry-run test)

---

### Step 1.4 — Update the bot's current universe to use one real ticker

**Goal:** the bot trades on `KXWARMING-50` (the one real single-event
market), not on the 4 fictional tickers currently in
`DEFAULT_TICKERS`.

**Scope:**
- Update `wrangler.jsonc` `DEFAULT_TICKERS` to `KXWARMING-50` only
- Update the LiveBot's defaults so the bot starts with a working
  universe
- Document this in the changeset

**Important:** the live bot's current universe is stored in DO
state, not in `DEFAULT_TICKERS`. The DEFAULT_TICKERS only applies on
a fresh `/start` call. The actual current universe is whatever the
LiveBot DO has loaded. So changing DEFAULT_TICKERS doesn't change
the running bot's universe; it just changes what a fresh `/start`
gets.

To actually update the running bot, the operator either:
- Calls `POST /api/pm/bot/start` with the new universe manually, or
- Lets the auto-drops surface and clicks Approve on each (which
  the cron will surface on the first run after deploy)

**Files to touch:**
- `wrangler.jsonc` — `DEFAULT_TICKERS` comment + value
- `src/durable-objects/LiveBot.ts` — any default fallback paths
- (the live bot's universe is in DO state, set via `/start`)

**Tests:**
- The existing `leads-cron.test.ts` uses a hardcoded state — should
  not need changes
- A new test that verifies the cron auto-suggested drops for the
  4 fictional tickers, and that the operator can approve them

**Exit criteria:**
- `DEFAULT_TICKERS = "KXWARMING-50"` in `wrangler.jsonc`
- On deploy, the first cron run surfaces 4 auto-drops for the
  fictional tickers in the current universe
- Operator approves the 4 drops → LiveBot's universe becomes
  just `KXWARMING-50`

**Est. effort:** half hour

---

### Step 1.5 — Deploy + monitor

**Goal:** the new code is live, the bot is healthy, and we observe
the per-vertical distribution over the next few cron runs.

**Scope:**
- `git add -A && git commit` with a clear message describing the
  restructure + the Phase 1 scope
- `npm run deploy` (wrangler deploy)
- Verify cadence via `curl api/pm/cadence`
- Set a cron self-reminder to check the next leads run (the next
  30 */6 * * * firing)
- If anything's off, roll back

**Per `MEMORY.md` gotcha:** `wrangler deploy` does NOT auto-apply
D1 migrations. We have no schema changes here, so this is safe —
the existing migrations table already has `lead_suggestions`. But
verify with a quick `SELECT name FROM sqlite_master WHERE type='table'`
query via `wrangler d1 execute prediction-market-lab --remote` if anything
looks off.

**Files to touch:** none (deploy-only)

**Tests:** smoke test the deployed endpoints after deploy

**Exit criteria:**
- Deployed Worker is healthy
- `cadence` endpoint shows the new leads cron registered
- The Dev page loads
- The next cron run (within 6h) produces the expected artifact
  (n_add=0, n_expired_drops=4, n_per_vertical=...)

**Est. effort:** 15 min (deploy + verify + set reminder)

---

### Phase 1 total estimate: ~2 days (calendar), ~1.5 days (focused work)

The biggest risk in Phase 1 is "the cron surfaces 4 auto-drops but
the operator doesn't approve them, and the bot keeps trying to
trade on 4 fictional markets." Mitigation: surface the drops
prominently in the Dev page, with a clear "your universe is
broken, approve these drops to fix" banner.

---

## 5. Phase 2 — Parlay strategy (SKETCH, follow-up)

This is the strategic bet. Without a leg-probability model, the bot
has no edge on the 4,065 sports markets that make up 68% of
Kalshi's catalog. The shape of Phase 2:

### Step 2.1 — Leg decomposition

**Goal:** for each parlay market, parse the title into a list of
legs. A title like "yes Team A,yes Team B,yes Over 7.5" becomes
`[{ team: "Team A", side: "yes" }, { team: "Team B", side: "yes" },
{ line: 7.5, side: "yes" }]`.

**Scope:**
- Parse `market.title` into a structured `ParlayLeg[]`
- Each leg has a side (yes/no), a market type (team outcome, total,
  spread, etc.), and the relevant entity references
- Handle edge cases: empty titles, non-parlay markets, mixed
  leg types

**Est. effort:** 2-3 days (parser is straightforward but
title-formatting is messy)

### Step 2.2 — Probability model

**Goal:** given a leg, estimate its true resolution probability.

**Decision (committed 2026-08-09):** the order is **(c) → (b) → (a)**.
The user has no sports data access today and considers external
APIs (SportsDataIO, OddsJam, etc.) too expensive at $200-300/mo
for an experimental bot. We start with the naive baseline, then
build our own model, and only fall back to a paid API if neither
of those produces a backtest-positive edge.

> **2026-08-09 (updated after liquidity scan):** the (c) → (b) → (a)
> ordering is still right, but **(c) is structurally dead-on-arrival**
> for now. A full sweep of Kalshi's open-market list (6,000+ markets)
> revealed:
>
> - **0 / 2000** sampled markets have a `yes_bid > 0` — no buyers
> - **0 / 2000** have a valid two-sided spread
> - **0 / 2000** have any volume or open interest
> - The 6,000+ parlay markets all have empty orderbooks (0¢/100¢ defaults)
> - The 2 single-game markets (KXMLBSPREAD, KXMLBTOTAL) have wide
>   spreads and no volume
> - The 1 single-event market that *could* be traded (KXWARMING-50)
>   has a 46¢ spread and zero volume
>
> **Net effect:** the bot cannot trade anything right now regardless
> of strategy. Kalshi is in "catalog mode" — events are listed but
> orderbooks aren't active. The real "when does Kalshi activate
> markets?" question is the binding constraint, not the strategy.
>
> **What this means for (c):** the naive math is sound, but with
> no observable leg prices and no parlay liquidity, we can't find
> any edge. The math is a *validation step* (when markets do
> activate) more than a *live strategy* (right now).
>
> **What this means for (b):** the model has long-term value as
> research infrastructure. When Kalshi activates markets, (b) is
> ready. Until then, it's a research project.
>
> **What this means for (a):** external data doesn't bridge the
> gap if the markets aren't tradeable.

**The three options, in committed order:**

#### (c) Naive baseline (START HERE, but won't make money right now)

**Approach:** for each leg, the probability = the market-implied
probability from Kalshi's orderbook. The parlay's joint = product
of leg probabilities (independence assumption). Edge = our_joint
vs Kalshi's quoted price.

**What this actually buys us:**
- Validates the parlay math end-to-end (leg decomposition, joint
  calculation, edge signal, integration with the bot's order
  flow)
- A baseline "zero edge" so any later model can show *delta*
  vs. naive
- Surfaces where the edges could be — the legs where Kalshi's
  orderbook diverges from our (naive) joint. If Kalshi's price
  already reflects independence, the naive edge is 0; if not,
  we find the divergence
- **Honest caveat (updated 2026-08-09):** the (c) math is correct,
  but Kalshi's markets are non-functional right now (no two-sided
  quotes, no trades). The (c) strategy can't find an edge against
  empty orderbooks. (c) is a *validation step for when Kalshi
  activates markets*, not a live trading strategy today.

**Est. effort:** 1-2 days. The math, the parser, the bot
  integration. No data, no model.

#### (b) Cloudflare Workers AI hosted 8B model (NEXT)

**Approach:** fine-tune (or prompt) an 8B model on
historically-resolved Kalshi markets + public game data. The
model outputs a probability for any leg given its entity
references (team, line, date, sport).

**Training data sources (free):**
- **Kalshi's own history** — Kalshi's `/markets` endpoint
  exposes historical resolutions via the `status` field
  (`settled`, `finalized`) and the `result` field. We can
  reconstruct historical leg outcomes from settled parlays.
- **Public sports data** — sports-reference.com, Wikipedia
  game results, NFL/NBA/MLB/NHL official sites. Free, scrapeable.
- **Wikipedia for entity resolution** — "Los Angeles Lakers
  vs Boston Celtics 2026-03-15" → both team names, the date, the
  sport.
- **Public betting lines (closing line value)** — for backtest
  baseline; even if we don't use them for live predictions,
  they're a sanity check.

**What this needs:**
- A training-set builder (scrape Kalshi history + public sports
  data, join on entity + date)
- A model architecture decision: fine-tune an existing 8B
  (Llama 3 8B, Mistral 7B, Qwen 2.5 7B) vs prompt a base model
  with retrieval. Fine-tune is more accurate but heavier
- Serving on Cloudflare Workers AI (model serving cost — need
  to check; the user has flagged this as the "if all else fails"
  cost concern, but the alternative is paying for an external
  API which is also expensive)
- An evaluation harness: train/val/test split, hit rate on
  held-out legs, calibration check

**Est. effort:** 4-6 weeks for full training + serving + eval.
  Can be staged: get the training-set pipeline working in
  week 1-2 (with stub predictions), then iterate on the model.

#### (a) External sports data API (LAST RESORT)

**Approach:** pay SportsDataIO / OddsJam / Action Network for
game-level data. Use their implied probability as the leg
probability.

**Why it's last:** $200-300/mo is 40-60x the bot's current
operating cost. The user explicitly said "insanely steep cost,
i feel like we can figure it out another way." Only do this if
(b) fails (backtest shows our model can't beat the baseline by
enough) AND (a)'s data is the only way to bridge the gap.

**What this changes vs (b):** less model ownership (we trust
their probabilities) but more cost (recurring). It also
externalizes the data dependency — if the API changes pricing
or shuts down, the bot breaks.

**Est. effort:** 1 week to integrate + validate (assuming the
  API has good docs).

**The order is (c) → (b) → (a). The user is committing to this
as of 2026-08-09.** We don't start (b) until (c) has been
backtested AND the parlay math is validated in production paper
trading. We don't start (a) until (b) has been backtested
against held-out data and the edge is real.

### Step 2.3 — Joint probability + edge calculator

**Goal:** given N leg probabilities, compute the joint probability
(assuming independence — a simplification), and compare to
Kalshi's quoted price. If the joint is meaningfully different
from Kalshi's quote, the parlay is a candidate.

**Scope:**
- Joint = product of leg probs (independence assumption)
- Add a correlation adjustment (worst-case, or a learned model
  from historical data)
- Edge = (our_joint × payout_after_fees) - our_stake
- Filter: only suggest if edge > threshold (e.g. 2%)

**Est. effort:** 1-2 weeks

### Step 2.4 — Backtest harness

**Goal:** validate the parlay strategy against historical Kalshi
resolution data before any live/paper trading.

**Scope:**
- Pull historical resolutions via the Kalshi `/markets` API
- For each resolved market, replay the strategy: would it have
  entered? What was the P&L?
- Compute Sharpe, max drawdown, hit rate, expected vs realized edge

**Est. effort:** 1 week

### Step 2.5 — Paper trade

**Goal:** the bot enters paper trades on mispriced parlays.
Operator watches for 30 days, then decides if to go real.

**Est. effort:** 1-2 weeks (mostly wiring)

### Phase 2 total estimate: ~2 months (with option c + b)
### Phase 2 total estimate: ~3-4 months (with the 8B model from scratch)

**The 8B model idea is captured here as Phase 2.2 option (b).** It
remains the right call for "if the external API doesn't work, or
if we want our own model that we control." The user wanted to make
sure this option doesn't get lost — it lives in Step 2.2 as the
"if all else fails" path. We don't need to commit to it now; we
talk sports-data-API costs first and see if option (a) is good
enough.

> **Updated 2026-08-09:** the user committed to (c) → (b) → (a)
> ordering. (a) is the last-resort, not the default. Phase 2
> total estimate is now ~2 months for the (c)+first-cut-(b)
> path; ~3-4 months if (b) requires a from-scratch model build
> (no fine-tuning, no transfer learning). See Step 2.2 for the
> full decision rationale.

---

## 6. Phase 3 — 1-leg subset pilot (SKETCH, optional)

If Phase 2 is too big, find a smaller subset of parlays where the
math is easier.

**Idea:** parlays where one leg dominates. E.g. a 4-leg parlay
where 3 legs are near-certainty (>=0.99) — the parlay's probability
is almost entirely driven by the 4th leg. Treat those as
single-event markets with the "other legs" as a fee.

**Scope:**
- Filter parlays where max leg probability is "interesting" and
  the others are near-certainty
- Apply the existing single-event strategy to the dominant leg
- Compare backtested P&L to the multi-leg full pricing

**Est. effort:** 1-2 weeks (could be a Step 2.0 before the full
parlay strategy)

**My take:** worth doing only if Phase 2 is taking too long. The
edge from "dominant-leg parlays" is probably small — Kalshi
already prices the dominant leg's contribution. The real edge
comes from the joint-probability math, which is the full Phase 2.

---

## 7. Phase 4 — Continuous wait for new markets (ALWAYS ON)

**Goal:** as Kalshi's catalog rotates, the bot's leads pipeline
automatically surfaces new markets.

**What's already in place:**
- The scout fetches a fresh market list every 6h
- The LLM is given the full snapshot, so new markets appear in
  the prompt automatically
- The leads-cron auto-suggests ADD for new vertical-relevant
  markets and DROP for expired ones
- No code changes needed for this phase

**What we'd want to add eventually:**
- A "newly listed" notification (Telegram or email) for high-value
  new markets — operator can fast-track approval
- A "vertical returned to active" notification (e.g. "KXGDP
  markets are back after 60 days of zero") — for the off-cycle
  verticals

**Est. effort:** existing infrastructure; notification layer is
half a day when we want it

---

## 8. Open questions (for the next conversation)

These are the questions that need answers before we commit to
Phase 2:

1. **Sports data API cost** — the user wants to discuss this.
   Options: SportsDataIO (~$200/mo for game-level data), ESPN
   (free but unofficial), OddsJam (~$300/mo for sharp odds).
   This determines Phase 2.2 (option a) feasibility.

   > **Updated 2026-08-09:** the user committed to the (c) → (b)
   > → (a) ordering. (a) is the last-resort, not the default.
   > This is the right call given the current cost constraints
   > (see §8 below). The conversation now moves to "what does
   > (c) buy us, and how do we get to (b) without a paid data
   > source?"

2. **Is the 8B model on CF AI Workers actually viable?** —
   Workers AI supports several model sizes; an 8B fine-tune might
   need a different serving path (could be external — Modal,
   Replicate, etc.). Need to check the actual serving cost.

3. **What's the expected edge on Kalshi parlays?** — before
   committing months to Phase 2, a quick estimate of "if we have
   a 5% edge on 1% of the 4,065 parlays, is the P&L worth the
   cost?" would tell us if this is a real business or a research
   project.

4. **Off-cycle verticals — when do they come back?** — Kalshi
   might list new economic / political markets on a schedule.
   Worth a quick check of their event calendar.

5. **Free public data sources for (b) training set** — the
   user has no sports data access today. We need to map what's
   publicly available and scrapable:
   - Kalshi's own historical resolutions (via `/markets` with
     `status=settled` / `finalized`) — public, scrapeable
   - sports-reference.com (game results, free, scrapable)
   - Wikipedia (entity resolution for team/player names)
   - NBA.com / NFL.com / MLB.com (official schedules, free,
     public)
   - Pro Football Reference, Basketball Reference, etc.
   The (b) training set is built from these; we don't need a
   paid data source. The question is "is the data clean enough
   to learn from?"

---

## 9. Budget — infrastructure vs. strategy model costs (committed 2026-08-09)

The user explicitly called this out (item 3 from the conversation).
The bot's existing operating budget, per the architecture doc:

| Line item | Cost (committed) |
|---|---|
| CF Workers Paid base | $5/mo |
| mmx LLM calls (M3 for leads + news + daily recap) | ~$4/mo |
| DO WebSocket hibernation | ~$0.50/mo |
| D1 / R2 / analytics | <$0.50/mo |
| **Infrastructure total** | **~$10/mo** |

The parlay strategy introduces a **new cost category** that the
infrastructure budget doesn't cover:

| New line item | Estimated cost |
|---|---|
| Cloudflare Workers AI: 8B model serving (option b) | TBD — need to check Workers AI pricing for 8B-class models. Could be $20-100/mo depending on inference volume. The model is called on every cron run + every paper-trade signal, not on every orderbook tick, so volume is bounded. |
| Training compute for (b) | One-time. Could be a CF AI training job (free tier? paid?). Or external (Modal, Replicate — typically $50-200 for a single fine-tune run). |
| External sports data API (option a) | $200-300/mo — **explicitly rejected by the user as too expensive for an experimental bot** |
| **Strategy model total** | **~$20-100/mo ongoing + one-time training cost** |

**The committed policy (2026-08-09):**

- **Strategy model costs are a separate budget line from
  infrastructure.** The $10/mo infrastructure budget is for
  keeping the bot alive; the strategy model budget is for
  making it smart.
- **Both lines must be affordable on a hobby budget.** The
  user has no revenue from this bot; it's an R&D project.
  Implication: we should not commit to a recurring cost
  >$50/mo for the strategy model unless the backtest shows
  a clearly profitable edge that justifies the spend.
- **The (c) → (b) → (a) ordering exists because of this
  budget.** (c) costs nothing; (b) costs ~$20-100/mo (model
  serving) + one-time training; (a) costs $200-300/mo. We
  start free, escalate only when the prior tier shows
  edge.
- **Hard stop at $50/mo strategy spend** until backtest +
  paper-trade P&L proves the model is worth the cost. If
  Workers AI 8B serving ends up >$50/mo, we revisit (re-tune
  to a smaller model, or use prompt-engineering + retrieval
  instead of fine-tuning, or stop).
- **Free public data only** for the (b) training set, per
  the user's "i have access to nothing" reality. This caps
  the (b) cost at serving + a one-time training job.

**What this changes for the plan:**

- The architecture doc's "~$10/mo total" stays true for
  Phase 1. Phase 2 introduces a second budget line that
  scales with model sophistication.
- We need to instrument the cost of (b) — log every model
  call, total $/day, alert if the daily run-rate exceeds
  the budget.
- If (b) ever costs more than (a), the order flips and we
  pay for the API. But (a) is $200+/mo, so (b) has a wide
  headroom before that flip happens.

---

---

## 10. Risks

- **Phase 1 risk:** the cron auto-drops surface, but the operator
  doesn't approve them, and the bot keeps trying to trade on 4
  fictional markets. *Mitigation:* Dev-page banner when
  expired_drops > 0.

- **Phase 2 risk:** the leg-probability model is wrong, and the
  bot loses money paper-trading. *Mitigation:* 30-day paper
  trading with daily P&L review before any live money.

- **Phase 2 risk:** Kalshi changes the title format for parlays
  and our parser breaks. *Mitigation:* monitor title parsing error
  rate; if it spikes, pause paper trading.

- **Phase 2 risk (the big one):** Kalshi's "no edge for
  single-event strategies" on parlays is real — there's no
  exploitable mispricing, and the bot loses money. *Mitigation:*
  backtest first, before any paper trading. If backtest is
  negative, the strategy is dead and we move on.

- **Phase 4 risk:** Kalshi rotates the catalog and the bot's
  universe goes stale. *Mitigation:* the cron + verify + auto-drops
  is exactly the right infrastructure to detect this; we already
  have it.

---

## 11. Decision log

- **2026-08-09:** Plan drafted. Phase 1 chosen as the immediate
  next step (combine: widen verticals + deploy with what we have
  + wait for new markets). Phase 2 sketched (parlay strategy).
  Phase 3 sketched (1-leg pilot as a fallback if Phase 2 is too
  big). Phase 4 ongoing (auto-surfacing of new listings).
- **2026-08-09:** 8B model on Cloudflare idea captured as
  Phase 2.2 option (b). Remains the "if all else fails" path.
  Not committed to; depends on sports-data-API cost discussion.
- **2026-08-09 (updated):** Phase 2.2 ordering committed as
  **(c) → (b) → (a)**. Start with the naive baseline (free),
  escalate to the 8B model on Cloudflare Workers AI (modest
  serving cost, free training data from Kalshi history +
  public sports sources), only fall back to a paid external
  API if both prior tiers fail. Rationale: external APIs at
  $200-300/mo are 40-60x the bot's current operating cost
  and explicitly rejected by the user as too expensive for an
  experimental bot. The user has no sports data access today;
  we bootstrap from Kalshi's own historical resolutions +
  public sports data (sports-reference.com, Wikipedia,
  official league sites) for the (b) training set.
- **2026-08-09 (updated):** Strategy model costs split out
  as a separate budget line from infrastructure. The bot's
  $10/mo infrastructure budget stays untouched; strategy
  model spending is its own line with a $50/mo hard cap
  until backtest + paper-trade P&L proves the model is
  worth the cost. If Workers AI 8B serving ends up >$50/mo,
  we revisit (re-tune to a smaller model, prompt + retrieval
  instead of fine-tune, or stop).

---

## 12. What's NOT in this plan

To keep scope tight:

- **Real-money trading.** The bot stays in paper mode. The
  auto-pilot cron is the path to live; that's a
  separate concern and gates on Phase 2 success.
- **Multi-user support.** The bot is single-user. Adding a
  second user is a schema + auth change, not a strategy change.
- **Mobile app / Telegram bot changes.** Out of scope.
- **Strategy backtesting for the existing reversion/naive
  strategies.** They work on `KXWARMING-50`; no need to revisit
  until Phase 2 establishes what else the bot can trade.

---

*Next step: the user and I talk about sports data API costs
(option a, ~$200/mo) vs. the 8B model option (b, ~months of
work + CF AI Workers hosting cost). That conversation decides
Phase 2's starting point. Until then, Phase 1 is the work.*
