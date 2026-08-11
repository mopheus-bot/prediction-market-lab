/**
 * pm-bot — leads-cron (chunk 11+).
 *
 * Runs every 6 hours +30min (00:30 / 06:30 / 12:30 / 18:30 UTC). Asks
 * the LLM which Kalshi tickers to ADD to the bot's universe and
 * which to DROP. Writes the suggestions to the `lead_suggestions`
 * D1 table; the operator reviews them on the Dev page and clicks
 * Approve / Reject.
 *
 * **The pipeline (the spec the user agreed to on 2026-08-09,
 *  tightened 2026-08-09 after they asked "shouldn't we be
 *  looking for + weighing out more tickers, more often?"):**
 *   - Every 6h, M3 reads current state + recent per-ticker
 *     performance + rejected-list, returns
 *     `{add: [4-6], drop: [0-2], overall_reasoning}`.
 *   - We validate format, dedupe, spread-check across verticals,
 *     and write to D1.
 *   - The previous run's `pending` rows are marked `superseded`
 *     (preserved for history) — the Dev page always shows the
 *     latest suggestions, never a queue of undecided rows.
 *   - Operator clicks Approve → POST /api/pm/bot/start with the
 *     new ticker universe → bot restarts.
 *   - Operator clicks Reject → row is marked `rejected`, and
 *     the cron won't re-suggest the same ticker for 30 days.
 *
 * **Why every 6h, not 15min (scan cadence) or daily:** the
 *  news-cron is on a 6h cycle; matching it (with a 30min
 *  offset so the LLM has fresh news data to weigh against)
 *  means "every fresh market info cycle gets a re-look."
 *  15min is overkill (96 LLM calls/day for a low-signal
 *  pipeline); daily was the v1 default but means stale
 *  suggestions 23/24h of the day.
 *
 * **Why a separate cron (not folded into daily-recap or the
 *  backtest):** the backtest is weekly, the daily recap writes
 *  R2, and lead generation needs to know about the latest
 *  backtest results when they exist (Sunday) but still run
 *  on the other 6 days.
 *
 * **The LLM call is recorded to `llm_calls` with
 *  purpose='leads_cron'** so the cadence + cost panels update
 *  immediately.
 *
 * **What "retargeting" means here:** the user originally
 *  asked for lead generation + retargeting. We're scoping to
 *  add + drop for now (per the 2026-08-09 conversation);
 *  vertical-cap rebalancing is a future extension once we
 *  have more than ~7 closed trades.
 *
 * **Operator workflow:**
 *   1. Open /app/dev → "Lead suggestions" panel.
 *   2. See 4-6 add suggestions + 0-2 drop suggestions.
 *   3. Click Approve / Reject per card.
 *   4. Approve an `add` → ticker joins the universe (bot
 *      restarts); approve a `drop` → ticker leaves.
 *   5. Next cron run (within 6h) replaces any rows you
 *      didn't touch.
 */

import type { CronResult } from "./dispatcher.js";
import { DEFAULT_USER_ID, type NewLeadSuggestion, type Vertical } from "../lib/types.js";
import { leadSuggestions as leadSuggestionsDb, llmCalls as llmCallsDb, signals as signalsDb, trades as tradesDb } from "../lib/db.js";
import { chat, DEFAULT_MODEL, type LLMEnv } from "../llm/index.js";
import {
	fetchAndFilterMarkets,
	buildScoutFromSnapshots,
	checkUniverseHealth,
	formatScoutForPrompt,
	type ScoutResult,
	type ScoutedMarket,
} from "../kalshi/leads-scout.js";
import { KalshiClient, DEFAULT_PRODUCTION_BASE } from "../kalshi/client.js";
import { loadPrivateKey, KalshiCredentials } from "../kalshi/auth.js";

const KALSHI_TICKER_RE = /^KX[A-Z0-9][A-Z0-9-]{1,14}$/;
// 2026-08-11: expanded from 4 to 17 verticals. The user said
// "expand coverage to include all 17 verticals, let the bot
// settle in (full immediate auto circle)." The leads-cron now
// considers every Kalshi category in its ADD suggestions,
// with the LLM spreading picks across the verticals that
// have real open events right now. The "Weather" and
// "Sports" rows the cron mentions in its system prompt are
// now "Climate and Weather" + "Sports" (and so on for the
// other 13); the prompt update below uses the full list.
const VERTICALS: Vertical[] = [
	"weather",
	"economic",
	"politics",
	"sports",
	"elections",
	"financials",
	"entertainment",
	"science_technology",
	"crypto",
	"companies",
	"commodities",
	"mentions",
	"social",
	"world",
	"health",
	"transportation",
	"uncategorized",
];

// 30 days. After this long, the cron may re-suggest a
// ticker the operator previously rejected — markets
// change, strategies change, and a "no" from last
// month shouldn't bind us forever.
const REJECT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

// How many ADD / DROP suggestions the cron asks the LLM
// for per run. These are the *request targets* — the LLM
// can return fewer (e.g. an empty drop array if nothing
// is clearly underperforming). 6h cadence × 10-15 adds
// (hard cap) = up to 60 fresh cards/day in the worst
// case, capped to the latest batch by the supersede
// step. The LLM is now constrained to a real Kalshi
// market list (via the scout), so the larger cap is
// reasonable — we're not just generating hallucination
// noise anymore.
const TARGET_ADD = 10;
const TARGET_DROP = 3;
const HARD_MAX_ADD = 15;
const HARD_MAX_DROP = 5;

export const SYSTEM_PROMPT = `You are the scout for a Kalshi trading bot. Your job is to actively look for new markets the bot has not yet seen, weigh each candidate carefully, and present them with enough detail that a human operator can decide yes/no in five seconds.

The bot runs mean-reversion strategies on weather + economic markets (the only two verticals with trained reversion models), and naive (high-confidence, near-certainty) strategies on politics + sports. For the other 13 verticals (elections, financials, entertainment, science_technology, crypto, companies, commodities, mentions, social, world, health, transportation, uncategorized), the LLM is the signal source — there's no reversion model yet, and we're accumulating trade data so we can train one per-vertical. It has a small bankroll and a per-trade notional cap, so we cannot take a hundred markets — every suggestion needs a real reason to be there.

Output STRICT JSON only — no prose, no markdown fences, no commentary, no preamble. Every suggestion must be a real, currently-open Kalshi ticker in the format KX followed by 2-12 uppercase letters, digits, or hyphens (e.g. KXWARMING-50, KXGDP-Q3, KXPRES-26, KXNBA-CHAMP). If you are not confident a ticker exists and is currently open, do not include it. Honest empty arrays > hallucinated tickers.

─── ADD SUGGESTIONS (target ${TARGET_ADD}, hard cap ${HARD_MAX_ADD}) ───

You will be given a real, current snapshot of every open Kalshi market that matches one of the bot's 17 verticals (weather / economic / politics / sports / elections / financials / entertainment / science_technology / crypto / companies / commodities / mentions / social / world / health / transportation / uncategorized), grouped by vertical and ranked by liquidity. ONLY suggest tickers that appear in that list — Kalshi's market data uses long UUID-style tickers (e.g. KXMVESPORTSMULTIGAMEEXTENDED-S2026...-XXX), and only ONE short ticker exists (KXWARMING-50, the climate market). If you suggest a short symbolic ticker that's not in the list, it WILL be silently dropped.

Actively look for *new* markets — categories the bot does not currently cover, timeframes that have launched since the last review, events that have come to Kalshi in the last few days. The current universe is shown below; do not re-suggest anything already in it.

For each candidate, weigh it out across three dimensions and put the result in the 'reasoning' field:
  1. **Fit** — does it match the bot's strategy for that vertical? Reversion needs liquid, mean-reverting markets. Naive needs near-certainty events (>=0.99 or <=0.01).
  2. **Edge** — what is the expected trading opportunity? Volume, open interest, time-to-resolution, recent price action.
  3. **Risk** — known thin markets, ambiguous resolution criteria, very long-dated markets, or markets dominated by a single news event.

Spread across all 17 verticals. Aim for at least one suggestion per vertical unless a vertical truly has nothing open right now. If a vertical is empty in your output, mention that in the 'overall_reasoning' field so the operator knows it was considered.

Prefer markets with non-trivial volume + open interest (liquidity matters for both entry and exit).

─── DROP SUGGESTIONS (target ${TARGET_DROP}, hard cap ${HARD_MAX_DROP}) ───

Only suggest dropping tickers that are clearly underperforming: zero signals in 30+ days, negative 30-day PnL, or markets that have effectively gone stale/resolved. The cron will additionally surface any current-universe tickers that have expired on Kalshi (404 from /markets) as auto-suggested drops — you don't need to suggest those. If nothing else is clearly droppable, return an empty drop array — silence is honest. A drop is a stronger claim than a no-add; only make it when the evidence is unambiguous.

─── OVERALL REASONING ───

1-3 sentences on the day's thesis. What regime do you see? Any new categories or verticals worth paying attention to? Anything stale we should be aware of?

─── OUTPUT SHAPE ───

Return JSON with this exact shape:
{
  "add": [
    {"ticker": "KXWARMING-60", "vertical": "weather", "reasoning": "Fit: reversion-friendly. Edge: 24h vol ~$50k, 12d to resolution. Risk: thin OI."}
  ],
  "drop": [
    {"ticker": "KXPRES-26", "reasoning": "0 signals in 30d, market effectively resolved."}
  ],
  "overall_reasoning": "Weather + economic reversion candidates look strong this cycle. No viable politics markets right now — elections are off-cycle."
}

Rules:
- vertical must be exactly one of: weather, economic, politics, sports
- every 'add' and 'drop' entry needs a non-empty 'reasoning' (1-3 sentences)
- do not include any 'add' ticker that's already in the current universe or in the rejected list
- drop tickers must be in the current universe
- if you're not sure a ticker exists, omit it. Honest empty arrays > hallucinated tickers.`;

export interface LeadsCronEnv extends LLMEnv {
	DB?: D1Database;
	LIVE_BOT?: DurableObjectNamespace;
	// Kalshi creds for the leads-scout (real market list fetch).
	// The cron uses these to build a KalshiClient and page
	// through /markets. Production is preferred (the actual
	// market data), but demo is acceptable for testing.
	KALSHI_PROD_KEY_ID?: string;
	KALSHI_PROD_PRIVATE_KEY?: string;
	KALSHI_DEMO_KEY_ID?: string;
	KALSHI_DEMO_PRIVATE_KEY?: string;
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

function buildPrompt(
	state: BotState,
	stats: Map<string, TickerStats>,
	rejected: Set<string>,
	scout: ScoutResult | null,
): string {
	return buildPromptInner(state, stats, rejected, scout, TARGET_ADD, TARGET_DROP);
}

/** Build the LLM prompt. Exported so the dry-run test can
 *  exercise the same prompt structure the cron uses, without
 *  going through the full D1 + DO read path. */
export function buildPromptForDryRun(
	state: BotState,
	stats: Map<string, TickerStats>,
	rejected: Set<string>,
	scout: ScoutResult | null = null,
): string {
	return buildPromptInner(state, stats, rejected, scout, TARGET_ADD, TARGET_DROP);
}

function buildPromptInner(
	state: BotState,
	stats: Map<string, TickerStats>,
	rejected: Set<string>,
	scout: ScoutResult | null,
	targetAdd: number,
	targetDrop: number,
): string {
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

	// The real Kalshi market list. This is the key
	// constraint: the LLM is told to ONLY pick from this
	// list, so the per-ticker verify step in
	// validateAndDedupe is just a final safety net.
	// Without the list, the LLM hallucinates freely
	// (we hit this on 2026-08-09 — all 5 of the old
	// prompt's suggestions were 404).
	if (scout !== null) {
		lines.push("");
		lines.push("Real Kalshi market snapshot (open, vertical-matched, ranked by liquidity; ONLY suggest tickers from this list):");
		lines.push(formatScoutForPrompt(scout));
	}

	lines.push("");
	lines.push(`Suggest up to ${targetAdd} new ADD tickers and up to ${targetDrop} DROP tickers. Spread across all four verticals. Weigh out each candidate with fit / edge / risk reasoning.`);
	lines.push("");
	lines.push("Return JSON with this exact shape:");
	lines.push(`{"add": [{"ticker": "KXWARMING-60", "vertical": "weather", "reasoning": "..."}], "drop": [{"ticker": "KXPRES-26", "reasoning": "..."}], "overall_reasoning": "1-3 sentences on the overall thesis."}`);
	lines.push("");
	lines.push("Rules:");
	lines.push(`- add: up to ${targetAdd} entries; verticals must be one of: weather, economic, politics, sports`);
	lines.push(`- drop: up to ${targetDrop} entries; ticker must be in the current universe`);
	lines.push("- Reasoning: 1-3 sentences per suggestion, addressing fit / edge / risk");
	lines.push("- Do NOT include any ticker in 'add' that's already in the current universe or in the rejected list");
	if (scout !== null && scout.ok) {
		lines.push("- ONLY suggest tickers that appear in the real Kalshi market snapshot above. Short symbolic tickers like KXGDP-Q3, KXNBA-CHAMP, KXPRES-26 do not exist on Kalshi (only KXWARMING-50 is short).");
	}
	lines.push("- If you're not sure a ticker exists, omit it. Honest empty arrays > hallucinated tickers.");
	lines.push("- If a vertical has nothing viable, mention that in 'overall_reasoning' rather than padding 'add'");
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
	scout?: ScoutResult | null,
): {
	add: NewLeadSuggestion[];
	drop: NewLeadSuggestion[];
	excluded: Array<{ ticker: string; kind: string; reason: string }>;
	unverified: string[];
	warnings: string[];
} {
	return validateAndDedupeWithCaps(
		parsed,
		state,
		rejected,
		HARD_MAX_ADD,
		HARD_MAX_DROP,
		scout ?? null,
	);
}

/** Same as validateAndDedupe but with caller-supplied caps.
 *  Used by the dry-run test to assert behavior at the cap.
 *
 *  When `scout` is non-null, every LLM ADD suggestion is also
 *  checked against the snapshot — if the LLM hallucinated a
 *  ticker that's not in Kalshi's open-market list, it's
 *  silently dropped and counted in `unverified`. The snapshot
 *  IS the source of truth; the LLM is a heuristic on top. */
export function validateAndDedupeWithCaps(
	parsed: ParsedLeads,
	state: BotState,
	rejected: Set<string>,
	maxAdd: number,
	maxDrop: number,
	scout: ScoutResult | null = null,
): {
	add: NewLeadSuggestion[];
	drop: NewLeadSuggestion[];
	excluded: Array<{ ticker: string; kind: string; reason: string }>;
	unverified: string[];
	warnings: string[];
} {
	const now = Date.now();
	const expiresAt = now + 24 * 60 * 60 * 1000;
	const currentSet = new Set(state.tickers);
	const seen = new Set<string>();
	const excluded: Array<{ ticker: string; kind: string; reason: string }> = [];
	const unverified: string[] = [];
	const warnings: string[] = [];

	// Snapshot of the scout's known tickers (in-memory O(1) lookup).
	// Built lazily — only used if a scout was passed in.
	const scoutKnown: Set<string> | null = scout && scout.ok
		? new Set(scout.all_markets.map((m) => m.ticker))
		: null;

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
		// Reasoning must be present AND have substance —
		// the LLM sometimes returns entries with empty
		// strings or whitespace. The cron already filters
		// those in parseLlmResponse, but a re-validate here
		// catches edge cases (e.g. reasoning is just punctuation).
		const reasoning = a.reasoning.trim();
		if (!reasoning || !/[a-zA-Z0-9]/.test(reasoning)) {
			excluded.push({ ticker, kind: "add", reason: "empty or non-substantive reasoning" });
			continue;
		}
		// Per-ticker verify against the scout snapshot.
		// This is the "real automation closure" — the LLM
		// can't slip a hallucinated ticker past us because
		// the snapshot is the source of truth.
		// (If no scout was provided, this step is skipped —
		// legacy behavior for unit tests that don't want to
		// mock a Kalshi client.)
		if (scoutKnown !== null && !scoutKnown.has(ticker)) {
			unverified.push(ticker);
			excluded.push({
				ticker,
				kind: "add",
				reason: "not in real Kalshi market snapshot (likely hallucinated)",
			});
			continue;
		}
		add.push({
			cron_run_id: null, // set after we record the cron run
			kind: "add",
			ticker,
			vertical: vertical as Vertical,
			reasoning: reasoning.slice(0, 500),
			raw_text: a.reasoning.slice(0, 500),
			status: "pending",
			created_at: now,
			expires_at: expiresAt,
		});
		// Cap at the hard max — anything past the cap is
		// dropped silently. We still want the run to log
		// a warning so the operator notices the LLM
		// over-eager.
		if (add.length >= maxAdd) {
			const remaining = parsed.add.length - parsed.add.indexOf(a) - 1;
			if (remaining > 0) {
				warnings.push(
					`truncated ${remaining} add suggestions past hard cap of ${maxAdd}`,
				);
			}
			break;
		}
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
		const reasoning = d.reasoning.trim();
		if (!reasoning || !/[a-zA-Z0-9]/.test(reasoning)) {
			excluded.push({ ticker, kind: "drop", reason: "empty or non-substantive reasoning" });
			continue;
		}
		drop.push({
			cron_run_id: null,
			kind: "drop",
			ticker,
			vertical,
			reasoning: reasoning.slice(0, 500),
			raw_text: d.reasoning.slice(0, 500),
			status: "pending",
			created_at: now,
			expires_at: expiresAt,
		});
		if (drop.length >= maxDrop) {
			const remaining = parsed.drop.length - parsed.drop.indexOf(d) - 1;
			if (remaining > 0) {
				warnings.push(
					`truncated ${remaining} drop suggestions past hard cap of ${maxDrop}`,
				);
			}
			break;
		}
	}

	// ── Vertical spread warning ──
	// If we accepted >= 3 adds and they're all in one
	// vertical, flag it. The operator might still want
	// them (the LLM may have a good reason), but a
	// warning surfaces the lack of diversification.
	if (add.length >= 3) {
		const verticalsHit = new Set(add.map((s) => s.vertical).filter((v): v is Vertical => v != null));
		if (verticalsHit.size === 1) {
			warnings.push(
				`all ${add.length} accepted adds are in the '${[...verticalsHit][0]}' vertical — ` +
					`consider spreading across weather/economic/politics/sports`,
			);
		}
	}

	return { add, drop, excluded, unverified, warnings };
}

export async function runLeadsCron(env: LeadsCronEnv): Promise<CronResult> {
	const startMs = Date.now();
	const userId = DEFAULT_USER_ID;
	const now = Date.now();

	// 1. Read state.
	const state = await readBotState(env, userId);
	const stats = state ? await readTickerStats(env, userId, state.tickers) : new Map();
	const rejected = await readRecentlyRejected(env, userId);

	// 2. Scout: fetch the real Kalshi market list and
	// filter to vertical-relevant markets. This is the
	// key constraint for the LLM prompt — without it,
	// the LLM hallucinates tickers (all 5 of the old
	// prompt's suggestions were 404 on 2026-08-09).
	//
	// 2026-08-10: read from live_market_snapshots FIRST
	// (the research-cron already polled Kalshi every 15min
	// and wrote the data; no reason to duplicate the work).
	// Fall back to a fresh Kalshi scan only if the snapshot
	// table is empty / stale (research-cron hasn't run yet).
	// This is the key rate-limit fix — leads-cron was a
	// SECOND 6h Kalshi consumer on top of research-cron's
	// 15min polls, and they kept hitting 429s together.
	let scout: ScoutResult | null = null;
	let scoutSource: "snapshots" | "kalshi" | "none" = "none";
	if (env.DB) {
		try {
			const snap = await buildScoutFromSnapshots({
				db: env.DB,
				user_id: userId,
				maxForLlm: 15,
			});
			if (snap.ok && snap.markets_for_llm.length > 0) {
				scout = snap;
				scoutSource = "snapshots";
				console.log(
					`[leads] scout from snapshots: ${snap.markets.length} vertical-matched, ${snap.markets_for_llm.length} for LLM`,
				);
			} else {
				console.log(
					`[leads] snapshot scout empty (${snap.error ?? "no markets"}); falling back to live Kalshi`,
				);
			}
		} catch (e) {
			console.warn("[leads] snapshot scout threw; falling back to live Kalshi", e);
		}
	}
	if (scout === null) {
		let kalshiClient: KalshiClient | null = null;
		if (env.KALSHI_PROD_KEY_ID && env.KALSHI_PROD_PRIVATE_KEY) {
			try {
				const pk = await loadPrivateKey(env.KALSHI_PROD_PRIVATE_KEY);
				const creds = new KalshiCredentials(env.KALSHI_PROD_KEY_ID, pk);
				kalshiClient = new KalshiClient({
					baseUrl: DEFAULT_PRODUCTION_BASE,
					credentials: creds,
					requestsPerSecond: 4,
				});
			} catch (e) {
				console.warn("[leads] failed to load Kalshi prod creds, falling back to demo", e);
			}
		}
		if (kalshiClient === null && env.KALSHI_DEMO_KEY_ID && env.KALSHI_DEMO_PRIVATE_KEY) {
			try {
				const pk = await loadPrivateKey(env.KALSHI_DEMO_PRIVATE_KEY);
				const creds = new KalshiCredentials(env.KALSHI_DEMO_KEY_ID, pk);
				kalshiClient = new KalshiClient({
					baseUrl: "https://demo-api.kalshi.co/trade-api/v2",
					credentials: creds,
					requestsPerSecond: 4,
				});
			} catch (e) {
				console.warn("[leads] failed to load Kalshi demo creds, scout disabled", e);
			}
		}
		if (kalshiClient !== null) {
			const fetched = await fetchAndFilterMarkets({ kalshiClient });
			if (fetched.ok) {
				scout = fetched;
				scoutSource = "kalshi";
			} else {
				console.warn(`[leads] Kalshi scout failed: ${fetched.error}`);
			}
		} else {
			console.warn("[leads] no Kalshi creds and no snapshots, scout disabled; LLM will run unfiltered");
		}
	}

	// 3. Build prompt.
	const fallbackState: BotState = state ?? {
		tickers: [],
		ticker_verticals: {},
		bankroll_cents: 0,
		max_notional_cents_per_trade: 0,
		daily_notional_cents_cap: 0,
		trading_mode: "paper",
		per_vertical_max_notional_cents: null,
	};
	const prompt = buildPrompt(
		fallbackState,
		stats,
		rejected,
		scout,
	);

	// 3. Call LLM. M3 is a reasoning model — generous
	// max_tokens so the JSON fits after the think block.
	// 2026-08-09: bumped from 2000 to 6000. The new
	// prompt asks for 4-6 adds (vs the old 1-3) with
	// per-ticker fit/edge/risk reasoning, plus drop +
	// overall_reasoning. M3's think block alone is
	// typically 1.5-2.5k tokens for this prompt. 2000
	// was hitting the cap mid-think and the LLM never
	// emitted the JSON.
	// 2026-08-09+: prompt now includes the real Kalshi
	// market snapshot (up to 30 markets × 4 verticals =
	// ~3-4k tokens of market data). Bumped max_tokens
	// to 8000 to fit the market list + think block +
	// per-ticker reasoning.
	const result = await chat(env, SYSTEM_PROMPT, prompt, { max_tokens: 8000 });

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

	// 5. Parse + validate (including per-ticker verify
	// against the scout snapshot, if available).
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

	const { add, drop, excluded, unverified, warnings } = validateAndDedupe(
		parsed,
		fallbackState,
		rejected,
		scout,
	);

	// 5b. Universe health: any current-universe tickers
	// that are no longer in Kalshi's open-market list
	// (i.e. they expired or were delisted) become
	// auto-suggested DROPs with reasoning "expired on
	// Kalshi". The operator can Approve to drop them
	// from the bot's universe. Without this, a stale
	// ticker would silently sit in the universe forever
	// (the bot would just keep getting 0 signals on it).
	const expiredDrops: NewLeadSuggestion[] = [];
	if (scout && scout.ok) {
		const health = checkUniverseHealth(scout, fallbackState.tickers);
		for (const e of health.expired) {
			// Skip if the LLM already suggested this drop
			// (would be a duplicate pending row).
			if (drop.some((d) => d.ticker === e.ticker)) continue;
			// Skip if the operator already rejected this
			// ticker recently (don't re-suggest).
			if (rejected.has(e.ticker)) continue;
			expiredDrops.push({
				cron_run_id: null,
				kind: "drop",
				ticker: e.ticker,
				vertical: (fallbackState.ticker_verticals[e.ticker] ?? null) as Vertical | null,
				reasoning: `Auto-flagged: ticker is no longer in Kalshi's open-market list (scanned ${scout.total_scanned} markets at ${new Date(scout.fetched_at).toISOString()}). It may have expired, settled, or been delisted. Approve to drop from the bot's universe.`,
				raw_text: null,
				status: "pending",
				created_at: now,
				expires_at: now + 24 * 60 * 60 * 1000,
			});
		}
		if (health.expired.length > 0) {
			warnings.push(
				`universe health: ${health.expired.length} of ${fallbackState.tickers.length} ` +
					`current-universe tickers are no longer in Kalshi's open-market list — ` +
					`auto-suggested as drops`,
			);
		}
	}

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

	// 7. Insert the new suggestions. Combine LLM drops
	// + auto-flagged expired drops into a single batch.
	const allDrops = [...drop, ...expiredDrops];
	let insertedIds: number[] = [];
	if (env.DB && (add.length > 0 || allDrops.length > 0)) {
		insertedIds = await leadSuggestionsDb
			.insertMany(env.DB, userId, [...add, ...allDrops])
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
			n_expired_drops: expiredDrops.length,
			n_unverified: unverified.length,
			n_excluded: excluded.length,
			n_superseded: supersededCount,
			excluded,
			unverified,
			warnings,
			scout_ok: scout?.ok ?? false,
			scout_source: scoutSource, // "snapshots" | "kalshi" | "none"
			scout_total_scanned: scout?.total_scanned ?? 0,
			scout_filtered: scout?.markets.length ?? 0,
			scout_error: scout && !scout.ok ? scout.error : null,
			llm_input_tokens: result.input_tokens,
			llm_output_tokens: result.output_tokens,
			llm_duration_ms: result.duration_ms,
			inserted,
		},
	};
}
