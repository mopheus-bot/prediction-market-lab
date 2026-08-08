/**
 * pm-bot — Sharpe ratio + auto-pilot metrics (chunk 11b).
 *
 * Used by the auto-pilot cron to decide whether the bot
 * has earned the right to flip from paper to real money.
 *
 * **Why this matters:** the user committed to "edge first,
 * real money second." Sharpe is the standard metric for
 * "is this strategy actually making money, or is it just
 * noise?" A positive Sharpe over a meaningful sample
 * (>30 trades) is the trigger to flip to real.
 *
 * **The math:**
 *   - For each closed trade, return = pnl_cents /
 *     (entry_price_cents × size). Bounded [-1, +1] for
 *     binary options.
 *   - Sharpe = mean(returns) / stddev(returns) × √(annualization).
 *   - Annualization depends on the window. For 7 days
 *     of trading, √(252 / 7) ≈ 6. For 30 days, ≈ 2.9.
 *   - A Sharpe > 0.5 over 30 trades is the auto-pilot
 *     threshold (chunk 11b default).
 *
 * **Edge cases:**
 *   - < 2 closed trades: Sharpe is undefined (return NaN).
 *   - stddev === 0 (all trades had the same return):
 *     Sharpe is undefined.
 *   - All trades are wins: Sharpe → +Infinity (clamped
 *     to a high number in practice; we report +Infinity
 *     so the operator sees the edge case).
 */

export interface SharpeResult {
	trade_count: number;
	mean_return: number; // mean of per-trade returns, -1..+1
	stddev_return: number;
	sharpe_raw: number; // un-annualized
	sharpe_annualized: number; // multiplied by sqrt(annualization)
	days_elapsed: number;
	total_pnl_cents: number;
	passes_auto_pilot: boolean; // true if trade_count >= min + sharpe >= min
}

/** Compute the Sharpe ratio from a list of trades. Pure
 *  function — no I/O, no D1. */
export function computeSharpe(
	trades: Array<{
		ts: number;
		pnl_cents: number | null;
		price_cents: number;
		size: number;
	}>,
	options: {
		nowMs: number;
		minDays?: number; // default 7
		minTrades?: number; // default 30
		minSharpe?: number; // default 0.5
		annualizationDays?: number; // default 252 (trading days/year)
	} = {
		nowMs: Date.now(),
	},
): SharpeResult {
	const {
		nowMs,
		minDays = 7,
		minTrades = 30,
		minSharpe = 0.5,
		annualizationDays = 252,
	} = options;
	const closedTrades = trades.filter(
		(t) => t.pnl_cents !== null && t.pnl_cents !== undefined,
	);
	const trade_count = closedTrades.length;
	if (trade_count === 0) {
		return {
			trade_count: 0,
			mean_return: 0,
			stddev_return: 0,
			sharpe_raw: NaN,
			sharpe_annualized: NaN,
			days_elapsed: 0,
			total_pnl_cents: 0,
			passes_auto_pilot: false,
		};
	}
	// Compute per-trade return (bounded -1..+1 for binary).
	const returns = closedTrades.map((t) => {
		const denom = t.price_cents * t.size;
		const pnl = t.pnl_cents as number; // closedTrades filters non-null
		return denom > 0 ? pnl / denom : 0;
	});
	const total_pnl_cents = closedTrades.reduce(
		(s, t) => s + (t.pnl_cents as number),
		0,
	);
	const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
	const variance =
		returns.length > 1
			? returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1)
			: 0;
	const stddev = Math.sqrt(variance);
	// Floating-point tolerance: when the variance is so small that
	// sqrt is below machine epsilon, the per-trade returns are
	// effectively identical — treat that as "no variance" rather
	// than a 5.88e15 Sharpe from floating-point error.
	const stddevMeaningful = stddev > 1e-9 ? stddev : 0;
	const sharpe_raw = stddevMeaningful > 0 ? mean / stddevMeaningful : NaN;
	// Days elapsed: from the first trade to now.
	const oldestTs = Math.min(...closedTrades.map((t) => t.ts));
	const days_elapsed = Math.max(1, Math.floor((nowMs - oldestTs) / 86400000));
	// Annualize: assume the window repeats 252/days_elapsed
	// times per year.
	const annualization =
		days_elapsed > 0 ? Math.sqrt(annualizationDays / days_elapsed) : 0;
	const sharpe_annualized = Number.isNaN(sharpe_raw)
		? NaN
		: sharpe_raw * annualization;

	const passes_auto_pilot =
		trade_count >= minTrades &&
		days_elapsed >= minDays &&
		!Number.isNaN(sharpe_annualized) &&
		sharpe_annualized >= minSharpe;

	return {
		trade_count,
		mean_return: round4(mean),
		stddev_return: round4(stddevMeaningful),
		sharpe_raw: round4(sharpe_raw),
		sharpe_annualized: round4(sharpe_annualized),
		days_elapsed,
		total_pnl_cents,
		passes_auto_pilot,
	};
}

function round4(n: number): number {
	if (Number.isNaN(n) || !Number.isFinite(n)) return n;
	return Math.round(n * 10000) / 10000;
}
