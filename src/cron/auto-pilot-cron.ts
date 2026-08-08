/**
 * pm-bot — auto-pilot cron (chunk 11b).
 *
 * Runs daily (05:30 UTC, before the daily recap). If
 * AUTO_PILOT_ENABLED is true and the bot is in paper mode,
 * checks whether the edge has been demonstrated. If yes,
 * flips trading_mode from "paper" to "real" and sends a
 * Telegram notification.
 *
 * **The rule (chunk 11b default):**
 *   - At least 7 days of paper trading
 *   - At least 30 closed trades
 *   - Annualized Sharpe > 0.5
 *
 * Override via env:
 *   - AUTO_PILOT_ENABLED: "true" to enable (default "false")
 *   - AUTO_PILOT_MIN_DAYS (default 7)
 *   - AUTO_PILOT_MIN_TRADES (default 30)
 *   - AUTO_PILOT_MIN_SHARPE (default 0.5)
 *
 * **Why a separate cron (not the daily recap):** the daily
 * recap writes the R2 summary. The auto-pilot check is a
 * different concern — it can flip the bot's mode, which is
 * a state change worth its own cron record. 05:30 UTC gives
 * 30 minutes of headroom before the daily recap.
 *
 * **What the cron does:**
 *   1. Read the bot's /status (via the DO).
 *   2. If trading_mode != "paper": no-op (already in real or off).
 *   3. If AUTO_PILOT_ENABLED != "true": no-op.
 *   4. Pull closed trades from the last N days.
 *   5. Compute the Sharpe ratio.
 *   6. If passes_auto_pilot: POST /trading-mode to flip to real.
 *   7. Send a Telegram message either way (auto-pilot on/off
 *      state, current Sharpe, decision).
 *
 * **Why POST /trading-mode instead of direct state mutation:**
 * the existing endpoint validates the mode string, records
 * the change, and surfaces it in the dashboard. Direct
 * mutation would skip the validation + observability.
 */

import type { CronResult } from "./dispatcher.js";
import type { TelegramEnv } from "../telegram/index.js";
import { sendMessage as sendTelegramMessage } from "../telegram/index.js";
import { DEFAULT_USER_ID, type NewCronRun } from "../lib/types.js";
import { cronRuns as cronRunsDb, trades as tradesDb } from "../lib/db.js";
import { computeSharpe } from "../lib/sharpe.js";

export interface AutoPilotEnv extends TelegramEnv {
	DB?: D1Database;
	LIVE_BOT?: DurableObjectNamespace;
	/** "true" to enable auto-pilot. Default "false". */
	AUTO_PILOT_ENABLED?: string;
	AUTO_PILOT_MIN_DAYS?: string;
	AUTO_PILOT_MIN_TRADES?: string;
	AUTO_PILOT_MIN_SHARPE?: string;
	/** Trading days per year. Default 252. */
	AUTO_PILOT_ANNUALIZATION_DAYS?: string;
}

const DEFAULT_LOOKBACK_DAYS = 30;

export async function runAutoPilotCron(env: AutoPilotEnv): Promise<CronResult> {
	const startMs = Date.now();
	const userId = DEFAULT_USER_ID;
	const now = Date.now();

	// 1. Read the bot's mode via the DO.
	let currentMode: "paper" | "real" | "off" = "paper";
	if (env.LIVE_BOT) {
		try {
			const id = env.LIVE_BOT.idFromName(`user:${userId}`);
			const stub = env.LIVE_BOT.get(id);
			const resp = await stub.fetch("https://bot.local/status");
			if (resp.ok) {
				const data = (await resp.json()) as {
					config?: { trading_mode?: "paper" | "real" | "off" };
				};
				currentMode = data.config?.trading_mode ?? "paper";
			}
		} catch (e) {
			console.warn("[auto-pilot] failed to read bot status", e);
		}
	}

	// 2. Skip if not paper.
	if (currentMode !== "paper") {
		return {
			ok: true,
			cron_name: "auto_pilot",
			duration_ms: Date.now() - startMs,
			artifacts: {
				skipped: true,
				reason: `trading_mode is ${currentMode} (not paper)`,
			},
		};
	}

	// 3. Skip if not enabled.
	if ((env.AUTO_PILOT_ENABLED ?? "false").toLowerCase() !== "true") {
		return {
			ok: true,
			cron_name: "auto_pilot",
			duration_ms: Date.now() - startMs,
			artifacts: {
				skipped: true,
				reason: "AUTO_PILOT_ENABLED is not 'true' (default off; opt in)",
			},
		};
	}

	// 4. Pull closed trades from the last N days.
	const lookbackDays = DEFAULT_LOOKBACK_DAYS;
	const sinceTs = now - lookbackDays * 24 * 60 * 60 * 1000;
	const trades = env.DB
		? await tradesDb
				.list(env.DB, userId, { limit: 1000, since_ts: sinceTs })
				.catch(() => [])
		: [];

	// 5. Compute the Sharpe.
	const minDays = Number(env.AUTO_PILOT_MIN_DAYS ?? "7");
	const minTrades = Number(env.AUTO_PILOT_MIN_TRADES ?? "30");
	const minSharpe = Number(env.AUTO_PILOT_MIN_SHARPE ?? "0.5");
	const annualizationDays = Number(env.AUTO_PILOT_ANNUALIZATION_DAYS ?? "252");
	const sharpe = computeSharpe(trades, {
		nowMs: now,
		minDays,
		minTrades,
		minSharpe,
		annualizationDays,
	});

	// 6. Flip if it passes.
	let flipped = false;
	if (sharpe.passes_auto_pilot && env.LIVE_BOT) {
		try {
			const id = env.LIVE_BOT.idFromName(`user:${userId}`);
			const stub = env.LIVE_BOT.get(id);
			const resp = await stub.fetch("https://bot.local/trading-mode", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ trading_mode: "real" }),
			});
			flipped = resp.ok;
		} catch (e) {
			console.error("[auto-pilot] failed to flip to real", e);
		}
	}

	// 7. Telegram on every run (whether flipped or not).
	if (env.TELEGRAM_BOT_TOKEN) {
		const lines = [
			flipped
				? "🟢 AUTO-PILOT: flipped paper → real"
				: sharpe.passes_auto_pilot
					? "🟡 AUTO-PILOT: passed but flip failed (check logs)"
					: "⏸️ AUTO-PILOT: not yet",
			`trades=${sharpe.trade_count} days=${sharpe.days_elapsed} sharpe=${Number.isNaN(sharpe.sharpe_annualized) ? "n/a" : sharpe.sharpe_annualized.toFixed(2)} pnl=${sharpe.total_pnl_cents}¢ ($${(sharpe.total_pnl_cents / 100).toFixed(2)})`,
			`thresholds: minDays=${minDays} minTrades=${minTrades} minSharpe=${minSharpe}`,
		];
		await sendTelegramMessage(env, lines.join("\n")).catch(() => undefined);
	}

	// Record the cron run.
	if (env.DB) {
		const cronRun: NewCronRun = {
			user_id: userId,
			cron_name: "auto_pilot",
			ts: now,
			duration_ms: Date.now() - startMs,
			status: "success",
			error_message: null,
			artifacts_json: JSON.stringify({ sharpe, flipped, currentMode }),
		};
		try {
			await cronRunsDb.insert(env.DB, cronRun);
		} catch (e) {
			console.error("[auto-pilot] failed to record cron run", e);
		}
	}

	return {
		ok: true,
		cron_name: "auto_pilot",
		duration_ms: Date.now() - startMs,
		artifacts: { sharpe, flipped, currentMode },
	};
}
