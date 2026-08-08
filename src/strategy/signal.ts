/**
 * pm-bot — signal + signal-context types.
 *
 * Mirrors `Prediction Market Lab/.../sim/signal.py` and
 * `Prediction Market Lab/.../sim/backtester.py:SignalContext`.
 *
 * A `Signal` is what a strategy emits: an actionable trade idea. The
 * engine decides whether to actually place the trade (after risk
 * checks). A `SignalContext` bundles everything a strategy might want
 * to look at — price history, orderbook, market, tick. The naive
 * signal only uses `priceHistory`; future ML signals (chunk 4) use
 * the full context to extract features.
 */

import type { Side, Vertical } from "../lib/types.js";

// ─── Signal ─────────────────────────────────────────────────────────────

/** Threshold for the naive "fade" signal: moves > 5% trigger a fade. */
export const FADE_THRESHOLD = 0.05;

export interface Signal {
	/** What to take. */
	side: Side;
	/** Limit price to use for the order (cents). */
	price: number;
	/** Number of contracts (the risk engine may scale this). */
	size: number;
	/** Short string for debugging / logging. */
	rationale: string;
	/** Signal confidence (0.0 - 1.0). Used by the flip-filter. */
	p: number;
}

// ─── SignalContext ──────────────────────────────────────────────────────

/**
 * The market metadata stub. Mirrors the Python `PaperMarket` dataclass
 * from `paper_engine.py`. The strategy router reads
 * `market.vertical` to dispatch to the right per-vertical profile.
 */
export interface SignalMarket {
	ticker: string;
	eventTicker: string;
	vertical: Vertical | string;
	title?: string;
}

/** A snapshot of the orderbook at decision time. */
export interface SignalOrderbook {
	ticker: string;
	yesLevels: Array<{ priceCents: number; count: number }>;
	noLevels: Array<{ priceCents: number; count: number }>;
}

/**
 * The context passed to a strategy on each decision point.
 *
 * `priceHistory` is in cents (oldest first, newest last). The naive
 * signal compares `priceHistory[0]` to `priceHistory[-1]`.
 *
 * `orderbook` and `market` are optional so the same context can be
 * constructed from partial state (e.g. during the first few frames
 * before the orderbook has been seeded).
 */
export interface SignalContext {
	ticker: string;
	priceHistory: number[];
	currentTick: number;
	orderbook?: SignalOrderbook | null;
	market?: SignalMarket | null;
}

// ─── Strategy interface ────────────────────────────────────────────────

export interface SignalStrategy {
	/** Strategy name, used for logging / rationale strings. */
	readonly name: string;
	/** Compute a signal for the given context. Returns null for "no trade". */
	__call(ctx: SignalContext): Signal | null;
}
