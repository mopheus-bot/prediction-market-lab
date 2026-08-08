/**
 * pm-bot — daily recap R2 read helper.
 *
 * The daily cron (src/cron/daily-cron.ts) writes a recap
 * JSON to R2 at `daily-recap/YYYY-MM-DD.json`. The status
 * API reads it back so the dashboard + Telegram can show
 * today's recap without re-aggregating from D1.
 */

import type { StatusEnv } from "./status.js";

export interface DailyRecap {
	date: string;
	lookback_hours: number;
	generated_at: string;
	user_id: string;
	trades: {
		n_total: number;
		n_opens: number;
		n_closes: number;
		realized_pnl_cents: number;
	};
	signals: {
		n_total: number;
		n_filled: number;
	};
	open_positions: number;
	verticals: Record<string, { n_trades: number; pnl_cents: number }>;
}

function isoDate(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Read the daily recap for a given date (default: today).
 * Returns null when the recap doesn't exist (the cron
 * hasn't run today, or R2 is unbound).
 */
export async function readDailyRecap(
	env: StatusEnv,
	date?: string,
): Promise<DailyRecap | null> {
	if (!env.BUCKET) return null;
	const key = `daily-recap/${date ?? isoDate(Date.now())}.json`;
	let obj: R2ObjectBody | null;
	try {
		obj = await env.BUCKET.get(key);
	} catch (e) {
		console.error(`[daily-recap] R2 get failed for ${key}`, e);
		return null;
	}
	if (!obj) return null;
	try {
		const text = await obj.text();
		return JSON.parse(text) as DailyRecap;
	} catch (e) {
		console.error(`[daily-recap] parse failed for ${key}`, e);
		return null;
	}
}
