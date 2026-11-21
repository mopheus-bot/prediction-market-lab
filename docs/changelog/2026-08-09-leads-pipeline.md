# LLM-driven lead generation and retargeting pipeline (2026-08-09)

**Scope:** wire the leads feature as a recurring automation, not a one-off
endpoint. The previous `suggest-leads` endpoint was a manual call; this
step makes it a daily pipeline with operator approval, vertical retargeting,
and a 24h TTL on undecided suggestions.

## What was already there

- `POST /api/pm/bot/suggest-leads` — single-shot LLM call returning
  `count` suggested tickers, deduped against the current universe.
  Used the manual "Suggest leads (LLM)" button on the Dev page.
- `runLeadsCron` was a stub returning `{ skipped: true }`.

## What changed

### 1. New `lead_suggestions` table (`migrations/0004_lead_suggestions.sql`)

Single-table state machine:

```
pending  → approved  (operator clicked Approve; applied to bot)
pending  → rejected  (operator clicked Reject; cron won't re-suggest for 30d)
pending  → superseded  (next cron run replaced it; undecided rows are
                        quietly overwritten on the next run)
```

Schema columns: `id, user_id, cron_run_id, kind ('add'|'drop'), ticker,
vertical, reasoning, raw_text, status, created_at, decided_at,
expires_at, applied_at, applied_run_id`.

Indices on `(user_id, status, created_at)` for the panel and
`(user_id, ticker, status)` for the recently-rejected cron query.

### 2. `leads-cron` (daily 02:00 UTC, after Sunday backtest)

- Reads current state from the LiveBot DO (tickers, ticker_verticals,
  bankroll, mode).
- Reads per-ticker 30d stats from D1 (signal count, trade count, PnL,
  days since last signal) — for the prompt's "drop candidate" reasoning.
- Reads recently-rejected tickers (last 30d) from `lead_suggestions` —
  the LLM is told not to re-suggest tickers the operator has said no to.
- Asks M3 for `{add: [...], drop: [...], overall_reasoning: "..."}`.
- Validates format + dedupes within batch + excludes against current
  universe + 30d rejected list. Mismatches go to `excluded` (with reason)
  and don't become suggestions.
- Marks all prior `pending` rows as `superseded` (preserves them for
  history; the panel never grows stale).
- Inserts the new batch with `status='pending', expires_at = now+24h`.
- Records the LLM call to `llm_calls` with `purpose='leads_cron'` so
  the cadence + cost panels reflect the run.

### 3. `leads` API (operator-facing)

- `GET  /api/pm/leads` — pending + history (last 25 each) +
  last-run summary (n_add, n_drop, n_excluded, n_superseded,
  llm tokens, reasoning).
- `POST /api/pm/leads/{id}/approve` — applies the suggestion to
  the bot's universe and restarts.
  - For `add`: appends the ticker + sets its vertical mapping.
  - For `drop`: removes the ticker + clears its vertical mapping.
  - **Regression fix**: the previous version of approve only set
    `ticker_verticals` for the new/removed ticker, but the bot's
    `/start` uses `Object.keys(ticker_verticals)` as the source of
    truth — so the rest of the universe was silently dropped. The
    fix populates verticals for ALL remaining tickers.
  - Idempotent: a second approve on the same id returns 409
    already_decided; the bot isn't restarted twice.
- `POST /api/pm/leads/{id}/reject` — marks the row rejected.
  The cron won't re-suggest this ticker for 30 days.

### 4. Cadence panel

`leads` shows up at "02:00 UTC daily" alongside the other crons.
The `SERVICE_CATALOGUE` table in `src/api/cadence.ts` is built
dynamically from `CRON_TABLE` — adding the cron to one place
cascades to (a) the cadence panel, (b) the `cronJobs` array
that fetches last-runs, (c) the `TRIGGERABLE_CRONS` list for
the manual trigger button.

### 5. Dev page UI

- New "Lead suggestions" card at the top of the Dev page
  (between "Manual cron triggers" and "API endpoints").
- Header: "🎯 Lead suggestions" + last-run badge (color-coded)
  + "Suggest now" button (manual cron trigger) + "History"
  toggle.
- Pending cards: kind (➕/➖) + ticker + vertical pill + reasoning
  (the LLM's one-sentence explanation) + age + TTL countdown +
  Approve / Reject buttons.
- Summary line: "N pending · N add · N drop · review before
  next cron at 02:00 UTC".
- History list: collapsed by default, shows the last 25 decided
  rows with status pills.
- Auto-refreshes every 10s on the same cycle as the rest of the
  Dev page.

### 6. Cron dispatcher bug fix (pre-existing)

The dispatcher (`src/cron/dispatcher.ts`) and the manual trigger
(`src/api/cron-trigger.ts`) now respect the inner cron's `ok` field.
Previously, a cron that returned `{ok: false, error_message: "..."}`
without throwing was recorded as `status='success'` in `cron_runs`
and the cadence panel showed "ok" — silently hiding failures. The
fix:
- The scheduled handler: extract `inner.ok`, write to cron_runs.
- The manual trigger: same.
- Don't double-wrap artifacts (`artifacts` should be the inner
  cron's own artifacts, not the whole inner CronResult).
- Applies to every cron, not just leads (the heartbeat cron had
  the same failure mode).

### 7. Dev page JS bug fix (pre-existing)

`poll.last_error` from the LiveBot is polymorphic (string | object
| null). Two `.slice()` calls in `dev.html` crashed the page when
it was an object, breaking every panel that ran after. Both sites
now type-check before slicing. Also the noop Proxy's
`querySelector/All` returns `[]` instead of `_noopFn` so that
`for (const x of el.querySelectorAll(...))` works (was throwing
"is not iterable") when the element is missing.

## Files

**New:**
- `migrations/0004_lead_suggestions.sql` — table + indices
- `src/cron/leads-cron.ts` — daily 02:00 UTC cron
- `src/api/leads.ts` — GET / approve / reject

**Modified:**
- `src/cron/dispatcher.ts` — respect inner ok; unwrap artifacts
- `src/api/cron-trigger.ts` — same fix
- `src/api/cadence.ts` — add `leads` to SERVICE_CATALOGUE
- `src/index.ts` — register the 3 new routes
- `src/lib/db.ts` — `leadSuggestions` repo (insertMany,
  supersedePending, listRecent, getById, setStatus, markApplied,
  recentlyRejected)
- `src/lib/types.ts` — `LeadKind`, `LeadStatus`, `LeadSuggestionRow`,
  `NewLeadSuggestion`
- `wrangler.jsonc` — add `0 2 * * *` cron trigger
- `public/app/dev.html` — Lead suggestions panel + render +
  approve/reject handlers + "Suggest now" button
- `public/app/app.js` — fix noop Proxy `querySelector/All` return
- `docs/operations.md` — add leads/heartbeat/auto_pilot/backtest
  to cadence table; LLM call purposes table
- `test/helpers/migrations.ts` — load migration 0004
- `vitest.config.mts` — register the 4 new test files
- `test/leads-cron.test.ts` — 18 tests (validation/dedupe)
- `test/leads-api.test.ts` — 12 tests (DB helpers + GET +
  approve + reject with LIVE_BOT stub)
- `test/suggest-leads.test.ts` — 13 tests (ticker validation)
- `test/cron-trigger.test.ts` — 8 tests (manual trigger +
  inner-ok propagation)

**Stats:** 2 commits (`2e6ef9d` leads, `52ffe11` verticals fix).
Plus 4 new test files (51 tests total) + docs cleanup.
Typecheck clean; 304/304 tests pass.

## Operator workflow

1. Open `/app/dev` → "Lead suggestions" panel.
2. The cron runs at 02:00 UTC and writes 1-3 add + 0-1 drop
   suggestions. (Until the cron runs in prod, the panel shows
   "no pending suggestions".)
3. Each card: kind + ticker + vertical + reasoning + age + TTL.
4. Click **Approve** → the bot's universe updates and the bot
   restarts. The card moves to history.
5. Click **Reject** → the row is marked rejected; the cron won't
   re-suggest this ticker for 30 days.
6. Undecided cards are quietly replaced on the next cron run
   (24h TTL is implicit via `superseded` on the next run).

The **Suggest now** button on the panel runs the cron on demand
(useful for testing or for the operator to "see what the LLM
thinks right now"). The **History** toggle shows the last 25
decided rows (approved/rejected/superseded).

## Not deployed

Per the user's "redeploy can wait" default. Two commits on
`origin/main` (2e6ef9d + 52ffe11) are queued for deploy.
The new `0004_lead_suggestions.sql` migration will auto-apply
to the remote D1 on first wrangler deploy (same as 0003 did).
