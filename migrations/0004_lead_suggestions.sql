-- pm-bot — chunk 11+ — lead_suggestions table.
--
-- The leads-cron (daily 02:00 UTC) asks the LLM to suggest
-- which Kalshi tickers to ADD to the bot's universe and which
-- to DROP. Suggestions are written here; the operator reviews
-- them on the Dev page and clicks Approve / Reject.
--
-- **Lifecycle (single table, status transitions):**
--   pending   → operator hasn't decided yet
--   approved  → operator clicked Approve; for `add` the ticker
--               is now in the bot's universe; for `drop` it
--               has been removed.
--   rejected  → operator clicked Reject; the LLM will not
--               re-suggest this ticker in future runs.
--   superseded → the next cron run replaced this suggestion
--               (operator never decided; undecided rows
--               are quietly replaced on the next run).
--
-- **Why not a separate "rejected" table:** a single table
-- keeps the Dev page simple (one list with status pills)
-- and the audit trail in one place. The "rejected" status
-- is checked by the cron before asking the LLM to keep a
-- suggestion out of the new prompt.
--
-- **Indexes:**
--   - user_id + status + created_at DESC: the "what's
--     pending right now" query that the Dev page runs on
--     every refresh.
--   - user_id + ticker + status: the cron needs to look
--     up "has this ticker been rejected recently?" before
--     asking the LLM to add it.

CREATE TABLE IF NOT EXISTS lead_suggestions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT    NOT NULL DEFAULT 'default',
  cron_run_id       INTEGER,                              -- FK -> cron_runs.id (logical)
  kind              TEXT    NOT NULL,                     -- 'add' | 'drop'
  ticker            TEXT    NOT NULL,
  vertical          TEXT,                                 -- nullable for drops where the LLM doesn't supply
  reasoning         TEXT    NOT NULL,                     -- the LLM's one-sentence explanation
  raw_text          TEXT,                                 -- debug: the LLM's full text for this suggestion (truncated)
  status            TEXT    NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected' | 'superseded'
  created_at        INTEGER NOT NULL,                     -- unix ms
  decided_at        INTEGER,                              -- unix ms (set on approve/reject)
  expires_at        INTEGER NOT NULL,                     -- created_at + 24h; UI can show "expires in X"
  -- 2026-08-09: when the operator approved this suggestion, the
  -- change to the bot was applied via POST /api/pm/bot/start.
  -- We don't need to re-apply on a second approve; this column
  -- tracks the apply-side effect (which cron_runs entry actually
  -- started the bot, if any) for audit.
  applied_at        INTEGER,
  applied_run_id    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lead_suggestions_user_status
  ON lead_suggestions (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_suggestions_user_ticker_status
  ON lead_suggestions (user_id, ticker, status);
