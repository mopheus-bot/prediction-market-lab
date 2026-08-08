/**
 * pm-bot — news cron (chunk 5).
 *
 * Runs every 6 hours. Iterates the open positions and
 * checks recent news for each via LLM. The actual LLM
 * call (via `mmx` CLI / direct API) is STUBBED in chunk 5
 * — full implementation lands in chunk 6 (status API +
 * Telegram). For now we log a "news-checked" entry per
 * position so the `llm_calls` table accumulates history
 * (useful for tracking the cron even before the LLM is
 * wired up).
 *
 * **Why a stub and not a full implementation:** the LLM
 * call needs an `mmx` CLI or direct Anthropic API
 * integration, both of which land in chunk 6 alongside
 * the Telegram bridge. Adding a half-baked LLM call here
 * would just be re-doing chunk 6 with a different name.
 *
 * **What ships in chunk 5:**
 *   - The cron runs on schedule (6-hourly).
 *   - It finds open positions in D1 (trades with
 *     `action='open'` and no matching `close`).
 *   - For each, it logs a `llm_calls` row with
 *     `status='success'` and `error_message=null`
 *     (representing "checked, no LLM call yet").
 *   - Returns the count.
 *
 * **chunk 6 will replace the stub** with a real
 * `analyze_position(ticker, side, age_hours, ...)` call
 * to the LLM and a Telegram message on `recommendation != 'hold'`.
 */

import { trades as tradesDb } from "../lib/db.js";
import { llmCalls as llmCallsDb } from "../lib/db.js";
import { DEFAULT_USER_ID } from "../lib/types.js";
import type { CronEnv, CronResult } from "./dispatcher.js";

const NEWS_MODEL = "MiniMax-M2.7-highspeed"; // per the plan's decision
const NEWS_PURPOSE = "news-check";

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
		// with action='open' and no subsequent close. The
		// `trades` DB helper has `list` but not "open-only";
		// we use a small inline query here.
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
			.all<{
				ticker: string;
				side: "yes" | "no";
				price_cents: number;
				size: number;
				opened_ts: number;
			}>();

		const positions = openRows.results ?? [];
		let nChecked = 0;
		for (const p of positions) {
			// STUB: log a "news-checked" row. The full LLM call
			// + Telegram bridge lands in chunk 6. For now we
			// record the cron visited this ticker.
			try {
				await llmCallsDb.insert(env.DB, {
					user_id: DEFAULT_USER_ID,
					ts: Date.now(),
					purpose: NEWS_PURPOSE,
					model: NEWS_MODEL,
					ticker: p.ticker,
					input_tokens_est: 0,
					output_tokens_est: 0,
					duration_ms: 0,
					status: "success",
					error_message: null,
				});
				nChecked += 1;
			} catch (e) {
				// Log the row failure but don't fail the whole cron.
				console.error(
					`[cron:news] failed to log llm_call for ${p.ticker}`,
					e,
				);
			}
		}

		return {
			ok: true,
			cron_name: "news",
			duration_ms: 0,
			artifacts: {
				n_positions: positions.length,
				n_checked: nChecked,
				note: "stub; full LLM call lands in chunk 6",
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
