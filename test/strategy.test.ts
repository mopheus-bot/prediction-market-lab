/**
 * prediction-market-lab — strategy unit tests.
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
		// 2026-08-11 (option 2, lock-in): the NaiveSignal's
		// reversal confirmation gate (min_support_contracts)
		// reads ctx.orderbook. The default min_support_contracts
		// in the router is 3, so tests need an orderbook with
		// at least 3 contracts at the best bid on the side
		// the signal is betting on. The newPrice is the last
		// element of `prices`; for a fade-up (movePct>0) the
		// signal bets "no" → we need NO bid depth. For a
		// fade-down, the signal bets "yes" → YES bid depth.
		// We populate both sides with 5 contracts so the gate
		// passes regardless of fade direction.
		orderbook: {
			yesLevels: [{ priceCents: prices[prices.length - 1] ?? 50, count: 5 }],
			noLevels: [{ priceCents: 100 - (prices[prices.length - 1] ?? 50), count: 5 }],
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

	// 2026-08-10: min absolute move (cents). Lets the bot
	// fire on stable markets where a 1¢ move is meaningful
	// edge but well below any reasonable percentage threshold.
	// KXWARMING-50 at 78¢ rarely moves 2% in 60 polls; a
	// 1¢ move is the kind of micro-inefficiency the bot
	// is designed to find.
	it("fires on 1¢ absolute move when min_absolute_move_cents=1", () => {
		const s = new NaiveSignal({ min_absolute_move_cents: 1 });
		// 78c -> 79c = 1.3% move (above 1¢ absolute, below
		// default 5% percentage). Should fire on absolute.
		const sig = s.__call(ctx([78, 79]));
		expect(sig).not.toBeNull();
		expect(sig?.side).toBe("no");
		expect(sig?.rationale).toContain("abs_up");
	});

	it("does NOT fire on sub-1¢ move at default thresholds", () => {
		const s = new NaiveSignal({ min_absolute_move_cents: 1 });
		expect(s.__call(ctx([78, 78]))).toBeNull();
	});

	it("rejects min_absolute_move_cents outside [0, 99]", () => {
		expect(() => new NaiveSignal({ min_absolute_move_cents: -1 })).toThrow();
		expect(() => new NaiveSignal({ min_absolute_move_cents: 100 })).toThrow();
	});

	it("OR-combines percentage and absolute thresholds", () => {
		// 4% move (above 3% pct threshold) fires on pct.
		const s1 = new NaiveSignal({ fade_threshold: 0.03, min_absolute_move_cents: 1 });
		const sig1 = s1.__call(ctx([50, 52]));
		expect(sig1).not.toBeNull();
		expect(sig1?.rationale).toContain("fade");
		// 1¢ move at 78¢ (1.3%, above 1¢ abs) fires on abs.
		const s2 = new NaiveSignal({ fade_threshold: 0.05, min_absolute_move_cents: 1 });
		const sig2 = s2.__call(ctx([78, 79]));
		expect(sig2).not.toBeNull();
		expect(sig2?.rationale).toContain("abs");
		// 0.5¢ move (below both) does NOT fire.
		const s3 = new NaiveSignal({ fade_threshold: 0.05, min_absolute_move_cents: 1 });
		expect(s3.__call(ctx([78, 78]))).toBeNull();
	});

	it("per-vertical min_absolute_move_cents on the router", () => {
		const router = new VerticalStrategyRouter({
			fade_thresholds: { weather: 0.05, sports: 0.05 },
			min_absolute_move_cents: { weather: 1, sports: 0 },
		});
		// 78c -> 79c fires on weather (1¢ abs) but not sports
		// (no abs override; 1.3% is below 5% pct).
		const wSig = router.__call(ctx([78, 79], "weather"));
		expect(wSig).not.toBeNull();
		const sSig = router.__call(ctx([78, 79], "sports"));
		expect(sSig).toBeNull();
	});
});

describe("VerticalStrategyRouter", () => {
	it("dispatches to the right vertical", () => {
		const router = new VerticalStrategyRouter();
		const sig = router.__call(ctx([50, 53], "weather"));
		expect(sig).not.toBeNull();
		expect(sig?.rationale).toContain("naive_weather");
	});

	it("dispatches to the per-vertical profile for new verticals", () => {
		// 2026-08-11: every Kalshi category now has its own
		// profile (no more "unknown" → default fallback for
		// known verticals). Crypto dispatches to naive_crypto.
		const router = new VerticalStrategyRouter();
		const sig = router.__call(ctx([50, 53], "crypto"));
		expect(sig).not.toBeNull();
		expect(sig?.rationale).toContain("naive_crypto");
	});

	it("falls back to default for null vertical", () => {
		const router = new VerticalStrategyRouter();
		const sig = router.__call({...ctx([50, 53]), market: null });
		expect(sig).not.toBeNull();
		expect(sig?.rationale).toContain("naive_default");
	});
});
