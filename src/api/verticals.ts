/**
 * pm-bot — verticals API (chunk 10.8c).
 *
 * The single source of truth for the dashboard's "Verticals"
 * panel. Returns per-vertical state:
 *   - active (boolean) — derived from disabled_verticals
 *   - model_version (string) — from D1 models table
 *   - strategy (string) — from strategy/router.ts
 *   - n_trades_24h, pnl_cents_24h — from D1 trades (24h)
 *   - n_trades_total, pnl_cents_total — from D1 trades (all)
 *   - cap_cents (number | null) — from per_vertical_max_notional_cents
 *   - tickers (string[]) — from ticker_verticals
 *
 * Used by the dashboard to render the "Verticals" card with
 * per-vertical status, model version, strategy, stats, and
 * enable/disable toggles.
 */

import { models as modelsDb } from "../lib/db.js";
import { DEFAULT_USER_ID } from "../lib/types.js";

export interface VerticalsEnv {
	DB?: D1Database;
}

export interface VerticalEntry {
	id: string;
	label: string;
	emoji: string;
	active: boolean;
	model_version: string;
	strategy: "reversion" | "naive" | "none";
	strategy_label: string;
	strategy_eli5: string;
	n_trades_24h: number;
	pnl_cents_24h: number;
	n_trades_total: number;
	pnl_cents_total: number;
	cap_cents: number | null;
	tickers: string[];
}

const KNOWN_VERTICALS: Array<{ id: string; label: string; emoji: string }> = [
	{ id: "weather", label: "Weather", emoji: "🌤" },
	{ id: "economic", label: "Economic", emoji: "📊" },
	{ id: "politics", label: "Politics", emoji: "🏛" },
	{ id: "sports", label: "Sports", emoji: "🏀" },
	{ id: "elections", label: "Elections", emoji: "🗳" },
	{ id: "financials", label: "Financials", emoji: "💰" },
	{ id: "entertainment", label: "Entertainment", emoji: "🎬" },
	{ id: "science_technology", label: "Sci & Tech", emoji: "🚀" },
	{ id: "crypto", label: "Crypto", emoji: "🪙" },
	{ id: "companies", label: "Companies", emoji: "🏢" },
	{ id: "commodities", label: "Commodities", emoji: "📦" },
	{ id: "mentions", label: "Mentions", emoji: "💬" },
	{ id: "social", label: "Social", emoji: "👥" },
	{ id: "world", label: "World", emoji: "🌍" },
	{ id: "health", label: "Health", emoji: "🏥" },
	{ id: "transportation", label: "Transportation", emoji: "✈️" },
	{ id: "uncategorized", label: "Uncategorized", emoji: "❔" },
];

// Strategy → ELI5 wording (the strategy router picks the
// actual strategy per vertical at runtime, but for the
// dashboard we report the default per vertical). 2026-08-11:
// expanded from 4 to 17 verticals. The four legacy verticals
// keep their original strategy labels (reversion on weather /
// economic, naive on politics / sports). The thirteen new
// verticals default to naive + LLM; the LLM is the primary
// signal source until a per-vertical model gets trained.
const VERTICAL_STRATEGY: Record<
	string,
	{ strategy: VerticalEntry["strategy"]; label: string; eli5: string }
> = {
	weather: {
		strategy: "reversion",
		label: "Reversion v1",
		eli5:
			"Bets that the YES price will revert to its 30-period mean after a sharp move. Trained on real Kalshi weather trades.",
	},
	economic: {
		strategy: "reversion",
		label: "Reversion v1",
		eli5:
			"Same reversion logic as weather, trained on economic indicator markets (Fed decisions, CPI, etc.).",
	},
	politics: {
		strategy: "naive",
		label: "Naive baseline",
		eli5:
			"Trades only when p(model) ≥ 0.99 or ≤ 0.01. No reversion model yet — politics data is too sparse for a robust reversion fit.",
	},
	sports: {
		strategy: "naive",
		label: "Naive baseline",
		eli5:
			"Same conservative baseline as politics. Sports markets are liquidity-driven, not statistical.",
	},
	// ── 13 new verticals (2026-08-11) ──
	elections: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"LLM evaluates each election market (KXNEXTNATO, KXNEWPOPE, KXPERSONPRES, etc.) and emits a verdict. Trade only when LLM confidence ≥ 0.6 and the LLM sees real edge.",
	},
	financials: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"LLM evaluates IPOs, M&A, earnings, Fed-adjacent. LLM is the signal source; we're collecting trade data so a reversion model can be trained later.",
	},
	entertainment: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"Movies, music, awards, celeb gossip. LLM evaluates. Most markets are low-liquidity long-tail; the LLM will produce mostly HOLD.",
	},
	science_technology: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"Mars, fusion, AI, AGI, earthquakes. LLM has decent training-data knowledge here; verdicts on AI/Mars tend to be more grounded than long-tail celebrity stuff.",
	},
	crypto: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"Token price markets (BTC, ETH, SOL, etc.). LLM evaluates; verdicts are best-effort given volatile pricing. Treat as paper-mode data collection for now.",
	},
	companies: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"Single-company events (CEO changes, IPOs, product launches). LLM evaluates. Sparse liquidity, paper-only until we have trade data.",
	},
	commodities: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"Gold, silver, oil — and Kalshi's \"AI model token pricing\" bucket (KXGPT, KXOPUS). LLM evaluates. Silver has the most live two-sided liquidity in this group.",
	},
	mentions: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"\"What will <company> say during their earnings call?\" — natural-language matching markets. LLM evaluates; expect mostly HOLD (LLM doesn't have transcript-level data).",
	},
	social: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"Demographics, geopolitics, leader meetings. LLM evaluates. Sparse trade data; treat as paper-mode exploration.",
	},
	world: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"Global events (EU expansion, world leaders, CO2 levels, Elon). LLM evaluates; some markets (KXELONMARS) are LLM-friendly, others (KXCO2) are domain-specific.",
	},
	health: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"FDA approvals, vaccines, IVF, polio. LLM evaluates. Most markets are 1-2 events; paper-only until volume data accumulates.",
	},
	transportation: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"Currently 1 event (KXBUSHBY — a world-walk attempt). Will expand as Kalshi adds flights, EVs, transit. Paper-only.",
	},
	uncategorized: {
		strategy: "naive",
		label: "Naive + LLM",
		eli5:
			"Catch-all bucket for events Kalshi lists without a category. Currently 1 event (Gold vs Silver 2026). Paper-only.",
	},
};

export async function handleVerticals(
	env: VerticalsEnv,
	_url: URL,
): Promise<Response> {
	const user_id = DEFAULT_USER_ID;

	// 1. Per-vertical 24h + all-time trade aggregates.
	const since24h = Date.now() - 24 * 60 * 60 * 1000;
	const trades24h =
		env.DB
			? await env.DB
					.prepare(
						`SELECT vertical,
						        COUNT(*) as n_trades,
						        COALESCE(SUM(CASE WHEN pnl_cents IS NOT NULL
						                          THEN pnl_cents ELSE 0 END), 0) as pnl_cents
						 FROM trades
						 WHERE user_id = ?1 AND ts >= ?2 AND vertical IS NOT NULL
						 GROUP BY vertical`,
					)
					.bind(user_id, since24h)
					.all<{ vertical: string; n_trades: number; pnl_cents: number }>()
			: { results: [] };
	const tradesTotal =
		env.DB
			? await env.DB
					.prepare(
						`SELECT vertical,
						        COUNT(*) as n_trades,
						        COALESCE(SUM(CASE WHEN pnl_cents IS NOT NULL
						                          THEN pnl_cents ELSE 0 END), 0) as pnl_cents
						 FROM trades
						 WHERE user_id = ?1 AND vertical IS NOT NULL
						 GROUP BY vertical`,
					)
					.bind(user_id)
					.all<{ vertical: string; n_trades: number; pnl_cents: number }>()
			: { results: [] };
	const stats24h: Record<string, { n_trades: number; pnl_cents: number }> = {};
	for (const r of trades24h.results ?? []) stats24h[r.vertical] = r;
	const statsTotal: Record<string, { n_trades: number; pnl_cents: number }> = {};
	for (const r of tradesTotal.results ?? []) statsTotal[r.vertical] = r;

	// 2. Active model per vertical from D1 models table.
	//    Falls back to the per-vertical default (reversion or
	//    naive) if no model is registered.
	const modelsList = env.DB
		? await modelsDb.list(env.DB, user_id).catch(() => [])
		: [];
	const activeModelByVertical: Record<string, string> = {};
	for (const m of modelsList) {
		if (m.status === "active") {
			activeModelByVertical[m.vertical] = m.version;
		}
	}

	// 3. The bot config (for disabled_verticals, per_vertical
	//    caps, and ticker_verticals). Read from D1 via the
	//    bot-config table if available; else empty defaults.
	const cfgRow = env.DB
		? await env.DB
				.prepare(
					`SELECT value FROM bot_config WHERE user_id = ?1 AND key = 'config'`,
				)
				.bind(user_id)
				.first<{ value: string }>()
		: null;
	const cfg = cfgRow?.value
		? (JSON.parse(cfgRow.value) as Record<string, unknown>)
		: {};
	const disabledVerticals = Array.isArray(cfg.disabled_verticals)
		? (cfg.disabled_verticals as string[])
		: [];
	const perVerticalCaps =
		(cfg.per_vertical_max_notional_cents as Record<string, number> | null) ?? {};
	const tickerVerticals =
		(cfg.ticker_verticals as Record<string, string>) ?? {};

	const verticals: VerticalEntry[] = KNOWN_VERTICALS.map((v) => {
		const strategyMeta = VERTICAL_STRATEGY[v.id] ?? {
			strategy: "none" as const,
			label: "—",
			eli5: "no strategy registered for this vertical",
		};
		const s24 = stats24h[v.id] ?? { n_trades: 0, pnl_cents: 0 };
		const sTot = statsTotal[v.id] ?? { n_trades: 0, pnl_cents: 0 };
		const tickers = Object.entries(tickerVerticals)
			.filter(([, tvert]) => tvert === v.id)
			.map(([t]) => t);
		return {
			id: v.id,
			label: v.label,
			emoji: v.emoji,
			active: !disabledVerticals.includes(v.id),
			model_version: activeModelByVertical[v.id] ?? "—",
			strategy: strategyMeta.strategy,
			strategy_label: strategyMeta.label,
			strategy_eli5: strategyMeta.eli5,
			n_trades_24h: s24.n_trades,
			pnl_cents_24h: s24.pnl_cents,
			n_trades_total: sTot.n_trades,
			pnl_cents_total: sTot.pnl_cents,
			cap_cents: perVerticalCaps[v.id] ?? null,
			tickers,
		};
	});

	return Response.json(
		{ ok: true, ts_ms: Date.now(), verticals },
		// 2026-08-11: was `public, max-age=30` but the
		// per-vertical PnL table on the dashboard
		// updates on every trade, and the dashboard
		// polls every 5s. The 30s cache made the
		// per-vertical column lag visibly. Real-time
		// display data — don't cache.
		{ headers: { "cache-control": "no-store" } },
	);
}
