/**
 * pm-bot — suggest-leads unit tests (chunk 11+).
 *
 * The /api/pm/bot/suggest-leads endpoint asks the LLM for
 * new Kalshi tickers and validates the response. These
 * tests cover the two pure functions that drive correctness:
 *   - `parseTickerList`: extracts the JSON object from the
 *     LLM's text (defends against partial / wrapped output).
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
	it("parses a clean JSON object", () => {
		const out = parseTickerList(
			`{"tickers":["KXGDP-Q4","KXWARMING-60"],"reasoning":"add two"}`,
			4,
		);
		expect(out.tickers).toEqual(["KXGDP-Q4", "KXWARMING-60"]);
		expect(out.reasoning).toBe("add two");
	});

	it("extracts JSON from a text wrapper", () => {
		const out = parseTickerList(
			`Here are my picks: {"tickers":["KXGDP-Q4"],"reasoning":"ok"}`,
			4,
		);
		expect(out.tickers).toEqual(["KXGDP-Q4"]);
	});

	it("returns empty when no JSON object is present", () => {
		const out = parseTickerList("nothing useful", 4);
		expect(out.tickers).toEqual([]);
		expect(out.reasoning).toMatch(/no JSON/);
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
		expect(out.reasoning).toMatch(/malformed/);
	});

	it("caps at requested count", () => {
		const out = parseTickerList(
			`{"tickers":["KXA-1","KXB-2","KXC-3","KXD-4","KXE-5"],"reasoning":""}`,
			3,
		);
		expect(out.tickers).toHaveLength(3);
	});

	it("filters non-string entries from the tickers array", () => {
		const out = parseTickerList(
			`{"tickers":["KXA-1",42,null,"KXB-2"],"reasoning":""}`,
			4,
		);
		expect(out.tickers).toEqual(["KXA-1", "KXB-2"]);
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
