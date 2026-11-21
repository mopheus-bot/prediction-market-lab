/**
 * prediction-market-lab — daily recap cron.
 *
 * Runs once a day at 06:00 UTC. Aggregates the last 24h
 * of trades, signals, and PnL; writes a summary JSON to
 * R2 at `daily-recap/YYYY-MM-DD.json`; logs the run in
 * `cron_runs`.
 *
 * **What it computes:**
 *   - n_trades, n_signals, n_frames (per the live bot's
 *     counters — these come from the bot DO via a small
 *     `GET /api/pm/bot/status` call; if the bot isn't
 *     running, we just write 0s).
 *   - realized_pnl_cents (sum of close-trade pnl_cents
 *     in the last 24h).
 *   - n_open_positions (current count of open positions).
 *   - per-vertical breakdown: n_trades, realized_pnl_cents
 *     per vertical.
 *
 * **Output:** a JSON file in R2. The dashboard reads it
 * in  to render the daily recap card.
 *
 * **Why R2 and not D1:** the daily recap is a one-shot
 * per-day artifact, not queryable data. Storing in R2
 * keeps the D1 row count small (the `cron_runs` table
 * already records the run metadata; the recap body
 * doesn't need to be queryable).
 */

import { DEFAULT_USER_ID } from "../lib/types.js";
import { chat } from "../llm/index.js";
import { sendMarkdown, telegramConfigured } from "../telegram/index.js";
import type { CronEnv, CronResult } from "./dispatcher.js";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_HOURS_DEFAULT = 24;

function isoDate(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

export async function runDailyCron(env: CronEnv): Promise<CronResult> {
	if (!env.DB) {
		return {
			ok: false,
			cron_name: "daily",
			duration_ms: 0,
			error_message: "DB binding missing",
		};
	}
	try {
		const now = Date.now();
		const since = now - TWENTY_FOUR_HOURS_MS;

		// 1. Aggregate trades in the window.
		const tradesAgg = await env.DB
			.prepare(
				`SELECT
				   COUNT(*) as n_trades,
				   COALESCE(SUM(CASE WHEN action = 'open' THEN 1 ELSE 0 END), 0) as n_opens,
				   COALESCE(SUM(CASE WHEN action = 'close' THEN 1 ELSE 0 END), 0) as n_closes,
				   COALESCE(SUM(CASE WHEN action = 'close' AND pnl_cents IS NOT NULL
				                     THEN pnl_cents ELSE 0 END), 0) as realized_pnl_cents
				 FROM trades
				 WHERE user_id = ?1 AND ts >= ?2`,
			)
			.bind(DEFAULT_USER_ID, since)
			.first<{
				n_trades: number;
				n_opens: number;
				n_closes: number;
				realized_pnl_cents: number;
			}>();

		// 2. Per-vertical breakdown.
		const perVert = await env.DB
			.prepare(
				`SELECT
				   vertical,
				   COUNT(*) as n_trades,
				   COALESCE(SUM(CASE WHEN action = 'close' AND pnl_cents IS NOT NULL
				                     THEN pnl_cents ELSE 0 END), 0) as pnl_cents
				 FROM trades
				 WHERE user_id = ?1 AND ts >= ?2
				 GROUP BY vertical`,
			)
			.bind(DEFAULT_USER_ID, since)
			.all<{ vertical: string; n_trades: number; pnl_cents: number }>();
		const verticals: Record<string, { n_trades: number; pnl_cents: number }> = {};
		for (const row of perVert.results ?? []) {
			verticals[row.vertical] = {
				n_trades: row.n_trades,
				pnl_cents: row.pnl_cents,
			};
		}

		// 3. Signal counts in the window.
		const signalsAgg = await env.DB
			.prepare(
				`SELECT
				   COUNT(*) as n_signals,
				   COALESCE(SUM(was_filled), 0) as n_filled
				 FROM signals
				 WHERE user_id = ?1 AND ts >= ?2`,
			)
			.bind(DEFAULT_USER_ID, since)
			.first<{ n_signals: number; n_filled: number }>();

		// 4. Current open positions (for the "open at midnight" line).
		const openAgg = await env.DB
			.prepare(
				`SELECT COUNT(DISTINCT ticker) as n_open_positions
				 FROM trades t
				 WHERE user_id = ?1 AND t.action = 'open'
				   AND NOT EXISTS (
				     SELECT 1 FROM trades c
				     WHERE c.user_id = t.user_id
				       AND c.ticker = t.ticker
				       AND c.action = 'close'
				       AND c.id > t.id
				)`,
			)
			.bind(DEFAULT_USER_ID)
			.first<{ n_open_positions: number }>();

		const recap = {
			date: isoDate(now),
			lookback_hours: LOOKBACK_HOURS_DEFAULT,
			generated_at: new Date(now).toISOString(),
			user_id: DEFAULT_USER_ID,
			trades: {
				n_total: tradesAgg?.n_trades ?? 0,
				n_opens: tradesAgg?.n_opens ?? 0,
				n_closes: tradesAgg?.n_closes ?? 0,
				realized_pnl_cents: tradesAgg?.realized_pnl_cents ?? 0,
			},
			signals: {
				n_total: signalsAgg?.n_signals ?? 0,
				n_filled: signalsAgg?.n_filled ?? 0,
			},
			open_positions: openAgg?.n_open_positions ?? 0,
			verticals,
		};

		// 5. Write to R2 if bound.
		if (env.BUCKET) {
			const key = `daily-recap/${recap.date}.json`;
			await env.BUCKET.put(key, JSON.stringify(recap, null, 2), {
				httpMetadata: { contentType: "application/json" },
			});
		}

		// 6. Optional: LLM-generated markdown recap + Telegram
		//    summary. The LLM is purely advisory; failures
		//    here don't fail the cron (the R2 JSON is the
		//    canonical record).
		let nTelegramSent = 0;
		if (telegramConfigured(env) || env.MMX_API_KEY) {
			const sysPrompt = (
				"You are a quant analyst. Given a daily paper-trading " +
				"summary, output a one-paragraph markdown recap with " +
				"PnL, top vertical, and any concerns. Keep it under " +
				"200 words. Use **bold** for key numbers."
			);
			const userPrompt = JSON.stringify(recap, null, 2);
			const llmResult = await chat(env, sysPrompt, userPrompt, {
				max_tokens: 1000,
			});
			if (llmResult.ok && telegramConfigured(env)) {
				const tg = await sendMarkdown(
					env,
					`*Daily recap — ${recap.date}*\n\n${llmResult.text}`,
				);
				if (tg.ok) nTelegramSent += 1;
				else console.error(`[cron:daily] telegram failed`, tg.error_message);
			}
		}

		return {
			ok: true,
			cron_name: "daily",
			duration_ms: 0,
			artifacts: {
				date: recap.date,
				n_trades: recap.trades.n_total,
				realized_pnl_cents: recap.trades.realized_pnl_cents,
				n_open_positions: recap.open_positions,
				r2_key: env.BUCKET ? `daily-recap/${recap.date}.json`: null,
				n_telegram_sent: nTelegramSent,
			},
		};
	} catch (e) {
		return {
			ok: false,
			cron_name: "daily",
			duration_ms: 0,
			error_message: e instanceof Error ? e.message: String(e),
		};
	}
}
