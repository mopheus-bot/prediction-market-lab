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
const AUTO_PROMOTE_VERTICALS: ReadonlySet<string> = new Set([
	"weather",
	"economic",
	"politics",
	"sports",
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
	// Last-1h bid/ask trend (oldest → newest). Length 0-4 depending
	// on how many research-cron snapshots landed in the last hour.
	// The LLM uses this to see momentum vs mean-revert pressure.
	priceHistory1h: Array<{
		ts_minutes_ago: number;
		yes_bid_cents: number;
		yes_ask_cents: number;
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

	const prompt = `Market: ${ctx.ticker}
Title: ${ctx.title}
Vertical: ${ctx.vertical}
Current YES price: ${ctx.currentYesPriceCents}¢ (NO = ${100 - ctx.currentYesPriceCents}¢)
Current orderbook: bid ${ctx.yesBidCents ?? "?"}¢ / ask ${ctx.yesAskCents ?? "?"}¢ / last trade ${ctx.lastPriceCents ?? "?"}¢
24h volume: ${ctx.volume24h ?? "?"} contracts · open interest: ${ctx.openInterest ?? "?"}${trendBlock}
What's your view? Reply JSON: {"side": "yes" | "no" | "hold", "confidence": 0.0-1.0, "reasoning": "..."}`;

	const result = await chat(env, SYSTEM_PROMPT, prompt, { max_tokens: 500 });
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

export interface LLMOpinionsEnv extends LLMEnv {
	DB?: D1Database;
	LIVE_BOT?: DurableObjectNamespace;
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
	// 2026-08-11 (Phase 3, all-three): bumped 50 → 200. The
	// user is on MiniMax Ultra (cost is bundled) and wants
	// the LLM to evaluate enough of the catalog to actually
	// find edge. At 200/run × */2 = 144K calls/day, the full
	// 2,184-market catalog cycles through in 22 min (vs 1.5
	// days at 50/run). Each LLM call gets a richer prompt
	// (price history + orderbook depth + vertical) — see
	// `askLLMForOpinion` for the new shape.
	const LLM_LOOP_CAP = 200;
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
		// Bot universe first (always), then top LLM_LOOP_CAP - universe
		// by volume/OI. Stable across runs (deterministic ordering).
		const universe = new Set(tickers);
		const universeFirst = allTickers.filter((t) => universe.has(t));
		const others = (rankedRows.results ?? []).map((r) => r.ticker);
		allTickers = [
			...universeFirst,
			...others.filter((t) => !universe.has(t)).slice(0, Math.max(0, LLM_LOOP_CAP - universeFirst.length)),
		];
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

	// For each ticker: read the latest snapshot (gives us
	// title + current bid/ask), ask the LLM, upsert verdict.
	// Filter to the union of (bot universe ∪ live markets) so
	// the LLM gets verdicts on every tradeable market, not
	// just the bot's current tickers.
	const placeholders = allTickers.map((_, i) => `?${i + 2}`).join(",");
	const latestRows = await env.DB
		.prepare(
			`SELECT * FROM (
			  SELECT *, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) AS rn
			  FROM live_market_snapshots
			  WHERE user_id = ?1 AND ticker IN (${placeholders})
			) WHERE rn = 1`,
		)
		.bind(userId, ...allTickers)
		.all<{
			ticker: string;
			event_ticker: string | null;
			title: string | null;
			yes_bid_cents: number;
			yes_ask_cents: number;
			last_price_cents: number | null;
		} & { rn: number }>();
	const snapByTicker = new Map<string, (typeof latestRows.results)[number]>();
	for (const row of latestRows.results ?? []) snapByTicker.set(row.ticker, row);

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

	for (const ticker of allTickers) {
		try {
			const snap = snapByTicker.get(ticker) ?? null;
			if (!snap) {
				skipped.push(`${ticker}: no_snapshot`);
				continue;
			}
			// Compute the mid price the LLM will see.
			// The snapshot has yes_bid and yes_ask; mid = (bid+ask)/2.
			let midCents: number;
			if (snap.yes_bid_cents > 0 && snap.yes_ask_cents > 0 && snap.yes_ask_cents > snap.yes_bid_cents) {
				midCents = Math.round((snap.yes_bid_cents + snap.yes_ask_cents) / 2);
			} else if (snap.last_price_cents && snap.last_price_cents > 0) {
				midCents = snap.last_price_cents;
			} else {
				// No usable price. Skip — the LLM can't evaluate
				// without a price to compare to fair value.
				skipped.push(`${ticker}: no_price`);
				continue;
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
			const llm = await askLLMForOpinion(env, {
				ticker,
				title,
				vertical,
				currentYesPriceCents: midCents,
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
			});
			totalInputTokens += llm.input_tokens ?? 0;
			totalOutputTokens += llm.output_tokens ?? 0;
			// Record the LLM call regardless of parse success.
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
				continue;
			}
			if (llm.parsed.confidence < MIN_CONFIDENCE) {
				skipped.push(`${ticker}: low_confidence`);
				continue;
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
	}

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
		},
	};
}
