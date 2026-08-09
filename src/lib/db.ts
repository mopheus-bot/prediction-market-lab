/**
 * pm-bot — D1 query helpers.
 *
 * All repo functions take a `D1Database` as the first argument so
 * they're testable in isolation (you can pass a real `env.DB` from
 * a Worker, or a test DB).
 *
 * Multi-tenant: every query takes a `user_id` (default 'default').
 * If you forget to pass it, the helper will fail loudly.
 */

import type { DEFAULT_USER_ID } from "./types";

export { DEFAULT_USER_ID } from "./types";
import type {
	CronRunRow,
	CronStatus,
	FillType,
	LeadKind,
	LeadStatus,
	LeadSuggestionRow,
	LlmCallRow,
	LlmStatus,
	MarketSnapshotRow,
	ModelRow,
	ModelStatus,
	NewCronRun,
	NewLeadSuggestion,
	NewLlmCall,
	NewMarketSnapshot,
	NewModel,
	NewScan,
	NewSignal,
	NewTrade,
	ScanCandidate,
	ScanRow,
	Side,
	SignalRow,
	SignalSource,
	TradeAction,
	TradeRow,
	Vertical,
} from "./types";

/** Strongly-typed wrapper around a D1 prepared statement. */
export class D1Stmt<T = unknown> {
	constructor(
		private readonly stmt: D1PreparedStatement,
		private readonly parse: (raw: Record<string, unknown>) => T,
	) {}

	async all(...params: unknown[]): Promise<T[]> {
		const res = await this.stmt.bind(...params).all();
		return (res.results ?? []).map((r) => this.parse(r as Record<string, unknown>));
	}

	async first(...params: unknown[]): Promise<T | null> {
		const res = await this.stmt.bind(...params).first();
		return res ? this.parse(res as Record<string, unknown>) : null;
	}

	async run(...params: unknown[]): Promise<D1Result> {
		return this.stmt.bind(...params).run();
	}
}

// ─── trades ─────────────────────────────────────────────────────────────

export const trades = {
	async insert(db: D1Database, t: NewTrade): Promise<number> {
		// Chunk 9: trading_mode defaults to "paper" for any caller
		// that doesn't pass it (legacy chunk-1-8 call sites and
		// the chunk-1-8 test fixtures). real_order_id is null
		// for paper trades. Real-trade call sites must set
		// `trading_mode: "real"` and supply the Kalshi order id.
		const tradingMode = t.trading_mode ?? "paper";
		const realOrderId = t.real_order_id ?? null;
		const res = await db
			.prepare(
				`INSERT INTO trades
				 (user_id, ts, ticker, vertical, side, action, price_cents, size,
				  signal_p, signal_rationale, model_version, pnl_cents, fill_type,
				  is_paper, trading_mode, real_order_id)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
				         ?15, ?16)
				 RETURNING id`,
			)
			.bind(
				t.user_id,
				t.ts,
				t.ticker,
				t.vertical,
				t.side,
				t.action,
				t.price_cents,
				t.size,
				t.signal_p,
				t.signal_rationale,
				t.model_version,
				t.pnl_cents,
				t.fill_type,
				t.is_paper,
				tradingMode,
				realOrderId,
			)
			.first<{ id: number }>();
		return res?.id ?? 0;
	},

	async list(
		db: D1Database,
		user_id: string,
		opts: { limit?: number; since_ts?: number; ticker?: string } = {},
	): Promise<TradeRow[]> {
		const limit = opts.limit ?? 100;
		const where: string[] = ["user_id = ?1"];
		const params: unknown[] = [user_id];
		if (opts.since_ts !== undefined) {
			where.push("ts >= ?");
			params.push(opts.since_ts);
		}
		if (opts.ticker !== undefined) {
			where.push("ticker = ?");
			params.push(opts.ticker);
		}
		const sql = `SELECT * FROM trades WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`;
		params.push(limit);
		const res = await db.prepare(sql).bind(...params).all<TradeRow>();
		return res.results ?? [];
	},

	async count(
		db: D1Database,
		user_id: string,
		opts: { since_ts?: number } = {},
	): Promise<number> {
		const where = ["user_id = ?1"];
		const params: unknown[] = [user_id];
		if (opts.since_ts !== undefined) {
			where.push("ts >= ?");
			params.push(opts.since_ts);
		}
		const res = await db
			.prepare(`SELECT COUNT(*) as n FROM trades WHERE ${where.join(" AND ")}`)
			.bind(...params)
			.first<{ n: number }>();
		return res?.n ?? 0;
	},

	async pnlSince(
		db: D1Database,
		user_id: string,
		since_ts: number,
	): Promise<{ gross: number; fees: number; net: number }> {
		const res = await db
			.prepare(
				`SELECT
				   COALESCE(SUM(pnl_cents), 0) as net,
				   COALESCE(SUM(CASE WHEN pnl_cents > 0 THEN pnl_cents ELSE 0 END), 0) as gross,
				   0 as fees
				 FROM trades
				 WHERE user_id = ?1 AND ts >= ?2 AND pnl_cents IS NOT NULL`,
			)
			.bind(user_id, since_ts)
			.first<{ net: number; gross: number; fees: number }>();
		return res ?? { gross: 0, fees: 0, net: 0 };
	},
};

// ─── signals ────────────────────────────────────────────────────────────

export const signals = {
	async insert(db: D1Database, s: NewSignal): Promise<number> {
		const res = await db
			.prepare(
				`INSERT INTO signals
				 (user_id, ts, ticker, vertical, side, signal_p, features_json,
				  model_version, source, was_filled)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
				 RETURNING id`,
			)
			.bind(
				s.user_id,
				s.ts,
				s.ticker,
				s.vertical,
				s.side,
				s.signal_p,
				s.features_json,
				s.model_version,
				s.source,
				s.was_filled,
			)
			.first<{ id: number }>();
		return res?.id ?? 0;
	},

	async list(
		db: D1Database,
		user_id: string,
		opts: {
			limit?: number;
			source?: SignalSource;
			model_version?: string;
			since_ts?: number;
			ticker?: string;
		} = {},
	): Promise<SignalRow[]> {
		const limit = opts.limit ?? 100;
		const where = ["user_id = ?1"];
		const params: unknown[] = [user_id];
		if (opts.source) {
			where.push("source = ?");
			params.push(opts.source);
		}
		if (opts.model_version) {
			where.push("model_version = ?");
			params.push(opts.model_version);
		}
		if (opts.since_ts !== undefined) {
			where.push("ts >= ?");
			params.push(opts.since_ts);
		}
		if (opts.ticker !== undefined) {
			where.push("ticker = ?");
			params.push(opts.ticker);
		}
		const sql = `SELECT * FROM signals WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`;
		params.push(limit);
		const res = await db.prepare(sql).bind(...params).all<SignalRow>();
		return res.results ?? [];
	},
};

// ─── market_snapshots ───────────────────────────────────────────────────

export const marketSnapshots = {
	async insert(db: D1Database, s: NewMarketSnapshot): Promise<void> {
		await db
			.prepare(
				`INSERT OR REPLACE INTO market_snapshots
				 (ts, ticker, vertical, mid_cents, bid_cents, ask_cents, volume_24h, open_interest)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
			)
			.bind(
				s.ts,
				s.ticker,
				s.vertical,
				s.mid_cents,
				s.bid_cents,
				s.ask_cents,
				s.volume_24h,
				s.open_interest,
			)
			.run();
	},

	async listForTicker(
		db: D1Database,
		ticker: string,
		opts: { since_ts?: number; until_ts?: number; limit?: number } = {},
	): Promise<MarketSnapshotRow[]> {
		const where = ["ticker = ?1"];
		const params: unknown[] = [ticker];
		if (opts.since_ts !== undefined) {
			where.push("ts >= ?");
			params.push(opts.since_ts);
		}
		if (opts.until_ts !== undefined) {
			where.push("ts <= ?");
			params.push(opts.until_ts);
		}
		const sql = `SELECT * FROM market_snapshots WHERE ${where.join(" AND ")} ORDER BY ts ASC LIMIT ?`;
		params.push(opts.limit ?? 1000);
		const res = await db.prepare(sql).bind(...params).all<MarketSnapshotRow>();
		return res.results ?? [];
	},
};

// ─── models (registry) ──────────────────────────────────────────────────

export const models = {
	async upsert(db: D1Database, m: NewModel): Promise<void> {
		await db
			.prepare(
				`INSERT INTO models
				 (user_id, version, vertical, artifact_path, trained_on_data_until,
				  train_metrics_json, deployed_at, retired_at, status, notes)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
				 ON CONFLICT(user_id, version) DO UPDATE SET
				   vertical = excluded.vertical,
				   artifact_path = excluded.artifact_path,
				   trained_on_data_until = excluded.trained_on_data_until,
				   train_metrics_json = excluded.train_metrics_json,
				   deployed_at = excluded.deployed_at,
				   retired_at = excluded.retired_at,
				   status = excluded.status,
				   notes = excluded.notes`,
			)
			.bind(
				m.user_id,
				m.version,
				m.vertical,
				m.artifact_path,
				m.trained_on_data_until,
				m.train_metrics_json,
				m.deployed_at,
				m.retired_at,
				m.status,
				m.notes,
			)
			.run();
	},

	async getActive(
		db: D1Database,
		user_id: string,
		vertical: Vertical,
	): Promise<ModelRow | null> {
		return await db
			.prepare(
				`SELECT * FROM models
				 WHERE user_id = ?1 AND vertical = ?2 AND status = 'active'
				 ORDER BY deployed_at DESC NULLS LAST
				 LIMIT 1`,
			)
			.bind(user_id, vertical)
			.first<ModelRow>();
	},

	async list(
		db: D1Database,
		user_id: string,
		opts: { status?: ModelStatus; vertical?: Vertical } = {},
	): Promise<ModelRow[]> {
		const where = ["user_id = ?1"];
		const params: unknown[] = [user_id];
		if (opts.status) {
			where.push("status = ?");
			params.push(opts.status);
		}
		if (opts.vertical) {
			where.push("vertical = ?");
			params.push(opts.vertical);
		}
		const sql = `SELECT * FROM models WHERE ${where.join(" AND ")} ORDER BY deployed_at DESC`;
		const res = await db.prepare(sql).bind(...params).all<ModelRow>();
		return res.results ?? [];
	},

	async setStatus(
		db: D1Database,
		user_id: string,
		version: string,
		status: ModelStatus,
		ts: number,
	): Promise<void> {
		const column = status === "retired" ? "retired_at" : "deployed_at";
		await db
			.prepare(
				`UPDATE models SET status = ?1, ${column} = ?2
				 WHERE user_id = ?3 AND version = ?4`,
			)
			.bind(status, ts, user_id, version)
			.run();
	},
};

// ─── scans ──────────────────────────────────────────────────────────────

export const scans = {
	async insert(
		db: D1Database,
		s: Omit<NewScan, "candidates_json" | "n_candidates"> & {
			candidates: ScanCandidate[];
		},
	): Promise<number> {
		const candidates_json = JSON.stringify(s.candidates);
		const n_candidates = s.candidates.length;
		const res = await db
			.prepare(
				`INSERT INTO scans
				 (user_id, ts, source, lookback_hours, min_trades, top_n, vol24h_min,
				  candidates_json, n_candidates)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
				 RETURNING id`,
			)
			.bind(
				s.user_id,
				s.ts,
				s.source,
				s.lookback_hours,
				s.min_trades,
				s.top_n,
				s.vol24h_min,
				candidates_json,
				n_candidates,
			)
			.first<{ id: number }>();
		return res?.id ?? 0;
	},

	async latest(
		db: D1Database,
		user_id: string,
	): Promise<{ row: ScanRow; candidates: ScanCandidate[] } | null> {
		const row = await db
			.prepare(
				`SELECT * FROM scans WHERE user_id = ?1 ORDER BY ts DESC LIMIT 1`,
			)
			.bind(user_id)
			.first<ScanRow>();
		if (!row) return null;
		const candidates = JSON.parse(row.candidates_json) as ScanCandidate[];
		return { row, candidates };
	},
};

// ─── cron_runs ──────────────────────────────────────────────────────────

export const cronRuns = {
	async insert(db: D1Database, c: NewCronRun): Promise<number> {
		const res = await db
			.prepare(
				`INSERT INTO cron_runs
				 (user_id, cron_name, ts, duration_ms, status, error_message, artifacts_json)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
				 RETURNING id`,
			)
			.bind(
				c.user_id,
				c.cron_name,
				c.ts,
				c.duration_ms,
				c.status,
				c.error_message,
				c.artifacts_json,
			)
			.first<{ id: number }>();
		return res?.id ?? 0;
	},

	async lastRun(
		db: D1Database,
		cron_name: string,
		user_id: string,
	): Promise<CronRunRow | null> {
		return await db
			.prepare(
				`SELECT * FROM cron_runs
				 WHERE cron_name = ?1 AND user_id = ?2
				 ORDER BY ts DESC LIMIT 1`,
			)
			.bind(cron_name, user_id)
			.first<CronRunRow>();
	},
};

// ─── llm_calls ──────────────────────────────────────────────────────────

export const llmCalls = {
	async insert(db: D1Database, c: NewLlmCall): Promise<number> {
		const res = await db
			.prepare(
				`INSERT INTO llm_calls
				 (user_id, ts, purpose, model, ticker, input_tokens_est,
				  output_tokens_est, duration_ms, status, error_message)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
				 RETURNING id`,
			)
			.bind(
				c.user_id,
				c.ts,
				c.purpose,
				c.model,
				c.ticker,
				c.input_tokens_est,
				c.output_tokens_est,
				c.duration_ms,
				c.status,
				c.error_message,
			)
			.first<{ id: number }>();
		return res?.id ?? 0;
	},

	async costSince(
		db: D1Database,
		user_id: string,
		since_ts: number,
	): Promise<{ n_calls: number; input_tokens: number; output_tokens: number }> {
		const res = await db
			.prepare(
				`SELECT
				   COUNT(*) as n_calls,
				   COALESCE(SUM(input_tokens_est), 0) as input_tokens,
				   COALESCE(SUM(output_tokens_est), 0) as output_tokens
				 FROM llm_calls
				 WHERE user_id = ?1 AND ts >= ?2 AND status = 'success'`,
			)
			.bind(user_id, since_ts)
			.first<{ n_calls: number; input_tokens: number; output_tokens: number }>();
		return res ?? { n_calls: 0, input_tokens: 0, output_tokens: 0 };
	},
};

// ─── lead_suggestions ─────────────────────────────────────────────────

export const leadSuggestions = {
	/** Bulk-insert a batch of pending suggestions. The cron
	 *  calls this once per run; the API never inserts (the
	 *  cron is the only producer). */
	async insertMany(
		db: D1Database,
		user_id: string,
		rows: Array<Omit<NewLeadSuggestion, "user_id">>,
	): Promise<number> {
		if (rows.length === 0) return 0;
		const stmt = db.prepare(
			`INSERT INTO lead_suggestions
			 (user_id, cron_run_id, kind, ticker, vertical, reasoning,
			  raw_text, status, created_at, decided_at, expires_at,
			  applied_at, applied_run_id)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, NULL, NULL)`,
		);
		let n = 0;
		for (const r of rows) {
			await stmt
				.bind(
					user_id,
					r.cron_run_id,
					r.kind,
					r.ticker,
					r.vertical,
					r.reasoning,
					r.raw_text,
					r.status,
					r.created_at,
					r.expires_at,
				)
				.run();
			n += 1;
		}
		return n;
	},

	/** Mark every current `pending` row as `superseded`. The
	 *  cron calls this on each run before inserting the new
	 *  batch, so the Dev page always shows the latest
	 *  suggestions and the operator doesn't have to delete
	 *  stale rows manually. */
	async supersedePending(
		db: D1Database,
		user_id: string,
		ts: number,
	): Promise<number> {
		const res = await db
			.prepare(
				`UPDATE lead_suggestions
				 SET status = 'superseded', decided_at = ?2
				 WHERE user_id = ?1 AND status = 'pending'`,
			)
			.bind(user_id, ts)
			.run();
		return res.meta?.changes ?? 0;
	},

	/** List pending + recent decided. Used by the Dev page.
	 *  `limit` defaults to 25 pending + 25 history (so the
	 *  page is bounded). */
	async listRecent(
		db: D1Database,
		user_id: string,
		opts: { limit?: number } = {},
	): Promise<{ pending: LeadSuggestionRow[]; history: LeadSuggestionRow[] }> {
		const limit = opts.limit ?? 25;
		const pendingRes = await db
			.prepare(
				`SELECT * FROM lead_suggestions
				 WHERE user_id = ?1 AND status = 'pending'
				 ORDER BY created_at DESC LIMIT ?`,
			)
			.bind(user_id, limit)
			.all<LeadSuggestionRow>();
		const historyRes = await db
			.prepare(
				`SELECT * FROM lead_suggestions
				 WHERE user_id = ?1 AND status IN ('approved', 'rejected', 'superseded')
				 ORDER BY COALESCE(decided_at, created_at) DESC LIMIT ?`,
			)
			.bind(user_id, limit)
			.all<LeadSuggestionRow>();
		return {
			pending: pendingRes.results ?? [],
			history: historyRes.results ?? [],
		};
	},

	async getById(
		db: D1Database,
		id: number,
		user_id: string,
	): Promise<LeadSuggestionRow | null> {
		return await db
			.prepare(
				`SELECT * FROM lead_suggestions
				 WHERE id = ?1 AND user_id = ?2`,
			)
			.bind(id, user_id)
			.first<LeadSuggestionRow>();
	},

	/** Mark a single row approved/rejected. Atomic check on
	 *  `status = 'pending'` prevents double-decide. */
	async setStatus(
		db: D1Database,
		id: number,
		user_id: string,
		status: LeadStatus,
		ts: number,
	): Promise<boolean> {
		const res = await db
			.prepare(
				`UPDATE lead_suggestions
				 SET status = ?3, decided_at = ?4
				 WHERE id = ?1 AND user_id = ?2 AND status = 'pending'`,
			)
			.bind(id, user_id, status, ts)
			.run();
		return (res.meta?.changes ?? 0) > 0;
	},

	/** Record the apply-side effect (the cron_runs.id of the
	 *  bot restart that resulted from this approval). The
	 *  audit trail for "which suggestions actually changed
	 *  the bot?". */
	async markApplied(
		db: D1Database,
		id: number,
		user_id: string,
		ts: number,
		applied_run_id: number | null,
	): Promise<void> {
		await db
			.prepare(
				`UPDATE lead_suggestions
				 SET applied_at = ?3, applied_run_id = ?4
				 WHERE id = ?1 AND user_id = ?2`,
			)
			.bind(id, user_id, ts, applied_run_id)
			.run();
	},

	/** Has this ticker been rejected recently (last 30d)?
	 *  The cron asks the LLM not to re-suggest tickers
	 *  the operator has already said no to. */
	async recentlyRejected(
		db: D1Database,
		user_id: string,
		ticker: string,
		since_ts: number,
	): Promise<boolean> {
		const row = await db
			.prepare(
				`SELECT 1 as one FROM lead_suggestions
				 WHERE user_id = ?1 AND ticker = ?2 AND status = 'rejected'
				   AND decided_at >= ?3 LIMIT 1`,
			)
			.bind(user_id, ticker, since_ts)
			.first<{ one: number }>();
		return row?.one === 1;
	},
};
