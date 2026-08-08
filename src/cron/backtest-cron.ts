/**
 * pm-bot — backtest cron (chunk 11a).
 *
 * Runs on a schedule (Sunday 01:00 UTC, after the train
 * cron at 00:00 UTC). Computes a model retrospective over
 * the last `BACKTEST_WINDOW_DAYS` (default 7) of trades,
 * writes the metrics to the cron_runs.notes field, and
 * registers a "candidate" model in the registry so the
 * operator can see the trend over time.
 *
 * The candidate model is named `backtest-{ts}` and is
 * automatically a "candidate" (not auto-promoted). The
 * operator promotes it manually via POST /api/pm/models/promote
 * if they want the live bot to use the backtest's metrics
 * as the new model_version.
 *
 * **Why a "candidate" model?** the existing chunk-8 train
 * flow uses `candidate` for any newly-registered model and
 * `active` for the one currently in use. Backtest metrics
 * aren't a model — they're a score. We still register
 * them in the same table so the operator has a unified
 * view of "what's running + what's pending promotion" in
 * the dashboard.
 */

import { DEFAULT_USER_ID, type NewCronRun, type NewModel } from "../lib/types.js";
import { cronRuns as cronRunsDb, models as modelsDb } from "../lib/db.js";
import { runBacktest, metricsSummary, type BacktestMetrics } from "../lib/backtest.js";
import type { CronResult } from "./dispatcher.js";

export interface BacktestEnv {
	DB?: D1Database;
	// Window size in days. Default 7.
	BACKTEST_WINDOW_DAYS?: string;
}

const DEFAULT_WINDOW_DAYS = 7;

export async function runBacktestCron(env: BacktestEnv): Promise<CronResult> {
	const startMs = Date.now();
	const windowDays = Number(env.BACKTEST_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
	const userId = DEFAULT_USER_ID;

	let metrics: BacktestMetrics | null = null;
	let status: "success" | "error" = "success";
	let errorMessage: string | null = null;
	const now = Date.now();

	try {
		metrics = await runBacktest(env, now, windowDays);
	} catch (e) {
		status = "error";
		errorMessage = e instanceof Error ? e.message : String(e);
	}

	const durationMs = Date.now() - startMs;
	const summary = metrics ? metricsSummary(metrics) : "no DB / no metrics";

	// Record the cron run.
	if (env.DB) {
		const cronRun: NewCronRun = {
			user_id: userId,
			cron_name: "backtest",
			ts: now,
			duration_ms: durationMs,
			status,
			error_message: errorMessage,
			artifacts_json: metrics ? JSON.stringify(metrics) : null,
		};
		try {
			await cronRunsDb.insert(env.DB, cronRun);
		} catch (e) {
			console.error("[backtest-cron] failed to record cron run", e);
		}

		// Register the metrics as a "candidate" model. The
		// operator promotes it manually if they want.
		if (metrics && metrics.trade_count > 0) {
			const version = `backtest-${now}`;
			const trainMetrics = JSON.stringify({
				trade_count: metrics.trade_count,
				win_rate: metrics.win_rate,
				model_agreement_rate: metrics.model_agreement_rate,
				total_pnl_cents: metrics.total_pnl_cents,
				period_days: windowDays,
			});
			const model: NewModel = {
				user_id: userId,
				version,
				vertical: "all",
				artifact_path: "backtest",
				trained_on_data_until: now,
				train_metrics_json: trainMetrics,
				deployed_at: null,
				retired_at: null,
				status: "candidate",
				notes: summary,
			};
			try {
				await modelsDb.upsert(env.DB, model);
			} catch (e) {
				console.error("[backtest-cron] failed to register candidate model", e);
			}
		}
	}

	console.log(`[backtest-cron] ${summary} (${durationMs}ms)`);
	return {
		ok: status === "success",
		cron_name: "backtest",
		duration_ms: durationMs,
		artifacts: {
			metrics,
			summary,
			window_days: windowDays,
		},
	};
}
