/**
 * prediction-market-lab — feature extraction unit tests.
 *
 * The 20-dim feature vector must match the Python
 * `extract_features` output for known inputs.
 */

import { describe, it, expect } from "vitest";
import {
	extractFeatures,
	FEATURE_NAMES,
	N_FEATURES,
	N_NUMERIC_FEATURES,
	VERTICAL_FEATURE_INDEX,
} from "../src/strategy/features";
import type { SignalContext } from "../src/strategy/signal";

function baseCtx(): SignalContext {
	return {
		ticker: "KXWARMING-50",
		priceHistory: [50, 51, 52, 53, 54],
		currentTick: 100,
		orderbook: {
			ticker: "KXWARMING-50",
			yesLevels: [
				{ priceCents: 49, count: 100 },
				{ priceCents: 48, count: 50 },
			],
			noLevels: [{ priceCents: 49, count: 200 }],
		},
		market: {
			ticker: "KXWARMING-50",
			eventTicker: "KXWARMING",
			vertical: "weather",
		},
	};
}

describe("Feature extraction", () => {
	it("returns a 20-dim feature vector", () => {
		const fv = extractFeatures(baseCtx());
		expect(fv.values.length).toBe(20);
		expect(fv.feature_names).toEqual(FEATURE_NAMES);
		expect(N_FEATURES).toBe(20);
	});

	it("computes price as mid / 100", () => {
		const fv = extractFeatures(baseCtx());
		// mid = (yes_bid + yes_ask) / 2 = (49 + 51) / 2 = 50
		// normalized: 50/100 = 0.5
		expect(fv.values[0]).toBeCloseTo(0.5, 9);
	});

	it("computes spread as yes_ask - yes_bid", () => {
		const fv = extractFeatures(baseCtx());
		// yes_ask = 100 - bestNoBid = 100 - 49 = 51
		// spread = 51 - 49 = 2
		expect(fv.values[1]).toBe(2);
	});

	it("sets the vertical one-hot correctly", () => {
		const c = baseCtx();
		c.market = {...c.market, vertical: "weather" };
		const fv = extractFeatures(c);
		expect(fv.values[VERTICAL_FEATURE_INDEX.weather]).toBe(1);
		expect(fv.values[VERTICAL_FEATURE_INDEX.politics]).toBe(0);
		expect(fv.values[VERTICAL_FEATURE_INDEX.sports]).toBe(0);
		expect(fv.values[VERTICAL_FEATURE_INDEX.economic]).toBe(0);
	});

	it("falls back to all-zero vertical one-hot for unknown verticals", () => {
		const c = baseCtx();
		c.market = {...c.market, vertical: "crypto" };
		const fv = extractFeatures(c);
		for (let i = 0; i < 4; i++) {
			expect(fv.values[8 + i]).toBe(0);
		}
	});

	it("computes recent_move_pct over the price history", () => {
		const c = baseCtx();
		c.priceHistory = [50, 55]; // 10% move
		const fv = extractFeatures(c);
		expect(fv.values[7]).toBeCloseTo(0.1, 9);
	});

	it("computes volatility (normalized) over the price history", () => {
		// All identical prices → std = 0 → normalized volatility = 0
		const c = baseCtx();
		c.priceHistory = [50, 50, 50, 50, 50];
		const fv = extractFeatures(c);
		expect(fv.values[3]).toBeCloseTo(0, 6);
	});

	it("computes orderbook imbalance", () => {
		// yes top: 100, no top: 200 → (100-200)/(100+200) = -1/3
		const fv = extractFeatures(baseCtx());
		expect(fv.values[4]).toBeCloseTo(-1 / 3, 6);
	});

	it("returns 0 for missing orderbook", () => {
		const c = baseCtx();
		c.orderbook = null;
		const fv = extractFeatures(c);
		expect(fv.values[0]).toBe(0); // price
		expect(fv.values[1]).toBe(0); // spread
		expect(fv.values[4]).toBe(0); // imbalance
	});

	it("returns 0 for missing market", () => {
		const c = baseCtx();
		c.market = null;
		const fv = extractFeatures(c);
		// No vertical one-hot, no fundamentals.
		expect(fv.values[8]).toBe(0);
		expect(fv.values[9]).toBe(0);
		expect(fv.values[10]).toBe(0);
		expect(fv.values[11]).toBe(0);
	});

	it("populates the matching vertical's fundamentals", () => {
		const c = baseCtx();
		c.market = {
			...c.market,
			vertical: "weather",
			fundamentals: { forecast_value: 0.55, forecast_confidence: 0.8 },
		};
		const fv = extractFeatures(c);
		// 16: forecast_value, 17: forecast_confidence
		expect(fv.values[16]).toBe(0.55);
		expect(fv.values[17]).toBe(0.8);
		// The other 6 fundamentals stay at 0.
		expect(fv.values[12]).toBe(0);
		expect(fv.values[18]).toBe(0);
	});

	it("uses market.createdAtTick / ttlSeconds for time_to_resolution when present", () => {
		const c = baseCtx();
		c.market = {
			...c.market,
			createdAtTick: 0,
			ttlSeconds: 1000,
		};
		c.currentTick = 500; // halfway
		const fv = extractFeatures(c);
		// (1000 - 500) / 1000 = 0.5
		expect(fv.values[2]).toBeCloseTo(0.5, 9);
	});

	it("defaults time_to_resolution to 0.5 when the market lacks TTL info (live path)", () => {
		const c = baseCtx();
		// market has no createdAtTick/ttlSeconds — live path.
		const fv = extractFeatures(c);
		expect(fv.values[2]).toBe(0.5);
	});

	it("does not regress on the numeric / one-hot split invariant", () => {
		const fv = extractFeatures(baseCtx());
		// 8 numeric + 4 one-hot + 8 fundamentals = 20.
		expect(N_NUMERIC_FEATURES).toBe(8);
		expect(fv.values.length).toBe(N_NUMERIC_FEATURES + 4 + 8);
	});
});
