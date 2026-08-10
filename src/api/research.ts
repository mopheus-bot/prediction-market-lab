/**
 * pm-bot — research API (chunk 14.1, 2026-08-10).
 *
 * Surfaces the live_market_snapshots table the research-cron
 * writes every 15 min. Two endpoints:
 *
 *   GET /api/pm/research/live-markets
 *     → { ok, ts, n_live, markets: [...latest snapshot per ticker] }
 *     The "current live" view. By default, returns only markets
 *     with is_live = 1 (real two-sided orderbook). Pass
 *     ?include_dormant=1 to also see the markets that LOOK
 *     active but currently have a one-sided or empty book.
 *
 *   GET /api/pm/research/live-markets/:ticker
 *     → { ok, ts, ticker, history: [...all snapshots for that ticker] }
 *     Time series for one ticker, oldest first. Used by the
 *     Dev page to render a "this market over the last 24h"
 *     mini-chart.
 *
 * **Why a separate file:** the lead-cron and the cadence panel
 * don't need this data. The research-cron is its own concern
 * with its own DB table; the API is small enough to live in
 * a single file.
 */

import { DEFAULT_USER_ID } from "../lib/types.js";
import { liveMarketSnapshots } from "../lib/db.js";
import type { LiveMarketSnapshotRow } from "../lib/db.js";

export interface ResearchEnv {
	DB?: D1Database;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function handleGetLiveMarkets(
	env: ResearchEnv,
	url: URL,
): Promise<Response> {
	if (!env.DB) {
		return Response.json(
			{ ok: false, error: "no_db" },
			{ status: 503, headers: NO_STORE },
		);
	}
	const includeDormant = url.searchParams.get("include_dormant") === "1";
	const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));

	try {
		const markets = await liveMarketSnapshots.latestPerTicker(env.DB, DEFAULT_USER_ID, {
			onlyLive: !includeDormant,
			limit,
		});
		const liveCount = markets.filter((m) => m.is_live === 1).length;
		return Response.json(
			{
				ok: true,
				ts: Date.now(),
				include_dormant: includeDormant,
				n_returned: markets.length,
				n_live: liveCount,
				markets: markets.map(rowToJson),
			},
			{ headers: NO_STORE },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return Response.json({ ok: false, error: msg }, { status: 500, headers: NO_STORE });
	}
}

export async function handleGetLiveMarketHistory(
	env: ResearchEnv,
	ticker: string,
	url: URL,
): Promise<Response> {
	if (!env.DB) {
		return Response.json(
			{ ok: false, error: "no_db" },
			{ status: 503, headers: NO_STORE },
		);
	}
	const since = url.searchParams.get("since");
	const until = url.searchParams.get("until");
	const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
	const sinceTs = since ? parseInt(since, 10) * 1000 : undefined;
	const untilTs = until ? parseInt(until, 10) * 1000 : undefined;

	try {
		const history = await liveMarketSnapshots.history(env.DB, DEFAULT_USER_ID, ticker, {
			since_ts: sinceTs,
			until_ts: untilTs,
			limit,
		});
		return Response.json(
			{
				ok: true,
				ts: Date.now(),
				ticker,
				n_returned: history.length,
				history: history.map(rowToJson),
			},
			{ headers: NO_STORE },
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return Response.json({ ok: false, error: msg }, { status: 500, headers: NO_STORE });
	}
}

function rowToJson(m: LiveMarketSnapshotRow): Record<string, unknown> {
	return {
		ticker: m.ticker,
		event_ticker: m.event_ticker,
		title: m.title,
		yes_bid_cents: m.yes_bid_cents,
		yes_ask_cents: m.yes_ask_cents,
		no_bid_cents: m.no_bid_cents,
		no_ask_cents: m.no_ask_cents,
		last_price_cents: m.last_price_cents,
		volume_24h: m.volume_24h,
		open_interest: m.open_interest,
		is_live: m.is_live === 1,
		spread_cents:
			m.yes_ask_cents > m.yes_bid_cents && m.yes_bid_cents > 0
				? m.yes_ask_cents - m.yes_bid_cents
				: null,
		close_time: m.close_time,
		ts: m.ts,
	};
}
