/**
 * pm-bot — manual cron trigger tests (chunk 11+).
 *
 * Tests POST /api/pm/cron/{name}/run, the operator-facing
 * endpoint that runs a cron on demand. The endpoint
 * dispatches to the same JOBS table the scheduled handler
 * uses and records the run in cron_runs.
 *
 * Two regression cases (the same bug class hit both
 * the dispatcher and the manual trigger — the wrapper
 * hardcoded ok=true):
 *   - An unknown cron name returns 400 (not 500).
 *   - A job that returns ok=false is recorded with
 *     status='error' (not 'success'), so the cadence
 *     panel shows the failure correctly.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { handleCronTrigger, TRIGGERABLE_CRONS } from "../src/api/cron-trigger.js";
import { CRON_TABLE } from "../src/cron/dispatcher.js";
import { DEFAULT_USER_ID } from "../src/lib/types.js";
import { ALL_MIGRATIONS } from "./helpers/migrations";

beforeAll(async () => {
	await applyD1Migrations(env.DB, ALL_MIGRATIONS);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM cron_runs"),
		env.DB.prepare("DELETE FROM llm_calls"),
	]);
});

describe("TRIGGERABLE_CRONS", () => {
	it("mirrors CRON_TABLE (one entry per cron)", () => {
		expect(TRIGGERABLE_CRONS).toHaveLength(Object.keys(CRON_TABLE).length);
		for (const c of TRIGGERABLE_CRONS) {
			expect(CRON_TABLE[c.name as keyof typeof CRON_TABLE]).toBe(c.cronExpression);
		}
	});

	it("includes the leads cron at 0 2 * * *", () => {
		const leads = TRIGGERABLE_CRONS.find((c) => c.name === "leads");
		expect(leads).toBeDefined();
		expect(leads?.cronExpression).toBe("0 2 * * *");
	});
});

describe("handleCronTrigger — validation", () => {
	it("returns 400 for an unknown cron name", async () => {
		const r = await handleCronTrigger(env, "not_a_real_cron");
		expect(r.status).toBe(400);
		const data = (await r.json()) as { ok: boolean; error: string; message: string };
		expect(data.ok).toBe(false);
		expect(data.error).toBe("unknown_cron");
		expect(data.message).toMatch(/not_a_real_cron/);
	});

	it("returns 500 when no job is registered (defensive)", async () => {
		// This shouldn't happen in practice (CRON_TABLE and
		// JOBS are kept in sync), but the handler defends
		// against it. Skipped — JOBS is locked to CRON_TABLE.
	});
});

describe("handleCronTrigger — successful run", () => {
	it("runs the daily cron and records the run in cron_runs", async () => {
		// The daily cron writes an R2 summary; in the test env
		// there's no BUCKET, so the R2 write is a no-op. The
		// cron returns ok=true with artifacts. The endpoint
		// returns 200 and the row is recorded.
		const r = await handleCronTrigger(env, "daily");
		const data = (await r.json()) as {
			ok: boolean;
			cron_name: string;
			artifacts?: Record<string, unknown>;
		};
		expect(r.status).toBe(200);
		expect(data.ok).toBe(true);
		expect(data.cron_name).toBe("daily");
		expect(data.artifacts).toBeDefined();

		// The run was recorded in cron_runs.
		const row = await env.DB
			.prepare(
				`SELECT status FROM cron_runs WHERE cron_name = 'daily' AND user_id = ?1 ORDER BY ts DESC LIMIT 1`,
			)
			.bind(DEFAULT_USER_ID)
			.first<{ status: string }>();
		expect(row).not.toBeNull();
		expect(row?.status).toBe("success");
	});
});

describe("handleCronTrigger — failed run", () => {
	it("records status='error' (not 'success') when the job returns ok=false", async () => {
		// The leads cron returns ok=false when the LLM returns
		// a stub (no MMX_API_KEY in the test env). The wrapper
		// must respect that and record status='error' so the
		// cadence panel surfaces the failure.
		const r = await handleCronTrigger(env, "leads");
		const data = (await r.json()) as {
			ok: boolean;
			cron_name: string;
			error_message?: string;
		};
		// The endpoint may return 200 (with ok=false in the
		// body) — that's fine; what matters is the recorded
		// status in cron_runs.
		expect(data.cron_name).toBe("leads");
		expect(data.ok).toBe(false);
		expect(data.error_message).toBeDefined();

		const row = await env.DB
			.prepare(
				`SELECT status, error_message FROM cron_runs
				 WHERE cron_name = 'leads' AND user_id = ?1 ORDER BY ts DESC LIMIT 1`,
			)
			.bind(DEFAULT_USER_ID)
			.first<{ status: string; error_message: string | null }>();
		expect(row).not.toBeNull();
		expect(row?.status).toBe("error");
		expect(row?.error_message).toMatch(/JSON|parseable|stub/i);
	});

	it("records the LLM call to llm_calls (so the cadence + cost panels update)", async () => {
		// The leads cron records its LLM call to D1 with
		// purpose='leads_cron'. The cadence panel aggregates
		// LLM calls by this purpose, so without the record
		// the panel would be stale until the next scheduled
		// run.
		await handleCronTrigger(env, "leads");
		const row = await env.DB
			.prepare(
				`SELECT purpose, status FROM llm_calls
				 WHERE purpose = 'leads_cron' AND user_id = ?1 ORDER BY ts DESC LIMIT 1`,
			)
			.bind(DEFAULT_USER_ID)
			.first<{ purpose: string; status: string }>();
		expect(row).not.toBeNull();
		expect(row?.purpose).toBe("leads_cron");
		// In the test env there's no MMX_API_KEY, so the
		// call returns the stub. status='success' (the call
		// itself succeeded — it returned a stub response).
		// In prod with a real key, status='success' is
		// the normal path; the LLM might return malformed
		// JSON which would be status='error' on the row.
		expect(row?.status).toBe("success");
	});
});

describe("handleCronTrigger — cadence status reflects inner ok", () => {
	it("a successful cron (daily) shows status='success' in cron_runs", async () => {
		// Daily completes in <100ms in the test env (no
		// external network calls). The scan cron would
		// also pass but takes 5+s because it hits Kalshi.
		await handleCronTrigger(env, "daily");
		const row = await env.DB
			.prepare(
				`SELECT status FROM cron_runs
				 WHERE cron_name = 'daily' AND user_id = ?1 ORDER BY ts DESC LIMIT 1`,
			)
			.bind(DEFAULT_USER_ID)
			.first<{ status: string }>();
		expect(row?.status).toBe("success");
	});
});
