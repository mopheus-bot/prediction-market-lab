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
import type { CronEnv, CronResult } from "./dispatcher.js";
import type { LiveBotState, LiveBotConfig } from "../durable-objects/LiveBot.js";

const TTL_MS = 60 * 60 * 1000; // 1h soft TTL
const MIN_CONFIDENCE = 0.0; // 0 = store everything; the strategy filters at runtime

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

async function askLLMForOpinion(
	env: CronEnv,
	ticker: string,
	title: string,
	currentPriceCents: number,
): Promise<{ parsed: LLMParsedOpinion | null; raw: string; ok: boolean; duration_ms: number; input_tokens: number | null; output_tokens: number | null; error_message: string | null }> {
	const prompt = `Market: ${ticker}
Title: ${title}
Current YES price: ${currentPriceCents}¢ (NO = ${100 - currentPriceCents}¢)

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
	if (tickers.length === 0) {
		return {
			ok: true,
			cron_name: "llm_opinions",
			duration_ms: Date.now() - startMs,
			artifacts: { skipped: true, skip_reason: "no bot universe" },
		};
	}

	const errors: Array<{ ticker: string; message: string }> = [];
	const updated: string[] = [];
	const skipped: string[] = [];
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	// For each ticker: read the latest snapshot (gives us
	// title + current bid/ask), ask the LLM, upsert verdict.
	for (const ticker of tickers) {
		try {
			const snap = await liveMarketSnapshotsDb.latestPerTicker(env.DB, userId, { limit: 1 }).then((rows) => rows.find((r) => r.ticker === ticker) ?? null);
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
			const vertical = (snap as unknown as { vertical?: string }).vertical ?? "unknown";
			const llm = await askLLMForOpinion(env, ticker, title, midCents);
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
			await llmOpinionsDb.insert(env.DB, {
				user_id: userId,
				ts: now,
				ticker,
				side: llm.parsed.side,
				confidence: llm.parsed.confidence,
				reasoning: llm.parsed.reasoning,
				current_price_cents: midCents,
				vertical,
				model: DEFAULT_MODEL,
				input_tokens: llm.input_tokens,
				output_tokens: llm.output_tokens,
				duration_ms: llm.duration_ms,
				expires_at: now + TTL_MS,
			});
			updated.push(`${ticker}=${llm.parsed.side}@${llm.parsed.confidence.toFixed(2)}`);
		} catch (e) {
			errors.push({ ticker, message: e instanceof Error ? e.message : String(e) });
		}
	}

	// Record the cron run.
	try {
		await cronRunsDb.insert(env.DB, {
			user_id: userId,
			cron_name: "llm_opinions",
			ts: now,
			duration_ms: Date.now() - startMs,
			status: errors.length === 0 ? "success" : "error",
			error_message: errors.length > 0 ? errors.map((e) => e.ticker).join(",") : null,
			artifacts_json: null,
		});
	} catch (e) {
		console.warn("[llm-opinions] failed to record cron run", e);
	}

	return {
		ok: errors.length === 0,
		cron_name: "llm_opinions",
		duration_ms: Date.now() - startMs,
		artifacts: {
			n_tickers: tickers.length,
			n_updated: updated.length,
			n_skipped: skipped.length,
			n_errors: errors.length,
			updated,
			skipped,
			errors: errors.slice(0, 10),
			total_input_tokens: totalInputTokens,
			total_output_tokens: totalOutputTokens,
		},
	};
}
