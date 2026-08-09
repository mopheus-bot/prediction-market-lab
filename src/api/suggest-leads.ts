/**
 * pm-bot — LLM-powered lead generation endpoint (chunk 11+).
 *
 * Asks the LLM to suggest new Kalshi tickers the bot should
 * add to its universe, given the current state. The LLM picks
 * the tickers (this is the user's design intent — "the leads
 * are supposed to be LLM generated"), we validate the format
 * (real Kalshi ticker = KX followed by uppercase/digits/hyphens)
 * and the operator can review before applying.
 *
 * Hit with:
 *   curl -X POST api/pm/bot/suggest-leads
 *   curl -X POST api/pm/bot/suggest-leads -H "content-type: application/json" -d '{"count": 6}'
 *
 * Returns:
 *   { ok, tickers: ["KXWARMING-60", ...], reasoning: "...",
 *     excluded: [{ticker, reason}, ...],
 *     raw_text: "..." }
 *
 * **Why this exists:** the user wants the LLM to pick the
 * leads, not the operator. Hardcoding a list of tickers in
 * wrangler.jsonc is brittle (markets expire, new ones launch,
 * what worked last quarter doesn't work this quarter). The
 * LLM is the right tool for this — it knows the bot's
 * verticals + strategies, knows the Kalshi market landscape
 * (from training), and can reason about which markets fit
 * the bot's profile.
 *
 * **Operator workflow:**
 *   1. Hit this endpoint to get LLM-suggested tickers.
 *   2. Review the suggestions (the operator is the final
 *      approver — the LLM can hallucinate tickers).
 *   3. POST /api/pm/bot/start with the new tickers list to
 *      apply (this restarts the bot).
 *
 * **What's filtered out:**
 *   - Tickers already in the bot's current universe
 *   - Tickers that don't match the KX[A-Z0-9-]+ pattern
 *   - Duplicate suggestions
 *   - Suggestions the operator explicitly excluded
 *     (via the optional "exclude" body param)
 */

import { chat, type LLMEnv } from "../llm/index.js";

export interface SuggestLeadsEnv extends LLMEnv {
	// Read-only access to bot state. We don't pass the
	// full env — just what the prompt needs.
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
}

// We need the bot's current state to build the prompt.
// The endpoint accepts these via the body (default: empty).
// The Dev page calls /api/pm/bot/status first and passes
// the result in.
export interface SuggestLeadsBody {
	count?: number;
	exclude?: string[];
	current_tickers?: string[];
	bankroll_cents?: number;
	max_notional_cents_per_trade?: number;
	daily_notional_cents_cap?: number;
	verticals?: Array<{
		id: string;
		strategy: string;
		strategy_label?: string;
		model_version?: string;
	}>;
	trading_mode?: string;
}

const DEFAULT_COUNT = 4;

// Kalshi ticker format: KX followed by 2-12 uppercase
// letters / digits / hyphens. Matches the live KXWARMING-50,
// KXGDP-Q3, KXPRES-26 shape.
const KALSHI_TICKER_RE = /^KX[A-Z0-9][A-Z0-9-]{1,14}$/;

const SYSTEM_PROMPT = `You are advising a Kalshi trading bot. You suggest new markets (tickers) the bot should add to its watch list. You output STRICT JSON only — no prose, no markdown fences, no commentary. Your suggestions must be real Kalshi tickers in the format KX followed by 2-12 uppercase letters, digits, or hyphens (e.g. KXWARMING-50, KXGDP-Q3, KXPRES-26). Do not invent tickers — if you are not sure a ticker exists, do not include it. Prefer markets from the bot's configured verticals. Match the market to the strategy: reversion strategies need liquid markets with mean-reverting price history; naive strategies (>=0.99 or <=0.01) need high-confidence near-certainty events.`;

function buildUserPrompt(body: SuggestLeadsBody): string {
	const verticals = body.verticals ?? [];
	const lines: string[] = [];
	lines.push("Bot state:");
	lines.push(`- Trading mode: ${body.trading_mode ?? "paper"}`);
	lines.push(`- Bankroll: $${(body.bankroll_cents ?? 0) / 100}`);
	lines.push(`- Max notional / trade: $${(body.max_notional_cents_per_trade ?? 0) / 100}`);
	lines.push(`- Daily notional cap: $${(body.daily_notional_cents_cap ?? 0) / 100}`);
	lines.push(`- Current tickers: ${(body.current_tickers ?? []).join(", ") || "(none)"}`);
	lines.push("");
	lines.push("Verticals + strategies:");
	if (verticals.length === 0) {
		lines.push("- (no verticals configured)");
	} else {
		for (const v of verticals) {
			lines.push(`- ${v.id}: strategy=${v.strategy}${v.strategy_label ? ` (${v.strategy_label})` : ""}, model=${v.model_version ?? "v1"}`);
		}
	}
	lines.push("");
	lines.push(`Suggest ${body.count ?? DEFAULT_COUNT} new Kalshi tickers the bot should add to its universe.`);
	if (body.exclude && body.exclude.length > 0) {
		lines.push(`Exclude these (already considered or operator-rejected): ${body.exclude.join(", ")}`);
	}
	lines.push("");
	lines.push("Return JSON with this exact shape:");
	lines.push(`{"tickers": ["KXWARMING-60", "KXGDP-Q3", ...], "reasoning": "2-3 sentences on why these markets fit the bot's profile."}`);
	return lines.join("\n");
}

function parseTickerList(rawText: string, requestedCount: number): { tickers: string[]; reasoning: string } {
	// M3 wraps output in <think>...</think> (we strip that in
	// the chat() client). The remaining text should be JSON.
	// Be defensive: find the first { and the matching }.
	const jStart = rawText.indexOf("{");
	const jEnd = rawText.lastIndexOf("}");
	if (jStart === -1 || jEnd === -1 || jEnd < jStart) {
		return { tickers: [], reasoning: "(llm returned no JSON object)" };
	}
	try {
		const obj = JSON.parse(rawText.slice(jStart, jEnd + 1)) as { tickers?: unknown; reasoning?: unknown };
		const tickers = Array.isArray(obj.tickers)
			? obj.tickers.filter((t): t is string => typeof t === "string").slice(0, requestedCount)
			: [];
		const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";
		return { tickers, reasoning };
	} catch {
		return { tickers: [], reasoning: "(llm returned malformed JSON)" };
	}
}

export async function handleSuggestLeads(
	env: SuggestLeadsEnv,
	request: Request,
): Promise<Response> {
	// Read the body. The Dev page sends a JSON body with the
	// current bot state; a bare curl POST can omit it and we
	// fall back to defaults.
	let body: SuggestLeadsBody = {};
	try {
		const text = await request.text();
		if (text) body = JSON.parse(text) as SuggestLeadsBody;
	} catch {
		// ignore — use defaults
	}

	// Auto-fill sensible defaults so a bare curl POST still
	// produces a useful prompt. The Dev page passes the
	// current bot state in the body; the API falls back to
	// the configured verticals if no body is given.
	if (!body.verticals) {
		body.verticals = [
			{ id: "weather", strategy: "reversion", strategy_label: "Reversion v1", model_version: "v1" },
			{ id: "economic", strategy: "reversion", strategy_label: "Reversion v1", model_version: "v1" },
			{ id: "politics", strategy: "naive", strategy_label: "Naive baseline", model_version: "v0-naive" },
			{ id: "sports", strategy: "naive", strategy_label: "Naive baseline", model_version: "v0-naive" },
		];
	}

	const count = body.count ?? DEFAULT_COUNT;

	// 1. Build the prompt.
	const userPrompt = buildUserPrompt({ ...body, count });

	// 2. Ask the LLM.
	const result = await chat(env, SYSTEM_PROMPT, userPrompt, { max_tokens: 600 });

	if (!result.ok) {
		return Response.json(
			{
				ok: false,
				error: "llm_call_failed",
				detail: result.error_message ?? "unknown",
				stub: result.stub,
			},
			{ status: 500 },
		);
	}

	// 3. Parse the LLM's response.
	const parsed = parseTickerList(result.text, count);

	// 4. Validate format + dedupe + filter against excludes.
	const exclude = new Set([...(body.exclude ?? []), ...(body.current_tickers ?? [])]);
	const seen = new Set<string>();
	const accepted: string[] = [];
	const rejected: Array<{ ticker: string; reason: string }> = [];
	for (const raw of parsed.tickers) {
		const t = raw.trim().toUpperCase();
		if (seen.has(t)) {
			rejected.push({ ticker: t, reason: "duplicate" });
			continue;
		}
		seen.add(t);
		if (!KALSHI_TICKER_RE.test(t)) {
			rejected.push({ ticker: t, reason: "not a valid KX ticker (format)" });
			continue;
		}
		if (exclude.has(t)) {
			rejected.push({ ticker: t, reason: "already in current universe or excluded" });
			continue;
		}
		accepted.push(t);
	}

	return Response.json(
		{
			ok: true,
			tickers: accepted,
			reasoning: parsed.reasoning,
			excluded: rejected,
			raw_text: result.text,
			model: "MiniMax-M3",
			input_tokens: result.input_tokens,
			output_tokens: result.output_tokens,
			duration_ms: result.duration_ms,
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
