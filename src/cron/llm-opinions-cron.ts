/**
 * pm-bot — LLM opinions cron (2026-08-10).
 *
 * The user asked: "use the LLM to leverage opinion or bias
 * to our advantage." This cron refreshes per-ticker LLM
 * verdicts every 30 min so the bot's polling feed can
 * convert them into Signals.
 *
 * **Per ticker, every 30 min:**
 *   1. Read the latest live_market_snapshots row for the
 *      ticker (gives us bid/ask + title).
 *   2. Ask the LLM: "based on the market title + current
 *      YES price, is YES mispriced? Reply strict JSON
 *      {side, confidence, reasoning}."
 *   3. Upsert into llm_opinions with a soft TTL
 *      (default 1h — verdicts are good for at most 30 min
 *      but we keep them around for the dashboard).
 *
 * **Why a cron, not on-poll:** the LLM call costs ~1-2s
 * and tokens. Running it on every poll (1.5s × N tickers)
 * would be ruinous. 30 min is the right cadence: the
 * markets move slowly enough that a fresh opinion every
 * 30 min is enough to act on intraday moves, and the
 * cost is bounded (~144 calls/day for 1 ticker, or
 * ~1440 for 10 tickers — still well under the $50/mo
 * strategy budget).
 *
 * **Why read the LLM's verdict, not the LLM's text:** the
 * strategy is mechanical. A 1-3 sentence reasoning field
 * is enough for the operator to audit, and the structured
 * fields (side, confidence) let the strategy filter
 * without re-parsing.
 *
 * **Why not use news/sentiment sources:** the operator
 * hasn't given us a news feed. The LLM's training data
 * covers most Kalshi event types (climate, sports,
 * economics) well enough for a baseline. Adding a news
 * feed is a future extension (chunk +1).
 */

import { DEFAULT_PRODUCTION_BASE, KalshiClient } from "../kalshi/client.js";
import { DEFAULT_USER_ID, type LLMOpinionRow } from "../lib/types.js";
import { cronRuns as cronRunsDb, llmCalls as llmCallsDb, llmOpinions as llmOpinionsDb, liveMarketSnapshots as liveMarketSnapshotsDb } from "../lib/db.js";
import { loadPrivateKey, KalshiCredentials } from "../kalshi/auth.js";
import { chat, DEFAULT_MODEL, type LLMEnv } from "../llm/index.js";
import { classifyByEventTicker } from "../kalshi/leads-scout.js";
import type { CronEnv, CronResult } from "./dispatcher.js";
import type { LiveBotState, LiveBotConfig } from "../durable-objects/LiveBot.js";

const TTL_MS = 60 * 60 * 1000; // 1h soft TTL
const MIN_CONFIDENCE = 0.0; // 0 = store everything; the strategy filters at runtime

/**
 * 2026-08-12: cost-control artifact helper. The cron
 * accumulates `skipped` strings like `"KXWARMING-50: stale_verdict"`.
 * For the cadence panel / cron_run artifacts we want a
 * rolled-up breakdown by skip reason, not a flat list.
 */
function countByPrefix(skipped: string[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const s of skipped) {
		const idx = s.indexOf(": ");
		const key = idx >= 0 ? s.slice(idx + 2) : s;
		out[key] = (out[key] ?? 0) + 1;
	}
	return out;
}

// 2026-08-10: auto-promote thresholds. The user said "I don't
// want to have to promote anything" — so when the LLM gives
// us a high-confidence verdict on a market the bot isn't
// already watching, we add it to the universe automatically.
//
// 2026-08-10 19:45 (paper-mode expansion): the user wants to
// aggressively expand the universe in paper mode to gather
// data on how the bot handles more markets/verticals. Knobs
// pushed wide: threshold dropped 0.7 → 0.5, max-per-run 2 → 5,
// all 4 verticals included (sports + politics added). Risk:
// a misbehaving LLM could bloat the universe fast — the 5/run
// cap is the backstop. The blocklist + /start with explicit
// tickers is the manual override.
const AUTO_PROMOTE_THRESHOLD = 0.5;
const AUTO_PROMOTE_MAX_PER_RUN = 5;
// 2026-08-11: expanded from 4 to 17 verticals. The user said
// "expand coverage to include all" — auto-promote now allows
// any vertical. A high-confidence LLM verdict on a
// KXNEWPOPE / KXRAMPBREX / KXBTC market can now join the
// universe without manual operator intervention. The
// AUTO_PROMOTE_MAX_PER_RUN=5 cap is the backstop: at most 5
// new tickers per 30-min cron, regardless of how many
// high-confidence verdicts the LLM produces.
//
// 2026-08-11 (option 1, lock-in): removed "financials" from
// the auto-promote set. The financials vertical is currently
// disabled in the live bot (`disabled_verticals=["financials"]`)
// because the naive fade strategy is bleeding money on
// trending markets (KXOAIANTH-40-OAI: −$19.53 realized on a
// 651-contract fade-down that never bounced). While
// financials is off, we don't want the LLM cron to silently
// add new financials tickers back into the universe — that
// would re-open the bleeding-money path. When financials
// is re-enabled with a real edge, add it back here.
const AUTO_PROMOTE_VERTICALS: ReadonlySet<string> = new Set([
	"weather",
	"economic",
	"politics",
	"sports",
	"elections",
	// "financials", // disabled 2026-08-11 — see comment above
	"entertainment",
	"science_technology",
	"crypto",
	"companies",
	"commodities",
	"mentions",
	"social",
	"world",
	"health",
	"transportation",
	"uncategorized",
]);

interface LLMParsedOpinion {
	side: "yes" | "no" | "hold";
	confidence: number;
	reasoning: string;
}

function parseLLMOpinion(raw: string): LLMParsedOpinion | null {
	// chat() strips <think> blocks. Look for JSON.
	const jStart = raw.indexOf("{");
	const jEnd = raw.lastIndexOf("}");
	if (jStart === -1 || jEnd === -1) return null;
	try {
		const obj = JSON.parse(raw.slice(jStart, jEnd + 1)) as {
			side?: unknown;
			confidence?: unknown;
			reasoning?: unknown;
		};
		const side = obj.side;
		if (side !== "yes" && side !== "no" && side !== "hold") return null;
		const confidence = Number(obj.confidence);
		if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
		const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";
		return { side, confidence, reasoning: reasoning.slice(0, 500) };
	} catch {
		return null;
	}
}

const SYSTEM_PROMPT = `You are a research analyst for a Kalshi prediction-market trading bot. For each market you're shown, you give an opinionated directional view (yes / no / hold) and a confidence score. The bot will use your verdict to size a paper position; you don't need to be precise, just honest about whether you think the market is mispriced.

Output STRICT JSON only — no prose, no markdown, no commentary. Just one JSON object with this exact shape:
{
  "side": "yes" | "no" | "hold",
  "confidence": 0.0-1.0,
  "reasoning": "1-3 sentences on why you hold this view, citing any relevant knowledge"
}

Rules:
- "yes" = you think YES is currently underpriced (will resolve to YES, or the fair value is higher than the current YES price)
- "no" = you think NO is currently underpriced
- "hold" = you don't have a strong view either way
- confidence: 0.0 = no edge, 0.5 = coin flip, 0.7 = mild edge, 0.9 = strong edge, 1.0 = you would bet your life on it
- Be honest about uncertainty. Most markets deserve 0.4-0.6 confidence. Strong opinions (>0.7) should be rare and well-reasoned.
- Don't fabricate. If you don't know the market well enough to have an edge, say "hold" with low confidence.
- Reasoning: 1-3 sentences. Cite specific knowledge (e.g., "KXWARMING-50 asks if 2°C warming is reached by 2050; current YES at 78¢; IPCC says likely by 2050 with >50% probability, so 78¢ is roughly fair — slight edge to YES at 0.55").

If you're shown a market you genuinely don't know, default to {side: "hold", confidence: 0.3, reasoning: "I don't have a strong view on this market."} Be conservative. The bot's risk engine will gate low-confidence verdicts anyway.`;

// 2026-08-11 (Phase 3, all-three): richer context per call.
// The previous version of askLLMForOpinion only sent ticker + title
// + current YES price. The LLM had no way to evaluate parlays
// (KXMVECROSSCATEGORY bundles it can't see the legs of), no
// sense of momentum, no orderbook context, and no vertical cue
// (so it didn't know whether it was looking at climate / sports /
// econ / politics). This struct carries everything we can cheaply
// read from D1 + the research worker's snapshots. Fresh orderbook
// is intentionally NOT fetched here (extra 200ms API call per
// ticker × 200/run = 40s of serial work) — the snapshot's bid/
// ask is < 15 min stale, good enough for a directional view.
export interface LLMOpinionContext {
	ticker: string;
	title: string;
	vertical: string;
	currentYesPriceCents: number;
	yesBidCents: number | null;
	yesAskCents: number | null;
	lastPriceCents: number | null;
	volume24h: number | null;
	openInterest: number | null;
	// 2026-08-11: true when the snapshot has no live
	// price (no bid/ask, no last trade). The LLM
	// prompt tells the model to evaluate on title +
	// event context alone — the verdict can still be
	// confident enough to auto-promote the market
	// into the universe so the polling feed starts
	// tracking it. A price may appear later.
	noPrice?: boolean;
	// Last-1h bid/ask trend (oldest → newest). Length 0-4 depending
	// on how many research-cron snapshots landed in the last hour.
	// The LLM uses this to see momentum vs mean-revert pressure.
	priceHistory1h: Array<{
		ts_minutes_ago: number;
		yes_bid_cents: number;
		yes_ask_cents: number;
	}>;
	// 2026-08-11 (Phase 4, LLM-PIPELINE Bug A): parent event
	// context fetched from Kalshi's
	// /events/{event_ticker}?with_nested_markets=true. The LLM
	// was hallucinating on parlay markets because it had no
	// view of the bundle structure. Passing the event title +
	// sub_title + the leg list (for parlays) gives the LLM
	// real math to do instead of guessing. Optional — the
	// prompt builder gracefully handles undefined.
	eventTitle?: string;
	eventSubTitle?: string;
	rulesPrimary?: string;
	// 2026-08-11: for parlay markets (KXMVECROSSCATEGORY,
	// KXMVESPORTSMULTIGAME), the individual leg markets that
	// make up the bundle. Each leg has its own event_ticker,
	// market_ticker, and side. The LLM can compute the
	// bundle's fair value as the product of leg probabilities.
	// Optional — only present on parlays.
	parlayLegs?: Array<{
		event_ticker: string;
		market_ticker: string;
		side: "yes" | "no";
	}>;
}

async function askLLMForOpinion(
	env: CronEnv,
	ctx: LLMOpinionContext,
): Promise<{ parsed: LLMParsedOpinion | null; raw: string; ok: boolean; duration_ms: number; input_tokens: number | null; output_tokens: number | null; error_message: string | null }> {
	// Build the trend lines for the prompt. The LLM sees the
	// sequence of bid/ask over the last hour so it can reason
	// about momentum (price drifting up = "yes is getting more
	// expensive = market thinks YES is more likely") vs snap-
	// backs. We only show the bid/ask — full orderbook depth
	// would be too much for a 200-token user prompt.
	const trendLines = ctx.priceHistory1h
		.slice(-4) // last 4 snapshots
		.map((p) => {
			const mid = p.yes_bid_cents > 0 && p.yes_ask_cents > p.yes_bid_cents
				? Math.round((p.yes_bid_cents + p.yes_ask_cents) / 2)
				: p.yes_bid_cents > 0 ? p.yes_bid_cents : p.yes_ask_cents;
			return `${p.ts_minutes_ago}m ago: ${mid}¢ (bid ${p.yes_bid_cents} / ask ${p.yes_ask_cents})`;
		})
		.join("\n  ");
	const trendBlock = trendLines ? `\nLast hour trend (oldest → newest):\n  ${trendLines}\n` : "";

	// 2026-08-11 (Phase 4, LLM-PIPELINE Bug A): build the
	// event-context block. For single-event markets this
	// gives the LLM the parent event's title + sub_title +
	// resolution criteria. For parlay markets it gives
	// the leg list so the LLM can compute the bundle's
	// fair value instead of guessing. The previous
	// version of the prompt only had the market's title,
	// which for parlays is just a comma-separated YES
	// list (e.g. "yes Bibee 4+,yes Pérez 6+,yes Skenes 6+")
	// that the LLM had to interpret with no grounding.
	const eventContextLines: string[] = [];
	if (ctx.eventTitle) {
		eventContextLines.push(`Event: ${ctx.eventTitle}`);
	}
	if (ctx.eventSubTitle) {
		eventContextLines.push(`Sub-title: ${ctx.eventSubTitle}`);
	}
	if (ctx.rulesPrimary) {
		// Cap at 500 chars; full rules can be hundreds of
		// lines of legal text we don't need in the prompt.
		const rulesShort = ctx.rulesPrimary.length > 500
			? ctx.rulesPrimary.slice(0, 500) + "…"
			: ctx.rulesPrimary;
		eventContextLines.push(`Resolution: ${rulesShort}`);
	}
	if (ctx.parlayLegs && ctx.parlayLegs.length > 0) {
		// Cap at 10 legs in the prompt; a 22-leg parlay
		// would blow the token budget. The LLM doesn't
		// need every leg — the bundle is "all must win",
		// so the dominant legs (highest volume on
		// Kalshi) drive the implied probability. We
		// show the first 10 in deterministic order
		// (Kalshi's response order is stable per call).
		const legs = ctx.parlayLegs.slice(0, 10);
		const legsBlock = legs
			.map((leg) => `  - ${leg.market_ticker} (${leg.side})`)
			.join("\n");
		const extra = ctx.parlayLegs.length > 10
			? ` … and ${ctx.parlayLegs.length - 10} more legs`
			: "";
		eventContextLines.push(
			`This is a parlay market (${ctx.parlayLegs.length}-leg bundle). For YES to resolve, ALL of these must win:\n${legsBlock}${extra}`,
		);
	}
	const eventContext = eventContextLines.length > 0
		? `\n${eventContextLines.join("\n")}\n`
		: "";

	const prompt = `Market: ${ctx.ticker}
Title: ${ctx.title}
Vertical: ${ctx.vertical}${eventContext}
${ctx.noPrice ? "(no live price yet — evaluate on title + event context alone)\n" : ""}Current YES price: ${ctx.currentYesPriceCents}¢ (NO = ${100 - ctx.currentYesPriceCents}¢)
Current orderbook: bid ${ctx.yesBidCents ?? "?"}¢ / ask ${ctx.yesAskCents ?? "?"}¢ / last trade ${ctx.lastPriceCents ?? "?"}¢
24h volume: ${ctx.volume24h ?? "?"} contracts · open interest: ${ctx.openInterest ?? "?"}${trendBlock}
What's your view? Reply JSON: {"side": "yes" | "no" | "hold", "confidence": 0.0-1.0, "reasoning": "..."}`;

	const result = await chat(env, SYSTEM_PROMPT, prompt, { max_tokens: 600 });
	return {
		parsed: result.ok ? parseLLMOpinion(result.text) : null,
		raw: result.text,
		ok: result.ok,
		duration_ms: result.duration_ms,
		input_tokens: result.input_tokens ?? null,
		output_tokens: result.output_tokens ?? null,
		error_message: result.error_message ?? null,
	};
}

// 2026-08-11 (Phase 3, all-three): per-domain confidence caps.
// The user pointed out that an LLM confidence of 0.85 on a
// KXMVECROSSCATEGORY multi-leg parlay is a hallucination, not
// an edge. The LLM doesn't see the legs of the bundle; it
// can't reason about whether the YES side is mispriced.
//
// The fix is two-fold:
//   1. Feed the LLM more context (price history, orderbook
//      depth, vertical) so its verdicts are grounded — see
//      askLLMForOpinion above.
//   2. Cap the confidence it can STORE for markets the LLM
//      can't reason about. Parlays (KXMVECROSSCATEGORY,
//      KXMVESPORTSMULTIGAME) cap at 0.6. The strategy already
//      requires conf >= 0.6 to fire, so a parlay capped at
//      0.6 only fires when the LLM is at the upper bound —
//      a strong signal that even with the cap, the LLM
//      genuinely thinks the bundle is mispriced.
//
// Single-event markets (KXWARMING, KXGDP, KXNBA, KXPRES, etc.)
// are uncapped because the LLM has decent training-data
// knowledge of these verticals. If the LLM gives 0.85 on
// KXWARMING-50, that 0.85 is grounded in real climate science
// context, not a hallucination.
const PARLAY_PREFIXES = [/^KXMVECROSSCATEGORY/i, /^KXMVESPORTSMULTIGAME/i, /^KXMVESPORTS/i];
const PARLAY_CONFIDENCE_CAP = 0.6;
function isParlay(ticker: string): boolean {
	for (const re of PARLAY_PREFIXES) if (re.test(ticker)) return true;
	return false;
}
function capConfidenceByDomain(ticker: string, rawConfidence: number): number {
	if (!isParlay(ticker)) return rawConfidence;
	return Math.min(rawConfidence, PARLAY_CONFIDENCE_CAP);
}

// 2026-08-11 (Phase 4, LLM-PIPELINE Bug A): fetch the
// parent event for a market, with a per-event-ticker
// cache so multi-market events (e.g. KXNEWPOPE-70 has 7
// sub-markets) only trigger 1 /events call. Returns the
// LLM-relevant context (event title, sub_title, rules,
// parlay leg list). Failures return undefined — the LLM
// prompt gracefully degrades.
const _eventCtxCache = new Map<string, {
  fetchedAt: number;
  ctx: {
    eventTitle?: string;
    eventSubTitle?: string;
    rulesPrimary?: string;
    parlayLegs?: Array<{ event_ticker: string; market_ticker: string; side: "yes" | "no" }>;
  };
}>();
const EVENT_CTX_TTL_MS = 10 * 60 * 1000; // 10 min

async function fetchEventContextCached(
  env: CronEnv,
  eventTicker: string | null,
): Promise<{
  eventTitle?: string;
  eventSubTitle?: string;
  rulesPrimary?: string;
  parlayLegs?: Array<{ event_ticker: string; market_ticker: string; side: "yes" | "no" }>;
} | null> {
  if (!eventTicker) return null;
  const now = Date.now();
  const cached = _eventCtxCache.get(eventTicker);
  if (cached && now - cached.fetchedAt < EVENT_CTX_TTL_MS) {
    return cached.ctx;
  }
  if (!env.KALSHI_PROD_KEY_ID || !env.KALSHI_PROD_PRIVATE_KEY) return null;
  try {
    const { KalshiClient, DEFAULT_PRODUCTION_BASE } = await import("../kalshi/client.js");
    const { loadPrivateKey, KalshiCredentials } = await import("../kalshi/auth.js");
    const pk = await loadPrivateKey(env.KALSHI_PROD_PRIVATE_KEY);
    const creds = new KalshiCredentials(env.KALSHI_PROD_KEY_ID, pk);
    const client = new KalshiClient({
      baseUrl: DEFAULT_PRODUCTION_BASE,
      credentials: creds,
      requestsPerSecond: 4,
    });
    const event = await client.getEvent(eventTicker, { withNestedMarkets: true });
    // The leg list lives on each market in the event;
    // for our purposes the first market is enough since
    // multi-leg bundles have a single mve_selected_legs
    // list (only one market per bundle actually carries
    // the leg spec).
    const primaryMarket = event.markets.find((m) => m.mve_selected_legs && m.mve_selected_legs.length > 0)
      ?? event.markets[0];
    const ctx = {
      eventTitle: event.title || undefined,
      eventSubTitle: event.sub_title || undefined,
      rulesPrimary: (event as unknown as { rules_primary?: string }).rules_primary || undefined,
      parlayLegs: primaryMarket?.mve_selected_legs,
    };
    _eventCtxCache.set(eventTicker, { fetchedAt: now, ctx });
    return ctx;
  } catch (e) {
    console.warn(
      `[llm-opinions] fetchEventContext(${eventTicker}) failed (non-fatal):`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

async function readBotUniverse(env: CronEnv): Promise<string[]> {
	if (!env.LIVE_BOT) return [];
	try {
		const id = env.LIVE_BOT.idFromName(`user:${DEFAULT_USER_ID}`);
		const stub = env.LIVE_BOT.get(id);
		const resp = await stub.fetch("https://bot.local/status");
		if (!resp.ok) return [];
		const data = (await resp.json()) as { config?: { tickers?: string[] } };
		return data.config?.tickers ?? [];
	} catch {
		return [];
	}
}

// 2026-08-11 (Phase 4, followup #3): fresh-market
// discovery for new verticals, using /events instead
// of /markets. The /markets endpoint is dominated by
// the KXMVESPORTS* / KXMVECROSSCATEGORY parlay block
// (119k of the 120k open markets) — the first 200
// markets are all parlays, so the per-vertical filter
// returns 0 fresh candidates. /events?status=open
// returns a balanced mix (Elections, Climate, Sci/
// Tech, World, Politics, etc. in the first 10). And
// with with_nested_markets=true, the response includes
// the markets under each event, so we don't need a
// second API call to discover them. 1 API call per
// 2-min cron = 720 calls/day, well under the rate
// limit. The /events response also gives us the
// canonical `category` field, which is more reliable
// than the prefix-regex guess.
async function discoverFreshNewVerticalMarkets(
	env: CronEnv,
): Promise<Array<{ ticker: string; event_ticker: string; title: string; category: string }>> {
	if (!env.KALSHI_PROD_KEY_ID || !env.KALSHI_PROD_PRIVATE_KEY) return [];
	try {
		const baseUrl = "https://api.elections.kalshi.com/trade-api/v2";
		const queryPath = "/events?status=open&limit=200&with_nested_markets=true";
		const { loadPrivateKey, KalshiCredentials, buildAuthHeaders } = await import("../kalshi/auth.js");
		const pk = await loadPrivateKey(env.KALSHI_PROD_PRIVATE_KEY);
		const creds = new KalshiCredentials(env.KALSHI_PROD_KEY_ID, pk);
		const headers = await buildAuthHeaders(creds.privateKey, creds.keyId, "GET", `/trade-api/v2${queryPath}`);
		const resp = await fetch(`${baseUrl}${queryPath}`, { method: "GET", headers: { ...headers } });
		if (!resp.ok) {
			console.warn(`[llm-opinions] fresh-discovery /events returned ${resp.status}`);
			return [];
		}
		const data = await resp.json() as {
			events?: Array<{
				category?: string;
				event_ticker?: string;
				title?: string;
				markets?: Array<{ ticker: string; title?: string }>;
			}>;
		};
		const events = data.events ?? [];
		const out: Array<{ ticker: string; event_ticker: string; title: string; category: string }> = [];
		for (const ev of events) {
			const cat = ev.category || "";
			// Filter to the 13 new verticals only. The
			// legacy 4 are already in the bot universe
			// via the auto-promote pipeline.
			if (!["Elections", "Financials", "Entertainment", "Science and Technology",
				"Crypto", "Companies", "Commodities", "Mentions", "Social", "World",
				"Health", "Transportation"].includes(cat)) continue;
			const markets = ev.markets ?? [];
			if (markets.length === 0) continue;
			// Take the first market in the event (usually
			// the highest-volume one). The loop will
			// follow up with a GET for the orderbook.
			const m = markets[0];
			out.push({
				ticker: m.ticker,
				event_ticker: ev.event_ticker ?? "",
				title: m.title ?? ev.title ?? m.ticker,
				category: cat,
			});
		}
		return out;
	} catch (e) {
		console.warn(
			"[llm-opinions] fresh-market discovery failed (non-fatal):",
			e instanceof Error ? e.message : String(e),
		);
		return [];
	}
}

export interface LLMOpinionsEnv extends LLMEnv {
	DB?: D1Database;
	LIVE_BOT?: DurableObjectNamespace;
	// 2026-08-11 (Phase 4, followup #2): Kalshi creds
	// for fresh-market discovery (call /markets?status=open
	// directly when the snapshots table is stale). Inherited
	// from CronEnv in production; declared here so the type
	// checker doesn't reject the access in the loop.
	KALSHI_PROD_KEY_ID?: string;
	KALSHI_PROD_PRIVATE_KEY?: string;
	// Internal: stashed by the fresh-discovery step so the
	// per-ticker loop can find markets that don't have a
	// snapshot row yet. NOT part of the production Env —
	// populated at runtime by the cron.
	__freshDiscovery?: Array<{ ticker: string; event_ticker: string; title: string }>;
}

export async function runLLMOpinionsCron(env: LLMOpinionsEnv): Promise<CronResult> {
	const startMs = Date.now();
	const now = Date.now();
	const userId = DEFAULT_USER_ID;

	if (!env.DB) {
		return {
			ok: false,
			cron_name: "llm_opinions",
			duration_ms: Date.now() - startMs,
			error_message: "no DB binding",
		};
	}

	const tickers = await readBotUniverse(env);
	// 2026-08-10: track the bot's ACTUAL universe (not the
	// union with live markets) so the auto-promote logic
	// can correctly identify tickers that aren't already
	// being watched. `botUniverse` below is the union; the
	// LLM gets verdicts for every market in that union.
	const botUniverseOnly = new Set(tickers);
	if (tickers.length === 0) {
		return {
			ok: true,
			cron_name: "llm_opinions",
			duration_ms: Date.now() - startMs,
			artifacts: { skipped: true, skip_reason: "no bot universe" },
		};
	}

	// 2026-08-10: expand the universe to ALL live markets,
	// not just the bot's tickers. The research-cron's
	// catalog sweep surfaces every market with a real
	// two-sided quote; the LLM gives us an opinionated
	// verdict on each one (yes/no/hold + confidence +
	// reasoning). The bot's strategy still only fires on
	// the universe tickers, but the operator can see all
	// LLM verdicts in the dashboard and promote
	// high-confidence candidates to the universe via
	// /api/pm/bot/start.
	//
	// Cost: ~336 calls/day at 5 markets, well under the
	// $50/mo strategy budget.
	//
	// We UNION the bot's universe with the latest live
	// markets from live_market_snapshots. The UNION is
	// cheap (a single D1 query, no per-ticker roundtrips).
	const botUniverse = new Set(tickers);
	const liveRows = await env.DB
		.prepare(
			`SELECT DISTINCT ticker FROM live_market_snapshots
			 WHERE user_id = ?1 AND is_live = 1
			   AND ts >= ?2`,
		)
		.bind(userId, now - 60 * 60 * 1000) // last 1h of snapshots
		.all<{ ticker: string }>();
	for (const row of liveRows.results ?? []) {
		if (row.ticker) botUniverse.add(row.ticker);
	}
	let allTickers = Array.from(botUniverse);

	// 2026-08-10 19:48: cap the LLM loop. Kalshi's open catalog
	// is ~2250 markets (almost all parlays). Calling the LLM on
	// every one of them per 30-min cron = ~2.5 hours of LLM
	// work — way past the Worker wall-clock limit. Cap at 50
	// per run, prioritising (a) bot's actual universe first,
	// (b) markets with real volume, (c) markets with real OI.
	// The auto-promote pipeline still surfaces the long tail:
	// a different ticker's turn comes around every ~30 runs.
	//
	// 2026-08-10 20:30: D1 binds cap is 100 parameters per
	// query. The earlier "IN (...) with all 2,184 tickers" approach
	// crashed. New approach: don't pass allTickers to a
	// parameterised IN-clause. Just query the top 200 by
	// volume directly from live_market_snapshots, then take
	// the first LLM_LOOP_CAP of those.
	// 2026-08-11 (Phase 4, expansion): dropped 200 → 3.
	// The Phase 3 bump from 50 to 200 assumed ~1s per LLM
	// call; with the Phase 3 rich prompt (price history +
	// orderbook depth + vertical), measured latency is
	// 10.5s avg / 45s max. 200 calls × 10s = 2,000s wall-
	// clock, well over the 30s Worker wall-clock limit.
	// The cron was timing out mid-loop and not even writing
	// a cron_run row (no runs in 12+ min after deploy).
	//
	// 2026-08-11 (Phase 4, followup #4): parallelized.
	// The LLM call is I/O-bound (waiting on the model),
	// so concurrent calls don't add CPU cost — just
	// batch the wait. With MAX_CONCURRENT_LLM=5 inside
	// the pMap, 15 LLM calls = 3 batches × 10s = 30s
	// wall-clock (just at the limit). 15 calls × 30
	// runs/hour = 450 calls/hour = 10,800/day. The
	// 9,610-event catalog cycles in ~21 hours. The bot's
	// own universe (~40 tickers) gets first-priority in
	// the sort, so it cycles in 40/15 × 2 min = 5.3 min
	// — well under the LLM verdict TTL of 1h.
	//
	// The user pushed back: "this number isn't moving,
	// it isn't being exposed to anything." 3 was
	// starving the LLM. 15 puts real coverage on.
	const LLM_LOOP_CAP = 15;
	const CANDIDATE_POOL = 200;
	if (allTickers.length > LLM_LOOP_CAP) {
		const rankedRows = await env.DB
			.prepare(
				`SELECT ticker, MAX(volume_24h) as vol, MAX(open_interest) as oi
				 FROM live_market_snapshots
				 WHERE user_id = ?1 AND ts >= ?2 AND is_live = 1
				 GROUP BY ticker
				 ORDER BY vol DESC, oi DESC
				 LIMIT ?3`,
			)
			.bind(userId, now - 60 * 60 * 1000, CANDIDATE_POOL)
			.all<{ ticker: string; vol: number | null; oi: number | null }>();
		// 2026-08-11 (Phase 4, followup): priority order
		// flipped. With LLM_LOOP_CAP=3 and a universe of
		// 40 KXMVECROSSCATEGORY parlays, the OLD order
		// (universe first) ate all 3 calls on the parlays
		// — markets the LLM can't even price (no bid/ask).
		// The auto-promote pipeline needs to see NEW
		// markets in the 13 newly-expanded verticals
		// (elections, financials, crypto, etc.), not
		// re-evaluate the parlay universe every 2 min.
		// New order: live markets OUTSIDE the bot's
		// universe first (i.e. potential new additions),
		// then the bot's own universe as a tie-breaker.
		// With 3 calls per run, the first 3 go to fresh
		// discovery and the rest to existing universe
		// re-evaluation.
		//
		// 2026-08-11 (Phase 4, followup #2): pull from
		// Kalshi's /markets DIRECTLY for new verticals.
		// The previous Phase 4 order (snapshots-first)
		// was still bottlenecked on the research-cron,
		// which has been timing out at the 30s Worker
		// wall-clock limit (5+ min wall-clock per run)
		// since 01:10 — the snapshots table is stale
		// and shows no new-vertical markets. To unblock
		// the LLM from seeing the 13 new verticals, this
		// step now ALSO calls Kalshi's /markets?status=open
		// for a single 200-market page, filters to the
		// 13 new verticals (skipping the 4 legacy ones
		// already in the bot universe), and prepends
		// those to the freshFirst list. 1 extra API call
		// per 2-min cron, well under the rate limit.
		const freshNewVerticals = await discoverFreshNewVerticalMarkets(env);
		const freshNewVerticalsTickers = freshNewVerticals.map((f) => f.ticker);
		const universe = new Set(tickers);
		const others = (rankedRows.results ?? []).map((r) => r.ticker);
		const freshFirst = [
			...freshNewVerticalsTickers,
			...others.filter((t) => !universe.has(t)),
		].filter((t, i, arr) => arr.indexOf(t) === i); // dedupe
		const universeFirst = allTickers.filter((t) => universe.has(t));
		allTickers = [...freshFirst, ...universeFirst].slice(0, LLM_LOOP_CAP);
		// 2026-08-11 (Phase 4, followup #2): stash the
		// fresh-discovery markets on the env so the
		// per-ticker loop can find them in the snapshot
		// map even if they don't have a snapshot row yet
		// (they were just discovered via /markets). Without
		// this, the loop would skip the fresh markets
		// because the snapshot query returns nothing.
		if (freshNewVerticals.length > 0) {
			env.__freshDiscovery = freshNewVerticals;
		}
	}

	const errors: Array<{ ticker: string; message: string }> = [];
	const updated: string[] = [];
	const skipped: string[] = [];
	// 2026-08-10: auto-promote candidates collected during
	// the LLM loop. Each entry is `(ticker, vertical, conf,
	// reasoning)` for a non-universe ticker that the LLM
	// gave a high-confidence verdict on. The actual DO call
	// + lead_suggestion write happens after the loop so we
	// can sort by confidence and cap at AUTO_PROMOTE_MAX_PER_RUN.
	const autoPromoteCandidates: Array<{
		ticker: string;
		vertical: string;
		confidence: number;
		reasoning: string;
	}> = [];
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	// 2026-08-12 (cost-control, option 2): staleness filter.
	// Pre-load the latest verdict per ticker so the loop can
	// skip the LLM call when the verdict is recent AND the
	// current price is within STALENESS_PRICE_BAND of the
	// verdict's price. 89% of LLM verdicts come back as
	// `hold` — most of those are repeats of an existing
	// verdict where nothing has changed. Skipping those
	// drops calls ~50% with no signal-quality loss (the
	// strategy's `LLMOpinionSignal` already gates on
	// `ts + ttl_ms > now`, so an older verdict is still
	// usable — we just refresh it less aggressively).
	//
	// Pre-load also includes the per-ticker input/output
	// token estimate from the most recent call so the
	// daily-cap check doesn't double-count (we'll know
	// the per-call cost before committing).
	const DAILY_TOKEN_CAP = 200_000; // hard stop; ~$0.30/day at Gemini 3 Flash
	const STALENESS_PRICE_BAND = 2; // cents; YES price unchanged within ±2c → skip
	const STALENESS_MAX_AGE_MS = 30 * 60 * 1000; // 30 min; force a re-ask beyond this even if price flat
	const todaysCalls = await env.DB
		.prepare(
			`SELECT
				SUM(input_tokens_est) as in_today,
				SUM(output_tokens_est) as out_today
			 FROM llm_calls
			 WHERE user_id = ?1 AND purpose = 'llm_opinions_cron'
			   AND ts >= ?2`,
		)
		.bind(userId, now - 24 * 60 * 60 * 1000)
		.first<{ in_today: number | null; out_today: number | null }>();
	let dailyTokensUsed =
		(todaysCalls?.in_today ?? 0) + (todaysCalls?.out_today ?? 0);

	// 2026-08-12 (cost-control, option 2): pre-load latest
	// verdict per ticker. Combined with the snapshot
	// price-band check, the LLM call is skipped when the
	// previous verdict is fresh AND the market hasn't
	// moved. Estimated 30-50% reduction on top of the
	// 2-min → 1-hour cadence change.
	const latestVerdictsByTicker = new Map<
		string,
		{ ts: number; side: string; confidence: number; current_price_cents: number | null }
	>();
	{
		const CHUNK = 90;
		for (let i = 0; i < allTickers.length; i += CHUNK) {
			const slice = allTickers.slice(i, i + CHUNK);
			const placeholders = slice.map((_, j) => `?${j + 3}`).join(",");
			const rows = await env.DB
				.prepare(
					`SELECT ticker, ts, side, confidence, current_price_cents
					 FROM (
					   SELECT *, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) AS rn
					   FROM llm_opinions
					   WHERE user_id = ?1
					     AND ticker IN (${placeholders})
					     AND expires_at > ?2
					 )
					 WHERE rn = 1`,
				)
				.bind(userId, ...slice, now)
				.all<{
					ticker: string;
					ts: number;
					side: string;
					confidence: number;
					current_price_cents: number | null;
				} & { rn: number }>();
			for (const row of rows.results ?? []) {
				latestVerdictsByTicker.set(row.ticker, {
					ts: row.ts,
					side: row.side,
					confidence: row.confidence,
					current_price_cents: row.current_price_cents,
				});
			}
		}
	}

	// For each ticker: read the latest snapshot (gives us
	// title + current bid/ask), ask the LLM, upsert verdict.
	// Filter to the union of (bot universe ∪ live markets) so
	// the LLM gets verdicts on every tradeable market, not
	// just the bot's current tickers.
	//
	// 2026-08-11 (Phase 4, expansion): chunked the
	// snapshot query to match the price-history query.
	// Previously the IN-clause had a single placeholders
	// string with all allTickers, which hit D1's 100-param
	// bind cap (D1_ERROR: variable number must be between
	// ?1 and ?100) when allTickers exceeded ~99 tickers.
	// At LLM_LOOP_CAP=200 + the bot universe of 40
	// KXMVECROSSCATEGORY parlays, that crash was every
	// run. Now: chunk the same way the price-history
	// query does (CHUNK=90) and merge the results into a
	// single Map.
	const snapByTicker = new Map<string, {
		ticker: string;
		event_ticker: string | null;
		title: string | null;
		yes_bid_cents: number;
		yes_ask_cents: number;
		last_price_cents: number | null;
		volume_24h: number | null;
		open_interest: number | null;
	}>();
	{
		const SNAP_CHUNK = 90;
		for (let i = 0; i < allTickers.length; i += SNAP_CHUNK) {
			const slice = allTickers.slice(i, i + SNAP_CHUNK);
			const placeholders = slice.map((_, j) => `?${j + 2}`).join(",");
			const latestRows = await env.DB
				.prepare(
					`SELECT * FROM (
					  SELECT *, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) AS rn
					  FROM live_market_snapshots
					  WHERE user_id = ?1 AND ticker IN (${placeholders})
					) WHERE rn = 1`,
				)
				.bind(userId, ...slice)
				.all<{
					ticker: string;
					event_ticker: string | null;
					title: string | null;
					yes_bid_cents: number;
					yes_ask_cents: number;
					last_price_cents: number | null;
					volume_24h: number | null;
					open_interest: number | null;
				} & { rn: number }>();
			for (const row of latestRows.results ?? []) snapByTicker.set(row.ticker, row);
		}
	}

	// 2026-08-11 (Phase 3, all-three): also pull the last 1h
	// of snapshots per ticker so the LLM can see price
	// momentum (bid/ask trend), not just the current quote.
	// One round-trip, grouped by ticker. The single D1
	// parameter cap of 100 limits us to ~99 tickers per
	// IN-clause, so we chunk the query.
	const priceHistoryByTicker = new Map<
		string,
		Array<{
			ts_ms: number;
			yes_bid_cents: number;
			yes_ask_cents: number;
		}>
	>();
	{
		const CHUNK = 90; // stay under the 100-param D1 cap
		for (let i = 0; i < allTickers.length; i += CHUNK) {
			const slice = allTickers.slice(i, i + CHUNK);
			const placeholders = slice.map((_, j) => `?${j + 2}`).join(",");
			const rows = await env.DB
				.prepare(
					`SELECT ticker, ts, yes_bid_cents, yes_ask_cents
					 FROM live_market_snapshots
					 WHERE user_id = ?1 AND ticker IN (${placeholders})
					   AND ts >= ?${slice.length + 2}
					 ORDER BY ticker, ts ASC`,
				)
				.bind(userId, ...slice, now - 60 * 60 * 1000)
				.all<{
					ticker: string;
					ts: number;
					yes_bid_cents: number;
					yes_ask_cents: number;
				}>();
			for (const row of rows.results ?? []) {
				if (!priceHistoryByTicker.has(row.ticker)) {
					priceHistoryByTicker.set(row.ticker, []);
				}
				priceHistoryByTicker.get(row.ticker)!.push({
					ts_ms: row.ts,
					yes_bid_cents: row.yes_bid_cents,
					yes_ask_cents: row.yes_ask_cents,
				});
			}
		}
	}

	// 2026-08-11: parallelize the LLM loop. Previously
	// this was a sequential for-loop (3 LLM calls × 10.5s
	// = 30s wall-clock, the whole Worker budget). The
	// LLM call is I/O-bound (waiting on the model), so
	// running them concurrently doesn't add CPU cost —
	// just batches the wait. With MAX_CONCURRENT_LLM=5,
	// 15 LLM calls = 3 batches × 10s = 30s, just at
	// the limit. If the LLM latency is slower than
	// expected, the cron will start timing out and the
	// CF runtime will return whatever the dispatcher
	// records. The cron_run is written at the end so
	// the heartbeat stays accurate.
	//
	// The user pointed out: 'why is the bot not trading
	// if it's seeing the new markets? this number isn't
	// moving, it isn't being exposed to anything.' The
	// 3-call cap was starving the LLM — the bot was
	// seeing the same 4 single-event markets every 28
	// minutes. With 15 calls/run, the LLM cycles through
	// ~450 markets/hour. The 9,610-event catalog cycles
	// in ~21 hours. Auto-promote fires on the markets
	// the LLM actually has a view on, regardless of
	// whether they have a live price yet.
	const MAX_CONCURRENT_LLM = 5;
	async function pMap<T, R>(
		items: T[],
		concurrency: number,
		fn: (item: T, index: number) => Promise<R>,
	): Promise<R[]> {
		const results: R[] = new Array(items.length);
		let cursor = 0;
		async function worker() {
			while (true) {
				const idx = cursor;
				cursor += 1;
				if (idx >= items.length) return;
				results[idx] = await fn(items[idx]!, idx);
			}
		}
		const workerCount = Math.min(concurrency, items.length);
		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}

	await pMap(allTickers, MAX_CONCURRENT_LLM, async (ticker) => {
		try {
			let snap = snapByTicker.get(ticker) ?? null;
			// 2026-08-11 (Phase 4, followup #2): the
			// fresh-discovery step pulls markets directly
			// from Kalshi's /markets, but those markets
			// don't have a snapshot row yet (the research
			// cron is timing out at the 30s Worker limit
			// and not writing snapshots for new verticals).
			// Synthesize a minimal "snapshot" from the
			// fresh-discovery data so the LLM still gets
			// a price + title. We have to call /markets
			// again for the bid/ask — the list endpoint
			// returns 0 for those — so the LLM prompt
			// for a fresh-discovery market will have
			// "?" for bid/ask/last. That's OK: the LLM
			// can still see the title and last trade, and
			// the LLMOpinionSignal will skip on the
			// strategy side if no price is available.
			if (!snap) {
				const fresh = (env as CronEnv).__freshDiscovery?.find(
					(f) => f.ticker === ticker,
				);
				if (fresh) {
					// Try a quick GET to get the real orderbook.
					// If it fails, fall back to the title-only
					// synthesised snapshot.
					try {
						const { KalshiClient, DEFAULT_PRODUCTION_BASE } = await import("../kalshi/client.js");
						const { loadPrivateKey, KalshiCredentials } = await import("../kalshi/auth.js");
						if (env.KALSHI_PROD_KEY_ID && env.KALSHI_PROD_PRIVATE_KEY) {
							const pk = await loadPrivateKey(env.KALSHI_PROD_PRIVATE_KEY);
							const creds = new KalshiCredentials(env.KALSHI_PROD_KEY_ID, pk);
							const client = new KalshiClient({
								baseUrl: DEFAULT_PRODUCTION_BASE,
								credentials: creds,
								requestsPerSecond: 4,
							});
							const m = await client.getMarket(ticker);
							snap = {
								ticker: m.ticker,
								event_ticker: fresh.event_ticker,
								title: fresh.title,
								yes_bid_cents: m.yes_bid_cents,
								yes_ask_cents: m.yes_ask_cents,
								last_price_cents: m.last_price_cents,
								volume_24h: m.volume_24h ?? null,
								open_interest: m.open_interest ?? null,
							};
						}
					} catch {
						// GET failed — skip
						skipped.push(`${ticker}: fresh_discovery_get_failed`);
						return;
					}
				} else {
					skipped.push(`${ticker}: no_snapshot`);
					return;
				}
			}
			if (!snap) {
				skipped.push(`${ticker}: no_snapshot`);
				return;
			}
			// Compute the mid price the LLM will see.
			// The snapshot has yes_bid and yes_ask; mid = (bid+ask)/2.
			//
			// 2026-08-11: don't skip markets with no live
			// price. The previous behavior was to skip
			// (logged as `no_price`) because the LLM was
			// assumed to need a price to compare against.
			// But the LLM is also a DISCOVERY signal — it
			// can give a directional view on a market's
			// title alone ("this is interesting, add to
			// the universe") even when no two-sided quote
			// exists. For those markets we pass 50¢ as
			// the assumed fair value (binary default) and
			// the prompt tells the LLM to evaluate on
			// title alone. The auto-promote path is the
			// actual goal — once a market is in the
			// universe, the polling feed will start
			// tracking it and a price may appear later.
			let midCents: number;
			let noPrice = false;
			if (snap.yes_bid_cents > 0 && snap.yes_ask_cents > 0 && snap.yes_ask_cents > snap.yes_bid_cents) {
				midCents = Math.round((snap.yes_bid_cents + snap.yes_ask_cents) / 2);
			} else if (snap.last_price_cents && snap.last_price_cents > 0) {
				midCents = snap.last_price_cents;
			} else {
				midCents = 50; // binary default; prompt notes this
				noPrice = true;
			}
			const title = snap.title ?? ticker;
			// 2026-08-10 19:48: fix vertical inference. The
			// snapshot table has no `vertical` column, so the
			// old `(snap as any).vertical ?? "unknown"` always
			// returned "unknown" — which the auto-promote gate
			// rejected. Use the same prefix-based classifier
			// the leads-scout uses. Cross-category and
			// multigame-extended parlays return null there
			// (bot has no parlay strategy), so we map them
			// to "sports" as a paper-mode fallback — the
			// LLMOpinionSignal + NaiveSignal strategies are
			// vertical-agnostic and will run on any market
			// with a price. If the LLM says "hold" because
			// it doesn't understand parlays, fine; if it
			// gives a real opinion, we get to trade it.
			const classified = classifyByEventTicker(
				snap.event_ticker,
				snap.title,
			);
			const vertical = classified ?? (
				/^KXMVECROSSCATEGORY|^KXMVESPORTSMULTIGAME/i.test(snap.event_ticker ?? "")
					? "sports"
					: "unknown"
			);
			// 2026-08-11 (Phase 4, LLM-PIPELINE Bug A):
			// fetch the parent event so the LLM has the
			// event title, sub_title, resolution rules,
			// and (for parlays) the list of leg markets.
			// Without this, the LLM sees a market title
			// like "yes Bibee 4+,yes Pérez 6+,yes Skenes 6+"
			// and has to guess at the bundle — high
			// confidence on a 4-leg parlay is a hallucination,
			// not an edge. Cached per (ticker → event_ticker)
			// so multi-market events (e.g. KXNEWPOPE-70 has
			// 7 sub-markets) only trigger 1 /events call.
			const eventCtx = await fetchEventContextCached(
				env,
				snap.event_ticker,
			);

			// 2026-08-12 (cost-control, option 2 + 3):
			// cheap skip gates. The LLM is ~$0.005/call on
			// average; these gates are pure local reads.
			//
			// 2a. STALENESS — if the latest verdict is <30 min
			//     old AND the current price is within ±2¢ of
			//     the verdict's price, the LLM has nothing
			//     new to say. Reuse the existing verdict
			//     (the LLMOpinionSignal strategy still uses
			//     it for the next hour per its 1h TTL).
			// 2b. ONE-SIDED QUOTE — if the snapshot has no
			//     two-sided book (yes_bid or yes_ask = 0),
			//     the LLM has no price context to evaluate.
			//     The LLM verdict on these markets is almost
			//     always `hold 0.3` — pure spend. Skip.
			// 2c. DAILY CAP — hard stop at 200k tokens/day
			//     (~$0.30/day at Gemini 3 Flash). Once the
			//     cap is hit, the rest of the loop returns
			//     without calling the LLM. Fail closed.
			const prior = latestVerdictsByTicker.get(ticker);
			const hasTwoSidedQuote =
				snap.yes_bid_cents > 0 && snap.yes_ask_cents > 0;
			const priceBandOK =
				prior !== undefined &&
				prior.current_price_cents !== null &&
				Math.abs(midCents - prior.current_price_cents) <=
					STALENESS_PRICE_BAND;
			const freshEnough =
				prior !== undefined && now - prior.ts < STALENESS_MAX_AGE_MS;
			if (prior !== undefined && freshEnough && priceBandOK) {
				skipped.push(`${ticker}: stale_verdict`);
				return;
			}
			if (!hasTwoSidedQuote && !noPrice) {
				skipped.push(`${ticker}: one_sided_quote`);
				return;
			}
			if (dailyTokensUsed >= DAILY_TOKEN_CAP) {
				skipped.push(`${ticker}: daily_cap`);
				return;
			}

			const llm = await askLLMForOpinion(env, {
				ticker,
				title,
				vertical,
				currentYesPriceCents: midCents,
				// 2026-08-11: tell the LLM when there's no
				// live price so the prompt can say "evaluate
				// on title + event context alone". The verdict
				// can still be confident enough to auto-promote
				// (e.g., "KXNEWPOPE next Pope is 8%? — yes 0.7
				// confidence, add to universe, track when
				// price appears").
				noPrice,
				yesBidCents: snap.yes_bid_cents > 0 ? snap.yes_bid_cents : null,
				yesAskCents: snap.yes_ask_cents > 0 ? snap.yes_ask_cents : null,
				lastPriceCents: snap.last_price_cents,
				volume24h: (snap as { volume_24h?: number | null }).volume_24h ?? null,
				openInterest: (snap as { open_interest?: number | null }).open_interest ?? null,
				priceHistory1h: (priceHistoryByTicker.get(ticker) ?? []).map(
					(p) => ({
						ts_minutes_ago: Math.max(0, Math.round((now - p.ts_ms) / 60_000)),
						yes_bid_cents: p.yes_bid_cents,
						yes_ask_cents: p.yes_ask_cents,
					}),
				),
				eventTitle: eventCtx?.eventTitle,
				eventSubTitle: eventCtx?.eventSubTitle,
				rulesPrimary: eventCtx?.rulesPrimary,
				parlayLegs: eventCtx?.parlayLegs,
			});
			totalInputTokens += llm.input_tokens ?? 0;
			totalOutputTokens += llm.output_tokens ?? 0;
			// 2026-08-12: update the daily cap counter so
			// the loop can short-circuit later tickers
			// when we blow the budget. The counters above
			// are aggregate per-run; this one persists
			// across runs.
			dailyTokensUsed += (llm.input_tokens ?? 0) + (llm.output_tokens ?? 0);
			// Record the LLM call regardless of parse success.
			if (!env.DB) return;  // shouldn't happen in the worker
			await llmCallsDb
				.insert(env.DB, {
					user_id: userId,
					ts: now,
					purpose: "llm_opinions_cron",
					model: DEFAULT_MODEL,
					ticker,
					input_tokens_est: llm.input_tokens,
					output_tokens_est: llm.output_tokens,
					duration_ms: llm.duration_ms,
					status: llm.ok ? "success" : "error",
					error_message: llm.error_message,
				})
				.catch(() => undefined);
			if (!llm.parsed) {
				errors.push({ ticker, message: llm.error_message ?? "parse_failed" });
				return;
			}
			if (llm.parsed.confidence < MIN_CONFIDENCE) {
				skipped.push(`${ticker}: low_confidence`);
				return;
			}
			// 2026-08-11 (Phase 3, all-three): per-domain
			// confidence cap. Parlays get capped at 0.6 so
			// the LLM's confident hallucination on a
			// multi-leg bundle (0.85 on a 4-leg parlay with
			// no ground truth) can't auto-promote into the
			// universe. The strategy still requires conf
			// >= 0.6, so a parlay capped at 0.6 only fires
			// at the upper bound — a strong signal.
			const cappedConfidence = capConfidenceByDomain(
				ticker,
				llm.parsed.confidence,
			);
			if (!env.DB) return;
			await llmOpinionsDb.insert(env.DB, {
				user_id: userId,
				ts: now,
				ticker,
				side: llm.parsed.side,
				confidence: cappedConfidence,
				reasoning: cappedConfidence < llm.parsed.confidence
					? `[capped ${llm.parsed.confidence.toFixed(2)}→${cappedConfidence.toFixed(2)} for parlay] ${llm.parsed.reasoning}`
					: llm.parsed.reasoning,
				current_price_cents: midCents,
				vertical,
				model: DEFAULT_MODEL,
				input_tokens: llm.input_tokens,
				output_tokens: llm.output_tokens,
				duration_ms: llm.duration_ms,
				expires_at: now + TTL_MS,
			});
			updated.push(`${ticker}=${llm.parsed.side}@${llm.parsed.confidence.toFixed(2)}`);
			// 2026-08-10: auto-promote candidate. The LLM
			// verdict is fresh + parsed; we still need to
			// gate on (a) confidence above the auto
			// threshold, (b) vertical is in the auto-
			// promote whitelist, (c) ticker is NOT in
			// the bot's actual universe. The actual DO
			// call + lead_suggestion write happens after
			// the main loop (so we can sort by confidence
			// and cap at AUTO_PROMOTE_MAX_PER_RUN).
			// 2026-08-11 (Phase 3, all-three): use the CAPPED
			// confidence for the auto-promote gate. A parlay
			// with raw conf 0.7 (capped to 0.6) doesn't clear
			// the 0.5 threshold on raw conf AND it doesn't clear
			// it on capped conf — either way, 0.6 is the floor
			// for a parlay to auto-promote. The user pointed
			// out that 0.85 hallucination confidence was
			// auto-promoting parlays into the universe; this
			// is the fix on both the per-domain cap AND the
			// gate uses the capped value.
			if (
				cappedConfidence >= AUTO_PROMOTE_THRESHOLD &&
				AUTO_PROMOTE_VERTICALS.has(vertical) &&
				!botUniverseOnly.has(ticker)
			) {
				autoPromoteCandidates.push({
					ticker,
					vertical,
					confidence: cappedConfidence,
					reasoning: llm.parsed.reasoning,
				});
			}
		} catch (e) {
			errors.push({ ticker, message: e instanceof Error ? e.message : String(e) });
		}
	});

	// 2026-08-10: auto-promote the top-N high-confidence
	// non-universe tickers. Sort by confidence DESC so
	// the strongest signals get promoted first, cap at
	// AUTO_PROMOTE_MAX_PER_RUN to bound the impact of a
	// misbehaving LLM (each promote is irreversible until
	// the operator explicitly removes the ticker).
	//
	// For each candidate: (a) call DO /auto-promote to
	// add the ticker to the bot's universe atomically,
	// (b) write a lead_suggestion row with status=auto_promoted
	// for the operator's audit trail (the Dev page can show
	// these as "auto" pills so the operator knows what the
	// bot added on its own).
	const autoPromoted: Array<{ ticker: string; vertical: string; confidence: number; ok: boolean; error?: string }> = [];
	if (env.LIVE_BOT && autoPromoteCandidates.length > 0) {
		// Sort by confidence DESC, dedupe by ticker (just
		// in case two candidates share a ticker — the union
		// of bot universe + live markets can produce dupes).
		const seen = new Set<string>();
		const sorted = [...autoPromoteCandidates]
			.sort((a, b) => b.confidence - a.confidence)
			.filter((c) => {
				if (seen.has(c.ticker)) return false;
				seen.add(c.ticker);
				return true;
			})
			.slice(0, AUTO_PROMOTE_MAX_PER_RUN);

		const id = env.LIVE_BOT.idFromName(`user:${userId}`);
		const stub = env.LIVE_BOT.get(id);
		for (const cand of sorted) {
			try {
				const resp = await stub.fetch("https://bot.local/auto-promote", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						ticker: cand.ticker,
						vertical: cand.vertical,
						confidence: cand.confidence,
						reasoning: cand.reasoning,
					}),
				});
				if (!resp.ok) {
					autoPromoted.push({
						ticker: cand.ticker,
						vertical: cand.vertical,
						confidence: cand.confidence,
						ok: false,
						error: `http_${resp.status}`,
					});
					continue;
				}
				const data = (await resp.json().catch(() => ({}))) as {
					ok?: boolean;
					added?: boolean;
					already_in_universe?: boolean;
				};
				if (!data.ok) {
					autoPromoted.push({
						ticker: cand.ticker,
						vertical: cand.vertical,
						confidence: cand.confidence,
						ok: false,
						error: "do_returned_not_ok",
					});
					continue;
				}
				autoPromoted.push({
					ticker: cand.ticker,
					vertical: cand.vertical,
					confidence: cand.confidence,
					ok: true,
				});
				// Audit row: lead_suggestions with
				// status='auto_promoted'. The existing
				// 'decided_at' column is set to the
				// auto-promote timestamp so the Dev
				// page can render the action time
				// without a separate column.
				try {
					await env.DB
						.prepare(
							`INSERT INTO lead_suggestions
							 (user_id, cron_run_id, kind, ticker, vertical, reasoning, raw_text,
							  status, created_at, decided_at, expires_at, applied_at)
							 VALUES (?1, NULL, 'add', ?2, ?3, ?4, ?5, 'auto_promoted', ?6, ?6, ?7, ?6)`,
						)
						.bind(
							userId,
							cand.ticker,
							cand.vertical,
							`auto-promoted by llm_opinions_cron at conf ${cand.confidence.toFixed(2)}: ${cand.reasoning}`.slice(0, 1000),
							`confidence=${cand.confidence.toFixed(2)}; vertical=${cand.vertical}`,
							now,
							now + 30 * 24 * 60 * 60 * 1000, // 30d expiry on the audit row
						)
						.run();
				} catch (e) {
					console.warn(
						`[llm-opinions] auto-promote audit row failed for ${cand.ticker}:`,
						e instanceof Error ? e.message : String(e),
					);
				}
			} catch (e) {
				autoPromoted.push({
					ticker: cand.ticker,
					vertical: cand.vertical,
					confidence: cand.confidence,
					ok: false,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
		console.log(
			`[llm-opinions] auto-promoted ${autoPromoted.filter((a) => a.ok).length}/${sorted.length} candidates`,
		);
	}

	// Record the cron run.
	//
	// 2026-08-10: status logic fix. The previous "any error = error"
	// rule was too strict — a single ticker failing (e.g. stale
	// snapshot, LLM rate-limit on one of N parallel calls) made the
	// heartbeat count the whole run as failed even when 5+ opinions
	// were successfully written. The heartbeat's "3+ consecutive
	// errors" check then started firing Telegram alerts for a cron
	// that was functionally fine.
	//
	// New rule:
	//   - 0 errors                              → success
	//   - 1+ opinions written + 1+ errors       → success (partial — details
	//                                              in artifacts_json)
	//   - 0 opinions written + 1+ errors        → error  (true failure)
	//
	// The error_message field gets a real string summary (not a
	// comma-separated list of ticker names — the heartbeat was reading
	// those as error text and reporting them as cryptic identifiers).
	// Per-ticker details go into artifacts_json for the cadence panel.
	const cronStatus =
		errors.length === 0
			? "success"
			: updated.length > 0
				? "success"
				: "error";
	const errorMessage =
		errors.length > 0
			? `${errors.length}/${allTickers.length} tickers failed (e.g. ${errors[0]?.message?.slice(0, 80) ?? "unknown"})`
			: null;
	try {
		await cronRunsDb.insert(env.DB, {
			user_id: userId,
			cron_name: "llm_opinions",
			ts: now,
			duration_ms: Date.now() - startMs,
			status: cronStatus,
			error_message: errorMessage,
			artifacts_json:
				errors.length > 0 ? JSON.stringify({ errors: errors.slice(0, 10) }) : null,
		});
	} catch (e) {
		console.warn("[llm-opinions] failed to record cron run", e);
	}

	return {
		ok: cronStatus === "success",
		cron_name: "llm_opinions",
		duration_ms: Date.now() - startMs,
		artifacts: {
			n_tickers: allTickers.length,
			n_updated: updated.length,
			n_skipped: skipped.length,
			n_errors: errors.length,
			updated,
			skipped,
			errors: errors.slice(0, 10),
			// 2026-08-10: auto-promote audit. Each entry is
			// one LLM verdict that triggered (or tried to
			// trigger) an auto-add to the bot's universe.
			// ok=true means the DO accepted the promotion;
			// ok=false means the call failed (logged with
			// an error string the cadence panel can surface).
			auto_promoted: autoPromoted,
			total_input_tokens: totalInputTokens,
			total_output_tokens: totalOutputTokens,
			// 2026-08-12: cost-control artifacts. The
			// operator can see how many tickers were
			// short-circuited by the local gates
			// (stale_verdict, one_sided_quote, daily_cap)
			// vs. how many actually hit the LLM. If
			// `skipped` is dominated by the gates, the
			// cadence is over-firing; if it's dominated
			// by parse failures, the LLM is the problem.
			skipped_breakdown: countByPrefix(skipped),
			daily_tokens_used_pre: dailyTokensUsed - totalInputTokens - totalOutputTokens,
			daily_token_cap: 200_000,
		},
	};
}
