/**
 * prediction-market-lab — Kalshi category -> vertical mapper.
 *
 * Mirrors `Prediction Market Lab/.../live/category_mapper.py`.
 * The mapping lives in one place so the scan + bot
 * agree on which verticals a market belongs to.
 *
 * 2026-08-11: expanded from 4 buckets to 17 (one per
 * Kalshi category). Previously crypto/finance collapsed
 * into "economic" and elections into "politics" because
 * the bot had no separate strategy for them. With the
 * full universe live, each Kalshi category is its own
 * vertical so the operator can see per-category trade
 * counts, PnL, and caps on the dashboard.
 *
 * Order of matching: lower-cased input → known category
 * label. Anything not in the table falls through to
 * "uncategorized" (the (none) bucket Kalshi assigns when
 * the event has no category metadata).
 */

import type { Vertical } from "../lib/types.js";

const CATEGORY_TO_VERTICAL: Record<string, Vertical> = {
	"climate and weather": "weather",
	"weather": "weather",
	"economics": "economic",
	"economic": "economic",
	"finance": "financials",
	"financials": "financials",
	"elections": "elections",
	"election": "elections",
	"politics": "politics",
	"political": "politics",
	"sports": "sports",
	"sport": "sports",
	"entertainment": "entertainment",
	"science and technology": "science_technology",
	"science & technology": "science_technology",
	"science": "science_technology",
	"tech": "science_technology",
	"technology": "science_technology",
	"crypto": "crypto",
	"cryptocurrency": "crypto",
	"bitcoin": "crypto",
	"ethereum": "crypto",
	"companies": "companies",
	"company": "companies",
	"corporate": "companies",
	"commodities": "commodities",
	"commodity": "commodities",
	"mentions": "mentions",
	"mention": "mentions",
	"social": "social",
	"world": "world",
	"global": "world",
	"international": "world",
	"health": "health",
	"healthcare": "health",
	"medical": "health",
	"transportation": "transportation",
	"transit": "transportation",
	"travel": "transportation",
};

/**
 * Map a Kalshi event category to a strategy vertical.
 * Returns "uncategorized" for categories Kalshi lists
 * without a category label (currently rare — 1 event).
 */
export function mapCategory(category: string | null | undefined): Vertical {
	if (!category) return "uncategorized";
	const cat = category.toLowerCase().trim();
	return CATEGORY_TO_VERTICAL[cat] ?? "uncategorized";
}
