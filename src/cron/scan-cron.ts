/**
 * pm-bot — scan cron (chunk 5).
 *
 * Runs every 15 minutes. Pulls the open Kalshi markets + recent
 * trades, ranks them by realized vol × sqrt(n_trades) +
 * log(vol24h+1) × 0.5, and writes the top N to the `scans`
 * D1 table. The paper engine reads `scans.latest()` on
 * /start to discover the candidate universe.
 *
 * **Budget:** < 60 seconds wall-clock. The market list
 * endpoint paginates at 100 per page; we cap at
 * `SCAN_MARKET_LIMIT` (default 500) to stay under the
 * Worker CPU budget. Per-market trade fetches are also
 * capped (max 5 pages × 1000 trades = 5,000 trades).
 *
 * **Kalshi side-effects:** the scan uses public REST
 * (no auth needed for `/markets` list). Per-market
 * `/markets/trades` may need auth on some endpoints; the
 * `KalshiClient` signs automatically if creds are
 * provided via env.
 */

import {
	DEFAULT_DEMO_BASE,
	DEFAULT_PRODUCTION_BASE,
	KalshiClient,
} from "../kalshi/client.js";
import { scans as scansDb } from "../lib/db.js";
import type { CronEnv, CronResult } from "./dispatcher.js";
import {
	computeRealizedVol,
	rankCandidates,
	scoreMarket,
	type ScanCandidate,
} from "./scan.js";
import { mapCategory } from "./category-mapper.js";
import type { ScanCandidate as DBScanCandidate } from "../lib/types.js";

const DEFAULT_TOP_N = 25;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_MIN_TRADES = 10;
const DEFAULT_VOL24H_MIN = 0;
const DEFAULT_MARKET_LIMIT = 500;
const TRADES_PAGE_SIZE = 1000;
const TRADES_MAX_PAGES = 5;

function envInt(env: CronEnv, key: keyof CronEnv, fallback: number): number {
	const v = env[key];
	if (typeof v !== "string" || v === "") return fallback;
	const n = parseInt(v, 10);
	return Number.isFinite(n) ? n : fallback;
}

export async function runScanCron(env: CronEnv): Promise<CronResult> {
	const topN = envInt(env, "SCAN_TOP_N", DEFAULT_TOP_N);
	const lookbackHours = envInt(env, "SCAN_LOOKBACK_HOURS", DEFAULT_LOOKBACK_HOURS);
	const minTrades = envInt(env, "SCAN_MIN_TRADES", DEFAULT_MIN_TRADES);
	const vol24hMin = envInt(env, "SCAN_VOL24H_MIN", DEFAULT_VOL24H_MIN);
	const marketLimit = DEFAULT_MARKET_LIMIT;
	const seriesList = (env.SCAN_SERIES ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	const baseUrl =
		env.ENVIRONMENT === "production"
			? DEFAULT_PRODUCTION_BASE
			: DEFAULT_DEMO_BASE;
	const client = new KalshiClient({ baseUrl });

	// Compute the lookback cutoff in unix SECONDS (Kalshi's
	// `min_ts` filter rejects ms timestamps).
	const minTsSec = Math.floor(Date.now() / 1000) - lookbackHours * 3600;

	try {
		// 1. Fetch the events to build the ticker→category +
		//    ticker→vertical maps. One call, paginated.
		//    listEvents / iterEvents return PARSED KalshiEvent
		//    values (not wires), so we read fields directly.
		const events: import("../kalshi/models.js").KalshiEvent[] = [];
		{
			let cursor: string | undefined;
			for (let page = 0; page < 20; page++) {
				const { events: pageEvents, cursor: nextCursor } = await client.listEvents({
					status: "open",
					limit: 200,
					cursor,
				});
				for (const ev of pageEvents) events.push(ev);
				if (!nextCursor) break;
				cursor = nextCursor;
			}
		}
		const tickerToCategory: Record<string, string> = {};
		const tickerToVertical: Record<string, string> = {};
		for (const ev of events) {
			for (const m of ev.markets) {
				tickerToCategory[m.ticker] = ev.category;
				tickerToVertical[m.ticker] = mapCategory(ev.category);
			}
		}

		// 2. Iterate markets (or series). For each, fetch recent
		//    trades and build a ScanCandidate.
		const candidates: ScanCandidate[] = [];
		const seen = new Set<string>();

		const processMarket = async (ticker: string): Promise<void> => {
			if (seen.has(ticker)) return;
			seen.add(ticker);
			// listTrades returns PARSED KalshiTrade values.
			const trades: import("../kalshi/models.js").KalshiTrade[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < TRADES_MAX_PAGES; page++) {
				const { trades: pageTrades, cursor: nextCursor } = await client.listTrades({
					ticker,
					limit: TRADES_PAGE_SIZE,
					cursor,
					minTs: minTsSec,
				});
				for (const r of pageTrades) trades.push(r);
				if (!nextCursor) break;
				cursor = nextCursor;
			}
			if (trades.length < minTrades) return;
			const prices = trades
				.map((t) => t.yes_price_cents)
				.filter((c) => c > 0);
			if (prices.length < 2) return;
			const vol = computeRealizedVol(prices);
			const vol24h = trades.reduce((s, t) => s + t.count, 0);
			if (vol24hMin > 0 && vol24h < vol24hMin) return;
			const score = scoreMarket(vol, prices.length, vol24h);
			const cat = tickerToCategory[ticker] ?? null;
			const vert = tickerToVertical[ticker] ?? null;
			candidates.push({
				ticker,
				category: cat,
				vertical: vert,
				vol,
				n_trades: trades.length,
				vol24h,
				score,
				last_trade_at: trades[trades.length - 1].created_at,
			});
		};

		if (seriesList.length > 0) {
			// Series-anchored scan.
			for (const series of seriesList) {
				let cursor: string | undefined;
				for (let page = 0; page < 10; page++) {
					const { markets, cursor: nextCursor } = await client.listMarkets({
						seriesTicker: series,
						status: "open",
						limit: 50,
						cursor,
					});
					for (const m of markets) {
						if (seen.size >= marketLimit) break;
						await processMarket(m.ticker);
					}
					if (!nextCursor) break;
					cursor = nextCursor;
				}
			}
		} else {
			// Full-market scan.
			let nMarkets = 0;
			for await (const m of client.iterMarkets({ status: "open", limit: 100 })) {
				if (nMarkets >= marketLimit) break;
				nMarkets += 1;
				await processMarket(m.ticker);
			}
		}

		// 3. Rank + filter.
		const top = rankCandidates(candidates, topN, 0, vol24hMin);

		// 4. Persist to D1. We map the local ScanCandidate to
		//    the DB row shape (the D1 store takes a slimmed
		//    candidate type).
		if (env.DB) {
			const dbCandidates: DBScanCandidate[] = top.map((c) => ({
				ticker: c.ticker,
				score: c.score,
				vol24h: c.vol24h,
				n_trades: c.n_trades,
				vertical: (c.vertical as DBScanCandidate["vertical"]) ?? "unknown",
			}));
			await scansDb.insert(env.DB, {
				user_id: "default",
				ts: Date.now(),
				source: seriesList.length > 0 ? "series-anchored" : "full-market",
				lookback_hours: lookbackHours,
				min_trades: minTrades,
				top_n: topN,
				vol24h_min: vol24hMin,
				candidates: dbCandidates,
			});
		}

		return {
			ok: true,
			cron_name: "scan",
			duration_ms: 0,
			artifacts: {
				n_candidates: top.length,
				n_scanned: seen.size,
				top_n: topN,
				lookback_hours: lookbackHours,
			},
		};
	} catch (e) {
		return {
			ok: false,
			cron_name: "scan",
			duration_ms: 0,
			error_message: e instanceof Error ? e.message : String(e),
		};
	}
}
