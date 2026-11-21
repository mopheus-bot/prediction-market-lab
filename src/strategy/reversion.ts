/**
 * prediction-market-lab — `ReversionQualitySignal`.
 *
 * Mirrors `Prediction Market Lab/.../model/reversion.py:ReversionQualitySignal`.
 *
 * The signal logic:
 *   1. Extract the 20-dim feature vector.
 *   2. Run the trained `RandomForestModel` to predict
 *      p_revert ∈ [0, 1].
 *   3. Compute the current price deviation from the
 *      rolling mean of the price history.
 *   4. If `|deviation| >= dev_min` AND `p_revert >= p_min`:
 *      a. deviation > 0: price is elevated → fade with NO
 *         at the no_ask.
 *      b. deviation < 0: price is depressed → fade with YES
 *         at the yes_ask.
 *   5. Else: no signal.
 *
 * Defaults: `dev_min = 1.5` (only trade on >1.5c deviations,
 * above the 2c spread noise floor) and `p_min = 0.30` (the
 * natural reversion base rate on synthetic data; this gates
 * out the worst 70% of non-reverting moves).
 *
 * **The model's `p` is used directly as the signal's `p`.**
 * This is what the Python engine's flip-filter logic compares
 * against — a future opposite signal must be EITHER
 * `>= entry_p * 1.5` (significantly more confident) OR the
 * current position is not in profit (otherwise we keep the
 * open position).
 */

import { extractFeatures, N_FEATURES } from "./features.js";
import type { RandomForestModel } from "./forest.js";
import type { Signal, SignalContext, SignalStrategy } from "./signal.js";

export interface ReversionQualitySignalOpts {
	model: RandomForestModel;
	dev_min?: number;
	p_min?: number;
	size?: number;
	/** For logging only; does not affect logic. */
	name?: string;
}

export class ReversionQualitySignal implements SignalStrategy {
	readonly name: string;
	private readonly model: RandomForestModel;
	private readonly dev_min: number;
	private readonly p_min: number;
	private readonly size: number;

	constructor(opts: ReversionQualitySignalOpts) {
		if (opts.model.n_features !== N_FEATURES) {
			throw new Error(
				`ReversionQualitySignal expects a ${N_FEATURES}-feature model, ` +
					`got ${opts.model.n_features}`,
			);
		}
		if (opts.model.n_classes !== 2) {
			throw new Error(
				`ReversionQualitySignal expects a binary classifier, ` +
					`got ${opts.model.n_classes} classes`,
			);
		}
		if (opts.dev_min !== undefined && opts.dev_min < 0) {
			throw new Error(`dev_min must be >= 0, got ${opts.dev_min}`);
		}
		if (opts.p_min !== undefined && (opts.p_min < 0 || opts.p_min > 1)) {
			throw new Error(`p_min must be in [0, 1], got ${opts.p_min}`);
		}
		if (opts.size !== undefined && opts.size < 1) {
			throw new Error(`size must be >= 1, got ${opts.size}`);
		}
		this.model = opts.model;
		this.dev_min = opts.dev_min ?? 1.5;
		this.p_min = opts.p_min ?? 0.30;
		this.size = opts.size ?? 1;
		this.name = opts.name ?? "reversion";
	}

	__call(ctx: SignalContext): Signal | null {
		if (!ctx.orderbook || ctx.priceHistory.length < 2) return null;

		// 1. Compute p_revert from the model.
		const fv = extractFeatures(ctx);
		const proba = this.model.predictProbaOne(Array.from(fv.values));
		// Binary classifier: proba[1] = P(class 1) = P(revert).
		const pRevert = proba[1] ?? 0;
		if (pRevert < this.p_min) return null;

		// 2. Compute current deviation from the rolling mean.
		const mean =
			ctx.priceHistory.reduce((a, b) => a + b, 0) / ctx.priceHistory.length;
		const ob = ctx.orderbook;
		const yb = bestYesBidCents(ob);
		const ya = yesAskCents(ob);
		if (yb === null || ya === null) return null;
		const cur = (yb + ya) / 2;
		const deviation = cur - mean;
		if (Math.abs(deviation) < this.dev_min) return null;

		// 3. Compute the asks (clamped to [1, 99]).
		const nb = bestNoBidCents(ob);
		if (nb === null) return null;
		const yesAsk = clamp(100 - nb, 1, 99);
		const noAsk = clamp(100 - yb, 1, 99);

		if (deviation > 0) {
			// Price is elevated — fade with NO.
			return {
				side: "no",
				price: noAsk,
				size: this.size,
				rationale: `rq_no_p=${pRevert.toFixed(2)}_d=${deviation.toFixed(1)}`,
				p: pRevert,
			};
		}
		// Price is depressed — fade with YES.
		return {
			side: "yes",
			price: yesAsk,
			size: this.size,
			rationale: `rq_yes_p=${pRevert.toFixed(2)}_d=${deviation.toFixed(1)}`,
			p: pRevert,
		};
	}
}

// ─── Orderbook helpers (mirror features.ts but local) ─────────────────

function bestYesBidCents(ob: { yesLevels: ReadonlyArray<{ priceCents: number }> }): number | null {
	if (ob.yesLevels.length === 0) return null;
	let best = -Infinity;
	for (const l of ob.yesLevels) if (l.priceCents > best) best = l.priceCents;
	return best;
}

function bestNoBidCents(ob: { noLevels: ReadonlyArray<{ priceCents: number }> }): number | null {
	if (ob.noLevels.length === 0) return null;
	let best = -Infinity;
	for (const l of ob.noLevels) if (l.priceCents > best) best = l.priceCents;
	return best;
}

function yesAskCents(ob: { noLevels: ReadonlyArray<{ priceCents: number }> }): number | null {
	const no = bestNoBidCents(ob);
	return no === null ? null: 100 - no;
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}
