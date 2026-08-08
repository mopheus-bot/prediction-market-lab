/**
 * pm-bot — feature extraction (chunk 4).
 *
 * Mirrors `Prediction Market Lab/.../features.py:extract_features`.
 *
 * The 20-dim feature vector is laid out as:
 *   0  price                (mid_price / 100, in [0, 1])
 *   1  spread               (yes_ask - yes_bid, in cents)
 *   2  time_to_resolution   ((ttl - age) / ttl, in [0, 1])
 *   3  volatility           (sample std of mid_price over lookback,
 *                            normalized by mid_price)
 *   4  orderbook_imbalance  ((yes_qty - no_qty) / (yes_qty + no_qty), in [-1, 1])
 *   5  news_shock_magnitude (abs(latest shock magnitude), in [0, 1])
 *   6  news_shock_age_hours (hours since latest shock, capped at 24)
 *   7  recent_move_pct      ((new - old) / old over the lookback)
 *   8-11 vertical one-hot    (politics, sports, weather, economic — exactly one is 1.0)
 *   12-19 per-vertical fundamentals (commit 6 — populated only for the matching vertical)
 *
 * **Live-vs-synthetic gap:** the live paper engine does NOT
 * have:
 *   - `time_to_resolution` (no `created_at_tick` / `ttl_seconds` on the live book)
 *   - `news_shock_magnitude` / `news_shock_age_hours` (no shock tracking in the WS feed)
 *   - `per-vertical fundamentals` (no live fundamentals source yet — chunk 6+)
 *
 * We default these to 0.0 (matching the Python trainer's
 * default for unmatched verticals). The model sees zeros for
 * features it wasn't trained to use (the live retrains in
 * chunk 8+ will produce a model that knows the inputs are
 * 0 and ignores them). For chunk 4 we ship the existing
 * 20-dim model with the documented limitations — see the
 * changelog.
 *
 * **Pure function:** no I/O, no state. Safe to call on every
 * WS frame.
 */

import type { Side, Vertical } from "../lib/types.js";
import type {
	SignalContext,
	SignalOrderbook,
} from "./signal.js";

/** Feature names in the same order as `extract_features` returns. */
export const FEATURE_NAMES: readonly string[] = [
	// 0-7: numeric features
	"price",
	"spread",
	"time_to_resolution",
	"volatility",
	"orderbook_imbalance",
	"news_shock_magnitude",
	"news_shock_age_hours",
	"recent_move_pct",
	// 8-11: vertical one-hot
	"vertical_politics",
	"vertical_sports",
	"vertical_weather",
	"vertical_economic",
	// 12-19: per-vertical fundamentals (commit 6)
	"fundamental_poll_margin",
	"fundamental_days_to_election_normalized",
	"fundamental_team_strength",
	"fundamental_injury_severity",
	"fundamental_forecast_value",
	"fundamental_forecast_confidence",
	"fundamental_consensus_value",
	"fundamental_surprise",
];

export const N_FEATURES = FEATURE_NAMES.length;
export const N_NUMERIC_FEATURES = 8;

export const VERTICAL_FEATURE_INDEX: Record<Vertical, number> = {
	politics: 8,
	sports: 9,
	weather: 10,
	economic: 11,
};

export const FUNDAMENTAL_FEATURES_BY_VERTICAL: Record<
	Vertical,
	Record<string, number>
> = {
	politics: {
		poll_margin: 12,
		days_to_election_normalized: 13,
	},
	sports: {
		team_strength: 14,
		injury_severity: 15,
	},
	weather: {
		forecast_value: 16,
		forecast_confidence: 17,
	},
	economic: {
		consensus_value: 18,
		surprise: 19,
	},
};

/** A 20-dim feature vector. */
export interface FeatureVector {
	values: Float64Array;
	feature_names: readonly string[];
}

export interface Fundamentals {
	[key: string]: number;
}

export interface MarketWithFundamentals {
	ticker: string;
	eventTicker?: string;
	vertical: Vertical | string;
	fundamentals?: Fundamentals;
	createdAtTick?: number;
	ttlSeconds?: number;
}

// ─── Top-level extraction ─────────────────────────────────────────────

/**
 * Extract a 20-dim feature vector from a `SignalContext`. Returns
 * a fresh `Float64Array` (the model expects 2D; the caller
 * reshapes).
 */
export function extractFeatures(ctx: SignalContext): FeatureVector {
	// 1. price: mid_price / 100
	let midPrice = 0;
	let spread = 0;
	let obImbalance = 0;
	if (ctx.orderbook) {
		const ob = ctx.orderbook;
		const yb = bestYesBidCents(ob);
		const ya = yesAskCents(ob);
		if (yb !== null && ya !== null) {
			midPrice = (yb + ya) / 2;
			spread = ya - yb;
		}
		// Orderbook imbalance: top-of-book depth ratio.
		const yesQty = ob.yesLevels[0]?.count ?? 0;
		const noQty = ob.noLevels[0]?.count ?? 0;
		obImbalance = safeDivide(yesQty - noQty, yesQty + noQty);
	}

	// 2. time_to_resolution. Live path: if the market carries
	// `createdAtTick` and `ttlSeconds`, use them. Otherwise
	// default to 0.5 (mid-life).
	let ttr = 0.5;
	const market = ctx.market as MarketWithFundamentals | null | undefined;
	if (
		market &&
		typeof market.createdAtTick === "number" &&
		typeof market.ttlSeconds === "number" &&
		market.ttlSeconds > 0
	) {
		const age = Math.max(0, ctx.currentTick - market.createdAtTick);
		ttr = Math.max(0, (market.ttlSeconds - age) / market.ttlSeconds);
	}

	// 3. volatility: sample std of price history, normalized by midPrice.
	let volatility = 0;
	if (ctx.priceHistory.length >= 2 && midPrice > 0) {
		const mean =
			ctx.priceHistory.reduce((a, b) => a + b, 0) / ctx.priceHistory.length;
		let s = 0;
		for (const p of ctx.priceHistory) s += (p - mean) ** 2;
		const variance = s / (ctx.priceHistory.length - 1);
		volatility = Math.sqrt(variance) / midPrice;
	}

	// 4-5. news shock features. Live path: no shocks. Default 0 / 24.0
	// (the Python trainer's "no recent shock" convention).
	const newsShockMag = 0;
	const newsShockAge = 24.0;

	// 6. recent_move_pct over the price history
	let recentMovePct = 0;
	if (ctx.priceHistory.length >= 2) {
		const oldP = ctx.priceHistory[0];
		const newP = ctx.priceHistory[ctx.priceHistory.length - 1];
		if (oldP > 0) recentMovePct = (newP - oldP) / oldP;
	}

	// 7-10. vertical one-hot
	const verticalOh = [0, 0, 0, 0];
	const vertical = market?.vertical as Vertical | undefined;
	if (vertical && vertical in VERTICAL_FEATURE_INDEX) {
		const idx = VERTICAL_FEATURE_INDEX[vertical] - 8;
		if (idx >= 0 && idx < 4) verticalOh[idx] = 1;
	}

	// 11-18. per-vertical fundamentals. Live path: no fundamentals
	// (chunk 6+). Default 0 for all 8; the vertical one-hot lets
	// the model mask the irrelevant 6.
	const fundamentalsArr = new Array(8).fill(0);
	if (market?.fundamentals && vertical && vertical in FUNDAMENTAL_FEATURES_BY_VERTICAL) {
		const fundMap = FUNDAMENTAL_FEATURES_BY_VERTICAL[vertical];
		for (const [name, featureIdx] of Object.entries(fundMap)) {
			const localIdx = featureIdx - 12;
			if (localIdx >= 0 && localIdx < 8) {
				const v = market.fundamentals[name];
				if (typeof v === "number") fundamentalsArr[localIdx] = v;
			}
		}
	}

	const priceNorm = safeDivide(midPrice, 100);

	const values = new Float64Array([
		priceNorm,
		spread,
		ttr,
		volatility,
		obImbalance,
		newsShockMag,
		newsShockAge,
		recentMovePct,
		verticalOh[0],
		verticalOh[1],
		verticalOh[2],
		verticalOh[3],
		fundamentalsArr[0],
		fundamentalsArr[1],
		fundamentalsArr[2],
		fundamentalsArr[3],
		fundamentalsArr[4],
		fundamentalsArr[5],
		fundamentalsArr[6],
		fundamentalsArr[7],
	]);
	return { values, feature_names: FEATURE_NAMES };
}

// ─── Orderbook helpers (mirror kalshi/models.ts but type-local) ─────

function bestYesBidCents(ob: SignalOrderbook): number | null {
	if (ob.yesLevels.length === 0) return null;
	let best = -Infinity;
	for (const l of ob.yesLevels) if (l.priceCents > best) best = l.priceCents;
	return best;
}

function bestNoBidCents(ob: SignalOrderbook): number | null {
	if (ob.noLevels.length === 0) return null;
	let best = -Infinity;
	for (const l of ob.noLevels) if (l.priceCents > best) best = l.priceCents;
	return best;
}

function yesAskCents(ob: SignalOrderbook): number | null {
	const no = bestNoBidCents(ob);
	return no === null ? null : 100 - no;
}

function noAskCents(ob: SignalOrderbook): number | null {
	const yes = bestYesBidCents(ob);
	return yes === null ? null : 100 - yes;
}

function safeDivide(numerator: number, denominator: number): number {
	if (denominator === 0) return 0;
	return numerator / denominator;
}

// ─── Batch extraction ────────────────────────────────────────────────

export function extractFeaturesBatch(contexts: SignalContext[]): Float64Array[] {
	return contexts.map((ctx) => extractFeatures(ctx).values);
}
