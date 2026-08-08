/**
 * pm-bot — `NaiveSignal` strategy.
 *
 * Mirrors `Prediction Market Lab/.../strategy/naive.py:NaiveSignal`.
 *
 * The naive signal: **fade a move > 5% over the lookback window**.
 *
 * The strategy compares `priceHistory[0]` (old) to `priceHistory[-1]`
 * (new) and computes `(new - old) / old`. If the relative move
 * exceeds `FADE_THRESHOLD` (5%), the signal fades the move (takes the
 * opposite side). No "follow" case — see the Python module docstring
 * for the rationale (a "follow small moves" rule on a mean-reverting
 * walk without news shocks is break-even, and the 60-70% follow
 * signals cancel out the fade edge in the synthetic data).
 *
 * This is the chunk-3 placeholder strategy. Chunk 4 (ONNX models)
 * adds ML-based strategies that handle real momentum vs noise
 * discrimination; the per-vertical router in `router.ts` dispatches
 * to the right strategy by `market.vertical`.
 */

import {
	FADE_THRESHOLD,
	type Signal,
	type SignalContext,
	type SignalStrategy,
} from "./signal.js";

export class NaiveSignal implements SignalStrategy {
	readonly name: string;
	readonly size: number;

	constructor(opts: { size?: number; name?: string } = {}) {
		this.size = opts.size ?? 1;
		this.name = opts.name ?? "naive";
		if (this.size < 1) {
			throw new Error(`size must be >= 1, got ${this.size}`);
		}
	}

	__call(ctx: SignalContext): Signal | null {
		if (ctx.priceHistory.length < 2) return null;
		const oldPrice = ctx.priceHistory[0];
		const newPrice = ctx.priceHistory[ctx.priceHistory.length - 1];
		if (oldPrice <= 0) return null;

		const movePct = (newPrice - oldPrice) / oldPrice;

		if (Math.abs(movePct) > FADE_THRESHOLD) {
			// Big move — fade (overreaction hypothesis).
			if (movePct > 0) {
				return {
					side: "no",
					price: Math.round(newPrice),
					size: this.size,
					rationale: `${this.name}_fade_up`,
					p: 0.55, // Naive signal has no model confidence; default 0.55.
				};
			}
			return {
				side: "yes",
				price: Math.round(newPrice),
				size: this.size,
				rationale: `${this.name}_fade_down`,
				p: 0.55,
			};
		}
		return null;
	}
}
