/**
 * pm-bot — cost-monthly unit tests (chunk 10.5).
 *
 * Pins the math for the new cf_monthly and fly_relay
 * sections of /api/pm/cost. The 7d → 30d extrapolation,
 * the days_until_reset computation, and the Fly.io rate
 * math are all fragile enough to deserve explicit tests.
 */

import { describe, it, expect } from "vitest";

// ─── cf_monthly math (mirrors computeCfMonthly) ─────────────

interface CfMonthlySection {
	period: "since_billing_cycle_start";
	days_elapsed: number;
	days_until_reset: number;
	resets_on: string;
	requests: { current: number; limit: number; pct: number; overage_units: number };
	cpu_ms: { current: number; limit: number; pct: number; overage_units: number };
	d1_writes_24h: { current: number; limit: number; pct: number };
	r2_storage_gb: { current: number; limit: number; pct: number };
}

const INCLUDED = {
	requests: 10_000_000,
	cpuMs: 30_000_000,
	d1Writes: 100_000,
	r2GB: 10,
};

function addDays(iso: string, n: number): string {
	const d = new Date(iso + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
	return Math.round(
		(new Date(b + "T00:00:00Z").getTime() -
			new Date(a + "T00:00:00Z").getTime()) /
			86400000,
	);
}

function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}

function computeCfMonthly(
	cycleStart: string,
	requests7d: number,
	cpuMs7d: number,
	d1Writes24h: number,
	r2StorageGB: number,
	today: string,
): CfMonthlySection {
	const daysElapsed = Math.max(1, daysBetween(cycleStart, today));
	const daysInCycle = 30;
	const daysUntilReset = Math.max(0, daysInCycle - daysElapsed);
	const resetsOn = addDays(cycleStart, daysInCycle);
	const requestsScaled = Math.round((requests7d * daysElapsed) / 7);
	const cpuMsScaled = Math.round((cpuMs7d * daysElapsed) / 7);
	return {
		period: "since_billing_cycle_start",
		days_elapsed: daysElapsed,
		days_until_reset: daysUntilReset,
		resets_on: resetsOn,
		requests: {
			current: requestsScaled,
			limit: INCLUDED.requests,
			pct: round4((requestsScaled / INCLUDED.requests) * 100),
			overage_units: Math.max(0, requestsScaled - INCLUDED.requests),
		},
		cpu_ms: {
			current: cpuMsScaled,
			limit: INCLUDED.cpuMs,
			pct: round4((cpuMsScaled / INCLUDED.cpuMs) * 100),
			overage_units: Math.max(0, cpuMsScaled - INCLUDED.cpuMs),
		},
		d1_writes_24h: {
			current: d1Writes24h,
			limit: INCLUDED.d1Writes,
			pct: round4((d1Writes24h / INCLUDED.d1Writes) * 100),
		},
		r2_storage_gb: {
			current: r2StorageGB,
			limit: INCLUDED.r2GB,
			pct: round4((r2StorageGB / INCLUDED.r2GB) * 100),
		},
	};
}

describe("computeCfMonthly (chunk 10.5)", () => {
	it("scales 7d usage to elapsed days correctly", () => {
		// 1000 requests in last 7d, day 7 of cycle
		// → scaled = 1000 (7/7) = 1000
		const r = computeCfMonthly("2026-08-01", 1000, 0, 0, 0, "2026-08-08");
		expect(r.requests.current).toBe(1000);
	});

	it("scales 7d usage to half-cycle correctly", () => {
		// 1000 requests in 7d, day 14 of cycle
		// (2026-08-15 - 2026-08-01 = 14 days elapsed)
		// → scaled = 1000 × (14/7) = 2000
		const r = computeCfMonthly("2026-08-01", 1000, 0, 0, 0, "2026-08-15");
		expect(r.days_elapsed).toBe(14);
		expect(r.requests.current).toBe(2000);
	});

	it("computes days_until_reset from elapsed days", () => {
		const r = computeCfMonthly("2026-08-01", 0, 0, 0, 0, "2026-08-08");
		expect(r.days_elapsed).toBe(7);
		expect(r.days_until_reset).toBe(23);
		expect(r.resets_on).toBe("2026-08-31");
	});

	it("marks overage_units when usage > limit", () => {
		// 50M requests in 7d, day 7 → scaled = 50M
		// → 40M over the 10M limit
		const r = computeCfMonthly("2026-08-01", 50_000_000, 0, 0, 0, "2026-08-08");
		expect(r.requests.overage_units).toBe(40_000_000);
		expect(r.requests.pct).toBe(500);
	});

	it("clamps days_elapsed at minimum 1 (today==cycleStart)", () => {
		const r = computeCfMonthly("2026-08-08", 0, 0, 0, 0, "2026-08-08");
		expect(r.days_elapsed).toBe(1); // not 0
		expect(r.days_until_reset).toBe(29);
	});

	it("clamps days_until_reset at 0 (past cycle end)", () => {
		const r = computeCfMonthly("2026-08-01", 0, 0, 0, 0, "2026-10-01");
		expect(r.days_until_reset).toBe(0);
	});
});

// ─── Fly.io rate math (mirrors FLY_PRICING) ─────────────────

const FLY = {
	pricePerMonth: 1.94,
	pricePerHour: 1.94 / 730,
};

describe("Fly.io relay pricing (chunk 10.5)", () => {
	it("hourly rate is 1.94 / 730", () => {
		expect(round4(FLY.pricePerHour)).toBe(0.0027);
	});

	it("monthly cost for 24/7 = $1.94", () => {
		const cost = 24 * 30 * FLY.pricePerHour; // 720h ≈ 1 month
		expect(round4(cost)).toBe(1.9134); // ≈ 1.94
	});

	it("free credit decrement", () => {
		const freeCredit = 0.83;
		const cost = 24 * 5 * FLY.pricePerHour; // 5 days × 24h
		const remaining = Math.max(0, freeCredit - cost);
		// 120h × 0.002658... = 0.3192
		// 0.83 - 0.32 = 0.51
		expect(round4(remaining)).toBeCloseTo(0.5108, 3);
	});

	// Chunk 10.7: when the Fly.io API returns 404 (machine-scoped
	// token can't see its own app), we assume 1 machine running 24/7
	// and surface `status: "assumed_running"` instead of "not_deployed"
	// (which would zero the cost). This pins the math.
	it("assumed_running falls back to 1 machine × 24/7", () => {
		const freeCredit = 0.83;
		const assumedMachines = 1;
		const hoursThisMonth = 24 * 30 * assumedMachines; // 720h
		const cost = hoursThisMonth * FLY.pricePerHour;
		const remaining = Math.max(0, freeCredit - cost);
		// ~12.3 days of 24/7 are covered by the $0.83 free credit
		const daysCovered = (freeCredit / cost) * 30;
		expect(round4(cost)).toBeCloseTo(1.9134, 3);
		expect(daysCovered).toBeGreaterThan(11);
		expect(daysCovered).toBeLessThan(14);
		expect(round4(remaining)).toBe(0); // cost > credit
	});
});
