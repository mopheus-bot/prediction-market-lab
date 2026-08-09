/**
 * pm-bot — LLM test endpoint (chunk 11+).
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
import type { LLMEnv } from "../llm/index.js";

export interface LLMTestEnv extends LLMEnv {
	ENVIRONMENT?: string;
	SERVICE_NAME?: string;
}

const TEST_SYSTEM = "You are a concise assistant. Answer in one sentence.";
const TEST_USER = "Reply with the word 'pong' and nothing else.";

export async function handleLLMTest(env: LLMTestEnv): Promise<Response> {
	const model = env.MMX_MODEL ?? DEFAULT_MODEL;
	const baseUrl = env.MMX_BASE_URL ?? DEFAULT_BASE_URL;
	const result = await chat(env, TEST_SYSTEM, TEST_USER, { max_tokens: 50 });

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
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
