/**
 * prediction-market-lab — shared types
 *
 * Mirrors the D1 schema in `migrations/0001_initial_schema.sql` 1:1.
 * Multi-tenant from day 1: every entity has a `user_id` field.
 *
 * Times are unix milliseconds. Prices are cents. PnL is cents.
 * Serialized JSON fields hold structured data (features, candidates, etc).
 */

// ─── Enumerations ───────────────────────────────────────────────────────

/** What the bot is trading on. Maps 1:1 from Kalshi's category.
 *  2026-08-11: expanded from 4 → 17 to match the full open-trade
 *  universe. The four legacy verticals (weather / economic /
 *  politics / sports) keep their names so existing D1 rows +
 *  dashboard panels don't churn. The thirteen new verticals are
 *  snake_case versions of Kalshi's category labels. `uncategorized`
 *  is the catch-all for events that arrive without a category
 *  (currently 1 event / 2 markets — Gold vs Silver 2026). */
export type Vertical =
	| "weather"
	| "economic"
	| "politics"
	| "sports"
	| "elections"
	| "financials"
	| "entertainment"
	| "science_technology"
	| "crypto"
	| "companies"
	| "commodities"
	| "mentions"
	| "social"
	| "world"
	| "health"
	| "transportation"
	| "uncategorized";

export const VERTICALS: readonly Vertical[] = [
	"weather",
	"economic",
	"politics",
	"sports",
	"elections",
	"financials",
	"entertainment",
	"science_technology",
	"crypto",
	"companies",
	"commodities",
	"mentions",
	"social",
	"world",
	"health",
	"transportation",
	"uncategorized",
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

/** Suggestion kind. The leads-cron (every 6 hours +30min, 00:30/06:30/12:30/18:30 UTC) asks
 * the LLM for both kinds. `add` means "consider adding this
 * ticker to the universe"; `drop` means "consider removing
 * this ticker from the universe". 2026-08-09: tightened from
 * daily 02:00 UTC to 6h cadence to give fresh suggestions
 * 4x/day; offset 30min from news so the LLM has fresh news data. */
export type LeadKind = "add" | "drop";

/** Lifecycle status. See migrations/0004_lead_suggestions.sql
 * for the full state diagram. */
export type LeadStatus = "pending" | "approved" | "rejected" | "superseded";

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
	/**: the engine mode at the time of fill. "paper" by
	 * default for legacy rows; "real" once a real trade happens. */
	trading_mode: "paper" | "real" | "off";
	/**: Kalshi's order id (for real trades only). NULL
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

/** 2026-08-10: per-ticker LLM opinion verdicts. The
 *  LLMOpinionSignal strategy reads from this table on
 *  every bot poll (pre-fetched into SignalContext by
 *  maybeSignalAll) to emit verdict-driven signals. */
export interface LLMOpinionRow {
	id: number;
	user_id: string;
	ts: number;
	ticker: string;
	side: "yes" | "no" | "hold";
	confidence: number;
	reasoning: string;
	current_price_cents: number | null;
	vertical: string | null;
	model: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	duration_ms: number | null;
	expires_at: number;
}

export type NewLLMOpinion = Omit<LLMOpinionRow, "id">;

/** A pending LLM-generated suggestion. One row per
 * (ticker, kind, run) — the leads-cron inserts up to a
 * handful of rows per invocation. The operator reviews
 * on the Dev page and clicks Approve / Reject. */
export interface LeadSuggestionRow {
	id: number;
	user_id: string;
	cron_run_id: number | null;
	kind: LeadKind;
	ticker: string;
	vertical: Vertical | null;
	reasoning: string;
	raw_text: string | null;
	status: LeadStatus;
	created_at: number;
	decided_at: number | null;
	expires_at: number;
	applied_at: number | null;
	applied_run_id: number | null;
}

// ─── Insert types (no `id`, no `created_at` — DB sets those) ──────────

/** NewTrade:  made `trading_mode` and `real_order_id`
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
/** Insert shape for a new lead suggestion. The cron is the
 * only producer; decided_at / applied_at / applied_run_id
 * are set later by the API on approve/reject, so they're
 * not part of the insert shape. user_id is set by the
 * repo helper from a parameter, not from the row. */
export type NewLeadSuggestion = Omit<
	LeadSuggestionRow,
	"id" | "user_id" | "decided_at" | "applied_at" | "applied_run_id"
>;

// ─── Default user ───────────────────────────────────────────────────────

export const DEFAULT_USER_ID = "default";
