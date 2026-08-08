/**
 * pm-bot — backtest-run endpoint tests (chunk 10.8c).
 *
 * Verifies POST /api/pm/backtest/run:
 *   - returns ok with metrics + summary
 *   - registers a candidate model when register_candidate=true
 *   - skips candidate registration when register_candidate=false
 *   - returns error when DB is missing
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { handleBacktestRun } from "../src/api/backtest-run.js";
import { ALL_MIGRATIONS } from "./helpers/migrations";

beforeAll(async () => {
	await applyD1Migrations(env.DB, ALL_MIGRATIONS);
});

function makeRequest(body: unknown): Request {
	return new Request("https://x/pm/backtest/run", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? "" : JSON.stringify(body),
	});
}

describe("POST /api/pm/backtest/run (chunk 10.8c)", () => {
	it("returns ok + metrics with default 7-day window", async () => {
		const r = await handleBacktestRun({ DB: env.DB }, makeRequest({}));
		const body = (await r.json()) as {
			ok: boolean;
			summary: string;
			metrics: { trade_count: number };
		};
		expect(body.ok).toBe(true);
		expect(typeof body.summary).toBe("string");
		expect(typeof body.metrics.trade_count).toBe("number");
	});

	it("respects window_days parameter", async () => {
		const r = await handleBacktestRun(
			{ DB: env.DB },
			makeRequest({ window_days: 30 }),
		);
		const body = (await r.json()) as { ok: boolean; metrics: { period: { days: number } } };
		expect(body.ok).toBe(true);
		expect(body.metrics.period.days).toBe(30);
	});

	it("clamps window_days to [1, 90]", async () => {
		const tooBig = await handleBacktestRun(
			{ DB: env.DB },
			makeRequest({ window_days: 9999 }),
		);
		const body = (await tooBig.json()) as { metrics: { period: { days: number } } };
		expect(body.metrics.period.days).toBe(90);
	});

	it("registers a candidate model by default", async () => {
		const r = await handleBacktestRun({ DB: env.DB }, makeRequest({}));
		const body = (await r.json()) as {
			ok: boolean;
			candidate_model_version: string | null;
		};
		expect(body.candidate_model_version).toMatch(/^backtest-\d+$/);
	});

	it("skips candidate registration when register_candidate=false", async () => {
		const r = await handleBacktestRun(
			{ DB: env.DB },
			makeRequest({ register_candidate: false }),
		);
		const body = (await r.json()) as {
			ok: boolean;
			candidate_model_version: null;
		};
		expect(body.candidate_model_version).toBeNull();
	});

	it("returns 500 when DB is missing", async () => {
		const r = await handleBacktestRun({}, makeRequest({}));
		expect(r.status).toBe(500);
		const body = (await r.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toBe("missing_db");
	});
});
