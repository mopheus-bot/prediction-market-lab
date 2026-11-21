/**
 * prediction-market-lab — LLM test endpoint.
 *
 * Sends a fixed test prompt to the configured MiniMax-M3
 * endpoint and returns the full result (text + tokens +
 * duration + model + base URL). Mirrors the telegram-test
 * pattern: a one-call way to verify the LLM wiring without
 * waiting for the next scheduled cron.
 *
 * Hit with:
 *   curl -X POST api/pm/bot/llm-test
 *
 * Returns the same shape as `chat()`:
 *   { ok, text, input_tokens, output_tokens, duration_ms,
 *     model, base_url, stub, error_message }
 *
 * **Why this exists:** on 2026-08-09 the LLM service in
 * the cadence panel was stuck on 'error' — the bug was a
 * typo'd API host (api.mmx.com) in the default base URL.
 * After fixing the host, there was no way to verify the
 * fix without waiting for the next scheduled cron (news
 * = every 6h, daily = 06:00 UTC). This endpoint is it.
 *
 * The test prompt asks M3 a deliberately short, easy
 * question so the response is fast and the tokens-used
 * count is non-zero (proves a real round-trip, not a
 * stub).
 */

import { chat, DEFAULT_BASE_URL, DEFAULT_MODEL } from "../llm/index.js";
import { llmCalls as llmCallsDb } from "../lib/db.js";
import { DEFAULT_USER_ID } from "../lib/types.js";
import type { LLMEnv } from "../llm/index.js";

export interface LLMTestEnv extends LLMEnv {
	ENVIRONMENT?: string;
	SERVICE_NAME?: string;
	DB?: D1Database;
}

const TEST_SYSTEM = "You are a concise assistant. Answer in one sentence.";
const TEST_USER = "Reply with the word 'pong' and nothing else.";

export async function handleLLMTest(env: LLMTestEnv): Promise<Response> {
	const model = env.MMX_MODEL ?? DEFAULT_MODEL;
	const baseUrl = env.MMX_BASE_URL ?? DEFAULT_BASE_URL;
	const result = await chat(env, TEST_SYSTEM, TEST_USER, { max_tokens: 50 });

	// Record the call to the llm_calls D1 table so the
	// cadence panel + cost estimate update immediately.
	// The test calls show up in `costSince` (last 24h
	// aggregate) just like real cron-driven calls. The
	// purpose = 'llm_test' distinguishes them in the
	// raw llm_calls table.
	if (env.DB) {
		try {
			await llmCallsDb.insert(env.DB, {
				user_id: DEFAULT_USER_ID,
				ts: Date.now(),
				purpose: "llm_test",
				model,
				ticker: null,
				input_tokens_est: result.input_tokens ?? 0,
				output_tokens_est: result.output_tokens ?? 0,
				duration_ms: result.duration_ms,
				status: result.ok ? "success": "error",
				error_message: result.error_message ?? null,
			});
		} catch (e) {
			console.error(`[llm-test] failed to log llm_call`, e);
		}
	}

	return Response.json(
		{
			ok: result.ok,
			text: result.text,
			input_tokens: result.input_tokens,
			output_tokens: result.output_tokens,
			duration_ms: result.duration_ms,
			model,
			base_url: baseUrl,
			stub: result.stub,
			error_message: result.error_message,
			test_prompt: { system: TEST_SYSTEM, user: TEST_USER },
			logged_to_d1: !!env.DB,
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
