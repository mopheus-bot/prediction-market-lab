/**
 * pm-bot — `LLMOpinionSignal` strategy (2026-08-10).
 *
 * The user asked: "use the LLM to leverage opinion or bias
 * to our advantage." This strategy emits a Signal based on
 * a per-ticker LLM verdict that the bot's polling feed
 * pre-fetches and passes in via SignalContext.
 *
 * **How it works:**
 *   1. The cron `llm-opinions-cron.ts` runs every 30 min.
 *      For each ticker in the bot's universe, it asks the
 *      LLM: "based on the market title + current price, is
 *      YES mispriced? Reply {side, confidence, reasoning}."
 *   2. The verdict is stored in `llm_opinions` with a soft
 *      TTL (default 1h).
 *   3. On each bot poll, the LiveBot's `maybeSignalAll`
 *      pre-fetches the latest verdict for each ticker from
 *      D1 and passes it via `ctx.llmOpinion`.
 *   4. This strategy reads `ctx.llmOpinion` and emits a
 *      Signal if the verdict is fresh and confident.
 *
 * **Why a separate strategy class (not folded into NaiveSignal):**
 *   - Different cost profile: NaiveSignal runs on every tick
 *     with zero LLM cost. LLMOpinionSignal reads from a
 *     cached table — also zero per-tick LLM cost, but the
 *     cron's batched LLM call is the real cost.
 *   - Different data source: NaiveSignal is price-only.
 *     LLMOpinionSignal uses the LLM's world knowledge.
 *   - Different reasoning: NaiveSignal is "fade a move";
 *     LLMOpinionSignal is "the LLM thinks the market is wrong."
 *
 * **Risk / paper behavior:**
 *   - The signal's `p` is the LLM's confidence (0.0-1.0),
 *     which the flip-filter and risk engine treat the same
 *     as any other signal.
 *   - A LLM "hold" verdict emits no signal (side='hold' is
 *     a no-op).
 *   - Low-confidence verdicts (<MIN_CONFIDENCE) are ignored.
 *   - Stale verdicts (>TTL_MS old) are ignored.
 *   - The signal price uses the orderbook mid (not the
 *     price the LLM saw). If the market has moved since the
 *     verdict, we still enter at the current price.
 */

import type { Side } from "../lib/types.js";
import type { Signal, SignalContext, SignalStrategy } from "./signal.js";

/** A single LLM verdict, denormalized into SignalContext. */
export interface LLMOpinionForContext {
	side: Side | "hold";
	confidence: number;
	reasoning: string;
	ts: number;
	expires_at: number;
}

/** Confidence threshold below which the LLM verdict is ignored.
 *  0.6 means "the LLM has to have a real lean, not just a
 *  coin-flip slight" — at 0.5 the strategy was firing on
 *  essentially any opinion, which produced a lot of marginal
 *  trades that mostly got eaten by fees. Bumping to 0.6 cuts
 *  the noise trades and lets the LLM's actual edges breathe.
 *  Operators can tune per-vertical via LLMOpinionSignalOpts. */
export const DEFAULT_MIN_CONFIDENCE = 0.6;

/** Soft TTL for a verdict. Verdicts older than this are
 *  treated as stale and ignored. 1h is the default — the
 *  cron runs every 30 min so verdicts are at most 30 min
 *  stale at the moment of the next refresh. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface LLMOpinionSignalOpts {
	/** Confidence threshold. Default 0.5. */
	min_confidence?: number;
	/** Soft TTL in ms. Default 1h. */
	ttl_ms?: number;
	/** For logging. */
	name?: string;
}

export class LLMOpinionSignal implements SignalStrategy {
	readonly name: string;
	private readonly min_confidence: number;
	private readonly ttl_ms: number;

	constructor(opts: LLMOpinionSignalOpts = {}) {
		this.min_confidence = opts.min_confidence ?? DEFAULT_MIN_CONFIDENCE;
		this.ttl_ms = opts.ttl_ms ?? DEFAULT_TTL_MS;
		this.name = opts.name ?? "llm_opinion";
	}

	__call(ctx: SignalContext): Signal | null {
		const opinion = ctx.llmOpinion;
		if (!opinion) return null;
		const now = Date.now();
		if (opinion.expires_at < now) return null; // stale
		if (opinion.side === "hold") return null; // LLM says no edge
		if (opinion.confidence < this.min_confidence) return null;
		// Use the orderbook mid as the entry price. The
		// LLM's verdict was rendered against a specific
		// price (stored in current_price_cents) but the
		// market may have moved since. The risk engine
		// and the order-book check will gate the entry;
		// here we just emit a Signal at the current mid.
		const mid = ctx.orderbook
			? computeMid(ctx.orderbook)
			: ctx.priceHistory[ctx.priceHistory.length - 1] ?? null;
		if (mid === null || mid <= 0) return null;
		return {
			side: opinion.side,
			price: Math.round(mid),
			size: 1, // size is set by risk engine from position cap
			rationale: `${this.name}_${opinion.side}_c${opinion.confidence.toFixed(2)}`,
			p: opinion.confidence,
		};
	}
}

function computeMid(ob: {
	yesLevels: Array<{ priceCents: number; count: number }>;
	noLevels: Array<{ priceCents: number; count: number }>;
}): number | null {
	if (ob.yesLevels.length === 0 || ob.noLevels.length === 0) return null;
	const yb = Math.max(...ob.yesLevels.map((l) => l.priceCents));
	const nb = Math.max(...ob.noLevels.map((l) => l.priceCents));
	const ya = 100 - nb;
	if (yb <= 0 || ya <= 0 || ya <= yb) return null;
	return Math.round((yb + ya) / 2);
}
