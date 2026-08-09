/**
 * pm-bot — LLM client (chunk 6).
 *
 * The Python `advisor.py` uses the `mmx` CLI to call the
 * MiniMax Messages API. In Workers we can't shell out, so
 * we call the API directly via HTTP.
 *
 * **Model:** `MiniMax-M3` — per the plan's
 * "don't compromise quality for cost" decision. (Updated
 * 2026-08-08 from `MiniMax-M2.7-highspeed` to M3 — user
 * preference. Still on personal MMX token, no quality
 * compromise.)
 *
 * **Env (set via `wrangler secret put`):**
 *   - `MMX_API_KEY` — the API key
 *   - `MMX_BASE_URL` (optional) — the API base URL (defaults
 *     to `https://api.mmx.com/v1`)
 *
 * **Stub mode:** when `MMX_API_KEY` is not set, the client
 * returns a stub response. This lets the cron jobs run
 * without an LLM key configured (the news-cron will
 * "succeed" with the stub; the daily-cron is unaffected).
 *
 * The LLM is purely advisory — it never sends orders.
 */

export interface LLMMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface LLMEnv {
	MMX_API_KEY?: string;
	MMX_BASE_URL?: string;
	MMX_MODEL?: string;
}

export interface LLMResult {
	ok: boolean;
	text: string;
	input_tokens?: number;
	output_tokens?: number;
	duration_ms: number;
	error_message?: string;
	/** True when the LLM_API_KEY is missing and we returned a stub. */
	stub: boolean;
}

export const DEFAULT_MODEL = "MiniMax-M3";
// The MiniMax (M3) API host. Per platform.minimax.io/docs/token-plan/intro,
// the Token Plan Subscription Key hits api.minimax.io (international).
// api.minimax.chat returns 400 as of 2026-08-09. For China-based users,
// set MMX_BASE_URL=https://api.minimaxi.com/v1 to override.
export const DEFAULT_BASE_URL = "https://api.minimax.io/v1";

/**
 * Call the LLM with a system + user prompt. Returns the
 * assistant text. Times the call + records token usage.
 */
export async function chat(
	env: LLMEnv,
	system: string,
	user: string,
	opts: { max_tokens?: number; model?: string } = {},
): Promise<LLMResult> {
	const model = opts.model ?? env.MMX_MODEL ?? DEFAULT_MODEL;
	const baseUrl = env.MMX_BASE_URL ?? DEFAULT_BASE_URL;
	const started = Date.now();

	if (!env.MMX_API_KEY) {
		// Stub mode: the user hasn't configured mmx yet.
		// Return a deterministic stub so callers can be
		// tested without a real API. The caller should still
		// log the call to `llm_calls` so the observability is
		// intact.
		return {
			ok: true,
			text: stubResponse(system, user),
			input_tokens: 0,
			output_tokens: 0,
			duration_ms: 0,
			stub: true,
		};
	}

	const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
	const payload = {
		model,
		max_tokens: opts.max_tokens ?? 1000,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
	};

	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${env.MMX_API_KEY}`,
				"x-api-key": env.MMX_API_KEY,
			},
			body: JSON.stringify(payload),
		});
		const json = (await resp.json()) as {
			choices?: Array<{ message: { content: string } }>;
			usage?: { prompt_tokens: number; completion_tokens: number };
			error?: { message: string };
		};
		if (!resp.ok || !json.choices || json.choices.length === 0) {
			return {
				ok: false,
				text: "",
				duration_ms: Date.now() - started,
				error_message: json.error?.message ?? `HTTP ${resp.status}`,
				stub: false,
			};
		}
		// MiniMax-M3 is a reasoning model that wraps its output
		// in <think>...</think>. Strip the block before
		// returning so callers (news-cron verdict matching,
		// daily-cron Telegram post) get clean text. If the
		// model ever drops the think block, the regex just
		// no-ops and the full text passes through.
		const raw = json.choices[0].message.content;
		const thinkMatch = raw.match(/<think>[\s\S]*?<\/think>([\s\S]*)/);
		const text = (thinkMatch ? thinkMatch[1] : raw).trim();
		return {
			ok: true,
			text,
			input_tokens: json.usage?.prompt_tokens,
			output_tokens: json.usage?.completion_tokens,
			duration_ms: Date.now() - started,
			stub: false,
		};
	} catch (e) {
		return {
			ok: false,
			text: "",
			duration_ms: Date.now() - started,
			error_message: e instanceof Error ? e.message : String(e),
			stub: false,
		};
	}
}

/**
 * Deterministic stub response. Used when MMX_API_KEY is missing.
 * Returns a "no-op" message that callers can detect + handle.
 * The daily-cron's prompt produces a daily summary; the
 * news-cron's prompt produces a verdict. We look at the system
 * prompt to choose which stub to return.
 */
function stubResponse(system: string, _user: string): string {
	if (system.toLowerCase().includes("verdict")) {
		// News-cron: "INTACT" — no action needed.
		return "INTACT — stub LLM response (MMX_API_KEY not configured).";
	}
	if (system.toLowerCase().includes("recap") || system.toLowerCase().includes("daily")) {
		// Daily-cron: a minimal one-line summary.
		return "_Stub daily recap — MMX_API_KEY not configured. Set the key + redeploy to enable real reports._";
	}
	// Generic fallback.
	return "(stub LLM response — MMX_API_KEY not configured)";
}
