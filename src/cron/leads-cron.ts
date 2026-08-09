/**
 * pm-bot — leads-cron (chunk 11+).
 *
 * Runs daily (02:00 UTC, after backtest on Sunday and before
 * auto_pilot). Asks the LLM which Kalshi tickers to ADD to the
 * bot's universe and which to DROP. Writes the suggestions to
 * the `lead_suggestions` D1 table; the operator reviews them on
 * the Dev page and clicks Approve / Reject.
 *
 * **The pipeline (this is the spec the user agreed to on
 * 2026-08-09):**
 *   - Daily 02:00 UTC, M3 reads current state + recent
 *     per-ticker performance + rejected-list, returns
 *     `{add: [...], drop: [...], reasoning}`.
 *   - We validate format, dedupe, and write to D1.
 *   - The previous run's `pending` rows are marked
 *     `superseded` (preserved for history) — the Dev
 *     page always shows the latest suggestions, never
 *     a queue of undecided rows.
 *   - Operator clicks Approve → POST /api/pm/bot/start
 *     with the new ticker universe → bot restarts.
 *   - Operator clicks Reject → row is marked `rejected`,
 *     and the cron won't re-suggest the same ticker for
 *     30 days.
 *
 * **Why daily, not weekly:** the queue is bounded by
 * "what the bot thinks *now*." Daily is cheap (one LLM
 * call) and means you come back Monday to fresh
 * suggestions, not a week-old queue.
 *
 * **Why a separate cron (not folded into daily-recap or
 * the backtest):** the backtest is weekly, the daily
 * recap writes R2, and lead generation needs to know
 * about the latest backtest results when they exist
 * (Sunday) but still run on days the backtest didn't.
 *
 * **The LLM call is recorded to `llm_calls` with
 * purpose='leads_cron' so the cadence + cost panels
 * update immediately.**
 *
 * **What "retargeting" means here:** the user originally
 * asked for lead generation + retargeting. We're
 * scoping to add + drop for now (per the 2026-08-09
 * conversation); vertical-cap rebalancing is a future
 * extension once we have more than ~7 closed trades.
 *
 * **Operator workflow:**
 *   1. Open /app/dev → "Lead suggestions" panel.
 *   2. See 1-3 add suggestions + 0-1 drop suggestions.
 *   3. Click Approve / Reject per card.
 *   4. Approve an `add` → ticker joins the universe
 *      (bot restarts); approve a `drop` → ticker leaves.
 *   5. Cron tomorrow will replace any rows you didn't
 *      touch.
 */

import type { CronResult } from "./dispatcher.js";
import { DEFAULT_USER_ID, type NewLeadSuggestion, type Vertical } from "../lib/types.js";
import { leadSuggestions as leadSuggestionsDb, llmCalls as llmCallsDb, signals as signalsDb, trades as tradesDb } from "../lib/db.js";
import { chat, DEFAULT_MODEL, type LLMEnv } from "../llm/index.js";

const KALSHI_TICKER_RE = /^KX[A-Z0-9][A-Z0-9-]{1,14}$/;
const VERTICALS: Vertical[] = ["weather", "economic", "politics", "sports"];

// 30 days. After this long, the cron may re-suggest a
// ticker the operator previously rejected — markets
// change, strategies change, and a "no" from last
// month shouldn't bind us forever.
const REJECT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT = `You are advising a Kalshi trading bot on which markets to add or remove from its universe. The bot runs mean-reversion strategies on weather + economic markets, and naive (high-confidence) strategies on politics + sports. You output STRICT JSON only — no prose, no markdown fences, no commentary. Suggestions must be real Kalshi tickers in the format KX followed by 2-12 uppercase letters, digits, or hyphens (e.g. KXWARMING-50, KXGDP-Q3, KXPRES-26). Do not invent tickers — if you are not sure a ticker exists, do not include it. For "add", suggest 1-3 new markets that fit the bot's profile and diversify the existing universe. For "drop", suggest at most 1 ticker from the current universe that is clearly underperforming (no signals, negative PnL, or stale for 30+ days). If nothing is clearly droppable, return an empty drop array — silence is honest.`;

export interface LeadsCronEnv extends LLMEnv {
	DB?: D1Database;
	LIVE_BOT?: DurableObjectNamespace;
}

export interface BotState {
	tickers: string[];
	ticker_verticals: Record<string, string>;
	bankroll_cents: number;
	max_notional_cents_per_trade: number;
	daily_notional_cents_cap: number;
	trading_mode: string;
	per_vertical_max_notional_cents: Record<string, number> | null;
}

interface TickerStats {
	ticker: string;
	vertical: string;
	n_signals_30d: number;
	n_trades_30d: number;
	pnl_cents_30d: number;
	last_signal_ms: number | null;
	days_since_last_signal: number | null;
}

async function readBotState(env: LeadsCronEnv, userId: string): Promise<BotState | null> {
	if (!env.LIVE_BOT) return null;
	try {
		const id = env.LIVE_BOT.idFromName(`user:${userId}`);
		const stub = env.LIVE_BOT.get(id);
		const resp = await stub.fetch("https://bot/status");
		if (!resp.ok) return null;
		const data = (await resp.json()) as {
			config?: {
				tickers?: string[];
				ticker_verticals?: Record<string, string>;
				bankroll_cents?: number;
				max_notional_cents_per_trade?: number;
				daily_notional_cents_cap?: number;
				trading_mode?: string;
				per_vertical_max_notional_cents?: Record<string, number> | null;
			};
		};
		const cfg = data.config ?? {};
		return {
			tickers: cfg.tickers ?? [],
			ticker_verticals: cfg.ticker_verticals ?? {},
			bankroll_cents: cfg.bankroll_cents ?? 0,
			max_notional_cents_per_trade: cfg.max_notional_cents_per_trade ?? 0,
			daily_notional_cents_cap: cfg.daily_notional_cents_cap ?? 0,
			trading_mode: cfg.trading_mode ?? "paper",
			per_vertical_max_notional_cents: cfg.per_vertical_max_notional_cents ?? null,
		};
	} catch (e) {
		console.warn("[leads] failed to read bot status", e);
		return null;
	}
}

async function readTickerStats(
	env: LeadsCronEnv,
	userId: string,
	tickers: string[],
): Promise<Map<string, TickerStats>> {
	const out = new Map<string, TickerStats>();
	if (!env.DB || tickers.length === 0) return out;
	const now = Date.now();
	const since30d = now - 30 * 24 * 60 * 60 * 1000;

	for (const t of tickers) {
		const signals = await signalsDb
			.list(env.DB, userId, { ticker: t, limit: 1000, since_ts: since30d })
			.catch(() => []);
		const trades = await tradesDb
			.list(env.DB, userId, { ticker: t, limit: 1000, since_ts: since30d })
			.catch(() => []);
		const pnl = trades.reduce((acc, tr) => acc + (tr.pnl_cents ?? 0), 0);
		const lastSignal = signals[0]?.ts ?? null;
		out.set(t, {
			ticker: t,
			vertical: "unknown",
			n_signals_30d: signals.length,
			n_trades_30d: trades.length,
			pnl_cents_30d: pnl,
			last_signal_ms: lastSignal,
			days_since_last_signal: lastSignal ? Math.round((now - lastSignal) / (24 * 60 * 60 * 1000)) : null,
		});
	}
	return out;
}

async function readRecentlyRejected(env: LeadsCronEnv, userId: string): Promise<Set<string>> {
	if (!env.DB) return new Set();
	// We don't have a dedicated read for this; query
	// directly. The 30d lookback is enforced by REJECT_LOOKBACK_MS.
	const res = await env.DB
		.prepare(
			`SELECT DISTINCT ticker FROM lead_suggestions
			 WHERE user_id = ?1 AND status = 'rejected'
			   AND decided_at >= ?2`,
		)
		.bind(userId, Date.now() - REJECT_LOOKBACK_MS)
		.all<{ ticker: string }>();
	return new Set((res.results ?? []).map((r) => r.ticker));
}

function buildPrompt(state: BotState, stats: Map<string, TickerStats>, rejected: Set<string>): string {
	const lines: string[] = [];
	lines.push("Bot state:");
	lines.push(`- Trading mode: ${state.trading_mode}`);
	lines.push(`- Bankroll: $${(state.bankroll_cents / 100).toFixed(2)}`);
	lines.push(`- Max notional / trade: $${(state.max_notional_cents_per_trade / 100).toFixed(2)}`);
	lines.push(`- Daily notional cap: $${(state.daily_notional_cents_cap / 100).toFixed(2)}`);
	lines.push("");
	lines.push("Verticals:");
	for (const v of VERTICALS) {
		lines.push(`- ${v}`);
	}
	lines.push("");
	lines.push("Current universe (ticker — vertical — 30d signals / 30d trades / 30d PnL / days since last signal):");
	if (state.tickers.length === 0) {
		lines.push("- (empty universe)");
	} else {
		for (const t of state.tickers) {
			const v = state.ticker_verticals[t] ?? "unknown";
			const s = stats.get(t);
			if (s) {
				const days = s.days_since_last_signal == null ? "never" : `${s.days_since_last_signal}d`;
				const pnl = s.pnl_cents_30d === 0 ? "$0.00" : `$${(s.pnl_cents_30d / 100).toFixed(2)}`;
				lines.push(`- ${t} — ${v} — ${s.n_signals_30d} / ${s.n_trades_30d} / ${pnl} / ${days}`);
			} else {
				lines.push(`- ${t} — ${v} — 0 / 0 / $0.00 / never`);
			}
		}
	}
	if (rejected.size > 0) {
		lines.push("");
		lines.push(`Recently rejected (don't re-suggest within 30d): ${Array.from(rejected).join(", ")}`);
	}
	lines.push("");
	lines.push("Return JSON with this exact shape:");
	lines.push(`{"add": [{"ticker": "KXWARMING-60", "vertical": "weather", "reasoning": "..."}], "drop": [{"ticker": "KXPRES-26", "reasoning": "..."}], "overall_reasoning": "1-2 sentences on the overall thesis."}`);
	lines.push("");
	lines.push("Rules:");
	lines.push("- add: 1-3 entries; verticals must be one of: weather, economic, politics, sports");
	lines.push("- drop: 0-1 entries; ticker must be in the current universe");
	lines.push("- Reasoning: one short sentence per suggestion");
	lines.push("- Do NOT include any ticker in `add` that's already in the current universe or in the rejected list");
	lines.push("- If you're not sure a ticker exists, omit it. Honest empty arrays > hallucinated tickers.");
	return lines.join("\n");
}

interface ParsedLeads {
	add: Array<{ ticker: string; vertical: string; reasoning: string }>;
	drop: Array<{ ticker: string; reasoning: string }>;
	overall_reasoning: string;
}

export function parseLlmResponse(rawText: string): ParsedLeads | null {
	// chat() already strips the <think> block. The remaining
	// text should be JSON. Be defensive.
	const jStart = rawText.indexOf("{");
	const jEnd = rawText.lastIndexOf("}");
	if (jStart === -1 || jEnd === -1 || jEnd < jStart) return null;
	try {
		const obj = JSON.parse(rawText.slice(jStart, jEnd + 1)) as {
			add?: unknown;
			drop?: unknown;
			overall_reasoning?: unknown;
		};
		const add = Array.isArray(obj.add)
			? obj.add
					.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
					.map((x) => ({
						ticker: typeof x.ticker === "string" ? x.ticker : "",
						vertical: typeof x.vertical === "string" ? x.vertical : "",
						reasoning: typeof x.reasoning === "string" ? x.reasoning : "",
					}))
					.filter((x) => x.ticker && x.vertical && x.reasoning)
			: [];
		const drop = Array.isArray(obj.drop)
			? obj.drop
					.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
					.map((x) => ({
						ticker: typeof x.ticker === "string" ? x.ticker : "",
						reasoning: typeof x.reasoning === "string" ? x.reasoning : "",
					}))
					.filter((x) => x.ticker && x.reasoning)
			: [];
		const overall_reasoning = typeof obj.overall_reasoning === "string" ? obj.overall_reasoning : "";
		return { add, drop, overall_reasoning };
	} catch {
		return null;
	}
}

export function validateAndDedupe(
	parsed: ParsedLeads,
	state: BotState,
	rejected: Set<string>,
): { add: NewLeadSuggestion[]; drop: NewLeadSuggestion[]; excluded: Array<{ ticker: string; kind: string; reason: string }> } {
	const now = Date.now();
	const expiresAt = now + 24 * 60 * 60 * 1000;
	const currentSet = new Set(state.tickers);
	const seen = new Set<string>();
	const excluded: Array<{ ticker: string; kind: string; reason: string }> = [];

	// ── ADD validation ──
	const add: NewLeadSuggestion[] = [];
	for (const a of parsed.add) {
		const ticker = a.ticker.trim().toUpperCase();
		if (seen.has(ticker)) {
			excluded.push({ ticker, kind: "add", reason: "duplicate in batch" });
			continue;
		}
		seen.add(ticker);
		if (!KALSHI_TICKER_RE.test(ticker)) {
			excluded.push({ ticker, kind: "add", reason: "invalid KX ticker format" });
			continue;
		}
		if (currentSet.has(ticker)) {
			excluded.push({ ticker, kind: "add", reason: "already in current universe" });
			continue;
		}
		if (rejected.has(ticker)) {
			excluded.push({ ticker, kind: "add", reason: "rejected within last 30d" });
			continue;
		}
		const vertical = a.vertical.trim().toLowerCase();
		if (!VERTICALS.includes(vertical as Vertical)) {
			excluded.push({ ticker, kind: "add", reason: `unknown vertical: ${vertical}` });
			continue;
		}
		add.push({
			cron_run_id: null, // set after we record the cron run
			kind: "add",
			ticker,
			vertical: vertical as Vertical,
			reasoning: a.reasoning.slice(0, 500),
			raw_text: a.reasoning.slice(0, 500),
			status: "pending",
			created_at: now,
			expires_at: expiresAt,
		});
	}

	// ── DROP validation ──
	const drop: NewLeadSuggestion[] = [];
	for (const d of parsed.drop) {
		const ticker = d.ticker.trim().toUpperCase();
		if (seen.has(ticker)) {
			excluded.push({ ticker, kind: "drop", reason: "duplicate in batch" });
			continue;
		}
		seen.add(ticker);
		if (!currentSet.has(ticker)) {
			excluded.push({ ticker, kind: "drop", reason: "not in current universe" });
			continue;
		}
		// For drops, we carry the vertical from the current
		// universe so the UI can color the card.
		const vertical = (state.ticker_verticals[ticker] ?? null) as Vertical | null;
		drop.push({
			cron_run_id: null,
			kind: "drop",
			ticker,
			vertical,
			reasoning: d.reasoning.slice(0, 500),
			raw_text: d.reasoning.slice(0, 500),
			status: "pending",
			created_at: now,
			expires_at: expiresAt,
		});
	}

	return { add, drop, excluded };
}

export async function runLeadsCron(env: LeadsCronEnv): Promise<CronResult> {
	const startMs = Date.now();
	const userId = DEFAULT_USER_ID;
	const now = Date.now();

	// 1. Read state.
	const state = await readBotState(env, userId);
	const stats = state ? await readTickerStats(env, userId, state.tickers) : new Map();
	const rejected = await readRecentlyRejected(env, userId);

	// 2. Build prompt.
	const prompt = buildPrompt(
		state ?? {
			tickers: [],
			ticker_verticals: {},
			bankroll_cents: 0,
			max_notional_cents_per_trade: 0,
			daily_notional_cents_cap: 0,
			trading_mode: "paper",
			per_vertical_max_notional_cents: null,
		},
		stats,
		rejected,
	);

	// 3. Call LLM. M3 is a reasoning model — generous
	// max_tokens so the JSON fits after the think block.
	const result = await chat(env, SYSTEM_PROMPT, prompt, { max_tokens: 2000 });

	// 4. Always record the LLM call (success or error) so
	// the cadence + cost panels reflect this run.
	if (env.DB) {
		await llmCallsDb
			.insert(env.DB, {
				user_id: userId,
				ts: now,
				purpose: "leads_cron",
				model: DEFAULT_MODEL,
				ticker: null,
				input_tokens_est: result.input_tokens ?? null,
				output_tokens_est: result.output_tokens ?? null,
				duration_ms: result.duration_ms,
				status: result.ok ? "success" : "error",
				error_message: result.error_message ?? null,
			})
			.catch((e) => console.error("[leads] failed to record llm_call", e));
	}

	if (!result.ok) {
		return {
			ok: false,
			cron_name: "leads",
			duration_ms: Date.now() - startMs,
			error_message: `LLM call failed: ${result.error_message ?? "unknown"}`,
		};
	}

	// 5. Parse + validate.
	const parsed = parseLlmResponse(result.text);
	if (!parsed) {
		return {
			ok: false,
			cron_name: "leads",
			duration_ms: Date.now() - startMs,
			error_message: "LLM returned no parseable JSON",
			artifacts: { raw_text: result.text.slice(0, 500) },
		};
	}

	const { add, drop, excluded } = validateAndDedupe(
		parsed,
		state ?? {
			tickers: [],
			ticker_verticals: {},
			bankroll_cents: 0,
			max_notional_cents_per_trade: 0,
			daily_notional_cents_cap: 0,
			trading_mode: "paper",
			per_vertical_max_notional_cents: null,
		},
		rejected,
	);

	// 6. Mark prior pending as superseded. Do this even
	// when the new run has zero suggestions, so the Dev
	// page doesn't show stale rows.
	let supersededCount = 0;
	if (env.DB) {
		supersededCount = await leadSuggestionsDb
			.supersedePending(env.DB, userId, now)
			.catch((e) => {
				console.error("[leads] failed to supersede pending", e);
				return 0;
			});
	}

	// 7. Insert the new suggestions.
	let insertedIds: number[] = [];
	if (env.DB && (add.length > 0 || drop.length > 0)) {
		insertedIds = await leadSuggestionsDb
			.insertMany(env.DB, userId, [...add, ...drop])
			.catch((e) => {
				console.error("[leads] failed to insert suggestions", e);
				return [];
			});
	}
	const inserted = insertedIds.length;

	return {
		ok: true,
		cron_name: "leads",
		duration_ms: Date.now() - startMs,
		artifacts: {
			overall_reasoning: parsed.overall_reasoning,
			n_add: add.length,
			n_drop: drop.length,
			n_excluded: excluded.length,
			n_superseded: supersededCount,
			excluded,
			llm_input_tokens: result.input_tokens,
			llm_output_tokens: result.output_tokens,
			llm_duration_ms: result.duration_ms,
			inserted,
		},
	};
}
