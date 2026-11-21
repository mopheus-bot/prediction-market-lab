/**
 * prediction-market-lab — manual cron trigger endpoint.
 *
 * The crons run on a CF schedule (every 15min / 6h / daily /
 * weekly). For testing the full pipeline end-to-end without
 * waiting for the next scheduled run, this endpoint lets
 * the operator trigger any cron on demand.
 *
 * Hit with:
 *   curl -X POST api/pm/cron/news/run
 *   curl -X POST api/pm/cron/daily/run
 *   curl -X POST api/pm/cron/scan/run
 *   curl -X POST api/pm/cron/train/run
 *   curl -X POST api/pm/cron/auto_pilot/run
 *   curl -X POST api/pm/cron/backtest/run
 *
 * Routes through the same `dispatchScheduledEvent` that the
 * CF scheduled handler uses, so the run is recorded in the
 * `cron_runs` D1 table and visible in `/api/pm/cron-runs`.
 *
 * **Why this exists:** on 2026-08-09 the LLM was broken
 * (wrong default API host) but went undetected for months
 * because there was no way to test the full LLM →
 * cron → Telegram pipeline without waiting for the next
 * scheduled run. This endpoint + the smoke-test endpoint
 * make the full flow testable in <30 seconds.
 */

import { CRON_TABLE, JOBS, type CronName } from "../cron/dispatcher.js";
import { recordRun, type CronResult, type CronEnv } from "../cron/dispatcher.js";
import { DEFAULT_USER_ID } from "../lib/types.js";

const VALID_NAMES = new Set(Object.keys(CRON_TABLE));

export async function handleCronTrigger(
	env: CronEnv,
	name: string,
): Promise<Response> {
	if (!VALID_NAMES.has(name)) {
		return Response.json(
			{
				ok: false,
				error: "unknown_cron",
				message: `unknown cron: ${name}. valid: ${Array.from(VALID_NAMES).join(", ")}`,
			},
			{ status: 400 },
		);
	}
	const jobName = name as CronName;
	const job = JOBS[jobName];
	if (!job) {
		return Response.json(
			{ ok: false, error: "no_job", message: `no job registered for ${name}` },
			{ status: 500 },
		);
	}
	const started = Date.now();
	let result: CronResult;
	try {
		const inner = await job(env);
		// Respect the inner cron's `ok` field (the
		// dispatcher's same fix). Manual triggers should
		// record status='error' when the cron's own logic
		// failed (LLM parse error, etc.), not bury the
		// failure inside artifacts.
		const innerOk = inner?.ok !== false;
		result = {
			ok: innerOk,
			cron_name: jobName,
			duration_ms: Date.now() - started,
			error_message: innerOk ? undefined: inner?.error_message,
			artifacts: inner?.artifacts,
		};
	} catch (e) {
		result = {
			ok: false,
			cron_name: jobName,
			duration_ms: Date.now() - started,
			error_message: e instanceof Error ? e.message: String(e),
		};
	}
	// Record the run so it shows up in /api/pm/cron-runs
	// alongside the scheduled runs.
	await recordRun(env, result);
	return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}

// Used by the dev page to render a button per cron. Keep
// in sync with CRON_TABLE.
export const TRIGGERABLE_CRONS: Array<{
	name: CronName;
	label: string;
	cronExpression: string;
}> = Object.entries(CRON_TABLE).map(([name, cronExpression]) => ({
	name: name as CronName,
	label: name.replace(/_/g, " "),
	cronExpression,
}));
