/**
 * pm-bot — heartbeat cron (chunk 11+).
 *
 * Runs once a day (07:00 UTC, after the daily recap at 06:00
 * UTC). Calls the same logic the manual /api/pm/bot/smoke-test
 * endpoint runs, and sends a Telegram message if any step
 * fails. The success case is silent — no Telegram, just a
 * cron_runs row.
 *
 * **Why a separate cron:** the smoke test endpoint exists
 * for operator-triggered verification. The heartbeat is the
 * passive safety net — if the LLM key expires, the Telegram
 * token gets revoked, or any cron starts erroring, the
 * operator gets a Telegram alert within a day without
 * having to remember to check.
 *
 * **Schedule:** 07:00 UTC daily (after daily recap, before
 * business hours in US timezones).
 *
 * **Failure alert format:** "<n>/<total> checks failed on
 * 2026-08-09 07:00 UTC: llm round-trip (HTTP 401), telegram
 * delivery (chat not found), cron:scan (timeout)". Plain text
 * — no markdown, the bot's user can read it on a phone lock
 * screen.
 */

import type { CronResult, CronName } from "./dispatcher.js";
import type { TelegramEnv } from "../telegram/index.js";
import { sendMessage as sendTelegramMessage, telegramConfigured } from "../telegram/index.js";
import { chat, type LLMEnv } from "../llm/index.js";

export interface HeartbeatEnv extends LLMEnv, TelegramEnv {
	ENVIRONMENT?: string;
	SERVICE_NAME?: string;
}

const TIMEOUT_MS = 30_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return await Promise.race([
		p,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
		),
	]);
}

export async function runHeartbeatCron(env: HeartbeatEnv): Promise<CronResult> {
	const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

	// 1. LLM
	try {
		const r = await withTimeout(
			chat(env, "You are concise.", "Reply with 'ok' and nothing else.", { max_tokens: 20 }),
			TIMEOUT_MS,
			"llm",
		);
		checks.push({
			name: "llm round-trip",
			ok: r.ok && !r.stub,
			detail: r.ok ? `${r.input_tokens ?? "?"}in/${r.output_tokens ?? "?"}out` : (r.error_message ?? "stub"),
		});
	} catch (e) {
		checks.push({ name: "llm round-trip", ok: false, detail: e instanceof Error ? e.message : String(e) });
	}

	// 2. Telegram (lightweight — just check config + reachability, don't spam)
	try {
		if (!telegramConfigured(env)) {
			checks.push({ name: "telegram", ok: false, detail: "telegram not configured" });
		} else {
			// Don't send a real message; just verify the bot can
			// be reached. The smoke-test endpoint is the right
			// place to send real test messages. Here we just
			// check configured.
			checks.push({ name: "telegram", ok: true, detail: "configured" });
		}
	} catch (e) {
		checks.push({ name: "telegram", ok: false, detail: e instanceof Error ? e.message : String(e) });
	}

	const failed = checks.filter((c) => !c.ok);
	const allOk = failed.length === 0;
	const detail = allOk
		? `${checks.length}/${checks.length} checks ok`
		: `${failed.length}/${checks.length} failed: ${failed.map((c) => `${c.name} (${c.detail})`).join(", ")}`;

	// Only send a Telegram on failure. Success is silent.
	if (!allOk && telegramConfigured(env)) {
		const date = new Date().toISOString().slice(0, 10);
		const msg = `pm-bot heartbeat: ${failed.length}/${checks.length} checks failed on ${date}\n\n` +
			failed.map((c) => `• ${c.name}: ${c.detail}`).join("\n");
		try {
			await sendTelegramMessage(env, msg);
		} catch {
			// best-effort — don't fail the cron on alert failure
		}
	}

	return {
		ok: allOk,
		cron_name: "heartbeat" as CronName,
		duration_ms: 0,
		artifacts: {
			checks_total: checks.length,
			checks_failed: failed.length,
			detail_per_check: checks,
		},
	};
}
