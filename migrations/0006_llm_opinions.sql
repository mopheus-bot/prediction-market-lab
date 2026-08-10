-- pm-bot — LLM opinion signals (2026-08-10).
--
-- The user wanted the LLM to be a SIGNAL source, not just a
-- ticker picker. This table stores per-ticker LLM verdicts
-- ("based on my knowledge, is YES mispriced at current price?")
-- that the bot's polling feed can read on each tick.
--
-- The cron (src/cron/llm-opinions-cron.ts) refreshes verdicts
-- every 30 min. The bot's strategy (src/strategy/llm-opinion.ts)
-- reads the latest verdict per ticker and emits a Signal if
-- confidence is above threshold.
--
-- Schema is intentionally small — the LLM's output is the
-- source of truth, and the engine re-derives everything else.

CREATE TABLE IF NOT EXISTS llm_opinions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	ts INTEGER NOT NULL,                 -- when the LLM verdict was rendered
	ticker TEXT NOT NULL,
	side TEXT NOT NULL,                  -- 'yes' | 'no' | 'hold'
	confidence REAL NOT NULL,            -- 0.0 - 1.0
	reasoning TEXT NOT NULL,             -- LLM's explanation (1-3 sentences)
	current_price_cents INTEGER,         -- what the LLM saw when it answered
	vertical TEXT,                       -- weather | economic | politics | sports
	model TEXT,                          -- which model answered
	input_tokens INTEGER,
	output_tokens INTEGER,
	duration_ms INTEGER,
	expires_at INTEGER NOT NULL,         -- soft TTL; bot treats expired rows as stale
	UNIQUE(user_id, ticker, ts)
);

CREATE INDEX IF NOT EXISTS idx_llm_opinions_latest
	ON llm_opinions(user_id, ticker, ts DESC);

CREATE INDEX IF NOT EXISTS idx_llm_opinions_expires
	ON llm_opinions(user_id, expires_at);
