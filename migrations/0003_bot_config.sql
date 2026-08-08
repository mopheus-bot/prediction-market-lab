-- pm-bot — chunk 10.8c — bot_config table.
--
-- The LiveBot DO persists its config to ctx.storage, but the
-- /api/pm/verticals endpoint lives in the Worker (not the DO)
-- and needs to read the same config (disabled_verticals,
-- per_vertical_max_notional_cents, ticker_verticals). This
-- table mirrors the relevant subset so the Worker can serve
-- the verticals panel without an extra round-trip to the DO.
--
-- The DO is the source of truth; this table is a denormalized
-- read-cache. On every /start (or /trading-mode), the DO writes
-- the relevant fields here.
--
-- Single row per user; key/value with the full config as JSON
-- under the "config" key.

CREATE TABLE IF NOT EXISTS bot_config (
  user_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,            -- JSON-encoded
  ts_ms   INTEGER NOT NULL,          -- unix ms of the last write
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_bot_config_user_ts
  ON bot_config (user_id, ts_ms DESC);
