/**
 * pm-bot — cost estimation endpoint (chunk 9.7 + 10.5).
 *
 * Returns:
 *   - **cf** (24h): Workers request count + estimated cost.
 *   - **mmx** (24h): MMX token usage + estimated cost.
 *   - **d1 / r2** (24h, approx): row counts + storage estimate.
 *   - **cf_monthly** (chunk 10.5): usage vs the Workers Paid
 *     plan's monthly included amounts, with a "resets on"
 *     date and progress bars.
 *   - **fly_relay** (chunk 10.5): machine state + hours +
 *     estimated cost, minus the user's free credit.
 *
 * Numbers are ESTIMATES, not invoiced amounts. See the
 * notes field for caveats. Source: cloudflare.com/plans +
 * fly.io/docs/machines/ + the public MMX pricing.
 */

import type { CfAnalyticsResponse } from "./cf-analytics.js";
import { handleCfAnalytics as cfAnalyticsHandler } from "./cf-analytics.js";

// Public CF pricing (USD). Source: cloudflare.com/plans/workers
// and cloudflare.com/pricing (D1, R2 sections).
const CF_PRICING = {
	workers: {
		requestsPerMonth: 0.50 / 1_000_000,
		cpuMsPerMonth: 0.02 / 1_000_000,
		freeRequestsPerDay: 100_000,
		// Workers Paid plan monthly includes:
		includedRequests: 10_000_000,
		includedCpuMs: 30_000_000,
	},
	d1: {
		readsPerMonth: 0.75 / 1_000_000,
		writesPerMonth: 1.00 / 1_000_000,
		freeReadsPerDay: 5_000_000,
		freeWritesPerDay: 100_000,
		includedStorageGB: 5,
	},
	r2: {
		storagePerGBMonth: 0.015,
		readsPerMonth: 0.36 / 1_000_000,
		classAOpsPerMonth: 4.50 / 1_000_000,
		classBOpsPerMonth: 0.36 / 1_000_000,
		freeStorageGB: 10,
		includedStorageGB: 10,
		includedClassAOpsPerMonth: 1_000_000,
		includedClassBOpsPerMonth: 10_000_000,
	},
};

// Public Fly.io machine pricing (USD). Source: fly.io/docs/machines/
// (chunk 10.5 user-provided table). Per-second rate × seconds in
// the month. Default plan: shared-cpu-1x, 1GB RAM.
const FLY_PRICING = {
	sharedCpu1x1GB: {
		// $1.94/month. A month is 730 hours (8760 hours / 12).
		pricePerMonth: 1.94,
		pricePerHour: 1.94 / 730,
		pricePerSecond: 1.94 / (730 * 3600),
	},
};

// Public MMX pricing for `MiniMax-M2.7-highspeed` (USD).
const MMX_PRICING = {
	inputPer1M: 0.10,
	outputPer1M: 0.40,
};

export interface CostEnv {
	DB?: D1Database;
	CF_API_TOKEN?: string;
	CF_ACCOUNT_TAG?: string;
	CF_SCRIPT_NAME?: string;
	/** ISO YYYY-MM-DD of the Workers Paid plan signup. */
	CF_BILLING_CYCLE_START?: string;
	/** Fly.io machine API token. */
	FLY_API_TOKEN?: string;
	/** Fly.io app name. Defaults to "pm-bot-relay". */
	FLY_APP_NAME?: string;
	/** Free credit remaining (USD) for the user's Fly.io trial. */
	FLY_FREE_CREDIT_USD?: string;
}

export interface CfMonthlySection {
	period: "since_billing_cycle_start";
	days_elapsed: number;
	days_until_reset: number;
	resets_on: string; // ISO YYYY-MM-DD
	// Per-metric current / limit / pct / overage.
	requests: { current: number; limit: number; pct: number; overage_units: number };
	cpu_ms: { current: number; limit: number; pct: number; overage_units: number };
	d1_writes_24h: { current: number; limit: number; pct: number };
	r2_storage_gb: { current: number; limit: number; pct: number };
}

export interface FlyRelaySection {
	ok: boolean;
	reason?: string;
	/** "running" | "stopped" | "unknown" | "no_token" | "assumed_running" */
	status: "running" | "stopped" | "unknown" | "no_token" | "not_deployed" | "assumed_running";
	plan: "shared-cpu-1x-1gb";
	price_per_month: number;
	hours_this_month: number;
	estimated_cost_month: number;
	free_credit_remaining_usd: number;
	notes: string[];
}

export interface CostResponse {
	ok: true;
	period: "last_24h";
	cf: {
		requests_24h: number;
		errors_24h: number;
		estimated_cost_24h: number;
	};
	mmx: {
		calls_24h: number;
		input_tokens_24h: number;
		output_tokens_24h: number;
		estimated_cost_24h: number;
	};
	d1: { reads_24h: number; writes_24h: number; estimated_cost_24h: number };
	r2: { storage_gb: number; estimated_cost_24h: number };
	total_estimated_cost_24h: number;
	monthly_estimate: number;
	notes: string[];
	dashboard_url: string;
	// Chunk 10.5:
	cf_monthly: CfMonthlySection;
	fly_relay: FlyRelaySection;
}

export interface CostError {
	ok: false;
	error: string;
	detail?: string;
}

export type CostResult = CostResponse | CostError;

/** Round up to 4 decimal places. */
function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}

/** Day-of-year for an ISO date. */
function dayOfYear(iso: string): number {
	const d = new Date(iso + "T00:00:00Z");
	const start = Date.UTC(d.getUTCFullYear(), 0, 0);
	return Math.floor((d.getTime() - start) / 86400000);
}

/** Add N days to an ISO date, return ISO. */
function addDays(iso: string, n: number): string {
	const d = new Date(iso + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

/** Number of days between two ISO dates (b - a). */
function daysBetween(a: string, b: string): number {
	const da = new Date(a + "T00:00:00Z").getTime();
	const db = new Date(b + "T00:00:00Z").getTime();
	return Math.round((db - da) / 86400000);
}

/** Pull MMX usage from the D1 llm_calls table. */
async function getMmxUsage(
	db: D1Database,
	sinceTs: number,
): Promise<{ calls: number; input: number; output: number }> {
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

/** Approximate D1 row reads/writes (last 24h) by counting
 *  rows in the bot's active tables. Rough but free. */
async function getD1RowCounts(
	db: D1Database,
	sinceTs: number,
): Promise<{ reads: number; writes: number }> {
	let reads = 0;
	let writes = 0;
	const tables = ["cron_runs", "llm_calls", "trades", "signals", "scans"];
	for (const t of tables) {
		try {
			const row = await db
				.prepare(`SELECT COUNT(*) as n FROM ${t} WHERE ts >= ?1`)
				.bind(sinceTs)
				.first<{ n: number }>();
			reads += row?.n ?? 0;
			writes += row?.n ?? 0;
		} catch {
			// ignore
		}
	}
	return { reads, writes };
}

/** Compute the Fly.io relay section.
 *  - If FLY_API_TOKEN is missing: status="no_token", cost=0.
 *  - If the Fly.io API call fails: status="unknown", cost=0.
 *  - Otherwise: pull machine state + uptime, compute hours
 *    this month, multiply by the per-second rate. */
async function getFlyRelaySection(env: CostEnv): Promise<FlyRelaySection> {
	const freeCredit = Number(env.FLY_FREE_CREDIT_USD ?? "0");
	const notes: string[] = [];
	if (!env.FLY_API_TOKEN) {
		notes.push("FLY_API_TOKEN not set; relay cost not measured (set it via wrangler secret put FLY_API_TOKEN)");
		return {
			ok: false,
			reason: "FLY_API_TOKEN not set",
			status: "no_token",
			plan: "shared-cpu-1x-1gb",
			price_per_month: FLY_PRICING.sharedCpu1x1GB.pricePerMonth,
			hours_this_month: 0,
			estimated_cost_month: 0,
			free_credit_remaining_usd: freeCredit,
			notes,
		};
	}
	const appName = env.FLY_APP_NAME ?? "pm-bot-relay";
	const url = `https://api.fly.io/v1/apps/${appName}/machines`;
	let machines: Array<{ state?: string; started_at?: string; region?: string }> = [];
	try {
		const resp = await fetch(url, {
			headers: { Authorization: `Bearer ${env.FLY_API_TOKEN}` },
		});
		if (resp.status === 404) {
			// Chunk 10.7: a machine-scoped token (`fm2_*`) can't see
			// the app's machines via the org-level endpoint, so the
			// API returns 404 even when the app IS deployed and
			// running. Don't fall through to "not_deployed" — the
			// user clearly has a token, so they set it for a reason.
			// Fall through to the cost estimate using assumed
			// 24/7 operation and surface the API failure as a note.
			notes.push(
				`App "${appName}" not visible via this token (machine-scoped, not org-scoped). Cost estimated assuming 24/7 operation.`,
			);
		} else if (!resp.ok) {
			notes.push(`Fly.io API returned HTTP ${resp.status}`);
			return {
				ok: false,
				reason: `http_${resp.status}`,
				status: "unknown",
				plan: "shared-cpu-1x-1gb",
				price_per_month: FLY_PRICING.sharedCpu1x1GB.pricePerMonth,
				hours_this_month: 0,
				estimated_cost_month: 0,
				free_credit_remaining_usd: freeCredit,
				notes,
			};
		} else {
			const data = (await resp.json()) as { machines?: Array<{ state?: string }> };
			machines = data.machines ?? [];
		}
	} catch (e) {
		notes.push(`Fly.io API fetch failed: ${e instanceof Error ? e.message : String(e)}`);
		return {
			ok: false,
			reason: "fetch_failed",
			status: "unknown",
			plan: "shared-cpu-1x-1gb",
			price_per_month: FLY_PRICING.sharedCpu1x1GB.pricePerMonth,
			hours_this_month: 0,
			estimated_cost_month: 0,
			free_credit_remaining_usd: freeCredit,
			notes,
		};
	}

	// Compute hours for any machine in "started" state.
	const monthStart = new Date();
	monthStart.setUTCDate(1);
	monthStart.setUTCHours(0, 0, 0, 0);
	const monthStartMs = monthStart.getTime();
	const nowMs = Date.now();
	const runningMachines = machines.filter((m) => m.state === "started");
	// Chunk 10.7: if the API returned no machines (either the app
	// really doesn't exist, or our token can't see it because it's
	// machine-scoped, not org-scoped), assume 1 machine running
	// 24/7. The `notes` will surface which case it is.
	const assumedRunning = runningMachines.length > 0 ? runningMachines.length : 1;
	const hoursThisMonth = ((nowMs - monthStartMs) / 3600000) * assumedRunning;
	const estimatedCost = hoursThisMonth * FLY_PRICING.sharedCpu1x1GB.pricePerHour;
	if (runningMachines.length > 0) {
		notes.push(
			`${runningMachines.length}/${machines.length} machine(s) running; ${hoursThisMonth.toFixed(1)}h @ $${FLY_PRICING.sharedCpu1x1GB.pricePerHour.toFixed(4)}/h.`,
		);
	} else {
		notes.push(
			`No machine data visible (machine-scoped token); assuming 1 machine running 24/7: ${hoursThisMonth.toFixed(1)}h @ $${FLY_PRICING.sharedCpu1x1GB.pricePerHour.toFixed(4)}/h.`,
		);
	}

	return {
		ok: true,
		status: runningMachines.length > 0 ? "running" : "assumed_running",
		plan: "shared-cpu-1x-1gb",
		price_per_month: FLY_PRICING.sharedCpu1x1GB.pricePerMonth,
		hours_this_month: round4(hoursThisMonth),
		estimated_cost_month: round4(estimatedCost),
		free_credit_remaining_usd: round4(Math.max(0, freeCredit - estimatedCost)),
		notes,
	};
}

/** Compute the CF monthly section. Extrapolates 7-day
 *  usage to "since billing cycle start" for fair comparison. */
function computeCfMonthly(
	cycleStart: string,
	requests7d: number,
	cpuMs7d: number,
	d1Writes24h: number,
	r2StorageGB: number,
): CfMonthlySection {
	const today = new Date().toISOString().slice(0, 10);
	const daysElapsed = Math.max(1, daysBetween(cycleStart, today));
	const daysInCycle = 30; // CF bills on a 30-day window
	const daysUntilReset = Math.max(0, daysInCycle - daysElapsed);
	const resetsOn = addDays(cycleStart, daysInCycle);

	// Scale 7-day to "since cycle start" proportionally.
	const requestsScaled = Math.round((requests7d * daysElapsed) / 7);
	const cpuMsScaled = Math.round((cpuMs7d * daysElapsed) / 7);

	const reqLimit = CF_PRICING.workers.includedRequests;
	const cpuLimit = CF_PRICING.workers.includedCpuMs;
	const d1Limit = CF_PRICING.d1.freeWritesPerDay;
	const r2Limit = CF_PRICING.r2.includedStorageGB;

	const reqPct = (requestsScaled / reqLimit) * 100;
	const cpuPct = (cpuMsScaled / cpuLimit) * 100;
	const d1Pct = (d1Writes24h / d1Limit) * 100;
	const r2Pct = (r2StorageGB / r2Limit) * 100;

	return {
		period: "since_billing_cycle_start",
		days_elapsed: daysElapsed,
		days_until_reset: daysUntilReset,
		resets_on: resetsOn,
		requests: {
			current: requestsScaled,
			limit: reqLimit,
			pct: round4(reqPct),
			overage_units: Math.max(0, requestsScaled - reqLimit),
		},
		cpu_ms: {
			current: cpuMsScaled,
			limit: cpuLimit,
			pct: round4(cpuPct),
			overage_units: Math.max(0, cpuMsScaled - cpuLimit),
		},
		d1_writes_24h: {
			current: d1Writes24h,
			limit: d1Limit,
			pct: round4(d1Pct),
		},
		r2_storage_gb: {
			current: r2StorageGB,
			limit: r2Limit,
			pct: round4(r2Pct),
		},
	};
}

export async function handleCost(env: CostEnv, url: URL): Promise<Response> {
	const accountTag = env.CF_ACCOUNT_TAG ?? "8c995c329fee2ee6ab33d9d3d6a30e55";
	const scriptName = env.CF_SCRIPT_NAME ?? "pm-bot";
	const dashboardUrl =
		`https://dash.cloudflare.com/${accountTag}` +
		`/workers/services/view/${scriptName}/production/overview`;

	const notes: string[] = [];
	const sinceTs24h = Date.now() - 24 * 60 * 60 * 1000;

	// ─── CF: 7-day usage (for monthly extrapolation) + 24h errors ───
	let requests7d = 0;
	let requests24h = 0;
	let errors24h = 0;
	let cpuMs7d = 0;
	if (env.CF_API_TOKEN) {
		try {
			// 7d for the monthly extrapolation.
			const resp7d = (await cfAnalyticsHandler(
				env as Parameters<typeof cfAnalyticsHandler>[0],
				new URL(`${url.origin}?hours=168`),
			)) as Response;
			const data7d = (await resp7d.json()) as CfAnalyticsResponse;
			if (data7d.ok) {
				requests7d = data7d.totals.requests;
				// cpu_ms isn't in the totals; the GraphQL
				// response has it on each bucket. We
				// expose it as 0 here and rely on the
				// dashboard's "resets on" + extrapolated
				// requests to surface usage. (CF exposes
				// CPU time on the Workers dashboard; if
				// we want it here, we'd need to add a
				// separate aggregator in cf-analytics.ts.)
				cpuMs7d = 0;
			}
			// 24h for the "today" numbers + live indicator.
			const resp24h = (await cfAnalyticsHandler(
				env as Parameters<typeof cfAnalyticsHandler>[0],
				new URL(`${url.origin}?hours=24`),
			)) as Response;
			const data24h = (await resp24h.json()) as CfAnalyticsResponse;
			if (data24h.ok) {
				requests24h = data24h.totals.requests;
				errors24h = data24h.totals.errors;
			}
		} catch (e) {
			notes.push(
				`CF analytics fetch failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	} else {
		notes.push("CF_API_TOKEN not set; CF cost not measured");
	}
	// 24h cost = max(0, requests24h - 100K) × $0.50/M.
	const cfCost24hCents = Math.max(0, requests24h - CF_PRICING.workers.freeRequestsPerDay) *
		CF_PRICING.workers.requestsPerMonth;

	// ─── MMX (last 24h) ───
	let mmxCalls = 0;
	let mmxInput = 0;
	let mmxOutput = 0;
	let mmxCostCents = 0;
	if (env.DB) {
		const usage = await getMmxUsage(env.DB, sinceTs24h);
		mmxCalls = usage.calls;
		mmxInput = usage.input;
		mmxOutput = usage.output;
		mmxCostCents =
			(usage.input / 1_000_000) * MMX_PRICING.inputPer1M +
			(usage.output / 1_000_000) * MMX_PRICING.outputPer1M;
	} else {
		notes.push("DB not bound; MMX cost not measured");
	}

	// ─── D1 (24h, approx) ───
	let d1Reads = 0;
	let d1Writes = 0;
	if (env.DB) {
		const counts = await getD1RowCounts(env.DB, sinceTs24h);
		d1Reads = counts.reads;
		d1Writes = counts.writes;
	}
	const d1CostCents =
		Math.max(0, d1Reads / 30 - CF_PRICING.d1.freeReadsPerDay) *
			CF_PRICING.d1.readsPerMonth +
		Math.max(0, d1Writes / 30 - CF_PRICING.d1.freeWritesPerDay) *
			CF_PRICING.d1.writesPerMonth;
	notes.push(
		`D1: ${d1Reads} reads + ${d1Writes} writes (24h, approx; below free tier at ${CF_PRICING.d1.freeReadsPerDay.toLocaleString()} reads/day).`,
	);

	// ─── R2 (24h, rough) ───
	const r2StorageGBEstimate = 0.01; // 10MB
	const r2CostCents =
		Math.max(0, r2StorageGBEstimate - CF_PRICING.r2.freeStorageGB) *
		CF_PRICING.r2.storagePerGBMonth;
	notes.push("R2: ~10MB storage; reads not measured. Below free tier.");

	// ─── CF monthly + Fly.io relay (chunk 10.5) ───
	const cycleStart = env.CF_BILLING_CYCLE_START ?? "2026-08-08";
	const cfMonthly = computeCfMonthly(
		cycleStart,
		requests7d,
		cpuMs7d,
		d1Writes,
		r2StorageGBEstimate,
	);
	const flyRelay = await getFlyRelaySection(env);

	// ─── Total ───
	const cfCostTotal24h = cfCost24hCents + d1CostCents + r2CostCents;
	const totalCents24h = cfCostTotal24h + mmxCostCents;
	const monthlyCents = totalCents24h * 30 + flyRelay.estimated_cost_month;

	const result: CostResponse = {
		ok: true,
		period: "last_24h",
		cf: {
			requests_24h: requests24h,
			errors_24h: errors24h,
			estimated_cost_24h: round4(cfCostTotal24h),
		},
		mmx: {
			calls_24h: mmxCalls,
			input_tokens_24h: mmxInput,
			output_tokens_24h: mmxOutput,
			estimated_cost_24h: round4(mmxCostCents),
		},
		d1: { reads_24h: d1Reads, writes_24h: d1Writes, estimated_cost_24h: round4(d1CostCents) },
		r2: { storage_gb: r2StorageGBEstimate, estimated_cost_24h: round4(r2CostCents) },
		total_estimated_cost_24h: round4(totalCents24h),
		monthly_estimate: round4(monthlyCents),
		notes,
		dashboard_url: dashboardUrl,
		cf_monthly: cfMonthly,
		fly_relay: flyRelay,
	};
	return Response.json(result, {
		headers: {
			"Cache-Control": "public, max-age=60",
		},
	});
}
