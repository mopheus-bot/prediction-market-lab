/**
 * pm-bot — news cron (chunk 6).
 *
 * Runs every 6 hours. For each open position, calls the
 * LLM (mmx) with the position + recent news, and posts the
 * verdict to Telegram (when the bot token is configured).
 *
 * **The LLM is purely advisory** — it never sends orders.
 * If the verdict is BROKEN or AT RISK, we send a Telegram
 * message; INTACT verdicts go to the log only.
 *
 * **Telegram failure mode:** the LLM call + Telegram
 * message are best-effort. A failure in either does NOT
 * fail the cron — we log the failure to `llm_calls` and
 * continue. The cron is "fire and forget" at the cron
 * level; the verdict is informational.
 *
 * **Stub mode:** when `MMX_API_KEY` is not set, the LLM
 * client returns a stub verdict. The cron still logs the
 * call (so the observability is intact) and still posts
 * to Telegram (so you can verify the wiring end-to-end
 * before turning on the real LLM).
 */

import { DEFAULT_USER_ID } from "../lib/types.js";
import { llmCalls as llmCallsDb } from "../lib/db.js";
import { chat } from "../llm/index.js";
import { sendMarkdown, telegramConfigured } from "../telegram/index.js";
import type { CronEnv, CronResult } from "./dispatcher.js";

const NEWS_MODEL = "MiniMax-M3";
const NEWS_PURPOSE = "news-check";
const NEWS_PROMPT_SYSTEM = (
	"You are a quant analyst. Given an open prediction-market " +
	"position and recent news, output a 2-3 sentence verdict: " +
	"INTACT / AT RISK / BROKEN, plus the reason. Then list any " +
	"action the human should consider (do nothing, watch closely, " +
	"exit). Output plain text, no markdown."
);

const NEWS_QUERY_HINTS: Record<string, string> = {
	weather: "weather temperature forecast anomaly",
	economic: "economic data release jobs inflation",
	politics: "election poll candidate",
	sports: "game score injury roster",
};

interface OpenPositionRow {
	ticker: string;
	side: "yes" | "no";
	price_cents: number;
	size: number;
	opened_ts: number;
}

export async function runNewsCron(env: CronEnv): Promise<CronResult> {
	if (!env.DB) {
		return {
			ok: false,
			cron_name: "news",
			duration_ms: 0,
			error_message: "DB binding missing",
		};
	}
	try {
		// Find the open positions: the latest trade per ticker
		// with action='open' and no subsequent close.
		const openRows = await env.DB
			.prepare(
				`SELECT t.ticker, t.side, t.price_cents, t.size, t.ts as opened_ts
				 FROM trades t
				 INNER JOIN (
				   SELECT ticker, MAX(id) as max_id
				   FROM trades
				   WHERE user_id = ?1
				   GROUP BY ticker
				   HAVING SUM(CASE WHEN action = 'close' THEN 1 ELSE 0 END) = 0
				 ) latest ON latest.ticker = t.ticker AND latest.max_id = t.id
				 WHERE t.user_id = ?1 AND t.action = 'open'`,
			)
			.bind(DEFAULT_USER_ID)
			.all<OpenPositionRow>();
		const positions = openRows.results ?? [];

		let nChecked = 0;
		let nTelegramSent = 0;
		for (const p of positions) {
			// Pull the vertical from the most recent trade for
			// this ticker; fall back to "unknown" (the prompt
			// still works without a vertical hint).
			const vertRow = await env.DB
				.prepare(
					`SELECT vertical FROM trades
					 WHERE user_id = ?1 AND ticker = ?2
					 ORDER BY id DESC LIMIT 1`,
				)
				.bind(DEFAULT_USER_ID, p.ticker)
				.first<{ vertical: string }>();
			const vertical = vertRow?.vertical ?? "unknown";
			const hint = NEWS_QUERY_HINTS[vertical] ?? "";
			const query = `${p.ticker} ${hint}`.trim();
			// In chunk 6 we don't have a real news search;
			// pass the query into the LLM context as a "what
			// news to consider" hint. A real news API
			// integration lands in chunk 6+ if the LLM's
			// general knowledge is insufficient.
			const userPrompt =
				`# Position\n` +
				`- Ticker: ${p.ticker}\n` +
				`- Vertical: ${vertical}\n` +
				`- Side: ${p.side}\n` +
				`- Entry: ${p.price_cents}c\n` +
				`- Size: ${p.size} contracts\n` +
				`- Open since: ${new Date(p.opened_ts).toISOString()}\n` +
				`\n# Suggested news search\n${query}\n` +
				`\n# Verdict (INTACT / AT RISK / BROKEN, reason, suggested action):\n`;
			const result = await chat(env, NEWS_PROMPT_SYSTEM, userPrompt, {
				max_tokens: 600,
			});
			// Log the call to llm_calls (always; even on
			// failure) for observability.
			try {
				await llmCallsDb.insert(env.DB, {
					user_id: DEFAULT_USER_ID,
					ts: Date.now(),
					purpose: NEWS_PURPOSE,
					model: NEWS_MODEL,
					ticker: p.ticker,
					input_tokens_est: result.input_tokens ?? 0,
					output_tokens_est: result.output_tokens ?? 0,
					duration_ms: result.duration_ms,
					status: result.ok ? "success" : "error",
					error_message: result.error_message ?? null,
				});
			} catch (e) {
				console.error(`[cron:news] failed to log llm_call for ${p.ticker}`, e);
			}
			nChecked += 1;
			// Telegram: only send on non-INTACT verdicts (or
			// when we have no Telegram config and want to
			// verify the LLM output is being generated at
			// all — we log it).
			const verdict = (result.text ?? "").trim();
			const isAtRisk = /AT RISK|BROKEN/i.test(verdict);
			if (telegramConfigured(env) && (isAtRisk || result.stub)) {
				const msg =
					`*${p.ticker}* (${vertical})\n` +
					`Side: ${p.side} @ ${p.price_cents}c · size ${p.size}\n` +
					`\n${verdict}` +
					`\n\n_Stub: ${result.stub ? "yes" : "no"}_`;
				const tg = await sendMarkdown(env, msg);
				if (tg.ok) nTelegramSent += 1;
				else console.error(`[cron:news] telegram failed for ${p.ticker}`, tg.error_message);
			}
		}

		return {
			ok: true,
			cron_name: "news",
			duration_ms: 0,
			artifacts: {
				n_positions: positions.length,
				n_checked: nChecked,
				n_telegram_sent: nTelegramSent,
				llm_stub: !env.MMX_API_KEY,
				telegram_configured: telegramConfigured(env),
			},
		};
	} catch (e) {
		return {
			ok: false,
			cron_name: "news",
			duration_ms: 0,
			error_message: e instanceof Error ? e.message : String(e),
		};
	}
}
