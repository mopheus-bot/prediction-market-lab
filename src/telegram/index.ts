/**
 * prediction-market-lab — Telegram bridge.
 *
 * Thin wrapper over the Telegram Bot API. We use the HTTP
 * API directly (POST to `api.telegram.org/bot<token>/sendMessage`)
 * because Workers can't shell out to a CLI.
 *
 * **Why Telegram (per the plan):** "Telegram as primary IM
 * bridge. A secondary IM channel if a webhook URL is exposed."
 * Telegram works without the secondary channel being up, doesn't need a public
 * webhook URL (the Worker calls Telegram), and is the most
 * reliable channel for a single-user trading bot.
 *
 * **Config:**
 *   - `TELEGRAM_BOT_TOKEN` — from @BotFather
 *   - `TELEGRAM_CHAT_ID`   — your personal chat_id
 *
 * Both are bound via `wrangler secret put` so they never
 * appear in the Worker bundle or logs.
 *
 * **Failure mode:** if the bot token is missing or the API
 * call fails, the helper logs the error and returns a
 * structured failure — the caller (cron) records the
 * failure to `llm_calls` / `cron_runs` but doesn't crash.
 */

import type { Env } from "../index.js";

/** Subset of Env that the Telegram client needs. */
export interface TelegramEnv {
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
}

export interface TelegramSendResult {
	ok: boolean;
	message_id?: number;
	error_message?: string;
	chat_id?: number | string;
}

/** Parse the chat ID env (string-encoded). Returns null if not set. */
export function chatIdOf(env: TelegramEnv): number | string | null {
	const id = env.TELEGRAM_CHAT_ID;
	if (!id) return null;
	const n = parseInt(id, 10);
	return Number.isFinite(n) ? n: id;
}

/** True if the env has both bot token + chat id configured. */
export function telegramConfigured(env: TelegramEnv): boolean {
	return Boolean(env.TELEGRAM_BOT_TOKEN) && chatIdOf(env) !== null;
}

/**
 * Send a text message. Plain text + markdown by default;
 * the caller can pass HTML or `MarkdownV2` via `parse_mode`.
 * Telegram's `parse_mode` accepts "Markdown" | "MarkdownV2" |
 * "HTML" — anything else is ignored.
 *
 * Telegram caps messages at 4096 chars; we truncate at 4000
 * with a "…[truncated]" suffix to leave room for the
 * truncation marker.
 */
export async function sendMessage(
	env: TelegramEnv,
	text: string,
	opts: {
		parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
		chat_id?: number | string;
		disable_notification?: boolean;
	} = {},
): Promise<TelegramSendResult> {
	if (!env.TELEGRAM_BOT_TOKEN) {
		return { ok: false, error_message: "TELEGRAM_BOT_TOKEN not set" };
	}
	const chatId = opts.chat_id ?? chatIdOf(env);
	if (chatId === null) {
		return { ok: false, error_message: "TELEGRAM_CHAT_ID not set" };
	}
	const body = (text.length > 4000 ? text.slice(0, 4000) + "\n…[truncated]": text);
	const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
	const payload: Record<string, unknown> = {
		chat_id: chatId,
		text: body,
	};
	if (opts.parse_mode) payload.parse_mode = opts.parse_mode;
	if (opts.disable_notification !== undefined) {
		payload.disable_notification = opts.disable_notification;
	}
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		const json = (await resp.json()) as {
			ok: boolean;
			result?: { message_id: number; chat: { id: number | string } };
			description?: string;
		};
		if (!resp.ok || !json.ok) {
			return {
				ok: false,
				error_message: json.description ?? `HTTP ${resp.status}`,
				chat_id: chatId,
			};
		}
		return {
			ok: true,
			message_id: json.result?.message_id,
			chat_id: chatId,
		};
	} catch (e) {
		return {
			ok: false,
			error_message: e instanceof Error ? e.message: String(e),
			chat_id: chatId,
		};
	}
}

/**
 * Send a markdown message (parse_mode=Markdown). Convenience
 * for the cron jobs.
 */
export async function sendMarkdown(
	env: TelegramEnv,
	text: string,
	opts: { chat_id?: number | string; disable_notification?: boolean } = {},
): Promise<TelegramSendResult> {
	return sendMessage(env, text, {...opts, parse_mode: "Markdown" });
}

// Suppress unused-import warning for Env (the type is used
// implicitly via TelegramEnv — keep the import for IDE).
export type _TelegramEnv = Env;
