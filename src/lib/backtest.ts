/**
 * prediction-market-lab — backtest model retrospective.
 *
 * The "backtest" here is a model retrospective, not a full
 * historical simulation. It looks at the trades the bot
 * has already made (last N days), counts how often the
 * model's predicted signal_p aligned with the actual
 * outcome, and reports metrics. The metrics are registered
 * as a `candidate` model in the registry, so the operator
 * can see the trend over time.
 *
 * Why retrospective, not full backtest?
 *   - The bot doesn't have enough historical market_snapshots
 *     yet to replay a real-time strategy on.
 *   - A retrospective gives the same signal — "is the
 *     model good?" — without requiring a full simulation
 *     infra.
 *   - When + adds more historical data, this can
 *     evolve into a full replay.
 *
 * **Why it matters:** the user said "back testing stands
 * out" — they want the bot to evaluate its own performance
 * automatically. The model retrospective does that.
 *
 * **Metrics:**
 *   - `trade_count` — number of closed trades in the window
 *   - `wins` / `losses` / `pending` — outcomes
 *   - `win_rate` — wins / (wins + losses), 0..1
 *   - `total_pnl_cents` — sum of pnl_cents
 *   - `avg_pnl_cents` — mean
 *   - `model_agreement_rate` — fraction of trades where
 *     `signal_p > 0.5` aligned with `pnl_cents > 0`
 *     (model was "predicting the right direction" when
 *     it took the trade). This is the proxy for "is the
 *     model good".
 */

import { trades as tradesDb } from "./db.js";
import { DEFAULT_USER_ID, type TradeRow } from "./types.js";

export interface BacktestMetrics {
	period: {
		since_ts: number;
		until_ts: number;
		days: number;
	};
	trade_count: number;
	wins: number;
	losses: number;
	pending: number; // trades with no pnl yet (open position)
	win_rate: number; // 0..1, NaN if no closed trades
	total_pnl_cents: number;
	avg_pnl_cents: number;
	model_agreement_rate: number; // 0..1, NaN if no closed trades
	model_agreement_count: number; // closed trades where model was right
	verticals: Record<string, { trades: number; wins: number; pnl_cents: number }>;
}

export interface BacktestEnv {
	DB?: D1Database;
}

/** Round to 4 decimal places. */
function round4(n: number): number {
	if (Number.isNaN(n)) return NaN;
	return Math.round(n * 10000) / 10000;
}

/** Compute the metrics for a list of trades. Pure function,
 *  no I/O — easy to test. */
export function computeBacktestMetrics(
	trades: TradeRow[],
	nowMs: number,
	windowDays = 7,
): BacktestMetrics {
	const since_ts = nowMs - windowDays * 24 * 60 * 60 * 1000;
	const until_ts = nowMs;
	let trade_count = 0;
	let wins = 0;
	let losses = 0;
	let pending = 0;
	let total_pnl_cents = 0;
	let closed_count = 0;
	let agreement_count = 0;
	const verticals: BacktestMetrics["verticals"] = {};

	for (const t of trades) {
		if (t.ts < since_ts) continue;
		trade_count += 1;
		const v = t.vertical;
		if (!verticals[v]) verticals[v] = { trades: 0, wins: 0, pnl_cents: 0 };
		verticals[v].trades += 1;
		verticals[v].pnl_cents += t.pnl_cents ?? 0;

		if (t.pnl_cents === null || t.pnl_cents === undefined) {
			pending += 1;
			continue;
		}
		closed_count += 1;
		total_pnl_cents += t.pnl_cents;
		if (t.pnl_cents > 0) {
			wins += 1;
			verticals[v].wins += 1;
		} else if (t.pnl_cents < 0) {
			losses += 1;
		}
		// Model agreement: the model said "go" (signal_p > 0.5)
		// and the trade was a win, OR the model said "no"
		// (signal_p <= 0.5) and the trade would have been a
		// loss. We only count trades that DID happen, so
		// "go + win" is the only "model was right" outcome.
		// A "go + loss" is the model being wrong.
		// (The "no" cases aren't in the trades table because
		// the bot didn't act on them.)
		if (t.signal_p !== null && t.signal_p > 0.5 && t.pnl_cents > 0) {
			agreement_count += 1;
		}
	}

	const win_rate = closed_count > 0 ? wins / closed_count: NaN;
	const avg_pnl_cents = closed_count > 0 ? total_pnl_cents / closed_count: 0;
	const model_agreement_rate =
		closed_count > 0 ? agreement_count / closed_count: NaN;

	return {
		period: { since_ts, until_ts, days: windowDays },
		trade_count,
		wins,
		losses,
		pending,
		win_rate: round4(win_rate),
		total_pnl_cents,
		avg_pnl_cents: round4(avg_pnl_cents),
		model_agreement_rate: round4(model_agreement_rate),
		model_agreement_count: agreement_count,
		verticals,
	};
}

/** Pull trades from D1 + compute metrics. The D1 call is
 *  optional — if the binding is missing, returns null. */
export async function runBacktest(
	env: BacktestEnv,
	nowMs: number = Date.now(),
	windowDays = 7,
): Promise<BacktestMetrics | null> {
	if (!env.DB) return null;
	const since_ts = nowMs - windowDays * 24 * 60 * 60 * 1000;
	const trades = await tradesDb
		.list(env.DB, DEFAULT_USER_ID, { limit: 1000, since_ts })
		.catch(() => []);
	return computeBacktestMetrics(trades, nowMs, windowDays);
}

/** Format a BacktestMetrics as a one-line summary for the
 *  cron_runs.notes field. */
export function metricsSummary(m: BacktestMetrics): string {
	if (m.trade_count === 0) return "no trades in window";
	const winStr = Number.isNaN(m.win_rate) ? "n/a": `${(m.win_rate * 100).toFixed(0)}%`;
	const agrStr = Number.isNaN(m.model_agreement_rate)
		? "n/a"
		: `${(m.model_agreement_rate * 100).toFixed(0)}%`;
	return [
		`trades=${m.trade_count}`,
		`wins=${m.wins} losses=${m.losses} pending=${m.pending}`,
		`win_rate=${winStr}`,
		`model_agreement=${agrStr}`,
		`pnl=${m.total_pnl_cents}¢ (${(m.total_pnl_cents / 100).toFixed(2)})`,
	].join(" · ");
}
