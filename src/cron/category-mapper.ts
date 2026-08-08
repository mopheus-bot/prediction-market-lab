/**
 * pm-bot — Kalshi category -> vertical mapper.
 *
 * Mirrors `Prediction Market Lab/.../live/category_mapper.py`.
 * The mapping lives in one place so the scan + bot
 * agree on which verticals a market belongs to.
 */

import type { Vertical } from "../lib/types.js";

/**
 * Map a Kalshi event category to a strategy vertical.
 * Returns "unknown" for categories the strategy router
 * doesn't have a profile for (the router falls back to
 * NaiveSignal).
 */
export function mapCategory(category: string | null | undefined): Vertical | "unknown" {
	if (!category) return "unknown";
	const cat = category.toLowerCase();
	if (cat === "climate and weather" || cat === "weather") return "weather";
	if (cat === "economics" || cat === "economic" || cat === "crypto" || cat === "finance") {
		return "economic";
	}
	if (cat === "sports") return "sports";
	if (cat === "elections" || cat === "politics") return "politics";
	return "unknown";
}
