/**
 * prediction-market-lab — E2E smoke test endpoint.
 *
 * One-call way to verify the full operator pipeline is
 * healthy: LLM round-trip, Telegram delivery, each cron
 * runnable, cadence panel populated. Returns a structured
 * pass/fail report.
 *
 * Hit with:
 *   curl -X POST api/pm/bot/smoke-test
 *
 * Returns:
 *   { ok: <bool>, summary: { n_pass, n_fail, n_skip },
 *     results: [{ name, status, duration_ms, detail }] }
 *
 * **What it tests (in order):**
 *   1. LLM round-trip — calls the same chat() the crons use
 *      with a trivial prompt. The llm_calls row from this
 *      call also flows into the cadence + cost panels.
 *   2. Telegram delivery — sends a test message to the
 *      configured chat. Reports the message_id.
 *   3. Each cron triggerable — runs each cron (scan, news,
 *      daily, train, auto_pilot, backtest) and reports
 *      ok/error. Records the run in cron_runs.
 *   4. Cadence panel — pulls the cadence response and
 *      reports the summary (n_ok, n_error, n_off).
 *
 * **Why this exists:** on 2026-08-09 the LLM was broken
 * (wrong default API host) and went undetected for months.
 * The smoke test catches the same kind of regression in
 * <30 seconds — operator runs it once, gets a pass/fail
 * report, immediately sees if anything is off.
 *
 * Each step has a 30s timeout. The whole smoke test
 * typically takes 10-15s end-to-end.
 */

import { chat, DEFAULT_BASE_URL, DEFAULT_MODEL } from "../llm/index.js";
import { sendMessage as sendTelegramMessage, telegramConfigured } from "../telegram/index.js";
import { llmCalls as llmCallsDb, cronRuns as cronRunsDb } from "../lib/db.js";
import { CRON_TABLE, JOBS, recordRun, type CronName, type CronEnv, type CronResult } from "../cron/dispatcher.js";
import { handleCadence, type CadenceEnv } from "./cadence.js";
import { DEFAULT_USER_ID } from "../lib/types.js";

export interface SmokeTestEnv extends CadenceEnv {
	MMX_API_KEY?: string;
	MMX_BASE_URL?: string;
	MMX_MODEL?: string;
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
}

const TIMEOUT_MS = 30_000;

interface StepResult {
	name: string;
	status: "pass" | "fail" | "skip";
	duration_ms: number;
	detail: string;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return await Promise.race([
		p,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
		),
	]);
}

export async function handleSmokeTest(env: SmokeTestEnv): Promise<Response> {
	const started = Date.now();
	const results: StepResult[] = [];

	// 1. LLM round-trip
	{
		const t0 = Date.now();
		try {
			const llm = await withTimeout(
				chat(env, "You are a concise assistant.", "Reply with the word 'pong' and nothing else.", { max_tokens: 50 }),
				TIMEOUT_MS,
				"llm",
			);
			if (!llm.ok) {
				results.push({ name: "llm round-trip", status: "fail", duration_ms: Date.now() - t0, detail: llm.error_message ?? "unknown error" });
			} else if (llm.stub) {
				results.push({ name: "llm round-trip", status: "fail", duration_ms: Date.now() - t0, detail: "returned stub (MMX_API_KEY not configured)" });
			} else {
				results.push({ name: "llm round-trip", status: "pass", duration_ms: Date.now() - t0, detail: `model=${llm.stub ? "stub": DEFAULT_MODEL} tokens=${llm.input_tokens ?? "?"}in/${llm.output_tokens ?? "?"}out text=${JSON.stringify(llm.text).slice(0, 60)}` });
				// Also record to D1 so the cadence + cost panels
				// reflect the smoke test.
				if (env.DB) {
					await llmCallsDb.insert(env.DB, {
						user_id: DEFAULT_USER_ID,
						ts: Date.now(),
						purpose: "smoke_test",
						model: env.MMX_MODEL ?? DEFAULT_MODEL,
						ticker: null,
						input_tokens_est: llm.input_tokens ?? 0,
						output_tokens_est: llm.output_tokens ?? 0,
						duration_ms: llm.duration_ms,
						status: "success",
						error_message: null,
					}).catch(() => {});
				}
			}
		} catch (e) {
			results.push({ name: "llm round-trip", status: "fail", duration_ms: Date.now() - t0, detail: e instanceof Error ? e.message: String(e) });
		}
	}

	// 2. Telegram delivery
	{
		const t0 = Date.now();
		try {
			if (!telegramConfigured(env)) {
				results.push({ name: "telegram delivery", status: "fail", duration_ms: Date.now() - t0, detail: "telegram not configured (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID missing)" });
			} else {
				const tg = await withTimeout(
					sendTelegramMessage(env, `🧪 prediction-market-lab smoke test · ${new Date().toISOString()}`),
					TIMEOUT_MS,
					"telegram",
				);
				if (tg.ok) {
					results.push({ name: "telegram delivery", status: "pass", duration_ms: Date.now() - t0, detail: `message_id=${tg.message_id} chat_id=${tg.chat_id}` });
				} else {
					results.push({ name: "telegram delivery", status: "fail", duration_ms: Date.now() - t0, detail: tg.error_message ?? "unknown error" });
				}
			}
		} catch (e) {
			results.push({ name: "telegram delivery", status: "fail", duration_ms: Date.now() - t0, detail: e instanceof Error ? e.message: String(e) });
		}
	}

	// 3. Each cron triggerable
	for (const [name] of Object.entries(CRON_TABLE)) {
		const cronName = name as CronName;
		const job = JOBS[cronName];
		if (!job) {
			results.push({ name: `cron:${cronName}`, status: "skip", duration_ms: 0, detail: "no job registered" });
			continue;
		}
		const t0 = Date.now();
		try {
			const startedCron = Date.now();
			const artifacts = await withTimeout(job(env), TIMEOUT_MS, `cron:${cronName}`);
			const result: CronResult = {
				ok: true,
				cron_name: cronName,
				duration_ms: Date.now() - startedCron,
				artifacts: artifacts as unknown as Record<string, unknown>,
			};
			await recordRun(env, result);
			const detail = result.artifacts ? JSON.stringify(result.artifacts).slice(0, 100): "ok";
			results.push({ name: `cron:${cronName}`, status: "pass", duration_ms: Date.now() - t0, detail });
		} catch (e) {
			const result: CronResult = {
				ok: false,
				cron_name: cronName,
				duration_ms: Date.now() - t0,
				error_message: e instanceof Error ? e.message: String(e),
			};
			await recordRun(env, result);
			results.push({ name: `cron:${cronName}`, status: "fail", duration_ms: Date.now() - t0, detail: result.error_message ?? "unknown error" });
		}
	}

	// 4. Cadence panel — should be all-ok if 1-3 passed
	{
		const t0 = Date.now();
		try {
			const cadenceResp = await handleCadence(env, new URL("https://bot/api/pm/cadence"));
			const data = await cadenceResp.json() as { ok: boolean; summary?: { n_ok: number; n_error: number; n_off: number } };
			if (data.ok && data.summary) {
				const s = data.summary;
				const allOk = s.n_error === 0 && s.n_off === 0;
				results.push({
					name: "cadence panel",
					status: allOk ? "pass": "fail",
					duration_ms: Date.now() - t0,
					detail: `${s.n_ok} ok · ${s.n_error} error · ${s.n_off} off`,
				});
			} else {
				results.push({ name: "cadence panel", status: "fail", duration_ms: Date.now() - t0, detail: "cadence returned non-ok" });
			}
		} catch (e) {
			results.push({ name: "cadence panel", status: "fail", duration_ms: Date.now() - t0, detail: e instanceof Error ? e.message: String(e) });
		}
	}

	// Summary
	const nPass = results.filter((r) => r.status === "pass").length;
	const nFail = results.filter((r) => r.status === "fail").length;
	const nSkip = results.filter((r) => r.status === "skip").length;
	const ok = nFail === 0;

	return Response.json(
		{
			ok,
			summary: { n_pass: nPass, n_fail: nFail, n_skip: nSkip, total_duration_ms: Date.now() - started },
			results,
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
