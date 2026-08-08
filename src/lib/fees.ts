/**
 * pm-bot — Kalshi taker fee math.
 *
 * Mirrors `Prediction Market Lab/.../live/paper_engine.py:kalshi_taker_fee_cents`.
 *
 * Kalshi's taker fee for binary markets (default `fee_type='quadratic'`
 * for almost all event contracts; see
 * https://kalshi.com/docs/kalshi-fee-schedule.pdf):
 *
 *   fee_cents = ceil(0.07 * size * P * (1 - P) * 100)
 *
 * where `size` is the number of contracts and `P` is the entry price in
 * dollars (0 < P < 1). The fee is symmetric across YES/NO sides — buying
 * YES at 70c costs the same as buying NO at 30c — so the `side` argument
 * is ignored in the math (we keep it on the call site for readability
 * and to match the `_record_trade` signature).
 *
 * Worked examples (1 contract):
 *   10c/90c: 0.07 * 1 * 0.10 * 0.90 * 100 = 0.63 -> 1c
 *   30c/70c: 0.07 * 1 * 0.30 * 0.70 * 100 = 1.47 -> 2c
 *   50c/50c: 0.07 * 1 * 0.50 * 0.50 * 100 = 1.75 -> 2c
 *   5 contracts at 50c: 0.07 * 5 * 0.25 * 100 = 8.75 -> 9c
 */

import type { Side } from "../lib/types.js";

/**
 * Kalshi taker fee for a binary-market trade, in cents (rounded up).
 *
 * @param side          "yes" or "no" (ignored — fee is symmetric).
 * @param size          Number of contracts.
 * @param entryPriceCents  The YES-side price in cents (1-99). 0 and 100
 *                        are degenerate (no fee); out-of-range values
 *                        clamp to 0 fee.
 * @returns             Fee in cents, always >= 0.
 */
export function kalshiTakerFeeCents(
	side: Side,
	size: number,
	entryPriceCents: number,
): number {
	if (size <= 0) return 0;
	// Clamp to a valid price range. The quadratic formula has zero fee
	// at exactly 0c and 100c, but Kalshi's binary markets don't trade
	// there in practice. We clamp defensively rather than returning a
	// negative fee or crashing on out-of-band inputs.
	if (entryPriceCents <= 0 || entryPriceCents >= 100) return 0;
	const pDollars = entryPriceCents / 100;
	const feeCents = Math.ceil(0.07 * size * pDollars * (1 - pDollars) * 100);
	return feeCents;
}

/**
 * Check whether a trade at `entryPriceCents` is structurally guaranteed
 * to lose money after fees — the user-flagged guardrail
 * (2026-08-07: "it shouldn't buy something if the max potential gain is
 * less than the fee to place/sell").
 *
 * A binary contract pays at most 100c/contract on settlement. If the
 * cost is, say, 99c, the max gain is 1c, which is <= the 2c round-trip
 * fee (entry + worst-case auto-close). Such trades are guaranteed to
 * lose money after fees regardless of the model's confidence.
 *
 * @param entryPriceCents  The YES-side entry price in cents.
 * @param size             The position size in contracts.
 * @returns                True if the trade CANNOT be profitable after
 *                         fees. False if the trade has positive
 *                         expected math.
 */
export function isStructurallyUnprofitable(
	entryPriceCents: number,
	size: number,
): boolean {
	if (size <= 0) return true;
	// 1c and 99c are also degenerate (max gain 1c < 2c fees).
	if (entryPriceCents <= 1 || entryPriceCents >= 99) return true;
	// Conservative worst-case: 2x entry fee (entry + auto-close).
	const entryFee = kalshiTakerFeeCents("yes", size, entryPriceCents);
	const worstCaseFees = entryFee * 2;
	const costCents =
		entryPriceCents * size; // YES-side cost approximation; same answer
	// for NO (complement price) because both sides pay the same fee.
	const maxPayoutCents = 100 * size;
	const maxGainCents = maxPayoutCents - costCents - worstCaseFees;
	return maxGainCents <= 0;
}
