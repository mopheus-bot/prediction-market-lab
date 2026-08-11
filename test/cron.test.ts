/**
 * pm-bot — cron unit tests.
 *
 * Tests the scan math (computeRealizedVol, scoreMarket,
 * rankCandidates), the dispatcher (jobForCron), the
 * category mapper, and the per-job stubs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
	computeRealizedVol,
	rankCandidates,
	scoreMarket,
	type ScanCandidate,
} from "../src/cron/scan";
import { CRON_TABLE, jobForCron, type CronName } from "../src/cron/dispatcher";
import { mapCategory } from "../src/cron/category-mapper";

describe("computeRealizedVol", () => {
	it("returns 0 for fewer than 2 prices", () => {
		expect(computeRealizedVol([])).toBe(0);
		expect(computeRealizedVol([50])).toBe(0);
	});

	it("returns 0 when prices are all identical (no variance)", () => {
		expect(computeRealizedVol([50, 50, 50, 50])).toBe(0);
	});

	it("returns 0 when prices include a 0 (would div-by-zero)", () => {
		expect(computeRealizedVol([0, 50, 60])).toBe(0);
	});

	it("matches the Python std for a known sequence", () => {
		// Returns = [+0.10, -0.10] -> std = 0.141421356237...
		const v = computeRealizedVol([50, 55, 49.5]);
		expect(v).toBeCloseTo(0.1414, 3);
	});

	it("matches the Python std for the worked example", () => {
		// The Python docstring has this comment:
		//   Returns: [+0.01, -0.02, +0.005]
		//   std = 0.015
		const v = computeRealizedVol([100, 101, 99, 99.5]);
		expect(v).toBeCloseTo(0.0158, 3);
	});
});

describe("scoreMarket", () => {
	it("returns 0 when both vol and vol24h are 0", () => {
		expect(scoreMarket(0, 0, 0)).toBe(0);
		expect(scoreMarket(0, 100, 0)).toBe(0);
	});

	it("uses the log term when vol=0 but vol24h > 0", () => {
		// log(100+1) * 0.5 = ~2.35
		expect(scoreMarket(0, 0, 100)).toBeCloseTo(Math.log(101) * 0.5, 6);
	});

	it("combines the vol and activity terms", () => {
		// vol=0.05, n=100, vol24h=200
		// = 0.05 * 10 + log(201) * 0.5
		// = 0.5 + 2.65
		const s = scoreMarket(0.05, 100, 200);
		expect(s).toBeCloseTo(0.5 + Math.log(201) * 0.5, 6);
	});

	it("scales vol with sqrt(n)", () => {
		// 10 trades vs 100 trades at the same vol:
		// 10 -> vol * 3.16; 100 -> vol * 10
		const s10 = scoreMarket(0.1, 10, 0);
		const s100 = scoreMarket(0.1, 100, 0);
		expect(s100 / s10).toBeCloseTo(Math.sqrt(100 / 10), 3);
	});
});

describe("rankCandidates", () => {
	function c(
		ticker: string,
		score: number,
		vol = 0.05,
		vol24h = 100,
	): ScanCandidate {
		return {
			ticker,
			category: null,
			vertical: null,
			vol,
			n_trades: 50,
			vol24h,
			score,
			last_trade_at: null,
		};
	}

	it("sorts by score descending", () => {
		const top = rankCandidates(
			[c("B", 0.5), c("A", 2.0), c("C", 1.0)],
			10,
		);
		expect(top.map((x) => x.ticker)).toEqual(["A", "C", "B"]);
	});

	it("excludes score=0 candidates", () => {
		const top = rankCandidates(
			[c("A", 0), c("B", 1.0), c("C", 0.5)],
			10,
		);
		expect(top.map((x) => x.ticker)).toEqual(["B", "C"]);
	});

	it("respects the topN limit", () => {
		const many = Array.from({ length: 20 }, (_, i) => c(`T${i}`, 20 - i));
		const top = rankCandidates(many, 5);
		expect(top.length).toBe(5);
		expect(top[0].ticker).toBe("T0");
	});

	it("applies minVol and minVol24h floors", () => {
		const top = rankCandidates(
			[c("A", 5, 0.05, 100), c("B", 4, 0.001, 50), c("C", 3, 0.05, 1)],
			10,
			0.01,
			10,
		);
		// B filtered by minVol, C filtered by minVol24h.
		expect(top.map((x) => x.ticker)).toEqual(["A"]);
	});
});

describe("jobForCron", () => {
	it("maps each CRON_TABLE expression to its job", () => {
		for (const [name, expr] of Object.entries(CRON_TABLE)) {
			expect(jobForCron(expr)).toBe(name as CronName);
		}
	});

	it("returns null for unknown expressions", () => {
		expect(jobForCron("0 0 * * *")).toBeNull();
		expect(jobForCron("*/5 * * * *")).toBeNull();
	});
});

describe("mapCategory", () => {
	it("maps all 17 Kalshi categories", () => {
		// 2026-08-11: expanded from 4 → 17. Elections and
		// Politics are now separate verticals (previously
		// Elections was bucketed under Politics).
		expect(mapCategory("Climate and Weather")).toBe("weather");
		expect(mapCategory("Economics")).toBe("economic");
		expect(mapCategory("Sports")).toBe("sports");
		expect(mapCategory("Elections")).toBe("elections");
		expect(mapCategory("Politics")).toBe("politics");
		expect(mapCategory("Financials")).toBe("financials");
		expect(mapCategory("Entertainment")).toBe("entertainment");
		expect(mapCategory("Science and Technology")).toBe("science_technology");
		expect(mapCategory("Crypto")).toBe("crypto");
		expect(mapCategory("Companies")).toBe("companies");
		expect(mapCategory("Commodities")).toBe("commodities");
		expect(mapCategory("Mentions")).toBe("mentions");
		expect(mapCategory("Social")).toBe("social");
		expect(mapCategory("World")).toBe("world");
		expect(mapCategory("Health")).toBe("health");
		expect(mapCategory("Transportation")).toBe("transportation");
	});

	it("is case-insensitive", () => {
		expect(mapCategory("SPORTS")).toBe("sports");
		expect(mapCategory("economics")).toBe("economic");
		expect(mapCategory("CRYPTO")).toBe("crypto");
	});

	it("returns 'uncategorized' for unrecognized categories", () => {
		// 2026-08-11: the bot now covers all 17 Kalshi
		// categories. Anything not on the list (e.g. a
		// Kalshi-internal category name the bot hasn't seen,
		// or a typo) falls through to "uncategorized" — the
		// bot still evaluates it via the LLM, but the LLM
		// signal is the only strategy (no reversion model).
		// The pre-2026-08-11 return value of "unknown" is
		// now "uncategorized" to match the expanded Vertical
		// enum.
		expect(mapCategory("Culture")).toBe("uncategorized");
		expect(mapCategory("Real Estate")).toBe("uncategorized");
		expect(mapCategory(null)).toBe("uncategorized");
		expect(mapCategory(undefined)).toBe("uncategorized");
	});
});
