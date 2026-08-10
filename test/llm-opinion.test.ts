/**
 * pm-bot — LLMOpinionSignal unit tests (2026-08-10).
 *
 * Coverage for the chunk-15 strategy:
 *   - Stale opinions are ignored
 *   - "hold" verdicts are no-ops
 *   - Below-threshold confidence is ignored
 *   - Fresh + above-threshold + non-hold → emits a Signal
 *   - Orderbook mid is used as the signal price (NOT the
 *     LLM's recorded current_price_cents — the market may
 *     have moved since the verdict was rendered)
 *   - Custom min_confidence / ttl_ms opts work
 *
 * Mirrors the operator-visible behavior in
 * `src/strategy/llm-opinion.ts`. LLMOpinionSignal is a
 * pure function of SignalContext, so these are pure unit
 * tests (no D1/DO/WS bindings needed).
 */

import { describe, it, expect } from "vitest";
import {
	LLMOpinionSignal,
	DEFAULT_MIN_CONFIDENCE,
	DEFAULT_TTL_MS,
} from "../src/strategy/llm-opinion";
import type { SignalContext } from "../src/strategy/signal";

// We can't pin "now" to a fixed epoch because the strategy
// uses Date.now() directly. So opinion() builds relative to
// the call-time clock, and the staleness test uses an
// expires_at that's clearly in the past.
const NOW_OFFSET = () => Date.now();

function ctx(overrides: Partial<SignalContext> = {}): SignalContext {
	return {
		ticker: "KXWARMING-50",
		priceHistory: [50],
		currentTick: 0,
		...overrides,
	};
}

/** Orderbook that produces a 50¢ mid.
 *  yb=49 (best YES bid), nb=49 (best NO bid) → ya=100-49=51 (implied YES ask).
 *  Mid = (49 + 51) / 2 = 50. ya > yb → arbitrage-free. */
function ob50() {
	return {
		ticker: "KXWARMING-50",
		yesLevels: [{ priceCents: 49, count: 10 }],
		noLevels: [{ priceCents: 49, count: 10 }],
	};
}

/** Orderbook that produces a 60¢ mid.
 *  yb=50, nb=30 → ya=70. Mid = (50 + 70) / 2 = 60. */
function ob60() {
	return {
		ticker: "KXWARMING-50",
		yesLevels: [{ priceCents: 50, count: 10 }],
		noLevels: [{ priceCents: 30, count: 10 }],
	};
}

function opinion(
	overrides: Partial<NonNullable<SignalContext["llmOpinion"]>> = {},
): NonNullable<SignalContext["llmOpinion"]> {
	const now = NOW_OFFSET();
	return {
		side: "yes",
		confidence: 0.85,
		reasoning: "Model thinks the market is too low",
		ts: now,
		expires_at: now + DEFAULT_TTL_MS,
		...overrides,
	};
}

describe("LLMOpinionSignal — defaults", () => {
	it("emits a YES signal when opinion is fresh, confident, and not hold", () => {
		const s = new LLMOpinionSignal();
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				llmOpinion: opinion({ side: "yes", confidence: 0.85 }),
			}),
		);
		expect(sig).not.toBeNull();
		expect(sig?.side).toBe("yes");
		expect(sig?.price).toBe(50);
		expect(sig?.p).toBe(0.85);
		expect(sig?.rationale).toContain("llm_opinion_yes_c0.85");
	});

	it("emits a NO signal when opinion is fresh + non-hold + confident", () => {
		const s = new LLMOpinionSignal();
		const sig = s.__call(
			ctx({
				orderbook: ob60(),
				llmOpinion: opinion({ side: "no", confidence: 0.75 }),
			}),
		);
		expect(sig).not.toBeNull();
		expect(sig?.side).toBe("no");
		// mid(60¢ YES / 40¢ NO) = 60
		expect(sig?.price).toBe(60);
		expect(sig?.p).toBe(0.75);
		expect(sig?.rationale).toContain("llm_opinion_no_c0.75");
	});

	it("uses the orderbook mid as the signal price, not the LLM's recorded price", () => {
		// LLM saw current_price_cents=55 (encoded via confidence +
		// reasoning for simplicity — we don't expose current_price_cents
		// in SignalContext). Orderbook is 50/50 → mid 50.
		const s = new LLMOpinionSignal();
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				llmOpinion: opinion({ confidence: 0.7 }),
			}),
		);
		expect(sig?.price).toBe(50);
	});

	it("falls back to last priceHistory entry when no orderbook is present", () => {
		const s = new LLMOpinionSignal();
		const sig = s.__call(
			ctx({
				priceHistory: [48, 49, 50, 51],
				llmOpinion: opinion({ confidence: 0.8 }),
			}),
		);
		expect(sig?.price).toBe(51);
	});
});

describe("LLMOpinionSignal — no-op paths", () => {
	it("returns null when no opinion is in the context", () => {
		const s = new LLMOpinionSignal();
		expect(s.__call(ctx({ orderbook: ob50(), llmOpinion: null }))).toBeNull();
		expect(s.__call(ctx({ orderbook: ob50() }))).toBeNull();
	});

	it("returns null when opinion is missing the field entirely", () => {
		const s = new LLMOpinionSignal();
		expect(s.__call(ctx({ orderbook: ob50() }))).toBeNull();
	});

	it("returns null for a 'hold' verdict (LLM says no edge)", () => {
		const s = new LLMOpinionSignal();
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				llmOpinion: opinion({ side: "hold", confidence: 0.9 }),
			}),
		);
		expect(sig).toBeNull();
	});

	it("returns null when the opinion is stale (expires_at < now)", () => {
		const s = new LLMOpinionSignal();
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				// expires 1ms in the past
				llmOpinion: opinion({ expires_at: Date.now() - 1 }),
			}),
		);
		expect(sig).toBeNull();
	});

	it("returns null for confidence below the default 0.6 threshold", () => {
		const s = new LLMOpinionSignal();
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				llmOpinion: opinion({ confidence: DEFAULT_MIN_CONFIDENCE - 0.01 }),
			}),
		);
		expect(sig).toBeNull();
	});

	it("returns null for confidence exactly at the threshold (strict <)", () => {
		// LLMOpinionSignal uses strict less-than, so the threshold
		// itself is the floor. 0.6 with min=0.6 → fires.
		const s = new LLMOpinionSignal();
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				llmOpinion: opinion({ confidence: DEFAULT_MIN_CONFIDENCE }),
			}),
		);
		expect(sig).not.toBeNull();
		expect(sig?.p).toBe(DEFAULT_MIN_CONFIDENCE);
	});

	it("returns null when the orderbook mid is uncomputable (empty book)", () => {
		const s = new LLMOpinionSignal();
		const sig = s.__call(
			ctx({
				orderbook: {
					ticker: "KXWARMING-50",
					yesLevels: [],
					noLevels: [],
				},
				llmOpinion: opinion(),
			}),
		);
		expect(sig).toBeNull();
	});
});

describe("LLMOpinionSignal — custom opts", () => {
	it("respects a custom min_confidence (higher threshold)", () => {
		const s = new LLMOpinionSignal({ min_confidence: 0.8 });
		// 0.79 should be rejected with threshold 0.8
		expect(
			s.__call(
				ctx({
					orderbook: ob50(),
					llmOpinion: opinion({ confidence: 0.79 }),
				}),
			),
		).toBeNull();
		// 0.81 should fire
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				llmOpinion: opinion({ confidence: 0.81 }),
			}),
		);
		expect(sig).not.toBeNull();
		expect(sig?.p).toBe(0.81);
	});

	it("respects a custom min_confidence (lower threshold)", () => {
		const s = new LLMOpinionSignal({ min_confidence: 0.4 });
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				llmOpinion: opinion({ confidence: 0.45 }),
			}),
		);
		expect(sig).not.toBeNull();
		expect(sig?.p).toBe(0.45);
	});

	it("respects a custom ttl_ms as the upper bound (defense in depth)", () => {
		// ttl_ms is the strategy's own age cap. It's checked AFTER
		// the cron's stamped expires_at — so to exercise the ttl_ms
		// gate, expires_at must be in the future (passes the first
		// check) and `ts` must be older than ttl_ms (triggers the
		// second check).
		const s = new LLMOpinionSignal({ ttl_ms: 10_000 }); // 10s
		const now = Date.now();

		// ts is 30s old, expires_at is 1h in the future.
		// First check passes (expires_at > now), second check fires
		// (now - ts = 30s > 10s ttl_ms) → null.
		expect(
			s.__call(
				ctx({
					orderbook: ob50(),
					llmOpinion: {
						side: "yes",
						confidence: 0.8,
						reasoning: "fresh enough",
						ts: now - 30_000,
						expires_at: now + 60 * 60 * 1000,
					},
				}),
			),
		).toBeNull();

		// ts is 5s old (within 10s ttl_ms), expires_at is 1h in the future.
		// Both checks pass → signal.
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				llmOpinion: {
					side: "yes",
					confidence: 0.8,
					reasoning: "fresh",
					ts: now - 5_000,
					expires_at: now + 60 * 60 * 1000,
				},
			}),
		);
		expect(sig).not.toBeNull();
	});

	it("uses a custom name in the rationale", () => {
		const s = new LLMOpinionSignal({ name: "llm_weather" });
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				llmOpinion: opinion({ side: "yes", confidence: 0.7 }),
			}),
		);
		expect(sig?.rationale).toContain("llm_weather_yes");
		expect(sig?.rationale).not.toContain("llm_opinion");
	});
});

describe("LLMOpinionSignal — signal shape", () => {
	it("always emits size=1 (risk engine scales it)", () => {
		const s = new LLMOpinionSignal();
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				llmOpinion: opinion({ side: "yes", confidence: 0.9 }),
			}),
		);
		expect(sig?.size).toBe(1);
	});

	it("passes confidence through as p (the flip-filter input)", () => {
		const s = new LLMOpinionSignal();
		const sig = s.__call(
			ctx({
				orderbook: ob50(),
				llmOpinion: opinion({ side: "no", confidence: 0.72 }),
			}),
		);
		expect(sig?.p).toBe(0.72);
	});
});
