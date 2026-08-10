-- pm-bot — live market snapshots (chunk 14.1, 2026-08-10).
--
-- The research-cron polls Kalshi every 15 min and writes a snapshot
-- of any market with a non-empty two-sided orderbook. The Dev page
-- surfaces the "current live" view; the historical table is the
-- training set for Phase 2 (parlay strategy backtest).
--
-- **Why a time series:** Kalshi's markets are mostly dormant. The
-- snapshot table is the source of truth for "when did each market
-- activate / go dormant." The cadence panel renders the latest
-- snapshot per market; the history is queryable by ticker + time
-- range.
--
-- **Why we don't store EVERY polled market:** 6,000+ open markets
-- × 4 polls/hour = 24,000 rows/hour, dominated by dormant (0,0,0)
-- entries. The cron filters to markets that LOOK active (last_price
-- > 0 OR OI > 0) before doing the expensive GET, so this table
-- only contains the actionable subset.

CREATE TABLE IF NOT EXISTS live_market_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT    NOT NULL DEFAULT 'default',
  ts                INTEGER NOT NULL,                       -- unix ms
  ticker            TEXT    NOT NULL,
  event_ticker      TEXT,
  title             TEXT,
  yes_bid_cents     INTEGER NOT NULL,
  yes_ask_cents     INTEGER NOT NULL,
  no_bid_cents      INTEGER,
  no_ask_cents      INTEGER,
  last_price_cents  INTEGER,
  volume_24h        INTEGER,
  open_interest     INTEGER,
  -- True if the snapshot has a real two-sided quote (yes_bid > 0
  -- AND yes_ask > 0 AND yes_ask > yes_bid). Used by the Dev
  -- page to filter to "actually tradeable right now."
  is_live           INTEGER NOT NULL DEFAULT 0,             -- 0 | 1
  -- The close_time from Kalshi. Surfaced in the Dev page so the
  -- operator can see "this market expires in 2 days."
  close_time        TEXT
);

-- The "current live" view is a per-ticker last-snapshot lookup.
-- The cadence panel / Dev page uses this for the "tradeable now"
-- section.
CREATE INDEX IF NOT EXISTS idx_live_snapshots_ticker_ts
  ON live_market_snapshots (ticker, ts DESC);

CREATE INDEX IF NOT EXISTS idx_live_snapshots_is_live_ts
  ON live_market_snapshots (is_live, ts DESC);

CREATE INDEX IF NOT EXISTS idx_live_snapshots_user_ts
  ON live_market_snapshots (user_id, ts DESC);
