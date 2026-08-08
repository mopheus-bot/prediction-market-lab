-- pm-bot chunk 9: real trading columns
--
-- Adds the columns needed for chunk 9 (real trading toggle).
-- Backwards-compatible: existing rows get NULL/0 defaults so
-- old trades render correctly with is_paper=1 (paper) by default
-- in the API responses.
--
-- New columns:
--   - trades.real_order_id: Kalshi's order id for real trades;
--     NULL for paper. Lets us trace a D1 row back to a real
--     Kalshi order.
--   - trades.trading_mode: "paper" | "real" | "off" — the
--     engine mode at the time of fill. Lets the dashboard
--     split paper vs real PnL cleanly.

--> statement-breakpoint
ALTER TABLE trades ADD COLUMN real_order_id TEXT;
--> statement-breakpoint
ALTER TABLE trades ADD COLUMN trading_mode TEXT NOT NULL DEFAULT 'paper';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_trades_trading_mode ON trades (user_id, trading_mode, ts);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_trades_real_order_id ON trades (real_order_id) WHERE real_order_id IS NOT NULL;
