/**
 * pm-bot — research cron (chunk 14.1, 2026-08-10).
 *
 * Runs every 15 minutes. Polls Kalshi's open-market list, filters
 * to markets that LOOK active (last_price > 0 OR OI > 0), and
 * does a GET to pull the real orderbook for each. Writes
 * snapshots to `live_market_snapshots` so the Dev page and
 * the cadence panel can show "what's actually tradeable right
 * now" without the operator having to call Kalshi's API
 * themselves.
 *
 * **Why this exists (2026-08-10):** the LIST endpoint
 * (`/markets?status=open`) does NOT include live orderbook
 * data — it returns 0 for yes_bid_cents / yes_ask_cents on
 * every market. The real orderbook is only available via
 * the GET endpoint (`/markets/{ticker}`). Without this
 * cron, the operator has to manually GET each ticker to see
 * if there's a real two-sided quote. This cron does the
 * bulk GET in the background and surfaces the live view.
 *
 * **What "live" means here:** a market is `is_live = 1` if
 * it has a real two-sided orderbook (yes_bid_cents > 0 AND
 * yes_ask_cents > 0 AND yes_ask_cents > yes_bid_cents) on
 * the most recent snapshot. One-sided quotes (asks but no
 * bids, or bids but no asks) are NOT live — Kalshi is
 * offering to take the other side but no one's trading.
 *
 * **Cost:** ~30 LIST calls (1 page = 200 markets × 30 pages
 * = 6,000 markets) + N GET calls where N = number of
 * "looks active" markets (typically 0-100). At the default
 * 2 req/s throttle, this takes ~30-60 seconds wall-clock.
 * Well within the Worker CPU budget. At 4 runs/hour, total
 * ~1,000 GET calls/day — far below Kalshi's IP-level rate
 * limit.
 *
 * **What this is NOT:** this cron doesn't make any trading
 * decisions. It just observes. The lead-cron (chunk 13)
 * uses the scout to filter verticals. The future parlay
 * strategy (Phase 2) will use this snapshot as the source
 * of truth for which markets to consider.
 *
 * **Backward compat:** if the KalshiClient isn't built (no
 * creds), the cron logs a warning and returns ok=true with
 * a "skipped" artifact. The cadence panel surfaces the
 * skip. Operators who haven't set KALSHI_DEMO/PROD creds
 * still get a clean "research disabled" line.
 */

import {
	DEFAULT_PRODUCTION_BASE,
	KalshiClient,
} from "../kalshi/client.js";
import { DEFAULT_USER_ID } from "../lib/types.js";
import { cronRuns, liveMarketSnapshots } from "../lib/db.js";
import { loadPrivateKey, KalshiCredentials } from "../kalshi/auth.js";
import type { CronEnv, CronResult } from "./dispatcher.js";

const MAX_PAGES = 30;
const PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 8_000;

/** A market "looks active" if it has any historical trade OR
 *  any open interest. These are the markets we'll spend a
 *  GET call on. 6,000+ open markets exist, but >99% are
 *  freshly listed with no activity — we skip the GET for
 *  them. */
function looksActive(
	m: { last_price_cents?: number; open_interest?: number; volume?: number; volume_24h?: number },
): boolean {
	if ((m.last_price_cents ?? 0) > 0) return true;
	if ((m.open_interest ?? 0) > 0) return true;
	if ((m.volume_24h ?? 0) > 0) return true;
	if ((m.volume ?? 0) > 0) return true;
	return false;
}

/** A snapshot is "live" (real two-sided quote) if:
 *  - yes_bid > 0 (someone is bidding to buy yes)
 *  - yes_ask > 0 (someone is offering to sell yes)
 *  - yes_ask > yes_bid (the ask is genuinely above the bid —
 *    not a default 0/0 or 0/100 placeholder) */
function computeIsLive(
	yes_bid_cents: number,
	yes_ask_cents: number,
): 0 | 1 {
	if (yes_bid_cents > 0 && yes_ask_cents > 0 && yes_ask_cents > yes_bid_cents) {
		return 1;
	}
	return 0;
}

/** Build a KalshiClient from the worker's env creds. */
async function buildKalshiClientAsync(env: CronEnv): Promise<KalshiClient | null> {
	if (env.KALSHI_PROD_KEY_ID && env.KALSHI_PROD_PRIVATE_KEY) {
		try {
			const pk = await loadPrivateKey(env.KALSHI_PROD_PRIVATE_KEY);
			const creds = new KalshiCredentials(env.KALSHI_PROD_KEY_ID, pk);
			return new KalshiClient({
				baseUrl: DEFAULT_PRODUCTION_BASE,
				credentials: creds,
				requestsPerSecond: 2,
			});
		} catch (e) {
			console.warn("[research] failed to load Kalshi prod creds", e);
		}
	}
	if (env.KALSHI_DEMO_KEY_ID && env.KALSHI_DEMO_PRIVATE_KEY) {
		try {
			const pk = await loadPrivateKey(env.KALSHI_DEMO_PRIVATE_KEY);
			const creds = new KalshiCredentials(env.KALSHI_DEMO_KEY_ID, pk);
			return new KalshiClient({
				baseUrl: "https://demo-api.kalshi.co/trade-api/v2",
				credentials: creds,
				requestsPerSecond: 2,
			});
		} catch (e) {
			console.warn("[research] failed to load Kalshi demo creds", e);
		}
	}
	return null;
}

export async function runResearchCron(env: CronEnv): Promise<CronResult> {
	const startMs = Date.now();
	const now = Date.now();

	// 1. No DB → can't persist snapshots. Skip with a clear signal.
	if (!env.DB) {
		return {
			ok: false,
			cron_name: "research",
			duration_ms: Date.now() - startMs,
			error_message: "no DB binding; live_market_snapshots requires D1",
		};
	}

	// 2. No Kalshi creds → research disabled. Surface as a
	//    clear artifact so the cadence panel renders it.
	const client = await buildKalshiClientAsync(env);
	if (!client) {
		console.warn("[research] no Kalshi creds; research disabled");
		return {
			ok: true,
			cron_name: "research",
			duration_ms: Date.now() - startMs,
			artifacts: {
				skipped: true,
				skip_reason: "no_kalshi_creds",
			},
		};
	}

	let nScanned = 0;
	let nLookedActive = 0;
	let nSnapshotsWritten = 0;
	let nLive = 0;
	const liveTickers: string[] = [];
	const errors: Array<{ ticker: string; message: string }> = [];

	try {
		// 3. LIST the full open-market catalog. Cheap (1 call
		//    per page, 200 markets per page, ~30 pages = 6,000).
		//    The LIST endpoint doesn't include live orderbook
		//    data but DOES include last_price / OI / vol_24h —
		//    enough to filter to "looks active" markets.
		const looksActiveMarkets: Array<{
			ticker: string;
			event_ticker: string;
			title: string;
			last_price_cents: number;
			open_interest: number;
			volume_24h: number;
			close_time: string | null;
		}> = [];
		for await (const m of client.iterMarkets({
			status: "open",
			limit: PAGE_SIZE,
			maxPages: MAX_PAGES,
		})) {
			nScanned += 1;
			if (!looksActive(m)) continue;
			looksActiveMarkets.push({
				ticker: m.ticker,
				event_ticker: (m as unknown as { event_ticker?: string }).event_ticker ?? "",
				title: m.title ?? "",
				last_price_cents: m.last_price_cents,
				open_interest: m.open_interest ?? 0,
				volume_24h: m.volume_24h ?? 0,
				close_time: m.close_time ?? null,
			});
		}
		nLookedActive = looksActiveMarkets.length;

		// 4. For each "looks active" market, GET the real
		//    orderbook. The GET endpoint is the ONLY place
		//    yes_bid_cents / yes_ask_cents have real values.
		for (const candidate of looksActiveMarkets) {
			try {
				const m = await Promise.race([
					client.getMarket(candidate.ticker),
					new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error(`GET ${candidate.ticker} timed out`)),
							REQUEST_TIMEOUT_MS,
						),
					),
				]);
				const yes_bid = m.yes_bid_cents;
				const yes_ask = m.yes_ask_cents;
				const is_live = computeIsLive(yes_bid, yes_ask);
				if (is_live === 1) {
					nLive += 1;
					liveTickers.push(candidate.ticker);
				}
				await liveMarketSnapshots.upsert(env.DB, DEFAULT_USER_ID, {
					user_id: DEFAULT_USER_ID,
					ts: now,
					ticker: candidate.ticker,
					event_ticker: candidate.event_ticker || null,
					title: candidate.title || null,
					yes_bid_cents: yes_bid,
					yes_ask_cents: yes_ask,
					no_bid_cents: m.no_bid_cents,
					no_ask_cents: m.no_ask_cents,
					last_price_cents: m.last_price_cents,
					volume_24h: m.volume_24h ?? null,
					open_interest: m.open_interest ?? null,
					is_live,
					close_time: candidate.close_time,
				});
				nSnapshotsWritten += 1;
			} catch (e) {
				errors.push({
					ticker: candidate.ticker,
					message: e instanceof Error ? e.message : String(e),
				});
			}
		}
	} catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		console.error(`[research] failed: ${errMsg}`);
		return {
			ok: false,
			cron_name: "research",
			duration_ms: Date.now() - startMs,
			error_message: errMsg,
			artifacts: {
				n_scanned: nScanned,
				n_looked_active: nLookedActive,
				n_snapshots_written: nSnapshotsWritten,
				n_live: nLive,
				live_tickers: liveTickers,
				errors: errors.slice(0, 20),
			},
		};
	}

	// 5. Record the cron run for observability.
	try {
		await cronRuns.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			cron_name: "research",
			ts: now,
			duration_ms: Date.now() - startMs,
			status: errors.length > 0 ? "error" : "success",
			error_message:
				errors.length > 0
					? `${errors.length} ticker errors (first: ${errors[0].message})`
					: null,
			artifacts_json: null,
		});
	} catch (e) {
		console.warn("[research] failed to record cron_run", e);
	}

	return {
		ok: errors.length === 0,
		cron_name: "research",
		duration_ms: Date.now() - startMs,
		artifacts: {
			n_scanned: nScanned,
			n_looked_active: nLookedActive,
			n_snapshots_written: nSnapshotsWritten,
			n_live: nLive,
			live_tickers: liveTickers,
			errors: errors.slice(0, 20),
		},
	};
}
