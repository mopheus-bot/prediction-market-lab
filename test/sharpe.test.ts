/**
 * prediction-market-lab — Sharpe ratio unit tests.
 *
 * Pins the auto-pilot metrics math. Pure functions, no I/O.
 */

import { describe, it, expect } from "vitest";
import { computeSharpe } from "../src/lib/sharpe.js";

function makeTrade(overrides: {
	ts?: number;
	pnl_cents?: number | null;
	price_cents?: number;
	size?: number;
} = {}) {
	return {
		ts: 1700000000000,
		pnl_cents: 10,
		price_cents: 50,
		size: 1,
		...overrides,
	};
}

describe("computeSharpe", () => {
	const now = 1700100000000; // ~28 hours after the first trade

	it("returns NaN for empty trade list", () => {
		const r = computeSharpe([], { nowMs: now });
		expect(r.trade_count).toBe(0);
		expect(Number.isNaN(r.sharpe_annualized)).toBe(true);
		expect(r.passes_auto_pilot).toBe(false);
	});

	it("returns NaN for a single trade (stddev is undefined)", () => {
		const trades = [makeTrade({ pnl_cents: 5 })];
		const r = computeSharpe(trades, { nowMs: now });
		expect(r.trade_count).toBe(1);
		expect(Number.isNaN(r.sharpe_annualized)).toBe(true);
	});

	it("returns NaN when all trades have the same return (zero stddev)", () => {
		const trades = [
			makeTrade({ pnl_cents: 5 }),
			makeTrade({ pnl_cents: 5 }),
			makeTrade({ pnl_cents: 5 }),
		];
		const r = computeSharpe(trades, { nowMs: now });
		expect(r.trade_count).toBe(3);
		expect(Number.isNaN(r.sharpe_annualized)).toBe(true);
	});

	it("computes a positive Sharpe for profitable trades", () => {
		// 10 trades, each makes 10¢ on a 50¢ entry = 20% return.
		// stddev = 0 (all same) → NaN. Add some variance.
		const trades = [
			makeTrade({ pnl_cents: 12 }),
			makeTrade({ pnl_cents: 8 }),
			makeTrade({ pnl_cents: 10 }),
			makeTrade({ pnl_cents: 11 }),
			makeTrade({ pnl_cents: 9 }),
			makeTrade({ pnl_cents: 13 }),
			makeTrade({ pnl_cents: 7 }),
			makeTrade({ pnl_cents: 10 }),
			makeTrade({ pnl_cents: 12 }),
			makeTrade({ pnl_cents: 8 }),
		];
		const r = computeSharpe(trades, {
			nowMs: now,
			minDays: 0,
			minTrades: 0,
			minSharpe: 0,
		});
		expect(r.trade_count).toBe(10);
		expect(r.mean_return).toBeCloseTo(0.2, 2);
		expect(r.sharpe_raw).toBeGreaterThan(0);
		expect(r.sharpe_annualized).toBeGreaterThan(0);
		expect(r.passes_auto_pilot).toBe(true);
	});

	it("computes a negative Sharpe for losing trades", () => {
		const trades = [
			makeTrade({ pnl_cents: -10 }),
			makeTrade({ pnl_cents: -8 }),
			makeTrade({ pnl_cents: -12 }),
			makeTrade({ pnl_cents: -7 }),
			makeTrade({ pnl_cents: -9 }),
		];
		const r = computeSharpe(trades, {
			nowMs: now,
			minDays: 0,
			minTrades: 0,
			minSharpe: 0,
		});
		expect(r.trade_count).toBe(5);
		expect(r.sharpe_annualized).toBeLessThan(0);
		expect(r.passes_auto_pilot).toBe(false);
	});

	it("respects min_trades threshold", () => {
		// 5 profitable trades — not enough.
		const trades = Array.from({ length: 5 }, () => makeTrade({ pnl_cents: 10 }));
		const r = computeSharpe(trades, {
			nowMs: now,
			minDays: 0,
			minTrades: 30,
			minSharpe: 0,
		});
		expect(r.trade_count).toBe(5);
		expect(r.passes_auto_pilot).toBe(false);
	});

	it("respects min_days threshold", () => {
		// 50 profitable trades, all on the same day.
		const sameDay = 1700000000000;
		const trades = Array.from({ length: 50 }, () =>
			makeTrade({ ts: sameDay, pnl_cents: 10 }),
		);
		const r = computeSharpe(trades, {
			nowMs: sameDay + 3600000, // 1 hour later
			minDays: 7,
			minTrades: 0,
			minSharpe: 0,
		});
		// days_elapsed is clamped to a minimum of 1, so a same-day
		// test reports 1 (which is still < minDays=7, so the
		// auto-pilot doesn't pass).
		expect(r.days_elapsed).toBe(1);
		expect(r.passes_auto_pilot).toBe(false);
	});

	it("ignores trades with null pnl_cents (open positions)", () => {
		const trades = [
			makeTrade({ pnl_cents: 10 }),
			makeTrade({ pnl_cents: 5 }),
			makeTrade({ pnl_cents: null }), // open
			makeTrade({ pnl_cents: -3 }),
		];
		const r = computeSharpe(trades, {
			nowMs: now,
			minDays: 0,
			minTrades: 0,
			minSharpe: 0,
		});
		expect(r.trade_count).toBe(3); // only closed
	});
});
