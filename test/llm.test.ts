/**
 * prediction-market-lab — LLM client unit tests.
 *
 * Verifies:
 *   - Stub mode kicks in when MMX_API_KEY is missing.
 *   - Stub response is correct for the news-cron prompt
 *     (verdict-style) vs the daily-cron prompt (recap-style).
 *   - HTTP path: a mocked fetch returns the expected text +
 *     token counts. Errors propagate as ok=false.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chat, DEFAULT_BASE_URL, DEFAULT_MODEL } from "../src/llm";

describe("LLM client — stub mode", () => {
	it("returns a stub when MMX_API_KEY is missing", async () => {
		const r = await chat({}, "verdict", "ticker KXWARMING-50");
		expect(r.ok).toBe(true);
		expect(r.stub).toBe(true);
		expect(r.duration_ms).toBe(0);
	});

	it("returns a verdict-style stub for the news-cron prompt", async () => {
		const sys = "You are a quant analyst. Output a 2-3 sentence verdict: INTACT / AT RISK / BROKEN";
		const r = await chat({}, sys, "ticker KXWARMING-50");
		expect(r.text).toMatch(/INTACT/);
	});

	it("returns a recap-style stub for the daily-cron prompt", async () => {
		const sys = "Output a one-page daily recap";
		const r = await chat({}, sys, "trades: 0");
		expect(r.text).toMatch(/Stub/);
		expect(r.text).toMatch(/MMX_API_KEY/);
	});

	it("returns a generic stub for other prompts", async () => {
		const r = await chat({}, "compute something", "x");
		expect(r.text).toMatch(/stub/);
	});
});

describe("LLM client — HTTP path", () => {
	let mockFetch: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		mockFetch = vi.fn();
		// @ts-expect-error
		globalThis.fetch = mockFetch;
	});
	afterEach(() => vi.restoreAllMocks());

	it("calls the right URL with bearer + x-api-key auth", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				choices: [{ message: { content: "hello" } }],
				usage: { prompt_tokens: 50, completion_tokens: 25 },
			}),
		});
		const r = await chat(
			{ MMX_API_KEY: "test-key" },
			"system",
			"user",
			{ max_tokens: 500 },
		);
		expect(r.ok).toBe(true);
		expect(r.text).toBe("hello");
		expect(r.input_tokens).toBe(50);
		expect(r.output_tokens).toBe(25);
		expect(r.stub).toBe(false);
		// Verify URL + headers.
		const [url, init] = mockFetch.mock.calls[0]!;
		expect(url).toBe(`${DEFAULT_BASE_URL}/chat/completions`);
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer test-key");
		expect(headers["x-api-key"]).toBe("test-key");
		expect(headers["content-type"]).toBe("application/json");
		const body = JSON.parse(init.body as string);
		expect(body.messages).toEqual([
			{ role: "system", content: "system" },
			{ role: "user", content: "user" },
		]);
		expect(body.max_tokens).toBe(500);
	});

	it("uses the default model when none specified", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: "ok" } }] }),
		});
		await chat({ MMX_API_KEY: "k" }, "s", "u");
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
		expect(body.model).toBe(DEFAULT_MODEL);
	});

	it("uses the override model when given", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: "ok" } }] }),
		});
		await chat({ MMX_API_KEY: "k" }, "s", "u", { model: "custom-model" });
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
		expect(body.model).toBe("custom-model");
	});

	it("returns ok=false on HTTP error", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 401,
			json: async () => ({ error: { message: "Unauthorized" } }),
		});
		const r = await chat({ MMX_API_KEY: "k" }, "s", "u");
		expect(r.ok).toBe(false);
		expect(r.error_message).toBe("Unauthorized");
	});

	it("returns ok=false on fetch throw", async () => {
		mockFetch.mockRejectedValueOnce(new Error("network down"));
		const r = await chat({ MMX_API_KEY: "k" }, "s", "u");
		expect(r.ok).toBe(false);
		expect(r.error_message).toMatch(/network down/);
	});
});
