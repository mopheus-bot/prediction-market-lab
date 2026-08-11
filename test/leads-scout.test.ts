/**
 * pm-bot — leads-scout unit tests (chunk 13+, 2026-08-09).
 *
 * The scout pre-fetches Kalshi's open markets and filters to
 * vertical-relevant ones. These tests cover the pure functions:
 *   - `classifyVertical` (implicitly, via the regex on title)
 *   - `filterAndRank` (implicitly, via fetchAndFilterMarkets)
 *   - `checkUniverseHealth` (covered directly)
 *   - `formatScoutForPrompt` (covered directly)
 *
 * The KalshiClient is mocked with a simple in-memory market
 * list — we don't want unit tests to hit the real API.
 */

import { describe, it, expect, vi } from "vitest";
import {
	fetchAndFilterMarkets,
	checkUniverseHealth,
	formatScoutForPrompt,
	type ScoutedMarket,
} from "../src/kalshi/leads-scout.js";
import type { KalshiClient, KalshiMarket } from "../src/kalshi/client.js";

// ─── Mock KalshiClient ────────────────────────────────────────

function makeMarket(
	ticker: string,
	title: string,
	opts: { volume_24h?: number; open_interest?: number; event_ticker?: string } = {},
): KalshiMarket {
	return {
		ticker,
		event_ticker: opts.event_ticker ?? `EVT-${ticker}`,
		market_type: "binary",
		title,
		sub_title: "",
		status: "active",
		last_price_cents: 50,
		yes_bid_cents: 50,
		yes_ask_cents: 52,
		no_bid_cents: 48,
		no_ask_cents: 50,
		previous_price_cents: 50,
		open_interest: opts.open_interest ?? 100,
		volume: 1000,
		volume_24h: opts.volume_24h ?? 100,
		liquidity_cents: 100_00,
		close_time: null,
		open_time: null,
		expiration_time: null,
	};
}

function mockKalshiClient(markets: KalshiMarket[]): KalshiClient {
	// Build a generator that yields all markets then ends.
	async function* iter(opts: any): AsyncGenerator<KalshiMarket, void, void> {
		void opts;
		for (const m of markets) yield m;
	}
	return {
		iterMarkets: iter,
	} as unknown as KalshiClient;
}

function makeScoutedMarket(
	ticker: string,
	title: string,
	vertical: ScoutedMarket["vertical"],
): ScoutedMarket {
	return {
		ticker,
		title,
		vertical,
		volume_24h: 100,
		open_interest: 200,
		close_time: null,
		expiration_time: null,
	};
}

// ─── fetchAndFilterMarkets ────────────────────────────────────

describe("leads-scout / fetchAndFilterMarkets", () => {
	it("classifies weather markets by event_ticker prefix", async () => {
		const markets = [
			makeMarket("KXWARMING-50", "Will the world pass 2°C before 2050?", {
				event_ticker: "KXWARMING-50",
			}),
			makeMarket("KXTEMP-NYC-1", "Will NYC temperature exceed 90°F on July 4?", {
				event_ticker: "KXTEMP-NYC-1",
			}),
			makeMarket("KXRAIN-LAX-1", "Will it rain in LA on Friday?", {
				event_ticker: "KXRAIN-LAX-1",
			}),
		];
		const client = mockKalshiClient(markets);
		const result = await fetchAndFilterMarkets({ kalshiClient: client });
		expect(result.ok).toBe(true);
		expect(result.markets.map((m) => m.vertical)).toEqual([
			"weather",
			"weather",
			"weather",
		]);
	});

	it("classifies economic markets by event_ticker prefix", async () => {
		const markets = [
			makeMarket("KXGDP-Q3", "US GDP Q3 2026", { event_ticker: "KXGDP-Q3" }),
			makeMarket("KXCPI-AUG", "Headline CPI release", { event_ticker: "KXCPI-AUG" }),
			makeMarket("KXFED-RATE", "Fed rate decision September 2026", { event_ticker: "KXFED-RATE" }),
		];
		const client = mockKalshiClient(markets);
		const result = await fetchAndFilterMarkets({ kalshiClient: client });
		expect(result.markets.map((m) => m.vertical)).toEqual([
			"economic",
			"economic",
			"economic",
		]);
	});

	it("classifies politics markets by event_ticker prefix", async () => {
		const markets = [
			makeMarket("KXPRES-26", "2026 Presidential election winner", { event_ticker: "KXPRES-26" }),
			makeMarket("KXSENATE-OH-26", "Ohio Senate race 2026", { event_ticker: "KXSENATE-OH-26" }),
			makeMarket("KXGOV-CA-26", "California Governor election", { event_ticker: "KXGOV-CA-26" }),
		];
		const client = mockKalshiClient(markets);
		const result = await fetchAndFilterMarkets({ kalshiClient: client });
		expect(result.markets.map((m) => m.vertical)).toEqual([
			"politics",
			"politics",
			"politics",
		]);
	});

	it("classifies KXMVESPORTS* markets as sports", async () => {
		// The real Kalshi reality: 4,065 markets with this
		// prefix. Multi-game parlays, not simple-event, but
		// they're what Kalshi has.
		const markets = [
			makeMarket(
				"KXMVESPORTSMULTIGAMEEXTENDED-S2026AAA-XXX",
				"yes Team A,yes Team B",
				{ event_ticker: "KXMVESPORTSMULTIGAMEEXTENDED-S2026AAA-XXX" },
			),
		];
		const client = mockKalshiClient(markets);
		const result = await fetchAndFilterMarkets({ kalshiClient: client });
		expect(result.markets[0].vertical).toBe("sports");
	});

	it("excludes KXMVECROSSCATEGORY markets entirely", async () => {
		// Kalshi's docs flag these as multi-event parlays
		// the bot's strategies don't apply to.
		const markets = [
			makeMarket(
				"KXMVECROSSCATEGORY-S2026AAA-XXX",
				"yes Team A,yes GDP growth",
				{ event_ticker: "KXMVECROSSCATEGORY-S2026AAA-XXX" },
			),
		];
		const client = mockKalshiClient(markets);
		const result = await fetchAndFilterMarkets({ kalshiClient: client });
		expect(result.markets).toHaveLength(0);
	});

	it("classifies unmatched KX* tickers as 'uncategorized' (catch-all)", async () => {
		// 2026-08-11: the leads-scout now covers all 17 Kalshi
		// categories. KX* tickers that don't match any specific
		// prefix (e.g. brand-new market types Kalshi adds) fall
		// into the "uncategorized" catch-all vertical so the LLM
		// still gets a chance to evaluate them. The pre-2026-08-11
		// behavior was to skip these entirely; now they're
		// surfaced (with vertical=uncategorized) for the LLM.
		const markets = [
			makeMarket("KXRANDOM-1", "Will the next iPhone be released in September?", {
				event_ticker: "KXRANDOM-1",
			}),
		];
		const client = mockKalshiClient(markets);
		const result = await fetchAndFilterMarkets({ kalshiClient: client });
		expect(result.markets).toHaveLength(1);
		expect(result.markets[0].vertical).toBe("uncategorized");
		expect(result.total_scanned).toBe(1);
	});

	it("includes zero-liquidity markets by default (Kalshi lists them as active)", async () => {
		// As of 2026-08-09, the entire 4,065-market KXMVESPORTS*
		// block has vol_24h=0 AND OI=0 — Kalshi shows them as
		// "active" but no one has traded them yet. We include
		// these so the LLM can see newly-listed markets.
		const markets = [
			makeMarket("KXGDP-Q3", "GDP market", {
				event_ticker: "KXGDP-Q3",
				volume_24h: 0,
				open_interest: 0,
			}),
			makeMarket("KXGDP-Q4", "GDP market with trades", {
				event_ticker: "KXGDP-Q4",
				volume_24h: 100,
				open_interest: 0,
			}),
		];
		const client = mockKalshiClient(markets);
		const result = await fetchAndFilterMarkets({ kalshiClient: client });
		expect(result.markets).toHaveLength(2);
	});

	it("skips zero-liquidity markets when minLiquidity=1 is set", async () => {
		const markets = [
			makeMarket("KXGDP-Q3", "GDP market", {
				event_ticker: "KXGDP-Q3",
				volume_24h: 0,
				open_interest: 0,
			}),
			makeMarket("KXGDP-Q4", "GDP market with trades", {
				event_ticker: "KXGDP-Q4",
				volume_24h: 100,
				open_interest: 0,
			}),
		];
		const client = mockKalshiClient(markets);
		const result = await fetchAndFilterMarkets({
			kalshiClient: client,
			minLiquidity: 1,
		});
		expect(result.markets).toHaveLength(1);
		expect(result.markets[0].ticker).toBe("KXGDP-Q4");
	});

	it("caps per-vertical output at maxPerVertical", async () => {
		// 5 weather markets, cap at 3.
		const markets = Array.from({ length: 5 }, (_, i) =>
			makeMarket(`KXWARMING-${i}`, `Weather market ${i}`, {
				event_ticker: `KXWARMING-${i}`,
				volume_24h: 100 - i, // descending liquidity
			}),
		);
		const client = mockKalshiClient(markets);
		const result = await fetchAndFilterMarkets({
			kalshiClient: client,
			maxPerVertical: 3,
		});
		expect(result.markets).toHaveLength(3);
		// Should be the 3 highest-liquidity (lowest i).
		expect(result.markets.map((m) => m.ticker)).toEqual([
			"KXWARMING-0",
			"KXWARMING-1",
			"KXWARMING-2",
		]);
	});

	it("returns ok=false when the Kalshi client throws", async () => {
		const client = {
			iterMarkets: () => {
				throw new Error("Kalshi 503 Service Unavailable");
			},
		} as unknown as KalshiClient;
		const result = await fetchAndFilterMarkets({ kalshiClient: client });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("Kalshi 503");
		expect(result.markets).toHaveLength(0);
	});
});

// ─── checkUniverseHealth ──────────────────────────────────────

describe("leads-scout / checkUniverseHealth", () => {
	it("flags tickers not in the snapshot as expired", () => {
		const scout = {
			markets: [
				makeScoutedMarket("KXWARMING-50", "...", "weather"),
				makeScoutedMarket("KXGDP-Q3", "...", "economic"),
			],
			by_ticker: new Map(),
			all_markets: [
				makeMarket("KXWARMING-50", "..."),
				makeMarket("KXGDP-Q3", "..."),
				// KXPRES-26 NOT in the snapshot — it's expired.
			],
			total_scanned: 3,
			fetched_at: Date.now(),
			ok: true,
		};
		const health = checkUniverseHealth(scout, [
			"KXWARMING-50",
			"KXGDP-Q3",
			"KXPRES-26",
		]);
		expect(health.valid).toEqual(["KXWARMING-50", "KXGDP-Q3"]);
		expect(health.expired).toEqual([
			{ ticker: "KXPRES-26", last_seen: null },
		]);
	});

	it("returns all-valid when the universe is a subset of the snapshot", () => {
		const scout = {
			markets: [],
			by_ticker: new Map(),
			all_markets: [
				makeMarket("KXWARMING-50", "..."),
				makeMarket("KXGDP-Q3", "..."),
				makeMarket("KXNBA-CHAMP", "..."),
			],
			total_scanned: 3,
			fetched_at: Date.now(),
			ok: true,
		};
		const health = checkUniverseHealth(scout, ["KXWARMING-50"]);
		expect(health.valid).toEqual(["KXWARMING-50"]);
		expect(health.expired).toEqual([]);
	});

	it("returns all-expired when the snapshot is empty", () => {
		const scout = {
			markets: [],
			by_ticker: new Map(),
			all_markets: [],
			total_scanned: 0,
			fetched_at: Date.now(),
			ok: true,
		};
		const health = checkUniverseHealth(scout, [
			"KXWARMING-50",
			"KXGDP-Q3",
		]);
		expect(health.valid).toEqual([]);
		expect(health.expired.map((e) => e.ticker).sort()).toEqual([
			"KXGDP-Q3",
			"KXWARMING-50",
		]);
	});
});

// ─── formatScoutForPrompt ────────────────────────────────────

describe("leads-scout / formatScoutForPrompt", () => {
	it("includes a header line and groups markets by vertical", () => {
		const result = {
			markets: [
				makeScoutedMarket("KXWARMING-50", "Climate market", "weather"),
				makeScoutedMarket("KXGDP-Q3", "GDP market", "economic"),
			],
			by_ticker: new Map(),
			all_markets: [],
			total_scanned: 100,
			fetched_at: Date.now(),
			ok: true,
		};
		const out = formatScoutForPrompt(result);
		expect(out).toContain("100 open markets scanned");
		expect(out).toContain("2 matched verticals");
		expect(out).toContain("[weather]");
		expect(out).toContain("KXWARMING-50");
		expect(out).toContain("[economic]");
		expect(out).toContain("KXGDP-Q3");
	});

	it("emits a clear warning when the scout failed", () => {
		const result = {
			markets: [],
			by_ticker: new Map(),
			all_markets: [],
			total_scanned: 0,
			fetched_at: Date.now(),
			ok: false,
			error: "Kalshi 503 Service Unavailable",
		};
		const out = formatScoutForPrompt(result);
		expect(out).toContain("Scout failed");
		expect(out).toContain("Kalshi 503");
	});

	it("truncates long titles", () => {
		const longTitle = "x".repeat(500);
		const result = {
			markets: [
				makeScoutedMarket("KXWARMING-50", longTitle, "weather"),
			],
			by_ticker: new Map(),
			all_markets: [],
			total_scanned: 1,
			fetched_at: Date.now(),
			ok: true,
		};
		const out = formatScoutForPrompt(result, { maxTitleChars: 80 });
		expect(out).toContain("…");
		// The full 500-char title should NOT be in the output.
		expect(out).not.toContain(longTitle);
	});
});
