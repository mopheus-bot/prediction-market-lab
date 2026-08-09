/**
 * pm-bot — Telegram test endpoint (chunk 10.9+).
 *
 * Sends a "still alive" message via the same code path as
 * the order fill alert. Used to verify end-to-end Telegram
 * wiring without placing real orders. Hit it with:
 *
 *   curl -X POST api/pm/bot/telegram-test
 *
 * Returns the same shape as `sendMessage`:
 *   { ok: true, message_id, chat_id } on success
 *   { ok: false, error_message } on failure
 *
 * **Why this exists:** on 2026-08-08 a real test order
 * (id 7) was placed but the Telegram alert didn't fire.
 * The news cron's `telegram_configured: false` artifact
 * pointed at the env, but `wrangler secret list` showed
 * both secrets present. We needed a way to verify the
 * wiring without placing more real orders. This endpoint
 * is it.
 */

import { sendMessage, telegramConfigured } from "../telegram/index.js";
import type { TelegramEnv } from "../telegram/index.js";

export interface TelegramTestEnv extends TelegramEnv {
	ENVIRONMENT?: string;
	SERVICE_NAME?: string;
}

export async function handleTelegramTest(env: TelegramTestEnv): Promise<Response> {
	const configured = telegramConfigured(env);
	const text = [
		`🧪 pm-bot telegram test`,
		`service=${env.SERVICE_NAME ?? "pm-bot"} env=${env.ENVIRONMENT ?? "?"}`,
		`ts=${new Date().toISOString()}`,
		`configured=${configured}`,
	].join("\n");

	const tg = await sendMessage(env, text);

	return Response.json(
		{
			ok: tg.ok,
			configured,
			message_id: tg.message_id,
			chat_id: tg.chat_id,
			error_message: tg.error_message,
			preview: text.slice(0, 200),
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
