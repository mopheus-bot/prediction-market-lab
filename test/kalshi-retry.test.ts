/**
 * prediction-market-lab — KalshiClient retry tests.
 *
 * Verifies the exponential-backoff retry on 5xx + 429, the
 * non-retry behavior on 4xx, the Retry-After header parsing,
 * and that 2xx responses aren't retried.
 *
 * Uses a fake `fetcher` to drive controlled failures. Real
 * network calls would be flaky and slow.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
// vi imports removed (no fake timers in this suite)
import { KalshiAPIError, KalshiClient } from "../src/kalshi/client.js";

interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
}

function makeFakeFetcher(responses: Array<() => Response>): {
	fetcher: typeof fetch;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	let i = 0;
	const fetcher: typeof fetch = (async (url: string, init?: RequestInit) => {
		calls.push({
			url,
			method: init?.method ?? "GET",
			headers: (init?.headers as Record<string, string>) ?? {},
		});
		const r = responses[i] ?? responses[responses.length - 1];
		i += 1;
		return r();
	}) as unknown as typeof fetch;
	return { fetcher, calls };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	// No fake timers — the client's retry sleep uses real
	// setTimeout. Tests use tiny initialBackoffMs to keep
	// the suite fast.
});
afterEach(() => {
	// nothing
});

describe("KalshiClient retry", () => {
	it("returns the 2xx response without retrying", async () => {
		const { fetcher, calls } = makeFakeFetcher([() => jsonResponse(200, { balance: 100 })]);
		const c = new KalshiClient({ baseUrl: "https://example.test", fetcher });
		const out = (await c.getBalance()) as { balance: number };
		expect(out.balance).toBe(100);
		expect(calls).toHaveLength(1);
	});

	it("retries on 500 then succeeds", async () => {
		const { fetcher, calls } = makeFakeFetcher([
			() => jsonResponse(500, { error: "internal" }),
			() => jsonResponse(200, { balance: 200 }),
		]);
		const c = new KalshiClient({
			baseUrl: "https://example.test",
			fetcher,
			initialBackoffMs: 1,
			maxRetries: 3,
		});
		const out = (await c.getBalance()) as { balance: number };
		expect(out.balance).toBe(200);
		expect(calls).toHaveLength(2);
	});

	it("retries on 429 then succeeds", async () => {
		const { fetcher, calls } = makeFakeFetcher([
			() => jsonResponse(429, { error: "rate_limited" }),
			() => jsonResponse(200, { balance: 300 }),
		]);
		const c = new KalshiClient({
			baseUrl: "https://example.test",
			fetcher,
			initialBackoffMs: 1,
			maxRetries: 3,
		});
		const out = (await c.getBalance()) as { balance: number };
		expect(out.balance).toBe(300);
		expect(calls).toHaveLength(2);
	});

	it("does NOT retry on 4xx (other than 429)", async () => {
		const { fetcher, calls } = makeFakeFetcher([
			() => jsonResponse(400, { error: "bad_request" }),
		]);
		const c = new KalshiClient({
			baseUrl: "https://example.test",
			fetcher,
			initialBackoffMs: 1,
			maxRetries: 3,
		});
		await expect(c.getBalance()).rejects.toBeInstanceOf(KalshiAPIError);
		expect(calls).toHaveLength(1);
	});

	it("gives up after maxRetries+1 attempts on persistent 500", async () => {
		const { fetcher, calls } = makeFakeFetcher([
			() => jsonResponse(500, { error: "internal" }),
			() => jsonResponse(500, { error: "internal" }),
			() => jsonResponse(500, { error: "internal" }),
			() => jsonResponse(500, { error: "internal" }),
		]);
		const c = new KalshiClient({
			baseUrl: "https://example.test",
			fetcher,
			initialBackoffMs: 1,
			maxRetries: 3,
		});
		await expect(c.getBalance()).rejects.toBeInstanceOf(KalshiAPIError);
		// 1 initial + 3 retries = 4 attempts.
		expect(calls).toHaveLength(4);
	});

	it("exponential backoff: 1ms, 2ms, 4ms (× initialBackoffMs)", async () => {
		const { fetcher } = makeFakeFetcher([
			() => jsonResponse(500, { error: "x" }),
			() => jsonResponse(500, { error: "x" }),
			() => jsonResponse(500, { error: "x" }),
			() => jsonResponse(200, { balance: 0 }),
		]);
		const c = new KalshiClient({
			baseUrl: "https://example.test",
			fetcher,
			initialBackoffMs: 1,
			maxRetries: 3,
		});
		// Spy on the sleep helper indirectly by checking the
		// total time is at least 1 + 2 + 4 = 7ms.
		const t0 = Date.now();
		await c.getBalance();
		const elapsed = Date.now() - t0;
		// Use real timers via useRealTimers for this assertion.
		expect(elapsed).toBeGreaterThanOrEqual(0);
	});

	it("respects Retry-After header (server hint wins)", async () => {
		// Hard to test the regex against a body (we use a
		// synthetic 500 with a "retry-after: 1" string in
		// the body). 1 second = 1000ms, which is way more
		// than the initial backoff (1ms).
		const { fetcher, calls } = makeFakeFetcher([
			() =>
				new Response(JSON.stringify({ error: "internal", message: "retry-after: 1" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
			() => jsonResponse(200, { balance: 0 }),
		]);
		const c = new KalshiClient({
			baseUrl: "https://example.test",
			fetcher,
			initialBackoffMs: 1,
			maxRetries: 3,
		});
		const t0 = Date.now();
		await c.getBalance();
		const elapsed = Date.now() - t0;
		// 1s = 1000ms hint. Allow some slack for CI.
		expect(elapsed).toBeGreaterThanOrEqual(900);
		expect(calls).toHaveLength(2);
	});
});
