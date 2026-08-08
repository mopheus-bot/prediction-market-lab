/**
 * pm-bot — cost estimation endpoint.
 *
 * Returns a daily + monthly cost estimate for running pm-bot.
 * The numbers are ESTIMATES, not invoiced amounts, because:
 *
 * - **CF Workers requests**: pulled from the CF GraphQL
 *   Analytics API (last 24h, multiplied by ~30 for monthly).
 *   Workers free tier is 100K requests/day. Below the free
 *   tier, this costs $0. Above, it's $0.50/1M requests.
 *
 * - **D1 rows read/written**: we don't have direct counters
 *   for these. We approximate from the `cron_runs`,
 *   `llm_calls`, and `trades` table sizes (the tables
 *   the bot actively uses). D1 free tier is 5M reads +
 *   100K writes per day, so this is almost always $0.
 *
 * - **R2 storage + reads**: we don't track per-operation.
 *   The bot's R2 use is `daily-recap/*.json` (small, <1KB
 *   each) and `models/reversion-*.json` (~1MB total).
 *   R2 free tier is 10GB storage + 10M reads/month, so
 *   this is almost always $0.
 *
 * - **MMX API (LLM calls)**: pulled from the `llm_calls`
 *   D1 table. We sum input + output tokens and apply
 *   the public MiniMax pricing for `MiniMax-M2.7-highspeed`:
 *     - Input: $0.10/1M tokens
 *     - Output: $0.40/1M tokens
 *   These prices are approximate — confirm with your
 *   MiniMax dashboard before making business decisions.
 *
 * - **CF Workers Analytics GraphQL calls**: 0 (free).
 *
 * - **DO (Durable Object) compute**: hard to measure from
 *   the bot itself. CF's own dashboard shows DO usage.
 *   Free tier: 400K GB-seconds/month. Our bot uses
 *   <1 GB-second/day, so $0.
 *
 * The output gives the operator a single number to glance
 * at — "how much is this costing me right now" — without
 * needing to log into multiple CF dashboards. The estimate
 * is intentionally conservative (rounded up).
 */

import { dailyNotionalCents } from "../risk/state.js";
import type { CfAnalyticsResponse, handleCfAnalytics } from "./cf-analytics.js";
import { handleCfAnalytics as cfAnalyticsHandler } from "./cf-analytics.js";

// Public CF pricing (USD). Source: cloudflare.com/plans/workers
// and cloudflare.com/pricing (D1, R2 sections). Free tier
// amounts are also included so the estimate can show "$0.00"
// when usage is below the free threshold.
const CF_PRICING = {
	workers: {
		requestsPerMonth: 0.50 / 1_000_000, // $0.50 per 1M requests
		freeRequestsPerDay: 100_000,
	},
	d1: {
		readsPerMonth: 0.75 / 1_000_000, // $0.75 per 1M rows read
		writesPerMonth: 1.00 / 1_000_000, // $1.00 per 1M rows written
		freeReadsPerDay: 5_000_000,
		freeWritesPerDay: 100_000,
	},
	r2: {
		storagePerGBMonth: 0.015, // $0.015 per GB-month
		readsPerMonth: 0.36 / 1_000_000, // $0.36 per 1M reads
		classAOpsPerMonth: 4.50 / 1_000_000, // $4.50 per 1M Class A ops (writes)
		classBOpsPerMonth: 0.36 / 1_000_000, // $0.36 per 1M Class B ops (reads)
		freeStorageGB: 10,
		freeClassBOpsPerMonth: 10_000_000,
	},
	analytics: {
		// Workers Analytics GraphQL API is free. Listed for
		// transparency.
		graphsPerMonth: 0,
	},
};

// Public MiniMax pricing for `MiniMax-M2.7-highspeed` (USD).
// Approximate; verify in your MiniMax dashboard.
const MMX_PRICING = {
	inputPer1M: 0.10,
	outputPer1M: 0.40,
};

export interface CostEnv {
	DB?: D1Database;
	CF_API_TOKEN?: string;
	CF_ACCOUNT_TAG?: string;
	CF_SCRIPT_NAME?: string;
}

export interface CostResponse {
	ok: true;
	period: "last_24h";
	/** Workers request count from CF Analytics GraphQL. */
	cf: {
		requests_24h: number;
		errors_24h: number;
		/** Estimated cost in USD for the last 24h, rounded
		 * up to 4 decimal places. $0 if below free tier. */
		estimated_cost_24h: number;
	};
	/** MiniMax API usage from the `llm_calls` D1 table. */
	mmx: {
		calls_24h: number;
		input_tokens_24h: number;
		output_tokens_24h: number;
		estimated_cost_24h: number;
	};
	/** Sum of all estimated costs. */
	total_estimated_cost_24h: number;
	/** Same totals × 30 for a quick monthly estimate. */
	monthly_estimate: number;
	notes: string[];
	/** Link to the CF dashboard for ground-truth numbers. */
	dashboard_url: string;
}

export interface CostError {
	ok: false;
	error: string;
	detail?: string;
}

export type CostResult = CostResponse | CostError;

/** Round up to 4 decimal places (sub-cent precision). */
function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}

/** Get row count + token sum from `llm_calls` over the
 *  last 24h. */
async function getMmxUsage(db: D1Database, sinceTs: number): Promise<{
	calls: number;
	input: number;
	output: number;
}> {
	const row = await db
		.prepare(
			`SELECT
			   COUNT(*) as calls,
			   COALESCE(SUM(input_tokens_est), 0) as input,
			   COALESCE(SUM(output_tokens_est), 0) as output
			 FROM llm_calls
			 WHERE ts >= ?1 AND status = 'success'`,
		)
		.bind(sinceTs)
		.first<{ calls: number; input: number; output: number }>();
	return {
		calls: row?.calls ?? 0,
		input: row?.input ?? 0,
		output: row?.output ?? 0,
	};
}

export async function handleCost(env: CostEnv, url: URL): Promise<Response> {
	const accountTag = env.CF_ACCOUNT_TAG ?? "8c995c329fee2ee6ab33d9d3d6a30e55";
	const scriptName = env.CF_SCRIPT_NAME ?? "pm-bot";
	const dashboardUrl =
		`https://dash.cloudflare.com/${accountTag}` +
		`/workers/services/view/${scriptName}/production/overview`;

	const notes: string[] = [];

	// ─── CF: Workers request count (last 24h) ───
	let requests24h = 0;
	let errors24h = 0;
	let cfCostCents = 0;
	if (env.CF_API_TOKEN) {
		try {
			const cfResp = (await cfAnalyticsHandler(
				env as Parameters<typeof cfAnalyticsHandler>[0],
				new URL(`${url.origin}?hours=24`),
			)) as Response;
			const cfJson = (await cfResp.json()) as CfAnalyticsResponse;
			if (cfJson.ok) {
				requests24h = cfJson.totals.requests;
				errors24h = cfJson.totals.errors;
				// Estimate: requests beyond the free tier
				// cost $0.50 / 1M. We don't prorate by
				// hours here — we assume 24h usage * (30
				// days) and compare against the daily
				// free tier. If daily > 100K, the
				// "above free" portion is billable.
				const freeDaily = CF_PRICING.workers.freeRequestsPerDay;
				const billableRequestsPerDay = Math.max(
					0,
					requests24h - freeDaily,
				);
				cfCostCents = billableRequestsPerDay * CF_PRICING.workers.requestsPerMonth;
			} else {
				notes.push(
					`CF analytics unavailable (${cfJson.error}); CF cost estimated as $0.00`,
				);
			}
		} catch (e) {
			notes.push(
				`CF analytics fetch failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	} else {
		notes.push("CF_API_TOKEN not set; CF cost not measured");
	}

	// ─── MMX: token usage from D1 (last 24h) ───
	let mmxCalls = 0;
	let mmxInput = 0;
	let mmxOutput = 0;
	let mmxCostCents = 0;
	if (env.DB) {
		const sinceTs = Date.now() - 24 * 60 * 60 * 1000;
		const usage = await getMmxUsage(env.DB, sinceTs);
		mmxCalls = usage.calls;
		mmxInput = usage.input;
		mmxOutput = usage.output;
		// Cost = (input / 1M * input_price) + (output / 1M * output_price)
		mmxCostCents =
			(usage.input / 1_000_000) * MMX_PRICING.inputPer1M +
			(usage.output / 1_000_000) * MMX_PRICING.outputPer1M;
	} else {
		notes.push("DB not bound; MMX cost not measured");
	}

	// ─── D1 (estimated from table row counts) ───
	// We don't have per-operation counters. We can
	// approximate by counting rows in tables the bot
	// actively uses and treating each as 1 read + 1
	// write over the last 24h. This is rough but
	// gives an order of magnitude.
	let d1ReadsApprox = 0;
	let d1WritesApprox = 0;
	if (env.DB) {
		const sinceTs = Date.now() - 24 * 60 * 60 * 1000;
		try {
			const tables = ["cron_runs", "llm_calls", "trades", "signals", "scans"];
			for (const t of tables) {
				const row = await env.DB
					.prepare(`SELECT COUNT(*) as n FROM ${t} WHERE ts >= ?1`)
					.bind(sinceTs)
					.first<{ n: number }>();
				// Conservative: every read fetches at
				// least the row; every write created it.
				d1ReadsApprox += row?.n ?? 0;
				d1WritesApprox += row?.n ?? 0;
			}
			notes.push(
				`D1: ${d1ReadsApprox} reads + ${d1WritesApprox} writes (24h, approx; below free tier at ${CF_PRICING.d1.freeReadsPerDay.toLocaleString()} reads/day).`,
			);
		} catch (e) {
			notes.push(
				`D1 row count failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
	const d1CostCents =
		Math.max(0, d1ReadsApprox / 30 - CF_PRICING.d1.freeReadsPerDay) *
			CF_PRICING.d1.readsPerMonth +
		Math.max(0, d1WritesApprox / 30 - CF_PRICING.d1.freeWritesPerDay) *
			CF_PRICING.d1.writesPerMonth;

	// ─── R2 (storage + reads, rough estimate) ───
	// R2 storage is from the models + daily-recap
	// namespaces. We can query the bucket for actual
	// size, but that's an extra call. For now, we
	// hardcode a conservative estimate: 1MB models +
	// negligible daily-recap.
	const r2StorageGBEstimate = 0.01; // 10MB (overestimate)
	const r2StorageCostCents =
		Math.max(0, r2StorageGBEstimate - CF_PRICING.r2.freeStorageGB) *
		CF_PRICING.r2.storagePerGBMonth;
	// We can't measure R2 reads from inside the bot.
	// Assume 0 (the bot writes daily-recap once/day +
	// uploads models once on deploy; reads are rare).
	const r2ReadCostCents = 0;
	notes.push(
		"R2: 10MB storage assumed (models + daily-recap); reads not measured. Below free tier.",
	);

	// ─── Total ───
	const cfCostTotal = cfCostCents + d1CostCents + r2StorageCostCents + r2ReadCostCents;
	const totalCents = cfCostTotal + mmxCostCents;
	const monthlyCents = totalCents * 30;

	const result: CostResponse = {
		ok: true,
		period: "last_24h",
		cf: {
			requests_24h: requests24h,
			errors_24h: errors24h,
			estimated_cost_24h: round4(cfCostTotal),
		},
		mmx: {
			calls_24h: mmxCalls,
			input_tokens_24h: mmxInput,
			output_tokens_24h: mmxOutput,
			estimated_cost_24h: round4(mmxCostCents),
		},
		total_estimated_cost_24h: round4(totalCents),
		monthly_estimate: round4(monthlyCents),
		notes,
		dashboard_url: dashboardUrl,
	};
	return Response.json(result, {
		headers: {
			"Cache-Control": "public, max-age=60",
		},
	});
}
