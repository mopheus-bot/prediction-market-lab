/**
 * pm-bot — leads-cron unit tests (chunk 11+).
 *
 * The leads-cron runs every 6 hours +30min (00:30/06:30/12:30/18:30 UTC),
 * asks M3 to suggest add+drop for the bot's ticker universe,
 * and writes pending
 * suggestions to the `lead_suggestions` table. The
 * operator approves or rejects each on the Dev page.
 *
 * These tests cover the pure-function logic that the cron
 * depends on — the things that, if wrong, would silently
 * introduce bad tickers or hide rejected ones from the LLM.
 *   - `parseLlmResponse`: extracts the JSON object from the
 *     LLM's text (defends against partial / malformed /
 *     extra-prose output).
 *   - `validateAndDedupe`: format-validates, dedupes within
 *     batch, excludes against current universe and the
 *     rejected list, and routes `add` vs `drop` validation.
 *
 * The LLM call + DB writes are exercised by an integration
 * test in test/leads-api.test.ts (uses the real D1 via
 * vitest-pool-workers). Mocking the LLM is brittle; the
 * deterministic contract lives in these pure functions.
 */

import { describe, it, expect } from "vitest";
import { parseLlmResponse, validateAndDedupe, type BotState } from "../src/cron/leads-cron";

function makeState(overrides: Partial<BotState> = {}): BotState {
	return {
		tickers: ["KXWARMING-50", "KXPRES-26"],
		ticker_verticals: {
			"KXWARMING-50": "weather",
			"KXPRES-26": "politics",
		},
		bankroll_cents: 1000_00,
		max_notional_cents_per_trade: 25,
		daily_notional_cents_cap: 150,
		trading_mode: "paper",
		per_vertical_max_notional_cents: null,
		...overrides,
	};
}

describe("leads-cron / parseLlmResponse", () => {
	it("parses a clean JSON object", () => {
		const out = parseLlmResponse(
			`{"add":[{"ticker":"KXGDP-Q4","vertical":"economic","reasoning":"pairs with KXGDP-Q3"}],` +
				`"drop":[],"overall_reasoning":"add one"}`,
		);
		expect(out).not.toBeNull();
		expect(out!.add).toEqual([
			{ ticker: "KXGDP-Q4", vertical: "economic", reasoning: "pairs with KXGDP-Q3" },
		]);
		expect(out!.drop).toEqual([]);
		expect(out!.overall_reasoning).toBe("add one");
	});

	it("extracts the JSON object from a text wrapper", () => {
		// M3 occasionally wraps its JSON in prose. The parser
		// should still find the JSON object.
		const out = parseLlmResponse(
			`Here are my suggestions: {"add":[],"drop":[{"ticker":"KXPRES-26","reasoning":"0 signals"}],"overall_reasoning":"drop one"}`,
		);
		expect(out).not.toBeNull();
		expect(out!.drop).toEqual([
			{ ticker: "KXPRES-26", reasoning: "0 signals" },
		]);
	});

	it("returns null when no JSON object is present", () => {
		expect(parseLlmResponse("nothing useful here")).toBeNull();
		expect(parseLlmResponse("(stub LLM response)")).toBeNull();
	});

	it("returns null on malformed JSON", () => {
		expect(parseLlmResponse('{"add": [{"ticker": unterminated')).toBeNull();
	});

	it("returns empty arrays when the JSON has no add/drop", () => {
		const out = parseLlmResponse('{"overall_reasoning":"nothing to suggest"}');
		expect(out).not.toBeNull();
		expect(out!.add).toEqual([]);
		expect(out!.drop).toEqual([]);
	});

	it("filters malformed add entries (missing fields)", () => {
		const out = parseLlmResponse(
			`{"add":[{"ticker":"KXGDP-Q4","vertical":"economic","reasoning":"ok"},` +
				`{"ticker":"BAD-1"},{"vertical":"weather","reasoning":"missing ticker"},` +
				`{"ticker":"KXWARMING-65","vertical":"weather","reasoning":"good"}],` +
				`"drop":[],"overall_reasoning":""}`,
		);
		expect(out).not.toBeNull();
		// Only the two well-formed entries survive.
		expect(out!.add).toHaveLength(2);
		expect(out!.add[0].ticker).toBe("KXGDP-Q4");
		expect(out!.add[1].ticker).toBe("KXWARMING-65");
	});
});

describe("leads-cron / validateAndDedupe", () => {
	it("accepts a valid add with a known vertical", () => {
		const out = validateAndDedupe(
			{
				add: [{ ticker: "KXGDP-Q4", vertical: "economic", reasoning: "good" }],
				drop: [],
				overall_reasoning: "",
			},
			makeState(),
			new Set(),
		);
		expect(out.add).toHaveLength(1);
		expect(out.add[0].ticker).toBe("KXGDP-Q4");
		expect(out.add[0].vertical).toBe("economic");
		expect(out.add[0].status).toBe("pending");
		expect(out.add[0].expires_at).toBeGreaterThan(out.add[0].created_at);
		expect(out.excluded).toEqual([]);
	});

	it("rejects adds that don't match the KX ticker format", () => {
		const out = validateAndDedupe(
			{
				add: [
					{ ticker: "BAD-1", vertical: "weather", reasoning: "no KX prefix" },
					{ ticker: "KX", vertical: "weather", reasoning: "too short" },
					{ ticker: "KX!BAD", vertical: "weather", reasoning: "invalid char" },
				],
				drop: [],
				overall_reasoning: "",
			},
			makeState(),
			new Set(),
		);
		expect(out.add).toEqual([]);
		expect(out.excluded).toHaveLength(3);
		// All three should be excluded for the format reason
		// (note: "kxwarming-50" would be uppercased to
		// "KXWARMING-50" which IS in the universe, so it's
		// excluded with a different reason — covered by the
		// 'already in current universe' test below).
		expect(out.excluded.every((e) => e.reason.includes("format"))).toBe(true);
	});

	it("excludes adds already in the current universe", () => {
		const out = validateAndDedupe(
			{
				add: [{ ticker: "KXWARMING-50", vertical: "weather", reasoning: "already there" }],
				drop: [],
				overall_reasoning: "",
			},
			makeState(),
			new Set(),
		);
		expect(out.add).toEqual([]);
		expect(out.excluded).toEqual([
			{ ticker: "KXWARMING-50", kind: "add", reason: "already in current universe" },
		]);
	});

	it("excludes adds in the recently-rejected set", () => {
		const out = validateAndDedupe(
			{
				add: [{ ticker: "KXGDP-Q4", vertical: "economic", reasoning: "previously rejected" }],
				drop: [],
				overall_reasoning: "",
			},
			makeState(),
			new Set(["KXGDP-Q4"]),
		);
		expect(out.add).toEqual([]);
		expect(out.excluded).toEqual([
			{ ticker: "KXGDP-Q4", kind: "add", reason: "rejected within last 30d" },
		]);
	});

	it("rejects adds with an unknown vertical", () => {
		const out = validateAndDedupe(
			{
				add: [{ ticker: "KXGDP-Q4", vertical: "macro", reasoning: "no" }],
				drop: [],
				overall_reasoning: "",
			},
			makeState(),
			new Set(),
		);
		expect(out.add).toEqual([]);
		expect(out.excluded[0].reason).toMatch(/unknown vertical/);
	});

	it("dedupes duplicate adds in the same batch", () => {
		const out = validateAndDedupe(
			{
				add: [
					{ ticker: "KXGDP-Q4", vertical: "economic", reasoning: "first" },
					{ ticker: "KXGDP-Q4", vertical: "economic", reasoning: "dup" },
				],
				drop: [],
				overall_reasoning: "",
			},
			makeState(),
			new Set(),
		);
		expect(out.add).toHaveLength(1);
		expect(out.excluded).toEqual([
			{ ticker: "KXGDP-Q4", kind: "add", reason: "duplicate in batch" },
		]);
	});

	it("accepts a valid drop for a current-universe ticker", () => {
		const out = validateAndDedupe(
			{
				add: [],
				drop: [{ ticker: "KXPRES-26", reasoning: "0 signals 30d" }],
				overall_reasoning: "",
			},
			makeState(),
			new Set(),
		);
		expect(out.drop).toHaveLength(1);
		expect(out.drop[0].ticker).toBe("KXPRES-26");
		expect(out.drop[0].vertical).toBe("politics");
	});

	it("excludes drops that aren't in the current universe", () => {
		const out = validateAndDedupe(
			{
				add: [],
				drop: [{ ticker: "KXWARMING-99", reasoning: "doesn't exist" }],
				overall_reasoning: "",
			},
			makeState(),
			new Set(),
		);
		expect(out.drop).toEqual([]);
		expect(out.excluded).toEqual([
			{ ticker: "KXWARMING-99", kind: "drop", reason: "not in current universe" },
		]);
	});

	it("excludes drops for tickers not in the current universe", () => {
		// Drops are validated by current-universe membership
		// (not format): if the LLM suggests dropping a ticker
		// the bot doesn't have, that's a hallucination to be
		// excluded, not a format error. The current universe
		// is the source of truth for which tickers are valid
		// drop candidates.
		const out = validateAndDedupe(
			{
				add: [],
				drop: [{ ticker: "KXWARMING-99", reasoning: "doesn't exist" }],
				overall_reasoning: "",
			},
			makeState(),
			new Set(),
		);
		expect(out.drop).toEqual([]);
		expect(out.excluded).toEqual([
			{ ticker: "KXWARMING-99", kind: "drop", reason: "not in current universe" },
		]);
	});

	it("caps reasoning length at 500 chars", () => {
		const longReasoning = "x".repeat(800);
		const out = validateAndDedupe(
			{
				add: [{ ticker: "KXGDP-Q4", vertical: "economic", reasoning: longReasoning }],
				drop: [],
				overall_reasoning: "",
			},
			makeState(),
			new Set(),
		);
		expect(out.add[0].reasoning).toHaveLength(500);
		expect(out.add[0].raw_text).toHaveLength(500);
	});

	it("normalizes ticker case to upper", () => {
		const out = validateAndDedupe(
			{
				add: [{ ticker: "kxgdp-q4", vertical: "economic", reasoning: "lowercase" }],
				drop: [],
				overall_reasoning: "",
			},
			makeState(),
			new Set(),
		);
		expect(out.add[0].ticker).toBe("KXGDP-Q4");
	});

	it("handles add+drop in the same batch without collisions", () => {
		const out = validateAndDedupe(
			{
				add: [{ ticker: "KXGDP-Q4", vertical: "economic", reasoning: "add" }],
				drop: [{ ticker: "KXPRES-26", reasoning: "drop" }],
				overall_reasoning: "rebalance",
			},
			makeState(),
			new Set(),
		);
		expect(out.add).toHaveLength(1);
		expect(out.drop).toHaveLength(1);
		expect(out.excluded).toEqual([]);
	});
});
