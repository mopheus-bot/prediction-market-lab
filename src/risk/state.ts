/**
 * pm-bot — risk engine state.
 *
 * Mirrors `Prediction Market Lab/.../risk/state.py`.
 *
 * Mutable state owned by the risk engine. Tracks:
 *   - Current bankroll + peak bankroll.
 *   - Open positions (one per market).
 *   - Consecutive-loss counter.
 *   - Pause / cooldown end-ticks.
 *   - Per-trade PnL history.
 *
 * In a DO context, the RiskState lives in `ctx.storage` (we
 * serialize to a plain object on every update). The engine reads it
 * to decide whether to allow new orders and mutates it on fills /
 * closures.
 */

import type { Side, Vertical } from "../lib/types.js";

// ─── Open Position ─────────────────────────────────────────────────────

export interface Position {
	ticker: string;
	vertical: Vertical | string;
	side: Side;
	entry_price: number; // cents, [0, 100]
	size: number;
	opened_at_tick: number;
	/** Total cost in cents (entry_price * size for YES; (100 - entry_price) * size for NO). */
	cost_cents: number;
}

// ─── Closed Trade ──────────────────────────────────────────────────────

export interface ClosedTrade {
	ticker: string;
	vertical: Vertical | string;
	side: Side;
	entry_price: number;
	size: number;
	/** "yes" | "no" | "mark" (mark = MTM close). */
	settlement_outcome: Side | "mark";
	pnl_cents: number;
	bankroll_after: number;
	closed_at_tick: number;
}

// ─── Risk State ────────────────────────────────────────────────────────

export interface RiskState {
	starting_bankroll_cents: number;
	bankroll_cents: number;
	peak_bankroll_cents: number;
	open_positions: Record<string, Position>;
	closed_trades: ClosedTrade[];
	consecutive_losses: number;
	/** Tick at which the drawdown pause ends. */
	drawdown_pause_until_tick: number;
	/** Tick at which the loss-streak cooldown ends. */
	cooldown_until_tick: number;
	/** Recent per-trade PnL (FIFO, capped at 10,000). */
	pnl_history: number[];
	/** Chunk 9: rolling 24h notional deployed in cents. We track
	 * the last 1,000 individual trade notionals in a FIFO queue
	 * and sum any entry whose `ts_ms` is within the last 24h
	 * (`Date.now() - 86_400_000`). On every new trade we trim
	 * stale entries from the front and add the new notional
	 * with the current `ts_ms`. Persisted in DO storage
	 * alongside the rest of the state. */
	daily_notional_history: Array<{ ts_ms: number; cents: number }>;
}

export function makeRiskState(startingBankrollCents: number): RiskState {
	if (startingBankrollCents < 1) {
		throw new Error(
			`starting_bankroll_cents must be >= 1, got ${startingBankrollCents}`,
		);
	}
	return {
		starting_bankroll_cents: startingBankrollCents,
		bankroll_cents: startingBankrollCents,
		peak_bankroll_cents: startingBankrollCents,
		open_positions: {},
		closed_trades: [],
		consecutive_losses: 0,
		drawdown_pause_until_tick: 0,
		cooldown_until_tick: 0,
		pnl_history: [],
		daily_notional_history: [],
	};
}

export function currentDrawdownPct(state: RiskState): number {
	if (state.peak_bankroll_cents <= 0) return 0;
	const dd =
		(state.peak_bankroll_cents - state.bankroll_cents) / state.peak_bankroll_cents;
	return Math.max(0, dd);
}

export function nOpenPositions(state: RiskState): number {
	return Object.keys(state.open_positions).length;
}

export function totalPnlCents(state: RiskState): number {
	return state.bankroll_cents - state.starting_bankroll_cents;
}

/** Chunk 9: sum of trade notionals (cents) deployed in the last
 * 24h. Trims stale entries (older than 24h from `now`) and
 * returns the new total. Pure function over the array — caller
 * should assign the returned value back to `state.daily_notional_history`.
 *
 * The history is bounded to 1,000 entries to keep DO state
 * small. With one trade per minute, that's ~16h of history —
 * well within the 24h window for any realistic deployment. */
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_HISTORY_MAX = 1_000;

export function dailyNotionalCents(
	state: RiskState,
	now: number = Date.now(),
): number {
	const cutoff = now - DAILY_WINDOW_MS;
	let total = 0;
	for (const e of state.daily_notional_history) {
		if (e.ts_ms >= cutoff) total += e.cents;
	}
	return total;
}

/** Record a new notional deployment. Trims stale entries
 * (older than 24h) from the front, appends the new entry, and
 * caps the history at DAILY_HISTORY_MAX. Returns the new array
 * AND the updated 24h total. */
export function recordNotionalCents(
	state: RiskState,
	cents: number,
	now: number = Date.now(),
): { history: Array<{ ts_ms: number; cents: number }>; total: number } {
	const cutoff = now - DAILY_WINDOW_MS;
	const trimmed = state.daily_notional_history.filter((e) => e.ts_ms >= cutoff);
	trimmed.push({ ts_ms: now, cents });
	if (trimmed.length > DAILY_HISTORY_MAX) {
		trimmed.splice(0, trimmed.length - DAILY_HISTORY_MAX);
	}
	let total = 0;
	for (const e of trimmed) total += e.cents;
	return { history: trimmed, total };
}
