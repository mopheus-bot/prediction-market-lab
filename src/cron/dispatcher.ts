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
import { runBacktestCron } from "./backtest-cron.js";
import { runAutoPilotCron } from "./auto-pilot-cron.js";
import { runHeartbeatCron } from "./heartbeat-cron.js";
import { runLeadsCron } from "./leads-cron.js";
import { runResearchCron } from "./research-cron.js";
import { runLLMOpinionsCron } from "./llm-opinions-cron.js";
import type { LLMEnv } from "../llm/index.js";
import type { TelegramEnv } from "../telegram/index.js";

// ─── Cron schedule (must match wrangler.jsonc) ──────────────────────

export const CRON_TABLE = {
	scan: "*/15 * * * *",     // every 15 min (0,15,30,45)
	research: "5,20,35,50 * * * *", // every 15 min, offset 5 min from scan (5,20,35,50). 2026-08-10: chunk 14.1, polls Kalshi live markets. Unique expression so jobForCron dispatch works.
	news: "0 */6 * * *",      // every 6 hours (00/06/12/18 UTC)
	daily: "0 6 * * *",       // 06:00 UTC daily
	auto_pilot: "30 5 * * *", // 05:30 UTC daily (before daily recap)
	heartbeat: "0 7 * * *",   // 07:00 UTC daily (after daily recap; passive health check)
	leads: "30 */6 * * *",    // every 6 hours +30min (00:30/06:30/12:30/18:30 UTC). 2026-08-09: tightened from daily 02:00 UTC to 6h. Offset by 30min from news so the LLM has fresh news data; unique expression so jobForCron can dispatch correctly.
	llm_opinions: "*/2 * * * *", // every 2 min. 2026-08-10 21:00: tightened from 30 min to 2 min so the bot sees new market data within a couple polls of it appearing. 2026-08-11: aligned CRON_TABLE with wrangler.jsonc (which has been on */2 since commit 56c3c79); the previous `15,45` here caused jobForCron to label most `*/2` fires as the unknown-cron fallback ("scan"), so the LLM loop only ran at HH:15/HH:45.
	train: "0 0 * * SUN",     // 00:00 UTC Sunday (day-of-week as name, not 0)
	backtest: "0 1 * * SUN",  // 01:00 UTC Sunday (after train)
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
	// 2026-08-08: scan caching knobs. The full scan does
	// ~2,500 Kalshi calls; with the 15-min cron interval,
	// scans were overlapping and getting 429'd. Cache
	// results for this many seconds; skip entirely if a
	// 429 was hit within the backoff window.
	SCAN_CACHE_TTL_SEC?: string;
	SCAN_429_BACKOFF_SEC?: string;
	// Optional list of Kalshi series to anchor the scan on
	// (default = full-market scan).
	SCAN_SERIES?: string;       // comma-separated
	// Kalshi creds (used by the scan cron for auth-required calls).
	KALSHI_DEMO_KEY_ID?: string;
	KALSHI_DEMO_PRIVATE_KEY?: string;
	KALSHI_PROD_KEY_ID?: string;
	KALSHI_PROD_PRIVATE_KEY?: string;
	// LiveBot DO binding. Used by the research cron to
	// read the bot's current ticker universe and snapshot
	// those tickers even if they don't pass the
	// `looksActive` filter (e.g. KXWARMING-50 — the LIST
	// endpoint sometimes shows it as 0/0/0/0 even though
	// the bot is actively polling it).
	LIVE_BOT?: DurableObjectNamespace;
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
	research: runResearchCron,
	news: runNewsCron,
	daily: runDailyCron,
	auto_pilot: runAutoPilotCron,
	heartbeat: runHeartbeatCron,
	leads: runLeadsCron,
	llm_opinions: runLLMOpinionsCron,
	train: runTrainCron,
	backtest: runBacktestCron,
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
		const inner = await JOBS[name](env);
		const durationMs = Date.now() - started;
		// Respect the inner cron's `ok` field. If the cron
		// ran to completion but its own logic reported
		// failure (e.g. leads-cron LLM parse error, or
		// heartbeat with a failed check), we record
		// status='error' with the cron's error_message so
		// the cadence panel surfaces it correctly. The
		// dispatcher's outer ok reflects "did the cron
		// run to completion without throwing" — distinct
		// from "did the cron's business logic succeed."
		const innerOk = inner?.ok !== false;
		const result: CronResult = {
			ok: innerOk,
			cron_name: name,
			duration_ms: durationMs,
			error_message: innerOk ? undefined : inner?.error_message,
			artifacts: inner?.artifacts,
		};
		await recordRun(env, result);
		console.log(
			`[cron] ${name} ${innerOk ? "ok" : "err"} in ${durationMs}ms; ` +
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
