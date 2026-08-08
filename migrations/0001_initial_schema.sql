-- pm-bot initial schema — chunk 1
--
-- Multi-tenant from day 1: every table has a `user_id` column (default 'default').
-- A second user = config change, not a refactor.
--
-- Times are unix milliseconds. Cents for prices. Cents for PnL.
-- Rationale / features stored as JSON strings (SQLite has no JSON column type
-- but D1's JSON1 extension handles them).

PRAGMA foreign_keys = ON;

-- ──────────────────────────────────────────────────────────────────────
-- trades — the paper-trading ledger.
-- One row per fill (open or close). Real money in chunk 9 writes here too.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT    NOT NULL DEFAULT 'default',
  ts                INTEGER NOT NULL,                       -- unix ms
  ticker            TEXT    NOT NULL,
  vertical          TEXT    NOT NULL,                       -- weather | economic | politics | sports
  side              TEXT    NOT NULL,                       -- 'yes' | 'no'
  action            TEXT    NOT NULL,                       -- 'open' | 'close'
  price_cents       INTEGER NOT NULL,
  size              INTEGER NOT NULL,
  signal_p          REAL,                                  -- 0..1 model confidence at decision time
  signal_rationale  TEXT,                                  -- human-readable why
  model_version     TEXT,                                  -- FK -> models.version (logical, not enforced)
  pnl_cents         INTEGER,                               -- realized (on close) or NULL
  fill_type         TEXT    NOT NULL DEFAULT 'limit',      -- 'limit' | 'market' | 'replay'
  is_paper          INTEGER NOT NULL DEFAULT 1,            -- 1=paper, 0=real
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_trades_user_ts        ON trades (user_id, ts);
CREATE INDEX IF NOT EXISTS idx_trades_ticker_ts      ON trades (ticker, ts);
CREATE INDEX IF NOT EXISTS idx_trades_vertical       ON trades (vertical);
CREATE INDEX IF NOT EXISTS idx_trades_model          ON trades (model_version);
CREATE INDEX IF NOT EXISTS idx_trades_open           ON trades (user_id, ticker, action) WHERE action = 'open';

-- ──────────────────────────────────────────────────────────────────────
-- signals — every model decision, whether or not it became a trade.
-- Required for shadow mode (chunk 8) and for "what would the new model
-- have done?" backtests.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT    NOT NULL DEFAULT 'default',
  ts                INTEGER NOT NULL,
  ticker            TEXT    NOT NULL,
  vertical          TEXT    NOT NULL,
  side              TEXT,                                  -- 'yes' | 'no' | NULL when no actionable signal
  signal_p          REAL    NOT NULL,                       -- 0..1
  features_json     TEXT,                                  -- serialized feature vector
  model_version     TEXT    NOT NULL,
  source            TEXT    NOT NULL DEFAULT 'live',        -- 'live' | 'shadow' | 'backtest'
  was_filled        INTEGER NOT NULL DEFAULT 0,            -- 0/1, did this become a trade?
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_signals_user_ts       ON signals (user_id, ts);
CREATE INDEX IF NOT EXISTS idx_signals_ticker_ts     ON signals (ticker, ts);
CREATE INDEX IF NOT EXISTS idx_signals_model         ON signals (model_version);
CREATE INDEX IF NOT EXISTS idx_signals_source        ON signals (user_id, source, ts);

-- ──────────────────────────────────────────────────────────────────────
-- market_snapshots — periodic market state, used for replay and
-- backtest comparison. Sampled every ~30s for active tickers.
-- Composite primary key prevents dupes at the same instant.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_snapshots (
  ts                INTEGER NOT NULL,
  ticker            TEXT    NOT NULL,
  vertical          TEXT    NOT NULL,
  mid_cents         INTEGER,
  bid_cents         INTEGER,
  ask_cents         INTEGER,
  volume_24h        INTEGER,
  open_interest     INTEGER,
  PRIMARY KEY (ts, ticker)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ticker_ts  ON market_snapshots (ticker, ts);
CREATE INDEX IF NOT EXISTS idx_snapshots_vertical    ON market_snapshots (vertical, ts);

-- ──────────────────────────────────────────────────────────────────────
-- models — the model registry. One row per (user, version).
-- status transitions: candidate -> active -> retired.
-- artifact_path is an R2 key like 'models/reversion-weather-v3.onnx'.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS models (
  user_id             TEXT    NOT NULL DEFAULT 'default',
  version             TEXT    NOT NULL,
  vertical            TEXT    NOT NULL,                    -- 'weather' | 'economic' | 'politics' | 'sports' | 'all'
  artifact_path       TEXT    NOT NULL,                    -- R2 key
  trained_on_data_until INTEGER,                           -- unix ms of last training data point
  train_metrics_json  TEXT,                                -- { sharpe, win_rate, n_samples, ... }
  deployed_at         INTEGER,
  retired_at          INTEGER,
  status              TEXT    NOT NULL DEFAULT 'candidate',-- 'candidate' | 'active' | 'retired' | 'shadow'
  notes               TEXT,
  PRIMARY KEY (user_id, version)
);
CREATE INDEX IF NOT EXISTS idx_models_active         ON models (user_id, vertical, status);

-- ──────────────────────────────────────────────────────────────────────
-- scans — output of the universe-scan cron job (chunk 5).
-- One row per scan, candidates_json holds the ranked list.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scans (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT    NOT NULL DEFAULT 'default',
  ts                INTEGER NOT NULL,
  source            TEXT    NOT NULL DEFAULT 'series-anchored', -- scan strategy
  lookback_hours    INTEGER,
  min_trades        INTEGER,
  top_n             INTEGER,
  vol24h_min        INTEGER,
  candidates_json   TEXT    NOT NULL,                      -- [{ ticker, score, vol24h, n_trades, ... }]
  n_candidates      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_scans_user_ts        ON scans (user_id, ts DESC);

-- ──────────────────────────────────────────────────────────────────────
-- cron_runs — observability for the cron jobs themselves.
-- One row per cron invocation. Useful for "did the daily recap
-- actually run last night?" questions.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cron_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT    NOT NULL DEFAULT 'default',
  cron_name         TEXT    NOT NULL,                      -- 'scan-refresh' | 'news-check' | 'daily-recap' | 'train' | ...
  ts                INTEGER NOT NULL,                      -- when it started
  duration_ms       INTEGER,                               -- how long it took
  status            TEXT    NOT NULL,                      -- 'success' | 'error' | 'skipped'
  error_message     TEXT,
  artifacts_json    TEXT,                                  -- what it produced (report path, count, etc.)
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_name_ts    ON cron_runs (cron_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_user_ts    ON cron_runs (user_id, ts DESC);

-- ──────────────────────────────────────────────────────────────────────
-- llm_calls — track mmx usage and cost. Not exhaustive — just a
-- per-call log so we can audit and budget.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS llm_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT    NOT NULL DEFAULT 'default',
  ts                INTEGER NOT NULL,
  purpose           TEXT    NOT NULL,                      -- 'news-check' | 'daily-recap' | ...
  model             TEXT    NOT NULL,                      -- 'MiniMax-M2.7-highspeed'
  ticker            TEXT,                                  -- for news checks
  input_tokens_est  INTEGER,
  output_tokens_est INTEGER,
  duration_ms       INTEGER,
  status            TEXT    NOT NULL,                      -- 'success' | 'error'
  error_message     TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_user_ts    ON llm_calls (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_purpose    ON llm_calls (purpose, ts DESC);
