/**
 * prediction-market-lab — D1 unit tests
 *
 * Uses vitest-pool-workers so the same D1Database binding the Worker
 * uses is available in tests. Each test gets an isolated D1 (per-worker
 * storage in miniflare).
 *
 * Migrations are loaded as raw strings via Vite's `?raw` import and
 * applied in beforeAll with applyD1Migrations. This keeps the test
 * self-contained — no Node/Worker bridge needed.
 */

import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
	DEFAULT_USER_ID,
	trades,
	signals,
	marketSnapshots,
	models,
	scans,
	cronRuns,
	llmCalls,
} from "../src/lib/db";
import type {
	TradeAction,
	Side,
	Vertical,
	FillType,
} from "../src/lib/types";
import { ALL_MIGRATIONS } from "./helpers/migrations";

beforeAll(async () => {
	await applyD1Migrations(env.DB, ALL_MIGRATIONS);
});

beforeEach(async () => {
	// Wipe tables between tests so each starts clean.
	const tables = [
		"trades",
		"signals",
		"market_snapshots",
		"models",
		"scans",
		"cron_runs",
		"llm_calls",
	];
	await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("trades", () => {
	it("inserts and reads back a trade", async () => {
		const id = await trades.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			ts: 1_700_000_000_000,
			ticker: "KXCPI-26JUL-T0.1",
			vertical: "economic" as Vertical,
			side: "yes" as Side,
			action: "open" as TradeAction,
			price_cents: 50,
			size: 1,
			signal_p: 0.72,
			signal_rationale: "test rationale",
			model_version: "reversion-economic-v1",
			pnl_cents: null,
			fill_type: "limit" as FillType,
			is_paper: 1,
		});
		expect(id).toBeGreaterThan(0);

		const all = await trades.list(env.DB, DEFAULT_USER_ID);
		expect(all).toHaveLength(1);
		expect(all[0].ticker).toBe("KXCPI-26JUL-T0.1");
		expect(all[0].price_cents).toBe(50);
		expect(all[0].signal_p).toBeCloseTo(0.72);
		expect(all[0].is_paper).toBe(1);
	});

	it("filters by ticker", async () => {
		await trades.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			ts: 1_700_000_000_000,
			ticker: "KXCPI-26JUL-T0.1",
			vertical: "economic",
			side: "yes",
			action: "open",
			price_cents: 50,
			size: 1,
			signal_p: 0.7,
			signal_rationale: null,
			model_version: "v1",
			pnl_cents: null,
			fill_type: "limit",
			is_paper: 1,
		});
		await trades.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			ts: 1_700_000_001_000,
			ticker: "KXWARMING-50",
			vertical: "weather",
			side: "no",
			action: "open",
			price_cents: 40,
			size: 2,
			signal_p: 0.6,
			signal_rationale: null,
			model_version: "v1",
			pnl_cents: null,
			fill_type: "limit",
			is_paper: 1,
		});

		const onlyKXCPI = await trades.list(env.DB, DEFAULT_USER_ID, {
			ticker: "KXCPI-26JUL-T0.1",
		});
		expect(onlyKXCPI).toHaveLength(1);
		expect(onlyKXCPI[0].ticker).toBe("KXCPI-26JUL-T0.1");
	});

	it("isolates trades by user_id", async () => {
		await trades.insert(env.DB, {
			user_id: "alice",
			ts: 1_700_000_000_000,
			ticker: "KXCPI",
			vertical: "economic",
			side: "yes",
			action: "open",
			price_cents: 50,
			size: 1,
			signal_p: 0.5,
			signal_rationale: null,
			model_version: "v1",
			pnl_cents: null,
			fill_type: "limit",
			is_paper: 1,
		});
		await trades.insert(env.DB, {
			user_id: "bob",
			ts: 1_700_000_000_000,
			ticker: "KXCPI",
			vertical: "economic",
			side: "yes",
			action: "open",
			price_cents: 50,
			size: 1,
			signal_p: 0.5,
			signal_rationale: null,
			model_version: "v1",
			pnl_cents: null,
			fill_type: "limit",
			is_paper: 1,
		});

		const alice = await trades.list(env.DB, "alice");
		const bob = await trades.list(env.DB, "bob");
		expect(alice).toHaveLength(1);
		expect(bob).toHaveLength(1);
		expect(alice[0].user_id).toBe("alice");
		expect(bob[0].user_id).toBe("bob");
	});

	it("sums pnl correctly", async () => {
		await trades.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			ts: 1_700_000_000_000,
			ticker: "A",
			vertical: "economic",
			side: "yes",
			action: "close",
			price_cents: 60,
			size: 1,
			signal_p: 0.5,
			signal_rationale: null,
			model_version: "v1",
			pnl_cents: 10,
			fill_type: "limit",
			is_paper: 1,
		});
		await trades.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			ts: 1_700_000_001_000,
			ticker: "B",
			vertical: "economic",
			side: "no",
			action: "close",
			price_cents: 30,
			size: 1,
			signal_p: 0.5,
			signal_rationale: null,
			model_version: "v1",
			pnl_cents: -5,
			fill_type: "limit",
			is_paper: 1,
		});
		const pnl = await trades.pnlSince(env.DB, DEFAULT_USER_ID, 1_600_000_000_000);
		expect(pnl.net).toBe(5);
		expect(pnl.gross).toBe(10);
	});
});

describe("signals", () => {
	it("inserts and lists signals with source filter", async () => {
		await signals.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			ts: 1_700_000_000_000,
			ticker: "KXCPI",
			vertical: "economic",
			side: "yes",
			signal_p: 0.7,
			features_json: JSON.stringify({ f1: 0.1, f2: 0.2 }),
			model_version: "v1",
			source: "live",
			was_filled: 1,
		});
		await signals.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			ts: 1_700_000_001_000,
			ticker: "KXWARMING",
			vertical: "weather",
			side: null,
			signal_p: 0.3,
			features_json: null,
			model_version: "v1",
			source: "shadow",
			was_filled: 0,
		});

		const live = await signals.list(env.DB, DEFAULT_USER_ID, { source: "live" });
		expect(live).toHaveLength(1);
		expect(live[0].source).toBe("live");

		const shadow = await signals.list(env.DB, DEFAULT_USER_ID, { source: "shadow" });
		expect(shadow).toHaveLength(1);
		expect(shadow[0].source).toBe("shadow");
		expect(shadow[0].was_filled).toBe(0);
	});
});

describe("market_snapshots", () => {
	it("inserts and lists snapshots for a ticker", async () => {
		await marketSnapshots.insert(env.DB, {
			ts: 1_700_000_000_000,
			ticker: "KXCPI",
			vertical: "economic",
			mid_cents: 50,
			bid_cents: 49,
			ask_cents: 51,
			volume_24h: 1000,
			open_interest: 50,
		});
		await marketSnapshots.insert(env.DB, {
			ts: 1_700_000_060_000,
			ticker: "KXCPI",
			vertical: "economic",
			mid_cents: 52,
			bid_cents: 51,
			ask_cents: 53,
			volume_24h: 1100,
			open_interest: 50,
		});

		const snaps = await marketSnapshots.listForTicker(env.DB, "KXCPI");
		expect(snaps).toHaveLength(2);
		expect(snaps[0].mid_cents).toBe(50);
		expect(snaps[1].mid_cents).toBe(52);
	});
});

describe("models (registry)", () => {
	it("upserts and retrieves the active model for a vertical", async () => {
		await models.upsert(env.DB, {
			user_id: DEFAULT_USER_ID,
			version: "reversion-economic-v1",
			vertical: "economic",
			artifact_path: "models/reversion-economic-v1.onnx",
			trained_on_data_until: 1_700_000_000_000,
			train_metrics_json: JSON.stringify({ sharpe: 1.2, win_rate: 0.55 }),
			deployed_at: 1_700_000_000_000,
			retired_at: null,
			status: "active",
			notes: "first prod model",
		});

		const active = await models.getActive(env.DB, DEFAULT_USER_ID, "economic");
		expect(active).not.toBeNull();
		expect(active?.version).toBe("reversion-economic-v1");

		const list = await models.list(env.DB, DEFAULT_USER_ID, { status: "active" });
		expect(list).toHaveLength(1);
	});

	it("retires old model when promoting a new one", async () => {
		const t0 = 1_700_000_000_000;
		await models.upsert(env.DB, {
			user_id: DEFAULT_USER_ID,
			version: "v1",
			vertical: "economic",
			artifact_path: "models/v1.onnx",
			trained_on_data_until: t0,
			train_metrics_json: null,
			deployed_at: t0,
			retired_at: null,
			status: "active",
			notes: null,
		});
		const t1 = t0 + 86_400_000;
		await models.upsert(env.DB, {
			user_id: DEFAULT_USER_ID,
			version: "v2",
			vertical: "economic",
			artifact_path: "models/v2.onnx",
			trained_on_data_until: t1,
			train_metrics_json: null,
			deployed_at: t1,
			retired_at: null,
			status: "active",
			notes: null,
		});
		await models.setStatus(env.DB, DEFAULT_USER_ID, "v1", "retired", t1);

		const active = await models.getActive(env.DB, DEFAULT_USER_ID, "economic");
		expect(active?.version).toBe("v2");
		const all = await models.list(env.DB, DEFAULT_USER_ID);
		expect(all.find((m) => m.version === "v1")?.status).toBe("retired");
	});
});

describe("scans", () => {
	it("stores and retrieves the latest scan with candidates", async () => {
		const id = await scans.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			ts: 1_700_000_000_000,
			source: "series-anchored",
			lookback_hours: 24,
			min_trades: 3,
			top_n: 5,
			vol24h_min: 100,
			candidates: [
				{ ticker: "KXCPI-26JUL-T0.1", score: 5.5, vol24h: 14951, n_trades: 31, vertical: "economic" },
				{ ticker: "KXCPI-26JUL-T0.0", score: 5.4, vol24h: 23539, n_trades: 47, vertical: "economic" },
			],
		});
		expect(id).toBeGreaterThan(0);

		const latest = await scans.latest(env.DB, DEFAULT_USER_ID);
		expect(latest).not.toBeNull();
		expect(latest?.row.n_candidates).toBe(2);
		expect(latest?.candidates[0].ticker).toBe("KXCPI-26JUL-T0.1");
		expect(latest?.candidates[0].vol24h).toBe(14951);
	});
});

describe("cron_runs", () => {
	it("records a successful cron run and retrieves the latest", async () => {
		await cronRuns.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			cron_name: "pm-scan-refresh",
			ts: 1_700_000_000_000,
			duration_ms: 1234,
			status: "success",
			error_message: null,
			artifacts_json: JSON.stringify({ n_candidates: 5 }),
		});
		const last = await cronRuns.lastRun(env.DB, "pm-scan-refresh", DEFAULT_USER_ID);
		expect(last).not.toBeNull();
		expect(last?.duration_ms).toBe(1234);
		expect(last?.status).toBe("success");
	});
});

describe("llm_calls", () => {
	it("inserts an LLM call and aggregates cost", async () => {
		await llmCalls.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			ts: 1_700_000_000_000,
			purpose: "news-check",
			model: "MiniMax-M3",
			ticker: "KXCPI",
			input_tokens_est: 800,
			output_tokens_est: 200,
			duration_ms: 3500,
			status: "success",
			error_message: null,
		});
		await llmCalls.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			ts: 1_700_000_001_000,
			purpose: "daily-recap",
			model: "MiniMax-M3",
			ticker: null,
			input_tokens_est: 1500,
			output_tokens_est: 800,
			duration_ms: 5200,
			status: "success",
			error_message: null,
		});
		await llmCalls.insert(env.DB, {
			user_id: DEFAULT_USER_ID,
			ts: 1_700_000_002_000,
			purpose: "news-check",
			model: "MiniMax-M3",
			ticker: "KXWARMING",
			input_tokens_est: 9999,
			output_tokens_est: 9999,
			duration_ms: 100,
			status: "error",
			error_message: "API timeout",
		});

		const cost = await llmCalls.costSince(env.DB, DEFAULT_USER_ID, 1_600_000_000_000);
		expect(cost.n_calls).toBe(2);
		expect(cost.input_tokens).toBe(2300);
		expect(cost.output_tokens).toBe(1000);
	});
});

describe("multi-tenancy", () => {
	it("all queries are isolated by user_id", async () => {
		for (const u of ["alice", "bob"]) {
			await trades.insert(env.DB, {
				user_id: u,
				ts: 1_700_000_000_000,
				ticker: "KXCPI",
				vertical: "economic",
				side: "yes",
				action: "open",
				price_cents: 50,
				size: 1,
				signal_p: 0.5,
				signal_rationale: null,
				model_version: "v1",
				pnl_cents: null,
				fill_type: "limit",
				is_paper: 1,
			});
		}
		expect(await trades.list(env.DB, "alice")).toHaveLength(1);
		expect(await trades.list(env.DB, "bob")).toHaveLength(1);
		expect(await trades.list(env.DB, "carol")).toHaveLength(0);
	});
});
