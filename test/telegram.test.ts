/**
 * pm-bot — Telegram bridge unit tests.
 *
 * Verifies the sendMessage wrapper against a mocked fetch.
 * The tests don't need a real bot token; they just assert
 * the right URL, payload, and failure-mode behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	chatIdOf,
	sendMarkdown,
	sendMessage,
	telegramConfigured,
} from "../src/telegram";

const ENV_OK = {
	TELEGRAM_BOT_TOKEN: "123:abc",
	TELEGRAM_CHAT_ID: "987654",
};

describe("telegramConfigured", () => {
	it("true when both bot token and chat id are set", () => {
		expect(telegramConfigured(ENV_OK)).toBe(true);
	});
	it("false when bot token is missing", () => {
		expect(telegramConfigured({ TELEGRAM_CHAT_ID: "1" })).toBe(false);
	});
	it("false when chat id is missing", () => {
		expect(telegramConfigured({ TELEGRAM_BOT_TOKEN: "1:abc" })).toBe(false);
	});
	it("false when both are missing", () => {
		expect(telegramConfigured({})).toBe(false);
	});
});

describe("chatIdOf", () => {
	it("returns a number when the env value parses as int", () => {
		expect(chatIdOf(ENV_OK)).toBe(987654);
	});
	it("returns the raw string when the value isn't a valid int", () => {
		expect(chatIdOf({ TELEGRAM_CHAT_ID: "@my_channel" })).toBe("@my_channel");
	});
	it("returns null when unset", () => {
		expect(chatIdOf({})).toBeNull();
	});
});

describe("sendMessage", () => {
	let mockFetch: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		mockFetch = vi.fn();
		// @ts-expect-error — assign mock to global
		globalThis.fetch = mockFetch;
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns ok=false when bot token is missing", async () => {
		const r = await sendMessage({}, "hi");
		expect(r.ok).toBe(false);
		expect(r.error_message).toMatch(/TELEGRAM_BOT_TOKEN/);
	});

	it("returns ok=false when chat id is missing", async () => {
		const r = await sendMessage({ TELEGRAM_BOT_TOKEN: "1:abc" }, "hi");
		expect(r.ok).toBe(false);
		expect(r.error_message).toMatch(/TELEGRAM_CHAT_ID/);
	});

	it("calls the right URL with the right payload", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				ok: true,
				result: { message_id: 42, chat: { id: 987654 } },
			}),
		});
		const r = await sendMessage(ENV_OK, "hello");
		expect(r.ok).toBe(true);
		expect(r.message_id).toBe(42);
		expect(r.chat_id).toBe(987654);
		// Verify the URL + payload.
		const [url, init] = mockFetch.mock.calls[0]!;
		expect(url).toBe(
			"https://api.telegram.org/bot123:abc/sendMessage",
		);
		expect(init.method).toBe("POST");
		const body = JSON.parse(init.body as string);
		expect(body.chat_id).toBe(987654);
		expect(body.text).toBe("hello");
	});

	it("passes parse_mode when set", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 1 } } }),
		});
		await sendMessage(ENV_OK, "**bold**", { parse_mode: "Markdown" });
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
		expect(body.parse_mode).toBe("Markdown");
	});

	it("truncates messages over 4000 chars", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 1 } } }),
		});
		const long = "x".repeat(5000);
		await sendMessage(ENV_OK, long);
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
		expect(body.text.length).toBeLessThanOrEqual(4000 + "\n…[truncated]".length);
		expect(body.text.endsWith("…[truncated]")).toBe(true);
	});

	it("returns ok=false when Telegram rejects the message", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 400,
			json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
		});
		const r = await sendMessage(ENV_OK, "hi");
		expect(r.ok).toBe(false);
		expect(r.error_message).toMatch(/Bad Request/);
	});

	it("returns ok=false when fetch throws", async () => {
		mockFetch.mockRejectedValueOnce(new Error("network down"));
		const r = await sendMessage(ENV_OK, "hi");
		expect(r.ok).toBe(false);
		expect(r.error_message).toMatch(/network down/);
	});
});

describe("sendMarkdown", () => {
	let mockFetch: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 1 } } }),
		});
		// @ts-expect-error
		globalThis.fetch = mockFetch;
	});
	afterEach(() => vi.restoreAllMocks());

	it("sends with parse_mode=Markdown", async () => {
		await sendMarkdown(ENV_OK, "**hello**");
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
		expect(body.parse_mode).toBe("Markdown");
		expect(body.text).toBe("**hello**");
	});
});
