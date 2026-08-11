/**
 * pm-bot — status API handlers (chunk 6).
 *
 * Read-only JSON endpoints for the dashboard (chunk 7) +
 * the Telegram bot's daily summary. All endpoints scope to
 * the default user; the multi-tenant refactor lives in a
 * later chunk.
 *
 * **Endpoints:**
 *   - `GET /api/pm/status`       — overall state (bot + risk + counts)
 *   - `GET /api/pm/summary`      — last 24h aggregates (same shape as daily-cron output)
 *   - `GET /api/pm/trades`       — recent trades (filters: ?ticker= ?since= ?limit=)
 *   - `GET /api/pm/signals`      — recent signals (filters: ?ticker= ?source= ?limit=)
 *   - `GET /api/pm/scans`        — latest scan candidates
 *   - `GET /api/pm/cron-runs`    — recent cron runs (filters: ?cron= ?limit=)
 *
 * **Response shape:** every endpoint returns `{ ok: true, ... }`
 * on success and `{ ok: false, error: string }` on failure
 * (DB binding missing, bad input, etc.).
 *
 * **Auth:** CF Access sits in front of all `/api/pm/*` paths.
 * No additional auth in the handlers — the upstream layer is
 * the gate.
 */

import {
	trades as tradesDb,
	signals as signalsDb,
	scans as scansDb,
	cronRuns as cronRunsDb,
} from "../lib/db.js";
import { DEFAULT_USER_ID } from "../lib/types.js";

// Re-export the cron-runs helper (kept here so the API
// handlers + the cron jobs share the same env-passing
// pattern).
export { cronRunsDb };

export interface StatusEnv {
	DB?: D1Database;
	BUCKET?: R2Bucket;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function err(message: string, status = 500): Response {
	return json({ ok: false, error: message }, status);
}

// ─── /api/pm/status ─────────────────────────────────────────────────

export async function handleStatus(env: StatusEnv): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	try {
		// Single round-trip: count the trades, signals, and
		// open positions. We also fetch the latest cron run
		// to show in the status line.
		const counts = await env.DB
			.prepare(
				`SELECT
				   (SELECT COUNT(*) FROM trades WHERE user_id = ?1) as n_trades,
				   (SELECT COUNT(*) FROM signals WHERE user_id = ?1) as n_signals,
				   (SELECT COUNT(DISTINCT ticker) FROM trades t
				      WHERE user_id = ?1 AND t.action = 'open'
				        AND NOT EXISTS (SELECT 1 FROM trades c
				          WHERE c.user_id = t.user_id
				            AND c.ticker = t.ticker
				            AND c.action = 'close'
				            AND c.id > t.id
				        )) as n_open_positions`,
			)
			.bind(DEFAULT_USER_ID)
			.first<{ n_trades: number; n_signals: number; n_open_positions: number }>();
		const pnlRow = await env.DB
			.prepare(
				`SELECT
				   COALESCE(SUM(CASE WHEN pnl_cents IS NOT NULL AND ts >= (unixepoch() * 1000 - 86400000)
				                     THEN pnl_cents ELSE 0 END), 0) as pnl_24h_cents,
				   COALESCE(SUM(CASE WHEN pnl_cents IS NOT NULL
				                     THEN pnl_cents ELSE 0 END), 0) as pnl_total_cents
				 FROM trades WHERE user_id = ?1`,
			)
			.bind(DEFAULT_USER_ID)
			.first<{ pnl_24h_cents: number; pnl_total_cents: number }>();
		const latestCron = await cronRunsDb.lastRun(env.DB, "daily", DEFAULT_USER_ID);
		return json({
			ok: true,
			user_id: DEFAULT_USER_ID,
			counts: {
				n_trades: counts?.n_trades ?? 0,
				n_signals: counts?.n_signals ?? 0,
				n_open_positions: counts?.n_open_positions ?? 0,
			},
			pnl: {
				last_24h_cents: pnlRow?.pnl_24h_cents ?? 0,
				total_cents: pnlRow?.pnl_total_cents ?? 0,
			},
			latest_daily_cron: latestCron
				? {
						ts: latestCron.ts,
						status: latestCron.status,
						duration_ms: latestCron.duration_ms,
						error_message: latestCron.error_message,
					}
				: null,
		});
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}

// ─── /api/pm/summary ──────────────────────────────────────────────

export async function handleSummary(
	env: StatusEnv,
	_url: URL,
): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	try {
		// 2026-08-11: the summary endpoint used to read
		// the R2 daily-recap first (frozen at 06:00 UTC
		// every day) and fall back to a live aggregate.
		// That was wrong for the dashboard: the R2 file
		// captures the 06:00-to-06:00 window, so the
		// hero "24h PnL" was stuck at the previous
		// daily run's value for 24h. The live aggregate
		// is a rolling 24h from now (which is what the
		// label actually promises). The R2 file is kept
		// as a pure archive (daily-cron still writes it,
		// readDailyRecap is still exported for any
		// historical caller); it just doesn't drive the
		// live dashboard anymore.
		const since = Date.now() - 24 * 60 * 60 * 1000;
		const tradesAgg = await env.DB
			.prepare(
				`SELECT
				   COUNT(*) as n_trades,
				   COALESCE(SUM(CASE WHEN pnl_cents IS NOT NULL
				                     THEN pnl_cents ELSE 0 END), 0) as pnl_cents
				 FROM trades WHERE user_id = ?1 AND ts >= ?2`,
			)
			.bind(DEFAULT_USER_ID, since)
			.first<{ n_trades: number; pnl_cents: number }>();
		// Per-vertical breakdown (chunk 10.8). Drives the
		// "Per-vertical breakdown" card in the dashboard.
		// 2026-08-09: now includes lifetime PnL alongside the
		// 24h window. Always includes the 4 standard verticals
		// (weather / economic / politics / sports) with 0
		// values for any that haven't traded yet, so the
		// dashboard has a consistent shape.
		const perVerticalRows = await env.DB
			.prepare(
				`SELECT
				   vertical,
				   COUNT(*) as n_trades,
				   COALESCE(SUM(CASE WHEN pnl_cents IS NOT NULL
				                     THEN pnl_cents ELSE 0 END), 0) as pnl_cents
				 FROM trades
				 WHERE user_id = ?1 AND ts >= ?2 AND vertical IS NOT NULL
				 GROUP BY vertical
				 ORDER BY pnl_cents DESC`,
			)
			.bind(DEFAULT_USER_ID, since)
			.all<{ vertical: string; n_trades: number; pnl_cents: number }>();
		// 2026-08-09: lifetime PnL per vertical — same shape
		// but no `ts >= ?2` filter. Drives the "Lifetime PnL"
		// column in the dashboard.
		const perVerticalLifetimeRows = await env.DB
			.prepare(
				`SELECT
				   vertical,
				   COUNT(*) as n_trades,
				   COALESCE(SUM(CASE WHEN pnl_cents IS NOT NULL
				                     THEN pnl_cents ELSE 0 END), 0) as pnl_cents,
				   MIN(ts) as first_trade_ts
				 FROM trades
				 WHERE user_id = ?1 AND vertical IS NOT NULL
				 GROUP BY vertical`,
			)
			.bind(DEFAULT_USER_ID)
			.all<{
				vertical: string;
				n_trades: number;
				pnl_cents: number;
				first_trade_ts: number;
			}>();
		const STANDARD_VERTICALS = ["weather", "economic", "politics", "sports"];
		const verticals: Record<
			string,
			{
				n_trades_24h: number;
				pnl_24h_cents: number;
				n_trades_lifetime: number;
				pnl_lifetime_cents: number;
				first_trade_ts: number | null;
				n_open: number;
			}
		> = {};
		// Seed with all 4 standard verticals at zero so the
		// dashboard always has the same row count.
		for (const v of STANDARD_VERTICALS) {
			verticals[v] = {
				n_trades_24h: 0,
				pnl_24h_cents: 0,
				n_trades_lifetime: 0,
				pnl_lifetime_cents: 0,
				first_trade_ts: null,
				n_open: 0,
			};
		}
		// Per-vertical open-position count (lifetime — we
		// don't really have "opened in last 24h and still
		// open" as a meaningful stat for a paper-trading
		// bot. n_open = number of tickers with a current
		// open position in that vertical).
		const perVerticalOpenRows = await env.DB
			.prepare(
				`SELECT
				   t.vertical,
				   COUNT(DISTINCT t.ticker) as n_open
				 FROM trades t
				 WHERE t.user_id = ?1
				   AND t.action = 'open'
				   AND t.vertical IS NOT NULL
				   AND NOT EXISTS (
				     SELECT 1 FROM trades c
				     WHERE c.user_id = t.user_id
				       AND c.ticker = t.ticker
				       AND c.action = 'close'
				       AND c.id > t.id
				   )
				 GROUP BY t.vertical`,
			)
			.bind(DEFAULT_USER_ID)
			.all<{ vertical: string; n_open: number }>();
		for (const row of perVerticalRows.results ?? []) {
			const v = verticals[row.vertical] ?? {
				n_trades_24h: 0,
				pnl_24h_cents: 0,
				n_trades_lifetime: 0,
				pnl_lifetime_cents: 0,
				first_trade_ts: null,
				n_open: 0,
			};
			v.n_trades_24h = row.n_trades;
			v.pnl_24h_cents = row.pnl_cents;
			verticals[row.vertical] = v;
		}
		for (const row of perVerticalLifetimeRows.results ?? []) {
			const v = verticals[row.vertical] ?? {
				n_trades_24h: 0,
				pnl_24h_cents: 0,
				n_trades_lifetime: 0,
				pnl_lifetime_cents: 0,
				first_trade_ts: null,
				n_open: 0,
			};
			v.n_trades_lifetime = row.n_trades;
			v.pnl_lifetime_cents = row.pnl_cents;
			v.first_trade_ts = row.first_trade_ts;
			verticals[row.vertical] = v;
		}
		for (const row of perVerticalOpenRows.results ?? []) {
			const v = verticals[row.vertical] ?? {
				n_trades_24h: 0,
				pnl_24h_cents: 0,
				n_trades_lifetime: 0,
				pnl_lifetime_cents: 0,
				first_trade_ts: null,
				n_open: 0,
			};
			v.n_open = row.n_open;
			verticals[row.vertical] = v;
		}
		// Also include a lifetime total across all verticals.
		const lifetimeAgg = await env.DB
			.prepare(
				`SELECT
				   COUNT(*) as n_trades,
				   COALESCE(SUM(CASE WHEN pnl_cents IS NOT NULL
				                     THEN pnl_cents ELSE 0 END), 0) as pnl_cents,
				   MIN(ts) as first_trade_ts
				 FROM trades
				 WHERE user_id = ?1 AND pnl_cents IS NOT NULL`,
			)
			.bind(DEFAULT_USER_ID)
			.first<{ n_trades: number; pnl_cents: number; first_trade_ts: number }>();
		return json({
			ok: true,
			source: "live",
			recap: {
				n_trades: tradesAgg?.n_trades ?? 0,
				pnl_cents: tradesAgg?.pnl_cents ?? 0,
				// 2026-08-11: legacy aliases so the
				// dashboard's hero "24h PnL" / "X trades
				// 24h" KPIs read the same field names
				// regardless of source (R2 vs live).
				// See the R2 branch above for context.
				n_trades_24h: tradesAgg?.n_trades ?? 0,
				pnl_24h_cents: tradesAgg?.pnl_cents ?? 0,
				last_24h_cents: tradesAgg?.pnl_cents ?? 0,
				realized_cents: tradesAgg?.pnl_cents ?? 0,
				lookback_hours: 24,
				verticals,
				lifetime: {
					n_trades: lifetimeAgg?.n_trades ?? 0,
					pnl_cents: lifetimeAgg?.pnl_cents ?? 0,
					first_trade_ts: lifetimeAgg?.first_trade_ts ?? null,
				},
			},
		});
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}

// ─── /api/pm/trades ────────────────────────────────────────────────

export async function handleTrades(
	env: StatusEnv,
	url: URL,
): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	try {
		const ticker = url.searchParams.get("ticker") ?? undefined;
		const sinceStr = url.searchParams.get("since");
		const limitStr = url.searchParams.get("limit");
		const since = sinceStr ? parseInt(sinceStr, 10) : undefined;
		const limit = limitStr ? parseInt(limitStr, 10) : undefined;
		const rows = await tradesDb.list(env.DB, DEFAULT_USER_ID, {
			ticker,
			since_ts: Number.isFinite(since) ? since : undefined,
			limit: Number.isFinite(limit) ? limit : undefined,
		});
		return json({ ok: true, n: rows.length, trades: rows });
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}

// ─── /api/pm/signals ───────────────────────────────────────────────

export async function handleSignals(
	env: StatusEnv,
	url: URL,
): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	try {
		const ticker = url.searchParams.get("ticker") ?? undefined;
		const source = url.searchParams.get("source") as
			| "live"
			| "shadow"
			| "backtest"
			| undefined;
		const limitStr = url.searchParams.get("limit");
		const limit = limitStr ? parseInt(limitStr, 10) : undefined;
		const rows = await signalsDb.list(env.DB, DEFAULT_USER_ID, {
			ticker,
			source: source ?? undefined,
			limit: Number.isFinite(limit) ? limit : undefined,
		});
		return json({ ok: true, n: rows.length, signals: rows });
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}

// ─── /api/pm/scans ────────────────────────────────────────────────

export async function handleScans(env: StatusEnv): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	try {
		const latest = await scansDb.latest(env.DB, DEFAULT_USER_ID);
		if (!latest) return json({ ok: true, found: false });
		return json({
			ok: true,
			found: true,
			row: latest.row,
			candidates: latest.candidates,
		});
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}

// ─── /api/pm/cron-runs ────────────────────────────────────────────

export async function handleCronRuns(
	env: StatusEnv,
	url: URL,
): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	try {
		const cron = url.searchParams.get("cron") ?? undefined;
		const limitStr = url.searchParams.get("limit");
		const limit = limitStr ? parseInt(limitStr, 10) : 20;
		// No "list by cron_name" helper in db.ts; do an inline
		// query. Keeps the SQL near the handler for readability.
		const where: string[] = ["user_id = ?1"];
		const params: unknown[] = [DEFAULT_USER_ID];
		if (cron) {
			where.push("cron_name = ?");
			params.push(cron);
		}
		const sql = `SELECT * FROM cron_runs WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`;
		params.push(Number.isFinite(limit) ? limit : 20);
		const res = await env.DB
			.prepare(sql)
			.bind(...params)
			.all();
		return json({ ok: true, n: (res.results ?? []).length, runs: res.results });
	} catch (e) {
		return err(e instanceof Error ? e.message : String(e));
	}
}
