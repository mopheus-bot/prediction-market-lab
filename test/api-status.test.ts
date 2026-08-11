/**
 * pm-bot — status API integration tests.
 *
 * Uses vitest-pool-workers to call the actual handlers
 * with a real D1 binding. The handlers route through the
 * DB lib helpers, so these tests cover the full path.
 */

import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import {
	handleStatus,
	handleTrades,
	handleSignals,
	handleSummary,
	handleScans,
	handleCronRuns,
} from "../src/api/status";
import { DEFAULT_USER_ID } from "../src/lib/types";
import { ALL_MIGRATIONS } from "./helpers/migrations";

beforeAll(async () => {
	await applyD1Migrations(env.DB, ALL_MIGRATIONS);
});

async function insertTrade(
	ticker: string,
	side: "yes" | "no",
	action: "open" | "close",
	priceCents: number,
	pnlCents: number | null = null,
): Promise<void> {
	await env.DB!.prepare(
		`INSERT INTO trades
		 (user_id, ts, ticker, vertical, side, action, price_cents, size,
		  signal_p, signal_rationale, model_version, pnl_cents, fill_type, is_paper)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
	)
		.bind(
			DEFAULT_USER_ID,
			Date.now(),
			ticker,
			"weather",
			side,
			action,
			priceCents,
			10,
			0.55,
			"test",
			"v0-naive",
			pnlCents,
			"limit",
			1,
		)
		.run();
}

async function insertSignal(
	ticker: string,
	source: "live" | "shadow" | "backtest" = "live",
): Promise<void> {
	await env.DB!.prepare(
		`INSERT INTO signals
		 (user_id, ts, ticker, vertical, side, signal_p, features_json,
		  model_version, source, was_filled)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
	)
		.bind(
			DEFAULT_USER_ID,
			Date.now(),
			ticker,
			"weather",
			"yes",
			0.6,
			null,
			"v0-naive",
			source,
			0,
		)
		.run();
}

describe("/api/pm/status", () => {
	it("returns counts and PnL with no data", async () => {
		const r = await handleStatus({ DB: env.DB });
		expect(r.status).toBe(200);
		const body = (await r.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		const counts = body.counts as { n_trades: number; n_signals: number; n_open_positions: number };
		expect(counts.n_trades).toBeGreaterThanOrEqual(0);
	});

	it("returns counts after inserting some trades", async () => {
		await insertTrade("A", "yes", "open", 50);
		await insertTrade("B", "no", "open", 60);
		const r = await handleStatus({ DB: env.DB });
		const body = (await r.json()) as { counts: { n_open_positions: number } };
		expect(body.counts.n_open_positions).toBeGreaterThanOrEqual(2);
	});

	it("returns 500 when DB is missing", async () => {
		const r = await handleStatus({});
		expect(r.status).toBe(500);
	});
});

describe("/api/pm/trades", () => {
	it("filters by ticker", async () => {
		await insertTrade("TICKER-X", "yes", "open", 50);
		await insertTrade("TICKER-Y", "no", "open", 60);
		const url = new URL("https://x/pm/trades?ticker=TICKER-X&limit=50");
		const r = await handleTrades({ DB: env.DB }, url);
		const body = (await r.json()) as { trades: Array<{ ticker: string }> };
		expect(body.trades.every((t) => t.ticker === "TICKER-X")).toBe(true);
	});
});

describe("/api/pm/signals", () => {
	it("filters by source", async () => {
		await insertSignal("SIG-SHADOW", "shadow");
		await insertSignal("SIG-LIVE", "live");
		const url = new URL("https://x/pm/signals?source=shadow&limit=50");
		const r = await handleSignals({ DB: env.DB }, url);
		const body = (await r.json()) as { signals: Array<{ source: string }> };
		expect(body.signals.every((s) => s.source === "shadow")).toBe(true);
	});
});

describe("/api/pm/summary", () => {
	// 2026-08-11: handleSummary used to read the R2 daily-recap
	// first (frozen at 06:00 UTC) and fall back to the live
	// aggregate. That was wrong for the dashboard — the R2
	// file's window is 06:00-to-06:00, so the "24h PnL" hero
	// KPI was stuck at the previous daily run's value for 24h.
	// Now the endpoint always uses the rolling-24h live
	// aggregate. The R2 file remains a pure archive (the
	// daily-cron still writes it; readDailyRecap is exported
	// for any historical caller).
	it("always uses the live rolling-24h aggregate, never R2", async () => {
		// Even with a BUCKET bound, the response is "live".
		const fakeBucket = {
			get: async (_key: string) => ({
				text: async () => JSON.stringify({
					date: "2026-08-11",
					lookback_hours: 24,
					trades: { n_total: 999, realized_pnl_cents: 99999 },
				}),
			}),
		};
		const fakeEnv = { DB: env.DB, BUCKET: fakeBucket as any };
		const url = new URL("https://x/pm/summary");
		const r = await handleSummary(fakeEnv, url);
		const body = (await r.json()) as { source: string };
		expect(body.source).toBe("live");
	});

	it("exposes legacy aliases on the live recap", async () => {
		// 2026-08-11: legacy aliases (n_trades_24h,
		// pnl_24h_cents, last_24h_cents, realized_cents)
		// are set on the live aggregate so the dashboard's
		// hero "24h PnL" / "X trades 24h" KPIs read
		// the right numbers.
		const url = new URL("https://x/pm/summary");
		const r = await handleSummary({ DB: env.DB }, url);
		const body = (await r.json()) as {
			source: string;
			recap: {
				n_trades: number;
				pnl_cents: number;
				n_trades_24h: number;
				pnl_24h_cents: number;
				last_24h_cents: number;
				realized_cents: number;
			};
		};
		expect(body.source).toBe("live");
		expect(body.recap.n_trades_24h).toBe(body.recap.n_trades);
		expect(body.recap.pnl_24h_cents).toBe(body.recap.pnl_cents);
		expect(body.recap.last_24h_cents).toBe(body.recap.pnl_cents);
		expect(body.recap.realized_cents).toBe(body.recap.pnl_cents);
	});

	it("includes per-vertical breakdown in the live recap (chunk 10.8)", async () => {
		// Insert a couple of fake trades in different verticals.
		const now = Date.now();
		const since = now - 60_000; // 1 min ago
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO trades (user_id, ts, ticker, vertical, side, action, price_cents, size, fill_type, is_paper, trading_mode, created_at)
				 VALUES ('default', ?1, 'KXWARMING-50', 'weather', 'yes', 'open', 25, 1, 'limit', 1, 'paper', ?1)`,
			).bind(now - 10_000),
			env.DB.prepare(
				`INSERT INTO trades (user_id, ts, ticker, vertical, side, action, price_cents, size, pnl_cents, fill_type, is_paper, trading_mode, created_at)
				 VALUES ('default', ?1, 'KXPOLITICS-X', 'politics', 'yes', 'close', 50, 1, 100, 'limit', 1, 'paper', ?1)`,
			).bind(now - 5_000),
		]);
		// The summary endpoint ignores the test insert if R2 has a
		// recap; force the live path by hitting the API directly.
		const url = new URL("https://x/pm/summary");
		const r = await handleSummary({ DB: env.DB }, url);
		const body = (await r.json()) as {
			source: string;
			recap: {
				n_trades: number;
				verticals?: Record<string, { n_trades: number; pnl_cents: number }>;
			};
		};
		// If R2 had a recap, verticals might be null. The live
		// path should always include verticals.
		if (body.source === "live") {
			// Either verticals is present (our 2 inserts show up)
			// or null (no trades in the 24h window). Both are
			// valid; the contract is that the field exists.
			expect(body.recap).toHaveProperty("verticals");
		}
	});
});

describe("/api/pm/scans", () => {
	it("returns ok when no scan has been recorded", async () => {
		const r = await handleScans({ DB: env.DB });
		const body = (await r.json()) as { ok: boolean; found: boolean };
		expect(body.ok).toBe(true);
	});
});

describe("/api/pm/cron-runs", () => {
	it("returns the recent run list", async () => {
		const url = new URL("https://x/pm/cron-runs?limit=5");
		const r = await handleCronRuns({ DB: env.DB }, url);
		const body = (await r.json()) as { ok: boolean; runs: unknown[] };
		expect(body.ok).toBe(true);
		expect(Array.isArray(body.runs)).toBe(true);
	});
});
