/**
 * pm-bot — shared types
 *
 * Mirrors the D1 schema in `migrations/0001_initial_schema.sql` 1:1.
 * Multi-tenant from day 1: every entity has a `user_id` field.
 *
 * Times are unix milliseconds. Prices are cents. PnL is cents.
 * Serialized JSON fields hold structured data (features, candidates, etc).
 */

// ─── Enumerations ───────────────────────────────────────────────────────

/** What the bot is trading on. Maps 1:1 from Kalshi's category. */
export type Vertical = "weather" | "economic" | "politics" | "sports";

export const VERTICALS: readonly Vertical[] = [
	"weather",
	"economic",
	"politics",
	"sports",
] as const;

/** Trade side — Kalshi markets are binary, you take 'yes' or 'no'. */
export type Side = "yes" | "no";

/** Open a new position or close an existing one. */
export type TradeAction = "open" | "close";

/** How the trade was executed. */
export type FillType = "limit" | "market" | "replay";

/** Where a signal originated. */
export type SignalSource = "live" | "shadow" | "backtest";

/** Lifecycle status for a model in the registry. */
export type ModelStatus = "candidate" | "active" | "retired" | "shadow";

/** Cron invocation outcome. */
export type CronStatus = "success" | "error" | "skipped";

/** LLM call outcome. */
export type LlmStatus = "success" | "error";

// ─── Row types (snake_case to match SQL) ────────────────────────────────

export interface TradeRow {
	id: number;
	user_id: string;
	ts: number;
	ticker: string;
	vertical: Vertical;
	side: Side;
	action: TradeAction;
	price_cents: number;
	size: number;
	signal_p: number | null;
	signal_rationale: string | null;
	model_version: string | null;
	pnl_cents: number | null;
	fill_type: FillType;
	is_paper: 0 | 1;
	/** Chunk 9: the engine mode at the time of fill. "paper" by
	 * default for legacy rows; "real" once a real trade happens. */
	trading_mode: "paper" | "real" | "off";
	/** Chunk 9: Kalshi's order id (for real trades only). NULL
	 * for paper. Lets the dashboard link a D1 row back to the
	 * actual Kalshi order. */
	real_order_id: string | null;
	created_at: number;
}

export interface SignalRow {
	id: number;
	user_id: string;
	ts: number;
	ticker: string;
	vertical: Vertical;
	side: Side | null;
	signal_p: number;
	features_json: string | null;
	model_version: string;
	source: SignalSource;
	was_filled: 0 | 1;
	created_at: number;
}

export interface MarketSnapshotRow {
	ts: number;
	ticker: string;
	vertical: Vertical;
	mid_cents: number | null;
	bid_cents: number | null;
	ask_cents: number | null;
	volume_24h: number | null;
	open_interest: number | null;
}

export interface ModelRow {
	user_id: string;
	version: string;
	vertical: Vertical | "all";
	artifact_path: string;
	trained_on_data_until: number | null;
	train_metrics_json: string | null;
	deployed_at: number | null;
	retired_at: number | null;
	status: ModelStatus;
	notes: string | null;
}

export interface ScanCandidate {
	ticker: string;
	score: number;
	vol24h: number;
	n_trades: number;
	vertical: Vertical;
	// Optional fields that scans may populate
	spread_cents?: number;
	mid_cents?: number;
}

export interface ScanRow {
	id: number;
	user_id: string;
	ts: number;
	source: string;
	lookback_hours: number | null;
	min_trades: number | null;
	top_n: number | null;
	vol24h_min: number | null;
	candidates_json: string; // JSON-serialized ScanCandidate[]
	n_candidates: number;
	created_at: number;
}

export interface CronRunRow {
	id: number;
	user_id: string;
	cron_name: string;
	ts: number;
	duration_ms: number | null;
	status: CronStatus;
	error_message: string | null;
	artifacts_json: string | null;
	created_at: number;
}

export interface LlmCallRow {
	id: number;
	user_id: string;
	ts: number;
	purpose: string;
	model: string;
	ticker: string | null;
	input_tokens_est: number | null;
	output_tokens_est: number | null;
	duration_ms: number | null;
	status: LlmStatus;
	error_message: string | null;
	created_at: number;
}

// ─── Insert types (no `id`, no `created_at` — DB sets those) ──────────

/** NewTrade: chunk 9 made `trading_mode` and `real_order_id`
 * optional on insert. Callers that pass them explicitly set
 * `trading_mode: "real"` + `real_order_id: <kalshi id>`. Legacy
 * callers and tests can omit both — the binding defaults to
 * paper + null. */
export type NewTrade = Omit<TradeRow, "id" | "created_at" | "trading_mode" | "real_order_id"> & {
	trading_mode?: "paper" | "real" | "off";
	real_order_id?: string | null;
};
export type NewSignal = Omit<SignalRow, "id" | "created_at">;
export type NewMarketSnapshot = Omit<MarketSnapshotRow, never>;
export type NewModel = Omit<ModelRow, never>;
export type NewScan = Omit<ScanRow, "id" | "created_at">;
export type NewCronRun = Omit<CronRunRow, "id" | "created_at">;
export type NewLlmCall = Omit<LlmCallRow, "id" | "created_at">;

// ─── Default user ───────────────────────────────────────────────────────

export const DEFAULT_USER_ID = "default";
