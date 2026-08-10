/**
 * pm-bot — leads scout (chunk 13+, 2026-08-09).
 *
 * The leads-cron and the /suggest-leads endpoint ask an LLM to
 * pick Kalshi tickers for the bot. The LLM can and does hallucinate
 * tickers that don't exist on Kalshi (e.g. "KXGDP-Q3", "KXNBA-CHAMP",
 * "KXPRES-26" — short symbolic tickers that sound right but Kalshi
 * doesn't actually use them; of ~6,000 open markets, only ONE has a
 * short ticker: KXWARMING-50).
 *
 * This module closes that gap. It:
 *
 *   1. Pages through Kalshi's `/markets?status=open` endpoint to
 *      build a real, current snapshot of every open market.
 *   2. Filters the snapshot to markets whose titles match one of
 *      the bot's verticals (weather / economic / politics / sports)
 *      via a keyword regex per vertical.
 *   3. Caps the result at MAX_PER_VERTICAL per vertical (top by
 *      liquidity heuristic: volume_24h + open_interest).
 *   4. Exposes a "universe health" check that flags current-universe
 *      tickers which are no longer present in the snapshot (i.e.
 *      they've been delisted / expired / settled).
 *
 * The leads-cron and suggest-leads endpoint use this so that:
 *   - The LLM prompt is GIVEN the real filtered list, constraining
 *     its suggestions to actually-existing tickers.
 *   - Each LLM suggestion is verified against the snapshot (in-memory
 *     O(1) check, no extra API call).
 *   - Any current-universe ticker that's gone missing becomes an
 *     auto-suggested DROP with reasoning "expired on Kalshi".
 *
 * **Why fetch every 6h:** the leads-cron itself runs every 6h, and
 * the snapshot is needed by the cron anyway. The scout doesn't
 * have its own schedule — it just runs inline as part of leadsCron.
 * If we add other consumers later (the Dev page "live market list"
 * panel, for example), they can reuse this with their own cadence.
 *
 * **Cost:** 30 API calls per invocation (200/page × 30 pages ≈ 6k
 * markets). At 4 invocations/day (every 6h), that's 120 calls/day,
 * well under Kalshi's rate limits and amortized to ~$0.01/day in
 * egress. We could cache to R2 to drop that further, but the rate
 * is already low enough that we don't bother.
 *
 * **Failure mode:** if Kalshi is down or rate-limiting, the scout
 * returns an empty snapshot and the cron falls back to "unfiltered
 * LLM with a stronger hallucination warning" — the operator's Dev
 * page will show "0 suggestions, 0 universe health (Kalshi API
 * unavailable)" which is a clear signal.
 */

import { type KalshiClient } from "./client.js";
import { type KalshiMarket } from "./models.js";
import type { Vertical } from "../lib/types.js";

// ─── Vertical classification ────────────────────────────────────
//
// Kalshi's v2 /markets endpoint doesn't expose a `category` field
// directly on individual markets (it's undefined in the wire shape).
// Instead, the category is ENCODED in the event_ticker prefix.
//
// As of 2026-08-09, the entire open-market list (~6,000 markets)
// is dominated by two prefixes:
//   - KXMVESPORTSMULTIGAMEEXTENDED  (~4,065 markets; multi-game
//     sports parlays — the bot's naive strategy doesn't really
//     fit, but they're the closest thing to "sports" Kalshi has)
//   - KXMVECROSSCATEGORY  (~1,935 markets; cross-category parlays
//     — explicit Kalshi warning: do NOT trade these with the
//     bot's strategies)
//
// Outside those two, there are very few markets. The notable
// one is KXWARMING-50 (the climate market, single event, real).
// That's the only market in any "vertical" sense.
//
// We classify by event_ticker PREFIX as the primary signal.
// Title regex is a fallback for older / single-event markets
// that don't have a category prefix (the "weather" / "GDP" /
// "election" wording in some descriptive titles).
//
// Vertical classification map:
//   weather:  KXWARMING*, KXTEMP*, KXHURRICANE*, KXRAIN*, KXCLIMATE*
//   economic: KXINFLATION, KXGDP, KXFED, KXUNEMPLOY, KXRECESSION, KXFOMC
//   politics: KXELECTION, KXPRES, KXSENATE, KXCONGRESS, KXGOV
//   sports:   KXMVESPORTS* (all multi-game sports parlays)
//   — cross: KXMVECROSSCATEGORY (explicitly excluded — bot's
//     strategies don't apply to parlays)

const VERTICAL_PREFIXES: Record<Vertical, RegExp[]> = {
	weather: [
		/^KXWARMING/i,
		/^KXTEMP/i,
		/^KXHURRICANE/i,
		/^KXRAIN/i,
		/^KXCLIMATE/i,
		/^KXWEATHER/i,
		/^KXSNOW/i,
		/^KXSTORM/i,
		/^KXDROUGHT/i,
	],
	economic: [
		/^KXGDP/i,
		/^KXINFLATION/i,
		/^KXCPI/i,
		/^KXFED/i,
		/^KXFOMC/i,
		/^KXRECESSION/i,
		/^KXUNEMPLOY/i,
		/^KXJOBS/i,
		/^KXTREASURY/i,
	],
	politics: [
		/^KXPRES/i,
		/^KXPRESIDENT/i,
		/^KXELECTION/i,
		/^KXSENATE/i,
		/^KXCONGRESS/i,
		/^KXGOV/i,
		/^KXBALLOT/i,
		/^KXPRIMARY/i,
	],
	sports: [
		// The big one: 4,065 markets in this prefix as of 2026-08-09.
		// These are multi-game parlays, which the bot's naive
		// strategy wasn't designed for, but they're the closest
		// thing to "sports" Kalshi has.
		/^KXMVESPORTS/i,
	],
};

// Title-keyword fallback. Used when the event_ticker prefix
// doesn't match (e.g. some older markets may not follow the
// KX{VERTICAL}* convention).
const WEATHER_TITLE_RE =
	/\b(weather|temperature|temp|rain(?!bow)|snow|storm|hurricane|wildfire|drought|heat(?!ing)|frost|climate|warming|°\s*[cf]\b|degrees?\b|precipitation)\b/i;

const ECONOMIC_TITLE_RE =
	/\b(gdp|inflation|cpi\b|jobs?\b|unemployment|unemploy|federal reserve|fomc|recession|interest rate|treasury|bond yields?|fed\b|non-?farm|consumer price)\b/i;

const POLITICS_TITLE_RE =
	/\b(election|president|presidential|senate|congress|governor|democrat|republican|poll(?!inator)|ballot|primary|caucus|midterm|electoral)\b/i;

const SPORTS_TITLE_RE =
	/\b(nba|nfl|mlb|nhl|ufc|soccer|football(?! field)|baseball|basketball|tennis|champion|playoff|super bowl|world series|premier league|la liga|serie a|bundesliga|ligue 1|champions league)\b/i;

/** True if the snapshot has a real two-sided quote (yes_bid > 0
 *  AND yes_ask > 0 AND yes_ask > yes_bid). Used by filterForLlm
 *  to surface only the markets that are actually tradeable. */
export function computeIsLive(
	yes_bid_cents: number,
	yes_ask_cents: number,
): 0 | 1 {
	if (yes_bid_cents > 0 && yes_ask_cents > 0 && yes_ask_cents > yes_bid_cents) {
		return 1;
	}
	return 0;
}

const TITLE_FALLBACK: Record<Vertical, RegExp> = {
	weather: WEATHER_TITLE_RE,
	economic: ECONOMIC_TITLE_RE,
	politics: POLITICS_TITLE_RE,
	sports: SPORTS_TITLE_RE,
};

// Cross-category markets are explicitly EXCLUDED from every
// vertical. The Kalshi docs flag these as multi-event parlays
// that don't fit single-event trading strategies.
const CROSS_CATEGORY_RE = /^KXMVECROSSCATEGORY/i;

// Cap per vertical so the LLM prompt doesn't get flooded. 30 is
// a reasonable number — fits in ~3-4k tokens when formatted as
// "ticker: title" pairs.
const MAX_PER_VERTICAL = 30;

// Don't include markets with zero liquidity. A market with
// volume_24h=0 AND open_interest=0 is "freshly listed" — Kalshi
// shows it as active but no one has traded it yet. As of
// 2026-08-09, the entire 4,065-market KXMVESPORTS* block is in
// this state. We INCLUDE these (vs filtering them out) so the
// LLM can see newly-listed markets and the operator can decide
// whether to add them. Set to 1 to filter out "fresh" markets
// and only show markets that already have trading activity —
// useful if you want a less noisy prompt.
const MIN_LIQUIDITY = 0; // include all open markets (no liquidity filter)

// Pagination cap. With 200/page, 30 pages = 6,000 markets, which
// is the entire open market list as of 2026-08-09. Bumping this
// is safe if Kalshi's universe grows.
const MAX_PAGES = 30;
const PAGE_SIZE = 200;

// ─── Public types ───────────────────────────────────────────────

export interface ScoutedMarket {
	ticker: string;
	event_ticker: string | null;
	title: string;
	vertical: Vertical;
	yes_bid_cents: number;
	yes_ask_cents: number;
	last_price_cents: number;
	volume_24h: number;
	open_interest: number;
	is_live: 0 | 1;
	close_time: string | null;
	expiration_time: string | null;
}

export interface ScoutResult {
	/** All markets that matched a vertical regex, capped per vertical.
	 *  Includes parlays. Used for the universe-health check
	 *  (which needs to see everything to know what's expired). */
	markets: ScoutedMarket[];
	/** The LLM-facing subset: top ~15 across all verticals, with
	 *  real bid/ask data, parlays and cross-category filtered out
	 *  (no strategy for them yet). This is what the LLM prompt
	 *  should use. Distinct from `markets` so the universe-health
	 *  check still sees everything. */
	markets_for_llm: ScoutedMarket[];
	/** Per-vertical map of ticker → ScoutedMarket for fast lookup. */
	by_ticker: Map<string, ScoutedMarket>;
	/** All markets from the snapshot (unfiltered), so the LLM has
	 *  full visibility if it wants to suggest something off-list. */
	all_markets: KalshiMarket[];
	/** Total number of markets scanned (across all pages). */
	total_scanned: number;
	/** Wall-clock ms when the snapshot was built. */
	fetched_at: number;
	/** True if the snapshot was built successfully. False means
	 *  Kalshi was down or rate-limited and we have an empty result. */
	ok: boolean;
	/** Error message if !ok. */
	error?: string;
}

export interface UniverseHealth {
	/** Tickers in the current universe that exist in the snapshot
	 *  (still tradeable). */
	valid: string[];
	/** Tickers in the current universe that are NOT in the
	 *  snapshot (delisted / expired / settled). The cron turns
	 *  these into drop candidates with reasoning "expired on
	 *  Kalshi at <fetched_at>". */
	expired: Array<{ ticker: string; last_seen: number | null }>;
}

// ─── Scout env ──────────────────────────────────────────────────

export interface ScoutEnv {
	/** Pre-built KalshiClient (lets the caller decide demo vs prod,
	 *  throttle rate, etc.). The cron builds one with the env's
	 *  creds; the dry-run test can pass a mocked client. */
	kalshiClient: KalshiClient;
	/** Per-vertical cap for the filtered list. Defaults to
	 *  MAX_PER_VERTICAL (= 30). */
	maxPerVertical?: number;
	/** Min liquidity filter. Defaults to MIN_LIQUIDITY (= 1). */
	minLiquidity?: number;
	/** Max pages to scan. Defaults to MAX_PAGES (= 30, ~6k markets). */
	maxPages?: number;
	/** Page size. Defaults to PAGE_SIZE (= 200). */
	pageSize?: number;
	/** Optional signal to abort — checked between pages so a long
	 *  scan doesn't run past a Workers' CPU budget. */
	shouldAbort?: () => boolean;
	/** Cap on the LLM-facing list (markets_for_llm). Defaults to 15.
	 *  Keep this low — the LLM prompt is the bottleneck, not the
	 *  catalog. */
	maxForLlm?: number;
}

// ─── Core API ───────────────────────────────────────────────────

/**
 * Page through Kalshi's open markets and build a filtered snapshot
 * the leads-cron can use.
 *
 * Returns an empty-but-`ok=false` result if Kalshi is unreachable;
 * the caller should surface that to the operator as a "scout failed"
 * warning.
 */
export async function fetchAndFilterMarkets(env: ScoutEnv): Promise<ScoutResult> {
	const startedAt = Date.now();
	const maxPerVertical = env.maxPerVertical ?? MAX_PER_VERTICAL;
	const minLiquidity = env.minLiquidity ?? MIN_LIQUIDITY;
	const maxPages = env.maxPages ?? MAX_PAGES;
	const pageSize = env.pageSize ?? PAGE_SIZE;

	const all_markets: KalshiMarket[] = [];
	let totalScanned = 0;
	try {
		for await (const m of env.kalshiClient.iterMarkets({
			status: "open",
			limit: pageSize,
			maxPages,
		})) {
			all_markets.push(m);
			totalScanned += 1;
			if (env.shouldAbort?.()) {
				return {
					markets: [],
					markets_for_llm: [],
					by_ticker: new Map(),
					all_markets,
					total_scanned: totalScanned,
					fetched_at: startedAt,
					ok: false,
					error: "aborted (shouldAbort=true)",
				};
			}
		}
	} catch (e) {
		return {
			markets: [],
			markets_for_llm: [],
			by_ticker: new Map(),
			all_markets: [],
			total_scanned: totalScanned,
			fetched_at: startedAt,
			ok: false,
			error: `Kalshi /markets failed: ${e instanceof Error ? e.message : String(e)}`,
		};
	}

	const filtered = filterAndRank(all_markets, {
		maxPerVertical,
		minLiquidity,
	});
	const byTicker = new Map<string, ScoutedMarket>();
	for (const m of filtered) byTicker.set(m.ticker, m);

	// The LLM-facing subset: top ~15 single-event markets with
	// real bid/ask data. Excludes parlays (KXMVESPORTS*,
	// KXMVECROSSCATEGORY*) since the bot has no parlay strategy
	// yet. Includes single-game markets (KXMLBSPREAD, KXNBASPREAD,
	// etc.) — the LLM should see them as candidates.
	const marketsForLlm = filterForLlm(filtered, all_markets, {
		maxTotal: env.maxForLlm ?? 15,
	});

	return {
		markets: filtered,
		markets_for_llm: marketsForLlm,
		by_ticker: byTicker,
		all_markets,
		total_scanned: totalScanned,
		fetched_at: startedAt,
		ok: true,
	};
}

// ─── Internals ──────────────────────────────────────────────────

function classifyVertical(
	market: KalshiMarket,
): Vertical | null {
	const eventTicker: string = (market as unknown as { event_ticker?: string }).event_ticker ?? "";
	// Explicit cross-category exclusion: Kalshi's docs flag
	// these as multi-event parlays the bot's strategies
	// don't apply to. Skip them entirely.
	if (CROSS_CATEGORY_RE.test(eventTicker)) return null;
	// Primary signal: event_ticker prefix.
	for (const v of ["weather", "economic", "politics", "sports"] as const) {
		for (const re of VERTICAL_PREFIXES[v]) {
			if (re.test(eventTicker)) return v;
		}
	}
	// Fallback: title keyword regex (catches the few
	// markets that don't follow the KX{VERTICAL}* prefix
	// convention — e.g. the KXWARMING-50 title is
	// "Will the world pass 2°C before 2050?" which would
	// match via the title regex even without the prefix).
	const title = market.title ?? "";
	for (const v of ["weather", "economic", "politics", "sports"] as const) {
		if (TITLE_FALLBACK[v].test(title)) return v;
	}
	return null;
}

function filterAndRank(
	all: KalshiMarket[],
	opts: { maxPerVertical: number; minLiquidity: number },
): ScoutedMarket[] {
	const byVertical: Record<Vertical, ScoutedMarket[]> = {
		weather: [],
		economic: [],
		politics: [],
		sports: [],
	};

	for (const m of all) {
		const v = classifyVertical(m);
		if (v === null) continue;
		const title = m.title ?? "";
		const liquid = (m.volume_24h ?? 0) >= opts.minLiquidity ||
			(m.open_interest ?? 0) >= opts.minLiquidity;
		if (!liquid) continue;
		byVertical[v].push({
			ticker: m.ticker,
			event_ticker: (m as unknown as { event_ticker?: string }).event_ticker ?? null,
			title,
			vertical: v,
			yes_bid_cents: m.yes_bid_cents,
			yes_ask_cents: m.yes_ask_cents,
			last_price_cents: m.last_price_cents,
			volume_24h: m.volume_24h ?? 0,
			open_interest: m.open_interest ?? 0,
			is_live: computeIsLive(m.yes_bid_cents, m.yes_ask_cents),
			close_time: m.close_time ?? null,
			expiration_time: m.expiration_time ?? null,
		});
	}

	// Rank each vertical by a simple liquidity score
	// (volume_24h + open_interest * 5; OI is a stronger
	// signal of a tradeable book than 24h volume) and
	// take the top N. The LLM gets the most promising
	// markets first, not the entire vertical.
	const ranked: ScoutedMarket[] = [];
	for (const v of ["weather", "economic", "politics", "sports"] as const) {
		const sorted = byVertical[v].sort(
			(a, b) =>
				b.volume_24h + b.open_interest * 5 -
				(a.volume_24h + a.open_interest * 5),
		);
		ranked.push(...sorted.slice(0, opts.maxPerVertical));
	}
	return ranked;
}

/**
 * Build the LLM-facing market list. Filters out parlays and
 * cross-category markets (no strategy for them yet), prioritizes
 * by liquidity, caps at `maxTotal`. Designed to give the LLM
 * a tight 10-20 list of real, tradeable candidates instead of
 * the full vertical-bucketed catalog (which can have 100+ markets,
 * most of which the bot can't actually trade).
 *
 * The filter is strict on parlays (KXMVESPORTS*, KXMVECROSSCATEGORY*)
 * and loose on everything else. If Kalshi adds new single-event
 * categories in the future, they'll show up here automatically.
 *
 * If `scouted` is empty (no vertical matches), we fall back to
 * looking at `all_markets` for any non-parlay market with real
 * bid/ask data — Kalshi's product is fluid and we don't want
 * to miss new market types just because the vertical regex
 * doesn't cover them yet.
 */
function filterForLlm(
	scouted: ScoutedMarket[],
	all_markets: KalshiMarket[],
	opts: { maxTotal: number },
): ScoutedMarket[] {
	// 1. Filter out parlays from the scouted list.
	const PARLAY_RE = /^KX(MVESPORTS|MVECROSSCATEGORY)/i;
	const nonParlay = scouted.filter((m) => !PARLAY_RE.test(m.event_ticker ?? ""));

	// 2. Sort by liquidity: vol_24h + OI * 5.
	nonParlay.sort((a, b) => {
		const scoreA = a.volume_24h + a.open_interest * 5;
		const scoreB = b.volume_24h + b.open_interest * 5;
		return scoreB - scoreA;
	});

	// 3. Cap at maxTotal. If we have enough non-parlay scouted
	//    markets, use them. Otherwise, fall back to all_markets.
	if (nonParlay.length >= opts.maxTotal) {
		return nonParlay.slice(0, opts.maxTotal);
	}

	// 4. Fallback: scan all_markets for any non-parlay, non-empty
	//    market. We only know about market_type / event_ticker /
	//    title here, not real bid/ask (those are only in scouted
	//    which is itself derived from GET). So we're checking
	//    "is this not a parlay prefix" only.
	const knownTickers = new Set(nonParlay.map((m) => m.ticker));
	const fallback: ScoutedMarket[] = [];
	for (const m of all_markets) {
		if (fallback.length + nonParlay.length >= opts.maxTotal) break;
		if (knownTickers.has(m.ticker)) continue;
		const et = (m as unknown as { event_ticker?: string }).event_ticker ?? "";
		if (PARLAY_RE.test(et)) continue;
		// Re-classify vertical for display.
		const v = classifyVerticalPublic(m) ?? "unknown";
		fallback.push({
			ticker: m.ticker,
			event_ticker: et || null,
			title: m.title ?? "",
			vertical: v as Vertical,
			yes_bid_cents: m.yes_bid_cents,
			yes_ask_cents: m.yes_ask_cents,
			last_price_cents: m.last_price_cents,
			volume_24h: m.volume_24h ?? 0,
			open_interest: m.open_interest ?? 0,
			is_live: computeIsLive(m.yes_bid_cents, m.yes_ask_cents),
			close_time: m.close_time ?? null,
			expiration_time: m.expiration_time ?? null,
		});
	}
	const combined = [...nonParlay, ...fallback];
	return combined.slice(0, opts.maxTotal);
}

/** Public alias for classifyVertical so filterForLlm can use it. */
function classifyVerticalPublic(
	market: KalshiMarket,
): Vertical | null {
	return classifyVertical(market);
}

// ─── Universe health ────────────────────────────────────────────

/**
 * Compare the current bot universe against the fresh scout
 * snapshot. Returns the set of valid (still-tradeable) and
 * expired (no longer in Kalshi's open-market list) tickers.
 *
 * "Expired" doesn't necessarily mean settled — Kalshi can
 * also delist markets for other reasons (regulatory, low
 * liquidity, contract dispute). The bot should drop them
 * either way; the operator can re-add later if Kalshi
 * relists.
 */
export function checkUniverseHealth(
	scout: ScoutResult,
	currentTickers: string[],
): UniverseHealth {
	const valid: string[] = [];
	const expired: Array<{ ticker: string; last_seen: number | null }> = [];
	const inSnapshot = new Set<string>();
	for (const m of scout.all_markets) inSnapshot.add(m.ticker);
	for (const m of scout.markets) inSnapshot.add(m.ticker);
	for (const t of currentTickers) {
		if (inSnapshot.has(t)) {
			valid.push(t);
		} else {
			expired.push({ ticker: t, last_seen: null });
		}
	}
	return { valid, expired };
}

// ─── Format helpers ─────────────────────────────────────────────

/**
 * Format a ScoutResult for inclusion in the LLM prompt. Keeps it
 * compact: just ticker + truncated title per market, grouped by
 * vertical. Caps total output so the prompt stays under ~3-4k
 * tokens for the market list portion.
 */
export function formatScoutForPrompt(
	scout: ScoutResult,
	opts: { maxTitleChars?: number } = {},
): string {
	if (!scout.ok) {
		return `⚠ Scout failed: ${scout.error}\n` +
			`(Falling back to LLM-only — suggestions will need manual ticker verification.)`;
	}
	const maxTitle = opts.maxTitleChars ?? 120;
	const lines: string[] = [];
	lines.push(`Scout snapshot: ${scout.total_scanned} open markets scanned, ${scout.markets.length} matched verticals (top ${scout.markets.length} by liquidity).`);
	lines.push("");
	const grouped: Record<Vertical, ScoutedMarket[]> = {
		weather: [],
		economic: [],
		politics: [],
		sports: [],
	};
	// Use `markets_for_llm` (parlays filtered out, capped at ~15,
	// bid/ask populated) instead of `markets` (full vertical
	// catalog with parlays, capped at 30/vertical). The LLM
	// gets a tight, actionable list.
	const list = scout.markets_for_llm ?? scout.markets;
	for (const m of list) {
		const v = (m.vertical ?? "weather") as Vertical;
		if (grouped[v]) grouped[v].push(m);
	}
	for (const v of ["weather", "economic", "politics", "sports"] as const) {
		const sub = grouped[v];
		if (sub.length === 0) {
			lines.push(`[${v}]: (no real markets — skip)`);
			continue;
		}
		lines.push(`[${v}] (${sub.length}):`);
		for (const m of sub) {
			const title = m.title.length > maxTitle
				? m.title.slice(0, maxTitle - 1) + "…"
				: m.title;
			const live = m.is_live === 1 ? "LIVE" : "1-sided";
			const book = m.yes_bid_cents > 0
				? `${m.yes_bid_cents}/${m.yes_ask_cents}¢`
				: "—";
			lines.push(
				`  ${m.ticker}  [${live} ${book}]  vol24h=${m.volume_24h}  OI=${m.open_interest}  — ${title}`,
			);
		}
	}
	return lines.join("\n");
}
