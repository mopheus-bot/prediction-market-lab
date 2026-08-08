/**
 * pm-bot — backtest unit tests (chunk 11a).
 *
 * Pins the metrics math for the model retrospective. Pure
 * functions — no I/O, no D1.
 */

import { describe, it, expect } from "vitest";
import { computeBacktestMetrics, metricsSummary } from "../src/lib/backtest.js";
import type { TradeRow } from "../src/lib/types.js";

function makeTrade(overrides: Partial<TradeRow> = {}): TradeRow {
	return {
		id: 1,
		user_id: "default",
		ts: 1700000000000,
		ticker: "KXWARMING-50",
		vertical: "weather",
		side: "yes",
		action: "open",
		price_cents: 50,
		size: 1,
		signal_p: 0.7,
		signal_rationale: "test",
		model_version: "v1",
		pnl_cents: null,
		fill_type: "taker",
		is_paper: 1,
		trading_mode: "paper",
		real_order_id: null,
		...overrides,
	};
}

describe("computeBacktestMetrics (chunk 11a)", () => {
	const now = 1700000000000;
	const windowDays = 7;
	const windowMs = windowDays * 24 * 60 * 60 * 1000;

	it("returns zeros + NaN for an empty trade list", () => {
		const m = computeBacktestMetrics([], now, windowDays);
		expect(m.trade_count).toBe(0);
		expect(m.wins).toBe(0);
		expect(m.losses).toBe(0);
		expect(m.pending).toBe(0);
		expect(Number.isNaN(m.win_rate)).toBe(true);
		expect(m.total_pnl_cents).toBe(0);
		expect(Number.isNaN(m.model_agreement_rate)).toBe(true);
	});

	it("counts wins + losses + computes win_rate", () => {
		const trades: TradeRow[] = [
			makeTrade({ id: 1, pnl_cents: 100, signal_p: 0.7 }),
			makeTrade({ id: 2, pnl_cents: -50, signal_p: 0.6 }),
			makeTrade({ id: 3, pnl_cents: 200, signal_p: 0.8 }),
		];
		const m = computeBacktestMetrics(trades, now, windowDays);
		expect(m.trade_count).toBe(3);
		expect(m.wins).toBe(2);
		expect(m.losses).toBe(1);
		expect(m.win_rate).toBeCloseTo(0.6667, 3);
		expect(m.total_pnl_cents).toBe(250);
		expect(m.avg_pnl_cents).toBeCloseTo(83.3333, 3);
	});

	it("counts pending trades (pnl_cents === null) separately", () => {
		const trades: TradeRow[] = [
			makeTrade({ id: 1, pnl_cents: 100 }),
			makeTrade({ id: 2, pnl_cents: null }), // open
			makeTrade({ id: 3, pnl_cents: null }), // open
		];
		const m = computeBacktestMetrics(trades, now, windowDays);
		expect(m.trade_count).toBe(3);
		expect(m.pending).toBe(2);
		expect(m.wins).toBe(1);
		expect(m.losses).toBe(0);
		// win_rate = wins / (wins + losses) — pending excluded
		expect(m.win_rate).toBe(1);
	});

	it("computes model_agreement_rate (signal_p > 0.5 + pnl > 0 = agreement)", () => {
		const trades: TradeRow[] = [
			makeTrade({ id: 1, signal_p: 0.7, pnl_cents: 100 }), // agree
			makeTrade({ id: 2, signal_p: 0.6, pnl_cents: -50 }), // disagree
			makeTrade({ id: 3, signal_p: 0.8, pnl_cents: 200 }), // agree
			makeTrade({ id: 4, signal_p: 0.4, pnl_cents: 100 }), // disagree (low p + win)
		];
		const m = computeBacktestMetrics(trades, now, windowDays);
		expect(m.model_agreement_count).toBe(2);
		expect(m.model_agreement_rate).toBe(0.5);
	});

	it("ignores trades outside the window", () => {
		const oldTrade = makeTrade({ id: 1, ts: now - windowMs - 1000, pnl_cents: 100 });
		const recentTrade = makeTrade({ id: 2, ts: now - 1000, pnl_cents: -50 });
		const m = computeBacktestMetrics([oldTrade, recentTrade], now, windowDays);
		expect(m.trade_count).toBe(1);
		expect(m.wins).toBe(0);
		expect(m.losses).toBe(1);
	});

	it("aggregates per-vertical stats", () => {
		const trades: TradeRow[] = [
			makeTrade({ id: 1, vertical: "weather", pnl_cents: 100 }),
			makeTrade({ id: 2, vertical: "weather", pnl_cents: -50 }),
			makeTrade({ id: 3, vertical: "economic", pnl_cents: 200 }),
		];
		const m = computeBacktestMetrics(trades, now, windowDays);
		expect(m.verticals.weather.trades).toBe(2);
		expect(m.verticals.weather.wins).toBe(1);
		expect(m.verticals.weather.pnl_cents).toBe(50);
		expect(m.verticals.economic.trades).toBe(1);
		expect(m.verticals.economic.wins).toBe(1);
		expect(m.verticals.economic.pnl_cents).toBe(200);
	});
});

describe("metricsSummary (chunk 11a)", () => {
	it("returns 'no trades in window' for empty metrics", () => {
		const m = computeBacktestMetrics([], 1700000000000, 7);
		expect(metricsSummary(m)).toBe("no trades in window");
	});

	it("formats non-empty metrics with all key numbers", () => {
		const trades: TradeRow[] = [
			makeTrade({ id: 1, pnl_cents: 100, signal_p: 0.7 }),
			makeTrade({ id: 2, pnl_cents: -50, signal_p: 0.6 }),
		];
		const m = computeBacktestMetrics(trades, 1700000000000, 7);
		const s = metricsSummary(m);
		expect(s).toContain("trades=2");
		expect(s).toContain("wins=1");
		expect(s).toContain("losses=1");
		expect(s).toContain("pending=0");
		expect(s).toContain("win_rate=50%");
		expect(s).toContain("model_agreement=50%");
		expect(s).toContain("pnl=50¢ (0.50)");
	});
});
