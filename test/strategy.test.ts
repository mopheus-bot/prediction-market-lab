/**
 * pm-bot — strategy unit tests.
 *
 * Tests the NaiveSignal against the threshold-based logic in
 * `signal.py:naive_signal` (5% move threshold, fade-only).
 */

import { describe, it, expect } from "vitest";
import { NaiveSignal } from "../src/strategy/naive";
import { VerticalStrategyRouter } from "../src/strategy/router";
import type { SignalContext } from "../src/strategy/signal";

function ctx(prices: number[], vertical = "weather"): SignalContext {
	return {
		ticker: "KXWARMING-50",
		priceHistory: prices,
		currentTick: 0,
		market: {
			ticker: "KXWARMING-50",
			eventTicker: "KXWARMING",
			vertical,
		},
	};
}

describe("NaiveSignal", () => {
	it("returns null for fewer than 2 prices", () => {
		const s = new NaiveSignal();
		expect(s.__call(ctx([]))).toBeNull();
		expect(s.__call(ctx([50]))).toBeNull();
	});

	it("returns null for moves <= 5%", () => {
		const s = new NaiveSignal();
		// 50c -> 52c = 4% move, below the 5% threshold.
		expect(s.__call(ctx([50, 52]))).toBeNull();
		// 50c -> 51c = 2% move.
		expect(s.__call(ctx([50, 51]))).toBeNull();
		// No change.
		expect(s.__call(ctx([50, 50]))).toBeNull();
	});

	it("fades up moves > 5% with a NO signal", () => {
		const s = new NaiveSignal();
		// 50c -> 53c = 6% move, fades the move.
		const sig = s.__call(ctx([50, 53]));
		expect(sig).not.toBeNull();
		expect(sig?.side).toBe("no");
		expect(sig?.price).toBe(53);
		expect(sig?.rationale).toContain("fade_up");
	});

	it("fades down moves > 5% with a YES signal", () => {
		const s = new NaiveSignal();
		// 50c -> 47c = 6% down move, fades the move.
		const sig = s.__call(ctx([50, 47]));
		expect(sig).not.toBeNull();
		expect(sig?.side).toBe("yes");
		expect(sig?.price).toBe(47);
		expect(sig?.rationale).toContain("fade_down");
	});

	it("returns null for old_price <= 0", () => {
		const s = new NaiveSignal();
		expect(s.__call(ctx([0, 50]))).toBeNull();
	});

	it("rejects size < 1", () => {
		expect(() => new NaiveSignal({ size: 0 })).toThrow();
		expect(() => new NaiveSignal({ size: -1 })).toThrow();
	});

	// 2026-08-10: per-vertical threshold override. Live Kalshi
	// markets (weather, single-game sports) are lower-vol than
	// the synthetic data the default 5% was calibrated against.
	// The bot needs to be able to drop the threshold per-vertical.
	it("respects a custom fade_threshold (override)", () => {
		// 50c -> 52c = 4% move, fires with threshold=0.03 (3%).
		// Strict greater-than: 4% > 3% = true. UP move fades with NO.
		const s = new NaiveSignal({ fade_threshold: 0.03 });
		const sig = s.__call(ctx([50, 52]));
		expect(sig).not.toBeNull();
		expect(sig?.side).toBe("no");
		expect(sig?.rationale).toContain("fade_up");
	});

	it("does NOT fire a 2% move at default 5% threshold", () => {
		const s = new NaiveSignal();
		expect(s.__call(ctx([50, 51]))).toBeNull();
	});

	it("rejects fade_threshold outside (0, 1]", () => {
		expect(() => new NaiveSignal({ fade_threshold: 0 })).toThrow();
		expect(() => new NaiveSignal({ fade_threshold: -0.1 })).toThrow();
		expect(() => new NaiveSignal({ fade_threshold: 1.5 })).toThrow();
	});

	it("per-vertical threshold override on the router (weather=3%, sports=5%)", () => {
		const router = new VerticalStrategyRouter({
			fade_thresholds: { weather: 0.03, sports: 0.05 },
		});
		// 50c -> 52c = 4% — fires on weather (threshold 3%)
		// but not on sports (threshold 5%).
		const wSig = router.__call(ctx([50, 52], "weather"));
		expect(wSig).not.toBeNull();
		const sSig = router.__call(ctx([50, 52], "sports"));
		expect(sSig).toBeNull();
		// 50c -> 53c = 6% — fires on both.
		const wBig = router.__call(ctx([50, 53], "weather"));
		const sBig = router.__call(ctx([50, 53], "sports"));
		expect(wBig).not.toBeNull();
		expect(sBig).not.toBeNull();
	});
});

describe("VerticalStrategyRouter", () => {
	it("dispatches to the right vertical", () => {
		const router = new VerticalStrategyRouter();
		const sig = router.__call(ctx([50, 53], "weather"));
		expect(sig).not.toBeNull();
		expect(sig?.rationale).toContain("naive_weather");
	});

	it("falls back to the default profile for unknown verticals", () => {
		const router = new VerticalStrategyRouter();
		const sig = router.__call(ctx([50, 53], "crypto"));
		expect(sig).not.toBeNull();
		expect(sig?.rationale).toContain("naive_default");
	});

	it("falls back to default for null vertical", () => {
		const router = new VerticalStrategyRouter();
		const sig = router.__call({ ...ctx([50, 53]), market: null });
		expect(sig).not.toBeNull();
		expect(sig?.rationale).toContain("naive_default");
	});
});
