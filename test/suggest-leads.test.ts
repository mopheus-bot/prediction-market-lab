/**
 * prediction-market-lab — suggest-leads unit tests.
 *
 * The /api/pm/bot/suggest-leads endpoint asks the LLM for
 * new Kalshi tickers and validates the response. These
 * tests cover the two pure functions that drive correctness:
 *   - `parseTickerList`: extracts the JSON object from the
 *     LLM's text (defends against partial / wrapped output).
 *     2026-08-09: shape changed from {tickers: string[],
 *     reasoning: string} to {tickers: {ticker, reasoning}[],
 *     overall_reasoning: string} to give the operator per-
 *     ticker fit/edge/risk reasoning. The parser still
 *     accepts the old flat-string shape for backward compat.
 *   - `validateTickerSuggestions`: dedupes + format-checks
 *     + filters against the operator's "exclude" list + the
 *     bot's current universe.
 *
 * The HTTP + LLM call path is exercised by the manual
 * /api/pm/bot/suggest-leads button on the Dev page.
 */

import { describe, it, expect } from "vitest";
import { parseTickerList, validateTickerSuggestions } from "../src/api/suggest-leads";

describe("parseTickerList", () => {
	it("parses a clean JSON object (new per-ticker-reasoning shape)", () => {
		const out = parseTickerList(
			`{"tickers":[{"ticker":"KXGDP-Q4","reasoning":"economic fit"},{"ticker":"KXWARMING-60","reasoning":"weather fit"}],"overall_reasoning":"add two"}`,
			4,
		);
		expect(out.tickers).toEqual([
			{ ticker: "KXGDP-Q4", reasoning: "economic fit" },
			{ ticker: "KXWARMING-60", reasoning: "weather fit" },
		]);
		expect(out.overall_reasoning).toBe("add two");
	});

	it("accepts the legacy flat-string shape for backward compat", () => {
		// 2026-08-09: M3 may still return the old shape
		// from cache or from a fresh prompt that didn't
		// include the new shape instructions. The parser
		// degrades gracefully — empty reasoning.
		const out = parseTickerList(
			`{"tickers":["KXGDP-Q4","KXWARMING-60"],"reasoning":"add two"}`,
			4,
		);
		expect(out.tickers).toEqual([
			{ ticker: "KXGDP-Q4", reasoning: "" },
			{ ticker: "KXWARMING-60", reasoning: "" },
		]);
		// The old `reasoning` field is mapped to
		// overall_reasoning as a fallback (single
		// sentence summary).
		expect(out.overall_reasoning).toBe("add two");
	});

	it("extracts JSON from a text wrapper", () => {
		const out = parseTickerList(
			`Here are my picks: {"tickers":[{"ticker":"KXGDP-Q4","reasoning":"ok"}],"overall_reasoning":"ok"}`,
			4,
		);
		expect(out.tickers).toEqual([{ ticker: "KXGDP-Q4", reasoning: "ok" }]);
	});

	it("returns empty when no JSON object is present", () => {
		const out = parseTickerList("nothing useful", 4);
		expect(out.tickers).toEqual([]);
		expect(out.overall_reasoning).toMatch(/no JSON/);
	});

	it("returns empty on malformed JSON (has braces but unparseable)", () => {
		// The parser extracts text between the first { and the
		// last }. If that slice isn't valid JSON, the catch
		// fires and returns 'malformed'. Note: a string with
		// no closing } takes the 'no JSON object' branch
		// (covered by the previous test) because the
		// indexOf('{') succeeds but lastIndexOf('}') returns -1.
		const out = parseTickerList('{"tickers": [{"a": 1}', 4);
		expect(out.tickers).toEqual([]);
		expect(out.overall_reasoning).toMatch(/malformed/);
	});

	it("caps at requested count", () => {
		const out = parseTickerList(
			`{"tickers":[{"ticker":"KXA-1"},{"ticker":"KXB-2"},{"ticker":"KXC-3"},{"ticker":"KXD-4"},{"ticker":"KXE-5"}],"overall_reasoning":""}`,
			3,
		);
		expect(out.tickers).toHaveLength(3);
	});

	it("filters non-string entries from the tickers array", () => {
		// 2026-08-09: now handles a mix of string entries
		// (legacy) and object entries (new). Non-string /
		// non-object entries (numbers, null) are dropped.
		const out = parseTickerList(
			`{"tickers":[{"ticker":"KXA-1","reasoning":"x"},42,null,{"ticker":"KXB-2","reasoning":"y"}],"overall_reasoning":""}`,
			4,
		);
		expect(out.tickers).toEqual([
			{ ticker: "KXA-1", reasoning: "x" },
			{ ticker: "KXB-2", reasoning: "y" },
		]);
	});
});

describe("validateTickerSuggestions", () => {
	it("accepts valid KX tickers that aren't excluded", () => {
		const out = validateTickerSuggestions(
			["KXGDP-Q4", "KXWARMING-60"],
			{ exclude: [], limit: 4 },
		);
		expect(out.accepted).toEqual(["KXGDP-Q4", "KXWARMING-60"]);
		expect(out.rejected).toEqual([]);
	});

	it("rejects bad-format tickers", () => {
		// "kxwarming-50" uppercases to a valid KX ticker
		// (KALSHI_TICKER_RE doesn't care about case at
		// validation time, only at format time — and the
		// format check is on the uppercased string), so it's
		// accepted when no exclude is set. The two format
		// failures are "BAD-1" (no KX prefix) and "KX" (too
		// short). The 'uppercases to current universe' test
		// below covers what happens when the uppercased
		// version is already in the universe.
		const out = validateTickerSuggestions(
			["BAD-1", "kxwarming-50", "KX"],
			{ exclude: [], limit: 4 },
		);
		expect(out.accepted).toEqual(["KXWARMING-50"]);
		expect(out.rejected).toHaveLength(2);
		expect(out.rejected.every((r) => r.reason.includes("format"))).toBe(true);
	});

	it("uppercases the input before validation", () => {
		const out = validateTickerSuggestions(
			["kxgdp-q4", "KXWARMING-60"],
			{ exclude: [], limit: 4 },
		);
		expect(out.accepted).toEqual(["KXGDP-Q4", "KXWARMING-60"]);
	});

	it("rejects tickers in the exclude set (current universe)", () => {
		const out = validateTickerSuggestions(
			["KXWARMING-50", "KXGDP-Q4"],
			{ exclude: ["KXWARMING-50", "KXPRES-26"], limit: 4 },
		);
		expect(out.accepted).toEqual(["KXGDP-Q4"]);
		expect(out.rejected).toEqual([
			{ ticker: "KXWARMING-50", reason: "already in current universe or excluded" },
		]);
	});

	it("rejects tickers in the operator's exclude list", () => {
		const out = validateTickerSuggestions(
			["KXGDP-Q4", "KXWARMING-60"],
			{ exclude: ["KXGDP-Q4"], limit: 4 },
		);
		expect(out.accepted).toEqual(["KXWARMING-60"]);
		expect(out.rejected).toEqual([
			{ ticker: "KXGDP-Q4", reason: "already in current universe or excluded" },
		]);
	});

	it("dedupes within the batch (case-insensitive)", () => {
		const out = validateTickerSuggestions(
			["KXGDP-Q4", "kxgdp-q4", "KXGDP-Q4"],
			{ exclude: [], limit: 4 },
		);
		expect(out.accepted).toEqual(["KXGDP-Q4"]);
		expect(out.rejected).toEqual([
			{ ticker: "KXGDP-Q4", reason: "duplicate" },
			{ ticker: "KXGDP-Q4", reason: "duplicate" },
		]);
	});

	it("caps accepted at the limit", () => {
		const out = validateTickerSuggestions(
			["KXA-1", "KXB-2", "KXC-3", "KXD-4", "KXE-5"],
			{ exclude: [], limit: 2 },
		);
		expect(out.accepted).toEqual(["KXA-1", "KXB-2"]);
		expect(out.rejected).toEqual([]);
	});
});
