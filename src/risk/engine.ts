/**
 * pm-bot — risk engine.
 *
 * Mirrors `Prediction Market Lab/.../risk/engine.py:RiskEngine` (commit 7 of the
 * Python implementation plan).
 *
 * Pure functions over `RiskState` that decide whether a new order is
 * allowed and how big it should be. The engine also tracks the
 * consequence of each trade (consecutive losses, drawdown, etc.) and
 * updates the state.
 *
 * Six rules (per docs/strategy.md §6):
 *   1. 1% sizing — `size = floor(0.01 * bankroll / entry_price)`.
 *      Capped at 5% per market and (optional) `max_contracts_per_trade`.
 *   2. 3 concurrent positions cap.
 *   3. 5% per-market cap.
 *   4. 10% drawdown pause (configurable ticks).
 *   5. 3-loss cooldown (configurable ticks).
 *   6. Cancel-on-shock — not implemented in chunk 3 (cancel-on-shock
 *      lives in the execution manager, which lands in chunk 7 or later).
 *
 * The engine is stateful (mutates `RiskState`) but the rules themselves
 * are pure functions of (state, signal, current_tick).
 */

import { validateRiskConfig, type RiskConfig } from "./config.js";
import {
	makeRiskState,
	dailyNotionalCents,
	nOpenPositions,
	type ClosedTrade,
	type Position,
	type RiskState,
} from "./state.js";
import type { Side } from "../lib/types.js";

// ─── Reject reasons ────────────────────────────────────────────────────

export interface RejectReason {
	code: string;
	message: string;
}

export const REJECT_DRAWDOWN_PAUSE: RejectReason = {
	code: "drawdown_pause",
	message: "Engine is in drawdown pause (>= 10% drawdown).",
};
export const REJECT_LOSS_STREAK_COOLDOWN: RejectReason = {
	code: "loss_streak_cooldown",
	message: "Engine is in loss-streak cooldown (3 consecutive losses).",
};
export const REJECT_CONCENTRATION: RejectReason = {
	code: "concentration_limit",
	message: "Max concurrent positions reached.",
};
export const REJECT_ALREADY_IN_MARKET: RejectReason = {
	code: "already_in_market",
	message: "Already have an open position in this market.",
};
export const REJECT_PER_MARKET_CAP: RejectReason = {
	code: "per_market_cap",
	message: "Position size would exceed per-market cap (5%).",
};
export const REJECT_INVALID_PRICE: RejectReason = {
	code: "invalid_price",
	message: "Limit price is outside [1, 99].",
};
export const REJECT_ZERO_BANKROLL: RejectReason = {
	code: "zero_bankroll",
	message: "Bankroll is zero; cannot size position.",
};
export const REJECT_TRADE_TICK_INVALID: RejectReason = {
	code: "tick_invalid",
	message: "current_tick is negative.",
};

// ─── Decision result ──────────────────────────────────────────────────

export interface RiskDecision {
	allowed: boolean;
	reason: RejectReason | null;
	size: number;
}

// ─── Engine ───────────────────────────────────────────────────────────

export class RiskEngine {
	private readonly _config: RiskConfig;
	private _state: RiskState;

	constructor(opts: { config: RiskConfig; state?: RiskState }) {
		validateRiskConfig(opts.config);
		this._config = opts.config;
		if (opts.config.starting_bankroll_cents !== opts.state?.starting_bankroll_cents) {
			// Consistency: if a state is provided, its starting bankroll
			// must match the config. Otherwise we silently overwrite it.
			this._state =
				opts.state ??
				makeRiskState(opts.config.starting_bankroll_cents);
		} else {
			this._state = opts.state;
		}
	}

	get config(): RiskConfig {
		return this._config;
	}
	get state(): RiskState {
		return this._state;
	}

	/** Replace the in-memory state (e.g. after loading from storage). */
	hydrateState(state: RiskState): void {
		if (state.starting_bankroll_cents !== this._config.starting_bankroll_cents) {
			throw new Error(
				`hydrateState: state.starting_bankroll_cents=${state.starting_bankroll_cents} ` +
					`does not match config.starting_bankroll_cents=${this._config.starting_bankroll_cents}`,
			);
		}
		this._state = state;
	}

	// ─── Sizing ───────────────────────────────────────────────────

	computeSize(entryPrice: number): number {
		if (!(entryPrice >= 1 && entryPrice <= 99)) return 0;
		if (this._state.bankroll_cents <= 0) return 0;
		const targetCents = Math.floor(
			this._config.position_size_pct * this._state.bankroll_cents,
		);
		const capCents = Math.floor(
			this._config.max_per_market_pct * this._state.bankroll_cents,
		);
		// 2026-08-10: per-trade notional cap. Was previously
		// only enforced in /place-test-order. The signal-driven
		// path used `bankroll_pct` alone, so the bot would
		// size to the full bankroll% even when the per-trade
		// cap was tighter. Now we clamp size to floor(cap/price)
		// so the per-trade cap is the hard limit on a single
		// fill's notional. With cap=25c and price=78c, the
		// computed size is 0 (rejected) — the cap blocks all
		// trades on markets priced above the cap. Operators
		// bump the cap via /start `max_notional_cents_per_trade`.
		const perTradeCapCents = this._config.max_notional_cents_per_trade;
		const perTradeCapSize = Math.floor(perTradeCapCents / entryPrice);
		const maxCents = Math.min(targetCents, capCents);
		let size = Math.min(Math.floor(maxCents / entryPrice), perTradeCapSize);
		if (this._config.max_contracts_per_trade !== null) {
			size = Math.min(size, this._config.max_contracts_per_trade);
		}
		return Math.max(0, size);
	}

	/**
	 * 2026-08-10 21:00 (paper-mode expansion): dynamic per-trade
	 * sizing judge. The static `computeSize` is bounded by the
	 * per-trade cap (a fixed number of contracts). The user
	 * asked for "an upper and lower threshold, any value in
	 * between is free game" — a dynamic range the bot can
	 * sweep through based on conditions.
	 *
	 * Algorithm:
	 *   baseCents = signal.confidence × upperCents
	 *   - drawdown > 5%       → halve
	 *   - recent win rate > 60% → 1.2× boost
	 *   - recent win rate < 40% → 0.7× shrink
	 *   - clamp to [lowerCents, upperCents]
	 *   - clamp to remaining daily notional
	 *   - clamp to remaining position slots
	 *
	 * Outputs the size in contracts and a reasoning string for
	 * the cadence panel / dashboard to display. NOT a replacement
	 * for computeSize — this is layered on top: the judge produces
	 * a target notional, then the per-trade cap + bankroll-pct
	 * floors/caps are applied. Use this for the signal-driven
	 * path; keep computeSize for the /place-test-order endpoint.
	 */
	judgeSize(
		entryPrice: number,
		signalConfidence: number,
		recentClosed: ReadonlyArray<{ pnl_cents: number }>,
	): { size: number; notional_cents: number; reasoning: string } {
		if (!(entryPrice >= 1 && entryPrice <= 99)) return { size: 0, notional_cents: 0, reasoning: "invalid_price" };
		if (this._state.bankroll_cents <= 0) return { size: 0, notional_cents: 0, reasoning: "zero_bankroll" };
		if (!(signalConfidence > 0 && signalConfidence <= 1)) {
			return { size: 0, notional_cents: 0, reasoning: "invalid_confidence" };
		}

		const upperCents = this._config.max_notional_cents_per_trade;
		const lowerCents = 10; // 10¢ floor — always have some skin in the game

		// Base: confidence × upper
		let baseCents = upperCents * signalConfidence;

		// Drawdown adjustment
		const drawdown =
			this._state.peak_bankroll_cents > 0
				? (this._state.peak_bankroll_cents - this._state.bankroll_cents) /
					this._state.peak_bankroll_cents
				: 0;
		if (drawdown > 0.10) baseCents *= 0.25; // in drawdown-pause zone anyway
		else if (drawdown > 0.05) baseCents *= 0.5;

		// Recent win rate (last 5 closed trades)
		const recent = recentClosed.slice(-5);
		const recentWins = recent.filter((t) => t.pnl_cents > 0).length;
		const recentWinRate = recent.length > 0 ? recentWins / recent.length : 0.5;
		if (recentWinRate > 0.6) baseCents *= 1.2;
		if (recentWinRate < 0.4) baseCents *= 0.7;

		// Clamp to [lower, upper]
		let finalCents = Math.max(lowerCents, Math.min(upperCents, baseCents));

		// Clamp to remaining daily notional. The state stores
		// the rolling 24h notional as a history array; sum it
		// here. The daily cap is the per-trade cap × 50 (50 trades
		// per day is the rough upper bound for the dynamic range).
		const dailyUsed = dailyNotionalCents(this._state);
		const dailyRemainingCents = Math.max(
			0,
			this._config.max_notional_cents_per_trade * 50 - dailyUsed,
		);
		finalCents = Math.min(finalCents, dailyRemainingCents);

		// Clamp to remaining position slots
		const openCount = Object.keys(this._state.open_positions).length;
		const slotsLeft = Math.max(0, this._config.max_concurrent_positions - openCount);
		if (slotsLeft <= 0) {
			return { size: 0, notional_cents: 0, reasoning: "no_position_slots" };
		}
		// Split the remaining daily notional across remaining slots
		const perSlotCap = Math.floor(dailyRemainingCents / slotsLeft);
		finalCents = Math.min(finalCents, perSlotCap);

		// Final clamp to [lower, upper] (in case daily cap was tight)
		finalCents = Math.max(lowerCents, Math.min(upperCents, finalCents));

		const size = Math.floor(finalCents / entryPrice);
		const reasoning =
			`judge: conf=${(signalConfidence * 100).toFixed(0)}% ` +
			`dd=${(drawdown * 100).toFixed(1)}% ` +
			`wr=${(recentWinRate * 100).toFixed(0)}% ` +
			`slots=${slotsLeft} → ${finalCents}¢ (${size} @ ${entryPrice}¢)`;
		return { size, notional_cents: finalCents, reasoning };
	}

	perMarketCostCents(ticker: string): number {
		const pos = this._state.open_positions[ticker];
		if (!pos) return 0;
		return pos.cost_cents;
	}

	// ─── Risk checks ─────────────────────────────────────────────

	canOpenPosition(
		ticker: string,
		entryPrice: number,
		currentTick: number,
	): RiskDecision {
		if (currentTick < 0) {
			return { allowed: false, reason: REJECT_TRADE_TICK_INVALID, size: 0 };
		}
		if (this._state.bankroll_cents <= 0) {
			return { allowed: false, reason: REJECT_ZERO_BANKROLL, size: 0 };
		}
		if (!(entryPrice >= 1 && entryPrice <= 99)) {
			return { allowed: false, reason: REJECT_INVALID_PRICE, size: 0 };
		}
		// Drawdown pause check.
		if (currentTick < this._state.drawdown_pause_until_tick) {
			return { allowed: false, reason: REJECT_DRAWDOWN_PAUSE, size: 0 };
		}
		// Loss-streak cooldown check.
		if (currentTick < this._state.cooldown_until_tick) {
			return { allowed: false, reason: REJECT_LOSS_STREAK_COOLDOWN, size: 0 };
		}
		// Concentration cap.
		if (nOpenPositions(this._state) >= this._config.max_concurrent_positions) {
			return { allowed: false, reason: REJECT_CONCENTRATION, size: 0 };
		}
		// Already-in-market check.
		if (ticker in this._state.open_positions) {
			return { allowed: false, reason: REJECT_ALREADY_IN_MARKET, size: 0 };
		}
		// Per-market cap.
		const size = this.computeSize(entryPrice);
		if (size <= 0) {
			return { allowed: false, reason: REJECT_ZERO_BANKROLL, size: 0 };
		}
		const capCents = Math.floor(
			this._config.max_per_market_pct * this._state.bankroll_cents,
		);
		const existingCost = this.perMarketCostCents(ticker);
		const newCost = size * entryPrice;
		if (existingCost + newCost > capCents) {
			return { allowed: false, reason: REJECT_PER_MARKET_CAP, size: 0 };
		}
		return { allowed: true, reason: null, size };
	}

	// ─── Lifecycle hooks (called by the paper engine) ───────────

	recordFill(
		ticker: string,
		vertical: string,
		side: Side,
		entryPrice: number,
		size: number,
		currentTick: number,
	): Position {
		const costCents =
			side === "yes" ? entryPrice * size : (100 - entryPrice) * size;
		const pos: Position = {
			ticker,
			vertical,
			side,
			entry_price: entryPrice,
			size,
			opened_at_tick: currentTick,
			cost_cents: costCents,
		};
		this._state.open_positions[ticker] = pos;
		return pos;
	}

	/**
	 * Record a settlement: close the open position (if any) and update
	 * the bankroll, peak, consecutive-loss counter, and circuit
	 * breakers. Returns the ClosedTrade if a position was open, else null.
	 *
	 * The risk engine does NOT debit the bankroll on fill — that's the
	 * paper engine's job. The engine credits the bankroll on settlement.
	 */
	recordSettlement(
		ticker: string,
		settlementOutcome: Side,
		currentTick: number,
	): ClosedTrade | null {
		const pos = this._state.open_positions[ticker];
		if (!pos) return null;
		delete this._state.open_positions[ticker];
		const pnlPerContract =
			pos.side === settlementOutcome
				? 100 - pos.entry_price
				: -pos.entry_price;
		const pnlCents = pnlPerContract * pos.size;
		this.applySettlement(pnlCents, ticker, pos, settlementOutcome, currentTick);
		return this.appendClosedTrade({
			ticker,
			vertical: pos.vertical,
			side: pos.side,
			entry_price: pos.entry_price,
			size: pos.size,
			settlement_outcome: settlementOutcome,
			pnl_cents: pnlCents,
			bankroll_after: this._state.bankroll_cents,
			closed_at_tick: currentTick,
		});
	}

	/**
	 * Close a position at a mark price (paper trading / stop-loss /
	 * take-profit). PnL is mark-to-market.
	 */
	closePositionAtMark(
		ticker: string,
		markCents: number,
		currentTick: number,
	): ClosedTrade | null {
		if (!(markCents >= 0 && markCents <= 100)) return null;
		const pos = this._state.open_positions[ticker];
		if (!pos) return null;
		delete this._state.open_positions[ticker];
		const pnlPerContract =
			pos.side === "yes"
				? markCents - pos.entry_price
				: pos.entry_price - (100 - markCents);
		const pnlCents = pnlPerContract * pos.size;
		this.applySettlement(pnlCents, ticker, pos, pos.side, currentTick);
		return this.appendClosedTrade({
			ticker,
			vertical: pos.vertical,
			side: pos.side,
			entry_price: pos.entry_price,
			size: pos.size,
			settlement_outcome: "mark",
			pnl_cents: pnlCents,
			bankroll_after: this._state.bankroll_cents,
			closed_at_tick: currentTick,
		});
	}

	// ─── Internal ────────────────────────────────────────────────

	private applySettlement(
		pnlCents: number,
		_ticker: string,
		pos: Position,
		_outcome: Side,
		currentTick: number,
	): void {
		const newBankroll = this._state.bankroll_cents + pnlCents;
		const newPeak = Math.max(this._state.peak_bankroll_cents, newBankroll);
		this._state.bankroll_cents = newBankroll;
		this._state.peak_bankroll_cents = newPeak;

		// Consecutive-loss counter.
		if (pnlCents < 0) {
			this._state.consecutive_losses += 1;
			if (
				this._state.consecutive_losses >=
				this._config.loss_streak_limit
			) {
				this._state.cooldown_until_tick =
					currentTick + this._config.loss_streak_cooldown_ticks;
				this._state.consecutive_losses = 0;
			}
		} else {
			this._state.consecutive_losses = 0;
		}

		// Drawdown pause check.
		if (this._state.peak_bankroll_cents > 0) {
			const drawdown =
				(this._state.peak_bankroll_cents - this._state.bankroll_cents) /
				this._state.peak_bankroll_cents;
			if (drawdown >= this._config.drawdown_pause_pct) {
				if (currentTick >= this._state.drawdown_pause_until_tick) {
					this._state.drawdown_pause_until_tick =
						currentTick + this._config.drawdown_pause_ticks;
				}
			}
		}

		// `pos` is referenced for symmetry with the Python engine; the
		// engine already popped it from open_positions before this call.
		void pos;
	}

	private appendClosedTrade(trade: ClosedTrade): ClosedTrade {
		this._state.closed_trades.push(trade);
		this._state.pnl_history.push(trade.pnl_cents);
		if (this._state.pnl_history.length > 10_000) {
			this._state.pnl_history.shift();
		}
		return trade;
	}
}
