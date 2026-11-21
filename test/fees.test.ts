/**
 * prediction-market-lab — fees unit tests.
 *
 * Mirrors the worked examples in the Python `kalshi_taker_fee_cents`
 * docstring. The fee formula is:
 *
 *   fee_cents = ceil(0.07 * size * P * (1 - P) * 100)
 *
 * where P = entry price in dollars (0 < P < 1) and the result is
 * rounded UP. Worked examples (1 contract):
 *   10c/90c: 0.07 * 1 * 0.10 * 0.90 * 100 = 0.63 -> 1c
 *   30c/70c: 0.07 * 1 * 0.30 * 0.70 * 100 = 1.47 -> 2c
 *   50c/50c: 0.07 * 1 * 0.50 * 0.50 * 100 = 1.75 -> 2c
 *   5 contracts at 50c: 0.07 * 5 * 0.25 * 100 = 8.75 -> 9c
 */

import { describe, it, expect } from "vitest";
import {
	isStructurallyUnprofitable,
	kalshiTakerFeeCents,
} from "../src/lib/fees";

describe("kalshiTakerFeeCents", () => {
	it("matches the worked example: 10c/1 contract = 1c", () => {
		expect(kalshiTakerFeeCents("yes", 1, 10)).toBe(1);
		expect(kalshiTakerFeeCents("no", 1, 10)).toBe(1); // symmetric
	});

	it("matches the worked example: 30c/1 contract = 2c", () => {
		expect(kalshiTakerFeeCents("yes", 1, 30)).toBe(2);
	});

	it("matches the worked example: 50c/1 contract = 2c", () => {
		expect(kalshiTakerFeeCents("yes", 1, 50)).toBe(2);
	});

	it("matches the worked example: 5 contracts at 50c = 9c", () => {
		expect(kalshiTakerFeeCents("yes", 5, 50)).toBe(9);
	});

	it("returns 0 for size <= 0", () => {
		expect(kalshiTakerFeeCents("yes", 0, 50)).toBe(0);
		expect(kalshiTakerFeeCents("yes", -5, 50)).toBe(0);
	});

	it("returns 0 for out-of-range prices (0c, 100c)", () => {
		expect(kalshiTakerFeeCents("yes", 1, 0)).toBe(0);
		expect(kalshiTakerFeeCents("yes", 1, 100)).toBe(0);
		expect(kalshiTakerFeeCents("yes", 1, -5)).toBe(0);
		expect(kalshiTakerFeeCents("yes", 1, 150)).toBe(0);
	});

	it("fee is symmetric across YES and NO at the same price", () => {
		expect(kalshiTakerFeeCents("yes", 3, 70)).toBe(kalshiTakerFeeCents("no", 3, 70));
		expect(kalshiTakerFeeCents("yes", 3, 70)).toBe(kalshiTakerFeeCents("yes", 3, 30));
	});

	it("rounds up (ceiling), not nearest", () => {
		// 1 contract at 5c: 0.07 * 1 * 0.05 * 0.95 * 100 = 0.3325 -> 1c
		expect(kalshiTakerFeeCents("yes", 1, 5)).toBe(1);
	});
});

describe("isStructurallyUnprofitable", () => {
	it("flags prices near the boundary as unprofitable", () => {
		// 99c: max gain 1c, fees > 1c, guaranteed loss.
		expect(isStructurallyUnprofitable(99, 1)).toBe(true);
		expect(isStructurallyUnprofitable(1, 1)).toBe(true);
		expect(isStructurallyUnprofitable(0, 1)).toBe(true);
		expect(isStructurallyUnprofitable(100, 1)).toBe(true);
	});

	it("passes mid-range prices as profitable", () => {
		// 50c: max gain 50c, fees ~2c, profitable.
		expect(isStructurallyUnprofitable(50, 1)).toBe(false);
		expect(isStructurallyUnprofitable(30, 10)).toBe(false);
	});

	it("returns true for size <= 0", () => {
		expect(isStructurallyUnprofitable(50, 0)).toBe(true);
		expect(isStructurallyUnprofitable(50, -1)).toBe(true);
	});
});
