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
 * **Per-vertical threshold override (2026-08-10):** the default
 * 5% is calibrated to high-vol synthetic data. On Kalshi's real
 * markets, low-vol verticals (weather, single-game sports) rarely
 * move 5% in 60 polls. The operator can pass `fade_threshold` in
 * the constructor to override — e.g. `new NaiveSignal({
 * fade_threshold: 0.02, name: "naive_weather" })` for a 2%
 * threshold. The router passes per-vertical values when the
 * strategy is wired up; tests use the default.
 *
 * **Reversal confirmation gate (2026-08-11, option 2):** the
 * naive fade is a "catching a falling knife" pattern on
 * trending markets. To make it safer, require that the
 * orderbook on the side we're betting on has real depth
 * (≥ `min_support_contracts` contracts at the best bid).
 * A thin bid means nobody is stepping in to support the
 * bounce — the fade is unlikely to fill / the fill is
 * unlikely to mean-revert. With a deep bid, somebody
 * else is also betting the bounce, which is evidence
 * (not proof) of a real reversal. Default 0 = off
 * (back-compat); the router sets it to 3 for live use.
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

export interface NaiveSignalOpts {
	size?: number;
	name?: string;
	/** Override the default 5% fade threshold. Useful for
	 *  low-vol verticals (weather) where 5% is too high and
	 *  the strategy would never fire. Pass a fraction (0.02
	 *  = 2%, not 2 cents). */
	fade_threshold?: number;
	/** Minimum absolute price move (in cents) to fire on.
	 *  The signal fires when EITHER the percentage threshold
	 *  OR this absolute threshold is exceeded. Useful for
	 *  stable markets (e.g. KXWARMING-50 at 78¢) where a 1¢
	 *  move is 1.3% — both meaningful in absolute terms
	 *  (entry edge) and would never hit a 5% percentage
	 *  threshold. Pass 0 to disable (percentage only). */
	min_absolute_move_cents?: number;
	/** Reversal confirmation: require at least this many
	 *  contracts at the best bid on the side we're betting
	 *  on. Filters out "fade into a void" entries on thin
	 *  books where the price is dropping because no one is
	 *  bidding, not because a buyer is about to step in.
	 *  Pass 0 to disable. Default 0. */
	min_support_contracts?: number;
}

export class NaiveSignal implements SignalStrategy {
	readonly name: string;
	readonly size: number;
	private readonly fade_threshold: number;
	private readonly min_absolute_move_cents: number;
	private readonly min_support_contracts: number;

	constructor(opts: NaiveSignalOpts = {}) {
		this.size = opts.size ?? 1;
		this.name = opts.name ?? "naive";
		this.fade_threshold = opts.fade_threshold ?? FADE_THRESHOLD;
		this.min_absolute_move_cents = opts.min_absolute_move_cents ?? 0;
		this.min_support_contracts = opts.min_support_contracts ?? 0;
		if (this.size < 1) {
			throw new Error(`size must be >= 1, got ${this.size}`);
		}
		if (this.fade_threshold <= 0 || this.fade_threshold > 1) {
			throw new Error(
				`fade_threshold must be in (0, 1], got ${this.fade_threshold}`,
			);
		}
		if (this.min_absolute_move_cents < 0 || this.min_absolute_move_cents > 99) {
			throw new Error(
				`min_absolute_move_cents must be in [0, 99], got ${this.min_absolute_move_cents}`,
			);
		}
		if (this.min_support_contracts < 0) {
			throw new Error(
				`min_support_contracts must be >= 0, got ${this.min_support_contracts}`,
			);
		}
	}

	__call(ctx: SignalContext): Signal | null {
		if (ctx.priceHistory.length < 2) return null;
		const oldPrice = ctx.priceHistory[0];
		const newPrice = ctx.priceHistory[ctx.priceHistory.length - 1];
		if (oldPrice <= 0) return null;

		const movePct = (newPrice - oldPrice) / oldPrice;
		const moveCents = Math.abs(newPrice - oldPrice);

		// Fire if EITHER threshold is exceeded. The
		// percentage threshold is the "high-vol fade" path
		// (5% on a 50¢ market = 2.5¢ — meaningful).
		// The absolute threshold is the "stable-market
		// micro-move" path (1¢ on a 78¢ market = 1.3% —
		// meaningful in absolute edge, below percentage
		// thresholds). The bot uses both for low-vol
		// verticals.
		const exceedsPct = Math.abs(movePct) > this.fade_threshold;
		const exceedsAbs =
			this.min_absolute_move_cents > 0 &&
			moveCents >= this.min_absolute_move_cents;
		if (!exceedsPct && !exceedsAbs) return null;

		// Tag the rationale with which threshold fired so
		// the operator can tell the two paths apart in
		// the signals log. The direction suffix describes
		// the price move (not the signal side): "up" =
		// price went up, we fade → side is no. "down" =
		// price went down, we fade → side is yes.
		const trigger = exceedsPct ? "fade" : "abs";
		const direction = movePct > 0 ? "up" : "down";
		const side: "yes" | "no" = movePct > 0 ? "no" : "yes";

		// Reversal confirmation gate. If the gate is on
		// and the orderbook is too thin on the side we're
		// betting on, drop the signal — the fade has no
		// real support.
		//
		// side=yes  → we want YES to go up; require depth
		//             at the YES best bid.
		// side=no   → we want NO to go up; require depth
		//             at the NO best bid.
		if (this.min_support_contracts > 0) {
			const depth = side === "yes"
				? this.bestBidDepth(ctx, "yes")
				: this.bestBidDepth(ctx, "no");
			if (depth < this.min_support_contracts) return null;
		}

		return {
			side,
			price: Math.round(newPrice),
			size: this.size,
			rationale: `${this.name}_${trigger}_${direction}`,
			p: 0.55,
		};
	}

	/** Sum the contract counts at the best bid price on
	 *  the given side. Returns 0 if no book is present
	 *  or the side has no levels. The caller treats 0
	 *  as "no support" — the gate filters it out when
	 *  min_support_contracts > 0. */
	private bestBidDepth(
		ctx: SignalContext,
		side: "yes" | "no",
	): number {
		const ob = ctx.orderbook;
		if (!ob) return 0;
		const levels = side === "yes" ? ob.yesLevels : ob.noLevels;
		if (levels.length === 0) return 0;
		const top = Math.max(...levels.map((l) => l.priceCents));
		let sum = 0;
		for (const l of levels) {
			if (l.priceCents === top) sum += l.count;
		}
		return sum;
	}
}
