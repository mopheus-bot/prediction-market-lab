/**
 * pm-bot — cron job dispatcher (chunk 5).
 *
 * Maps a Cloudflare scheduled event to a specific job by
 * inspecting `event.cron` (the cron expression that fired).
 * Each job has its own budget; we record every run in the
 * `cron_runs` D1 table for observability.
 *
 * **The 4 jobs** (per the plan):
 *   - `scan`     — every 15 min, runs the universe scan
 *                  (fetch markets, rank by vol, write top N
 *                  to the `scans` table).
 *   - `news`     — every 6 hours, for each open position
 *                  checks news via LLM. Stub in chunk 5;
 *                  full implementation lands in chunk 6.
 *   - `daily`    — once a day at 06:00 UTC, aggregates
 *                  today's trades + PnL, writes a summary
 *                  to R2.
 *   - `train`    — once a week on Sunday 00:00 UTC, kicks
 *                  the Python retrain pipeline. Stub in
 *                  chunk 5; the Python retrain is a separate
 *                  process (CF Workflow or external job in
 *                  chunk 8).
 *
 * **Why a single Worker with one scheduled handler:**
 * CF allows one Worker per "service" — a separate Worker
 * per cron job would mean 4 services to deploy. The
 * scheduled handler dispatches on `event.cron` to keep it
 * in one place.
 *
 * **The cron expressions** are defined in `wrangler.jsonc`
 * `triggers.crons` and the `CRON_TABLE` constant below. The
 * Worker validates the mapping at startup and fails fast
 * if the wrangler config drifts from the dispatcher.
 */

import { DEFAULT_USER_ID, type NewCronRun } from "../lib/types.js";
import { cronRuns as cronRunsDb } from "../lib/db.js";
import { runScanCron } from "./scan-cron.js";
import { runNewsCron } from "./news-cron.js";
import { runDailyCron } from "./daily-cron.js";
import { runTrainCron } from "./train-cron.js";
import type { LLMEnv } from "../llm/index.js";
import type { TelegramEnv } from "../telegram/index.js";

// ─── Cron schedule (must match wrangler.jsonc) ──────────────────────

export const CRON_TABLE = {
	scan: "*/15 * * * *",     // every 15 min
	news: "0 */6 * * *",      // every 6 hours
	daily: "0 6 * * *",       // 06:00 UTC daily
	train: "0 0 * * SUN",     // 00:00 UTC Sunday (day-of-week as name, not 0)
} as const;

export type CronName = keyof typeof CRON_TABLE;

/** Look up the job name for a given cron expression.
 *  Returns null if the expression doesn't match any known job
 *  (CF will fire the scheduled handler with whatever cron
 *  expressions are in `wrangler.jsonc.triggers.crons`; we
 *  ignore anything we don't recognize). */
export function jobForCron(cronExpression: string): CronName | null {
	for (const [name, expr] of Object.entries(CRON_TABLE)) {
		if (expr === cronExpression) return name as CronName;
	}
	return null;
}

// ─── Cron job contract ───────────────────────────────────────────────

/** Per-job env. Subset of the full Env (the cron Worker doesn't
 *  need the DO bindings). Includes LLM + Telegram creds so
 *  the news + daily crons can post verdicts. */
export interface CronEnv extends LLMEnv, TelegramEnv {
	DB?: D1Database;
	BUCKET?: R2Bucket;
	ENVIRONMENT?: string;
	SERVICE_NAME?: string;
	// Optional worker-level overrides for the scan cron.
	SCAN_TOP_N?: string;        // string-encoded int (env vars are strings)
	SCAN_LOOKBACK_HOURS?: string;
	SCAN_MIN_TRADES?: string;
	SCAN_VOL24H_MIN?: string;
	// Optional list of Kalshi series to anchor the scan on
	// (default = full-market scan).
	SCAN_SERIES?: string;       // comma-separated
	// Kalshi creds (used by the scan cron for auth-required calls).
	KALSHI_DEMO_KEY_ID?: string;
	KALSHI_DEMO_PRIVATE_KEY?: string;
	KALSHI_PROD_KEY_ID?: string;
	KALSHI_PROD_PRIVATE_KEY?: string;
}

export interface CronResult {
	ok: boolean;
	cron_name: CronName;
	duration_ms: number;
	error_message?: string;
	artifacts?: Record<string, unknown>;
}

// ─── Run record helper ───────────────────────────────────────────────

/**
 * Record a cron run in the `cron_runs` table. Always called
 * (success + failure) so we can build the "did the daily recap
 * actually run last night?" reports later.
 */
export async function recordRun(
	env: CronEnv,
	run: CronResult,
): Promise<void> {
	if (!env.DB) return;
	const row: NewCronRun = {
		user_id: DEFAULT_USER_ID,
		cron_name: run.cron_name,
		ts: Date.now(),
		duration_ms: run.duration_ms,
		status: run.ok ? "success" : "error",
		error_message: run.error_message ?? null,
		artifacts_json: run.artifacts ? JSON.stringify(run.artifacts) : null,
	};
	try {
		await cronRunsDb.insert(env.DB, row);
	} catch (e) {
		// Last-resort log. If this throws, the cron already
		// failed; double-failing on the log line is noisy but
		// not catastrophic.
		console.error(`[cron] failed to record run`, e);
	}
}

// ─── Per-job dispatch ───────────────────────────────────────────────

export type JobFn = (env: CronEnv) => Promise<CronResult>;

export const JOBS: Record<CronName, JobFn> = {
	scan: runScanCron,
	news: runNewsCron,
	daily: runDailyCron,
	train: runTrainCron,
};

/**
 * Dispatch a scheduled event to its job. Records the run in
 * `cron_runs` and returns a quick status JSON for the
 * CF dashboard log. The full job body runs in `ctx.waitUntil`
 * upstream so the response is fast.
 */
export async function dispatchScheduledEvent(
	cronExpression: string,
	env: CronEnv,
): Promise<CronResult> {
	const name = jobForCron(cronExpression);
	if (!name) {
		console.warn(
			`[cron] no job registered for cron expression: ${cronExpression}`,
		);
		return {
			ok: false,
			cron_name: "scan", // best-effort label; not in CRON_TABLE
			duration_ms: 0,
			error_message: `unknown cron expression: ${cronExpression}`,
		};
	}
	const started = Date.now();
	try {
		const artifacts = await JOBS[name](env);
		const durationMs = Date.now() - started;
		const result: CronResult = {
			ok: true,
			cron_name: name,
			duration_ms: durationMs,
			artifacts: artifacts as unknown as Record<string, unknown>,
		};
		await recordRun(env, result);
		console.log(
			`[cron] ${name} ok in ${durationMs}ms; ` +
				`artifacts=${JSON.stringify(result.artifacts ?? {})}`,
		);
		return result;
	} catch (e) {
		const durationMs = Date.now() - started;
		const result: CronResult = {
			ok: false,
			cron_name: name,
			duration_ms: durationMs,
			error_message: e instanceof Error ? e.message : String(e),
		};
		await recordRun(env, result);
		console.error(`[cron] ${name} failed in ${durationMs}ms: ${result.error_message}`);
		return result;
	}
}
