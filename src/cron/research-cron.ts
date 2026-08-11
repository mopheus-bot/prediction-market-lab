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
 * **What "live" means here (2026-08-10, paper-mode relaxation):**
 * a market is `is_live = 1` if EITHER yes_bid_cents > 0 OR
 * yes_ask_cents > 0 — i.e. Kalshi is quoting it on at least
 * one side. The previous definition required BOTH sides with
 * a sane spread (yes_ask > yes_bid), which correctly filtered
 * to markets with real two-sided liquidity but capped the
 * bot's tradable universe at 2 markets. Widening lets the
 * LLM auto-promote pipeline see all 2,254 listed markets
 * (most of them one-sided parlays) and pick up any that
 * actually have edge. Strategies filter on price quality
 * downstream — see `computeIsLive` for the full rationale.
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
import { classifyByEventTicker } from "../kalshi/leads-scout.js";
import type { CronEnv, CronResult } from "./dispatcher.js";

// 2026-08-11 (Phase 4, followup #3): Kalshi's open catalog
// is 99% parlay markets — ~62,000 KXMVESPORTS* and
// KXMVECROSSCATEGORY* multi-leg bundles that the bot's
// strategies (naive, reversion, LLM) explicitly don't
// price. The previous research-cron walked ALL 30 pages
// of the catalog and GET'd every "looks active" market
// — 550 GETs × 500ms each = 275s wall-clock, which is
// WAY over the 30s CF Worker limit. The cron had been
// timing out silently since 01:10 (no cron_run row
// because the kill happens before recordRun).
//
// 2026-08-11 fix: skip the parlay block at the LIST
// level (don't even include them in `looksActiveMarkets`).
// This drops the GET count from ~550 to ~50 (the actual
// single-event markets Kalshi lists). With throttle=4
// req/s, 50 GETs × 250ms = 12.5s + 6s for 30 LIST pages
// = 18.5s wall-clock per cron. Plenty of headroom under
// the 30s limit, and the cron now actually completes
// and writes to cron_runs every 15 min.
//
// The user asked: "isn't that collecting actual real live
// data and tickers (or supposed to) to feed the llm for
// verified kalshi leads (to prevent hallucination)?" —
// YES. The research-cron is the canonical "verified"
// data path: LIST returns the catalog, GET returns the
// real orderbook (LIST returns 0/0 for bid/ask), and the
// snapshot is what the LLM cron reads to ground its
// verdicts. Without this cron running, the LLM sees
// stale data and hallucinates more (Bug A from
// docs/LLM-PIPELINE.md).
const MAX_PAGES = 30;
const PAGE_SIZE = 200;
const REQUEST_TIMEOUT_MS = 8_000;
// 2026-08-11: cap GETs at 100 per cron. With 4 req/s
// throttle + 100 GETs = 25s wall-clock for the GET
// phase + 6s for 30 LIST pages = ~31s — just over
// the 30s limit. Bump throttle to 5 to fit. See
// buildKalshiClientAsync below.
const MAX_GETS = 100;
// Skip the parlay block at the LIST level. These are
// the 60k+ multi-leg bundles Kalshi pushes — the bot's
// strategies (naive, reversion, LLM) don't price them,
// and they would dominate the GET workload if included.
// KXMVESPORTS* = multi-game sports parlays, ~62k markets.
// KXMVECROSSCATEGORY* = cross-category parlays, ~57k markets.
const SKIP_PARLAY_PREFIXES = [
	/^KXMVESPORTSMULTIGAME/i,
	/^KXMVESPORTS/i,
	/^KXMVECROSSCATEGORY/i,
];
function isParlayEventTicker(eventTicker: string): boolean {
	for (const re of SKIP_PARLAY_PREFIXES) {
		if (re.test(eventTicker)) return true;
	}
	return false;
}

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

/** A snapshot is "live" (Kalshi is quoting this market) if EITHER
 *  side has a non-zero price — yes_bid > 0 OR yes_ask > 0.
 *
 *  2026-08-10 19:48 (paper-mode exploration): the previous
 *  definition required both sides (yes_bid > 0 AND yes_ask > 0
 *  AND yes_ask > yes_bid) — a strict "real two-sided
 *  orderbook" test. That correctly filtered out 2247 of 2254
 *  Kalshi markets (only KXWARMING-50 and one cross-category
 *  parlay have actual two-sided liquidity right now), but it
 *  also capped the bot's tradable universe at 2 markets in
 *  paper mode.
 *
 *  The user wants to push hard in paper mode. Widening to
 *  "either side has a quote" unlocks all 2,254 listed
 *  markets. The downstream strategies (NaiveSignal,
 *  LLMOpinionSignal) will see weird prices on the one-sided
 *  markets (Kalshi offering to take the other side at
 *  1¢–99¢) — most LLM verdicts will be "hold" because the
 *  LLM doesn't trust the implied price, and the strategies'
 *  computeMid() requires both sides so they no-op on
 *  one-sided books. Net effect: the LLM gets to evaluate
 *  every market, the auto-promote pipeline can pick up any
 *  market that genuinely has edge, and the strategies still
 *  filter on price quality. Cheap experiment.
 *
 *  If a market has yes_bid=0 AND yes_ask=0, last_price_cents
 *  is the only price signal — the snapshot still gets
 *  written, is_live=0, and the LLM cron skips it (no usable
 *  price to compare fair value against).
 */
function computeIsLive(
	yes_bid_cents: number,
	yes_ask_cents: number,
): 0 | 1 {
	if (yes_bid_cents > 0 || yes_ask_cents > 0) {
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
				requestsPerSecond: 5,
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
				requestsPerSecond: 5,
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
	let nUniverseSnapshotted = 0;
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
			source: "list" | "bot_universe";
		}> = [];
		for await (const m of client.iterMarkets({
			status: "open",
			limit: PAGE_SIZE,
			maxPages: MAX_PAGES,
		})) {
			nScanned += 1;
			const eventTicker =
				(m as unknown as { event_ticker?: string }).event_ticker ?? "";
			// 2026-08-10 21:10: also keep markets the LLM can
			// actually price (KXGDP, KXNBA, KXPRES, etc.) even
			// if they have last_price=0 / OI=0 in the LIST view.
			// Kalshi lists single-event markets with 0 price
			// when they're newly listed or pre-resolution; the
			// looksActive filter was dropping them. classifyByEventTicker
			// returns a vertical (weather/economic/politics/sports)
			// for these — the LLM has real knowledge of them.
			// Parlays (KXMVECROSSCATEGORY, KXMVESPORTSMULTIGAME)
			// are deliberately excluded by classifyByEventTicker
			// so they don't bypass the looksActive filter.
			const isKnownPrefix = classifyByEventTicker(eventTicker, m.title) != null;
			if (!looksActive(m) && !isKnownPrefix) continue;
			// 2026-08-11: skip the parlay block at the LIST level
			// (60k+ multi-leg bundles the bot doesn't price — see
			// SKIP_PARLAY_PREFIXES at the top of this file). Without
			// this filter, the research-cron walked ~550 GETs per
			// run, blowing past the 30s Worker wall-clock limit.
			if (isParlayEventTicker(eventTicker)) continue;
			looksActiveMarkets.push({
				ticker: m.ticker,
				event_ticker: eventTicker,
				title: m.title ?? "",
				last_price_cents: m.last_price_cents,
				open_interest: m.open_interest ?? 0,
				volume_24h: m.volume_24h ?? 0,
				close_time: m.close_time ?? null,
				source: "list",
			});
		}
		nLookedActive = looksActiveMarkets.length;
		// 2026-08-11 (Phase 4, followup #3): cap the GET
		// workload. Even after the parlay skip, there are
		// 1,000+ single-event markets. With 4 req/s
		// throttle, 1,000 GETs × 250ms = 250s wall-clock —
		// 8x over the 30s Worker limit. Sort by liquidity
		// (vol_24h + OI*5, same as the leads-scout) and
		// take the top 100. These are the markets most
		// likely to have real two-sided quotes AND matter
		// to the bot's decisions. The bot's own universe
		// (~40 tickers) is always included via the 3b
		// pass below (which adds the universe BEFORE
		// the cap is applied).
		looksActiveMarkets.sort(
			(a, b) =>
				(b.volume_24h + b.open_interest * 5) -
				(a.volume_24h + a.open_interest * 5),
		);
		if (looksActiveMarkets.length > MAX_GETS) {
			looksActiveMarkets.length = MAX_GETS;
		}

		// 3b. 2026-08-10: also pull the bot's current ticker
		//     universe from the LiveBot DO and add those to
		//     the snapshot list — bypassing the looksActive
		//     filter. KXWARMING-50 (the only live single-event
		//     market right now) sometimes fails the LIST-side
		//     filter (last_price=0 / OI=0 in the directory
		//     view) even though the bot's polling feed has
		//     23k+ trades on it. Without this step, the
		//     dashboard shows 0 markets even though the bot
		//     is actively trading on the ticker. De-dup
		//     against the list-sourced entries.
		//
		//     We do this AFTER the list pass so a market that's
		//     already in `looksActiveMarkets` (with a
		//     list-sourced event_ticker / title) keeps the
		//     better metadata. Universe-only entries get
		//     empty event_ticker / title until the GET fills
		//     them in.
		if (env.LIVE_BOT) {
			try {
				const id = env.LIVE_BOT.idFromName(`user:${DEFAULT_USER_ID}`);
				const stub = env.LIVE_BOT.get(id);
				const resp = await stub.fetch("https://bot.local/status");
				if (resp.ok) {
					const data = (await resp.json()) as {
						config?: { tickers?: string[] };
					};
					const universeTickers = data.config?.tickers ?? [];
					const known = new Set(looksActiveMarkets.map((m) => m.ticker));
					for (const t of universeTickers) {
						if (!t || known.has(t)) continue;
						looksActiveMarkets.push({
							ticker: t,
							event_ticker: "",
							title: "",
							last_price_cents: 0,
							open_interest: 0,
							volume_24h: 0,
							close_time: null,
							source: "bot_universe",
						});
						nUniverseSnapshotted += 1;
					}
				}
			} catch (e) {
				console.warn(
					"[research] failed to read bot universe (non-fatal):",
					e instanceof Error ? e.message : String(e),
				);
			}
		}

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

	// 5b. 2026-08-10: snapshot retention. The
	//     live_market_snapshots table grows at ~1 row
	//     per 3s per ticker (bot's polling feed). At
	//     1 ticker that's 28k rows/day; at 10 tickers
	//     280k. We only need the latest snapshot per
	//     ticker for the "live now" view, and the
	//     history() endpoint only goes back 1h. So
	//     keep 2h of history and trim the rest.
	try {
		const cutoff = now - 2 * 60 * 60 * 1000;
		const result = await env.DB
			.prepare(
				`DELETE FROM live_market_snapshots
				 WHERE user_id = ?1 AND ts < ?2`,
			)
			.bind(DEFAULT_USER_ID, cutoff)
			.run();
		const deleted = result.meta?.changes ?? 0;
		if (deleted > 0) {
			console.log(
				`[research] retention: deleted ${deleted} snapshots older than 2h`,
			);
		}
	} catch (e) {
		console.warn("[research] retention cleanup failed (non-fatal):", e);
	}

	return {
		ok: errors.length === 0,
		cron_name: "research",
		duration_ms: Date.now() - startMs,
		artifacts: {
			n_scanned: nScanned,
			n_looked_active: nLookedActive,
			n_universe_snapshotted: nUniverseSnapshotted,
			n_snapshots_written: nSnapshotsWritten,
			n_live: nLive,
			live_tickers: liveTickers,
			errors: errors.slice(0, 20),
		},
	};
}
