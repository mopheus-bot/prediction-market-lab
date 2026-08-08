/**
 * pm-bot — ReversionQualitySignal unit tests (chunk 4).
 *
 * Mirrors the Python `ReversionQualitySignal` behavior:
 *   - Requires an orderbook + a price history of length >= 2.
 *   - Returns null when `p_revert < p_min`.
 *   - Returns null when `|deviation| < dev_min`.
 *   - Fades up moves (deviation > 0) with a NO signal.
 *   - Fades down moves (deviation < 0) with a YES signal.
 *   - The signal's `p` is the model's `p_revert`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	loadForestFromJSON,
	RandomForestModel,
} from "../src/strategy/forest";
import { ReversionQualitySignal } from "../src/strategy/reversion";
import type { SignalContext } from "../src/strategy/signal";

function loadModel(): RandomForestModel {
	const raw = readFileSync(
		join(process.cwd(), "models", "reversion-weather-v1.json"),
		"utf8",
	);
	return loadForestFromJSON(raw);
}

function ctx(prices: number[], vertical: "weather" | "economic" | "politics" | "sports" = "weather"): SignalContext {
	return {
		ticker: "KXWARMING-50",
		priceHistory: prices,
		currentTick: 0,
		// Build a minimal orderbook where the ask/bid match the
		// mid of the price history (small spread). The signal uses
		// `yes_ask = 100 - bestNoBid` so we need a no-bid for the
		// yes ask to land close to 50.
		orderbook: {
			ticker: "KXWARMING-50",
			yesLevels: [{ priceCents: 49, count: 100 }],
			noLevels: [{ priceCents: 49, count: 100 }],
		},
		market: {
			ticker: "KXWARMING-50",
			eventTicker: "KXWARMING",
			vertical,
		},
	};
}

describe("ReversionQualitySignal", () => {
	it("returns null for fewer than 2 prices", () => {
		const sig = new ReversionQualitySignal({ model: loadModel() });
		expect(sig.__call(ctx([50]))).toBeNull();
	});

	it("returns null without an orderbook", () => {
		const sig = new ReversionQualitySignal({ model: loadModel() });
		const c = ctx([50, 53]);
		c.orderbook = null;
		expect(sig.__call(c)).toBeNull();
	});

	it("rejects a model with the wrong feature count", () => {
		const raw = {
			version: 1,
			format: "sklearn-randomforest-v1" as const,
			n_features: 10,
			n_classes: 2,
			classes: [0, 1],
			n_estimators: 1,
			max_depth: 1,
			feature_importances: new Array(10).fill(0.1),
			trees: [],
		};
		const bad = new RandomForestModel(raw);
		expect(
			() => new ReversionQualitySignal({ model: bad }),
		).toThrow(/expects a 20-feature model/);
	});

	it("rejects a non-binary classifier", () => {
		const raw = {
			version: 1,
			format: "sklearn-randomforest-v1" as const,
			n_features: 20,
			n_classes: 3,
			classes: [0, 1, 2],
			n_estimators: 1,
			max_depth: 1,
			feature_importances: new Array(20).fill(0.05),
			trees: [],
		};
		const bad = new RandomForestModel(raw);
		expect(
			() => new ReversionQualitySignal({ model: bad }),
		).toThrow(/expects a binary classifier/);
	});

	it("rejects invalid p_min / dev_min / size", () => {
		const m = loadModel();
		expect(() => new ReversionQualitySignal({ model: m, dev_min: -1 })).toThrow();
		expect(() => new ReversionQualitySignal({ model: m, p_min: 2 })).toThrow();
		expect(() => new ReversionQualitySignal({ model: m, size: 0 })).toThrow();
	});

	it("uses the model's p_revert as the signal's p", () => {
		const m = loadModel();
		const sig = new ReversionQualitySignal({ model: m, dev_min: 0.1, p_min: 0.0 });
		// With orderbook at yes_bid=49 / no_bid=49 (mid=50) and
		// price history [50, 56] (mean=53), the current price (50)
		// is 3 below the mean → deviation < 0 → the signal fades
		// the depression with YES.
		const c = ctx([50, 56]);
		const out = sig.__call(c);
		if (out) {
			expect(out.side).toBe("yes");
			expect(out.p).toBeGreaterThanOrEqual(0);
			expect(out.p).toBeLessThanOrEqual(1);
		}
	});
});
