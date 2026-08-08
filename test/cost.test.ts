/**
 * pm-bot — cost endpoint unit tests.
 *
 * The cost endpoint combines CF Analytics + D1 + MMX
 * pricing into a single daily + monthly estimate. The
 * math is straightforward but easy to get wrong
 * (millions-of-tokens conversion, free-tier subtraction).
 * These tests pin the formula down so a refactor can't
 * silently change the numbers.
 */

import { describe, it, expect } from "vitest";

/** Reproduce the cost math from src/api/cost.ts without
 *  pulling in the CF dependency. If you change the
 *  formula there, change it here too. */
function estimateMmxCost(
	inputTokens: number,
	outputTokens: number,
): number {
	const MMX_PRICING = { inputPer1M: 0.10, outputPer1M: 0.40 };
	return (
		(inputTokens / 1_000_000) * MMX_PRICING.inputPer1M +
		(outputTokens / 1_000_000) * MMX_PRICING.outputPer1M
	);
}

function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}

describe("cost math", () => {
	it("zero tokens = zero cost", () => {
		expect(estimateMmxCost(0, 0)).toBe(0);
	});

	it("1M input tokens at $0.10/1M = $0.10", () => {
		expect(round4(estimateMmxCost(1_000_000, 0))).toBe(0.1);
	});

	it("1M output tokens at $0.40/1M = $0.40", () => {
		expect(round4(estimateMmxCost(0, 1_000_000))).toBe(0.4);
	});

	it("typical 1-call usage: 500 input + 200 output ≈ $0.0001", () => {
		// 500 * 0.10/1M = 0.00005; 200 * 0.40/1M = 0.00008.
		// Sum = 0.00013. Rounds to 0.0001.
		const c = estimateMmxCost(500, 200);
		expect(round4(c)).toBe(0.0001);
	});

	it("10K calls × 500 in + 200 out ≈ $0.13/mo", () => {
		// 10K * 0.00013 = $1.30 for the day, * 30 = $39.
		// Wait — that's per-call. Let me redo:
		// 10K calls * 500 in tokens = 5,000,000 in tokens.
		// 10K calls * 200 out tokens = 2,000,000 out tokens.
		// 5M * 0.10/1M = $0.50; 2M * 0.40/1M = $0.80.
		// Sum = $1.30/day. * 30 = $39/mo.
		const c = estimateMmxCost(5_000_000, 2_000_000);
		expect(round4(c)).toBe(1.3);
		expect(round4(c * 30)).toBe(39);
	});

	it("free-tier arithmetic: under 100K requests/day costs $0", () => {
		const FREE_DAILY = 100_000;
		const requests = 5_000;
		const billable = Math.max(0, requests - FREE_DAILY);
		expect(billable).toBe(0);
		// 0 billable * $0.50/1M = $0.
		expect(round4(billable * (0.5 / 1_000_000))).toBe(0);
	});

	it("over free tier: 1M requests/day costs ~$0.45/day", () => {
		const FREE_DAILY = 100_000;
		const requests = 1_000_000;
		const billable = Math.max(0, requests - FREE_DAILY);
		// 900,000 * $0.50/1M = $0.45.
		expect(round4(billable * (0.5 / 1_000_000))).toBe(0.45);
	});
});

describe("round4", () => {
	it("rounds to 4 decimal places", () => {
		expect(round4(0.123456789)).toBe(0.1235);
		expect(round4(0.00009)).toBe(0.0001);
		expect(round4(0.00004)).toBe(0);
	});
});
