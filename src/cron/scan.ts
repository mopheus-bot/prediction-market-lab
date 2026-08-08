/**
 * pm-bot — scan math (chunk 5).
 *
 * Mirrors `Prediction Market Lab/.../live/scan.py`:
 *   - `computeRealizedVol` (sample std of returns)
 *   - `scoreMarket` (vol * sqrt(n_trades) + log(vol24h+1) * 0.5)
 *   - `rankCandidates` (sort by score desc, filter, top N)
 *
 * Pure functions. The cron job (`./scan-cron.ts`) wraps them
 * with the actual Kalshi REST + D1 writes.
 */

/** A single market's scan result. Mirrors the Python `ScanCandidate`. */
export interface ScanCandidate {
	ticker: string;
	category: string | null;
	vertical: string | null;
	/** Sample std of percentage returns over the lookback window. */
	vol: number;
	/** Number of trades in the lookback window. */
	n_trades: number;
	/** 24h volume in contracts (sum of trade counts in the window). */
	vol24h: number;
	/** Scanner score (output of `scoreMarket`). */
	score: number;
	/** ISO 8601 timestamp of the most recent trade, or null. */
	last_trade_at: string | null;
}

/**
 * Sample standard deviation of the percentage returns between
 * consecutive trade prices. Returns 0.0 if the sequence has
 * fewer than 2 valid (positive-price) trades.
 */
export function computeRealizedVol(prices: ReadonlyArray<number>): number {
	if (prices.length < 2) return 0;
	const valid: number[] = [];
	for (let i = 1; i < prices.length; i++) {
		const prev = prices[i - 1];
		const cur = prices[i];
		if (prev > 0) valid.push((cur - prev) / prev);
	}
	if (valid.length < 2) return 0;
	const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
	let sqDev = 0;
	for (const r of valid) sqDev += (r - mean) ** 2;
	return Math.sqrt(sqDev / (valid.length - 1));
}

/**
 * Scanner score:
 *   score = vol * sqrt(n_trades) + log(vol24h + 1) * 0.5
 *
 * Rewards both (a) realized vol AND (b) current 24h activity.
 * The log() compresses the vol24h term so a single 30k-trade
 * market doesn't dominate.
 */
export function scoreMarket(vol: number, nTrades: number, vol24h = 0): number {
	if (vol <= 0 && vol24h <= 0) return 0;
	if (vol <= 0 || nTrades <= 0) {
		// No realized vol but live activity still earns the log term.
		return Math.log(vol24h + 1) * 0.5;
	}
	return vol * Math.sqrt(nTrades) + Math.log(vol24h + 1) * 0.5;
}

/**
 * Sort candidates by score (descending) and return the top N.
 * Candidates with score = 0 are excluded. Optional floors on
 * `vol` and `vol24h` are applied pre-sort.
 */
export function rankCandidates(
	candidates: ReadonlyArray<ScanCandidate>,
	topN: number,
	minVol = 0,
	minVol24h = 0,
): ScanCandidate[] {
	const filtered = candidates.filter(
		(c) => c.score > 0 && c.vol >= minVol && c.vol24h >= minVol24h,
	);
	filtered.sort((a, b) => b.score - a.score);
	return filtered.slice(0, topN);
}
