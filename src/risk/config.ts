/**
 * pm-bot — risk engine configuration.
 *
 * Mirrors `Prediction Market Lab/.../risk/config.py:RiskConfig`.
 *
 * The risk envelope (per docs/strategy.md §6 and
 * docs/architecture.md §risk/):
 *   - **1% sizing** — `size = floor(0.01 * bankroll / entry_price)`.
 *   - **3 concurrent positions** — hard cap.
 *   - **5% per-market cap** — exposure per ticker.
 *   - **10% drawdown pause** — freeze when drawdown from peak > 10%.
 *   - **3-loss cooldown** — freeze after 3 consecutive losses.
 *
 * All limits are in cents to avoid float-rounding issues.
 */

export const DEFAULT_STARTING_BANKROLL_CENTS = 1_000_000; // $10K
export const DEFAULT_POSITION_SIZE_PCT = 0.01;
export const DEFAULT_MAX_PER_MARKET_PCT = 0.05;
export const DEFAULT_MAX_CONCURRENT_POSITIONS = 3;
export const DEFAULT_DRAWDOWN_PAUSE_PCT = 0.10;
export const DEFAULT_DRAWDOWN_PAUSE_TICKS = 86_400; // 24h @ 1 tick/s
export const DEFAULT_LOSS_STREAK_LIMIT = 3;
export const DEFAULT_LOSS_STREAK_COOLDOWN_TICKS = 3_600; // 1h @ 1 tick/s

export interface RiskConfig {
	starting_bankroll_cents: number;
	position_size_pct: number;
	max_per_market_pct: number;
	max_concurrent_positions: number;
	drawdown_pause_pct: number;
	drawdown_pause_ticks: number;
	loss_streak_limit: number;
	loss_streak_cooldown_ticks: number;
	max_contracts_per_trade: number | null;
}

export function defaultRiskConfig(): RiskConfig {
	return {
		starting_bankroll_cents: DEFAULT_STARTING_BANKROLL_CENTS,
		position_size_pct: DEFAULT_POSITION_SIZE_PCT,
		max_per_market_pct: DEFAULT_MAX_PER_MARKET_PCT,
		max_concurrent_positions: DEFAULT_MAX_CONCURRENT_POSITIONS,
		drawdown_pause_pct: DEFAULT_DRAWDOWN_PAUSE_PCT,
		drawdown_pause_ticks: DEFAULT_DRAWDOWN_PAUSE_TICKS,
		loss_streak_limit: DEFAULT_LOSS_STREAK_LIMIT,
		loss_streak_cooldown_ticks: DEFAULT_LOSS_STREAK_COOLDOWN_TICKS,
		max_contracts_per_trade: null,
	};
}

export function validateRiskConfig(cfg: RiskConfig): void {
	if (cfg.starting_bankroll_cents < 1) {
		throw new Error(
			`starting_bankroll_cents must be >= 1, got ${cfg.starting_bankroll_cents}`,
		);
	}
	if (!(cfg.position_size_pct > 0 && cfg.position_size_pct <= cfg.max_per_market_pct)) {
		throw new Error(
			`position_size_pct must be in (0, max_per_market_pct], got ` +
				`position_size_pct=${cfg.position_size_pct}, ` +
				`max_per_market_pct=${cfg.max_per_market_pct}`,
		);
	}
	if (!(cfg.max_per_market_pct > 0 && cfg.max_per_market_pct <= 1.0)) {
		throw new Error(
			`max_per_market_pct must be in (0, 1], got ${cfg.max_per_market_pct}`,
		);
	}
	if (cfg.max_concurrent_positions < 1) {
		throw new Error(
			`max_concurrent_positions must be >= 1, got ${cfg.max_concurrent_positions}`,
		);
	}
	if (!(cfg.drawdown_pause_pct > 0 && cfg.drawdown_pause_pct <= 1.0)) {
		throw new Error(
			`drawdown_pause_pct must be in (0, 1], got ${cfg.drawdown_pause_pct}`,
		);
	}
	if (cfg.drawdown_pause_ticks < 1) {
		throw new Error(
			`drawdown_pause_ticks must be >= 1, got ${cfg.drawdown_pause_ticks}`,
		);
	}
	if (cfg.loss_streak_limit < 1) {
		throw new Error(
			`loss_streak_limit must be >= 1, got ${cfg.loss_streak_limit}`,
		);
	}
	if (cfg.loss_streak_cooldown_ticks < 1) {
		throw new Error(
			`loss_streak_cooldown_ticks must be >= 1, got ${cfg.loss_streak_cooldown_ticks}`,
		);
	}
	if (cfg.max_contracts_per_trade !== null && cfg.max_contracts_per_trade < 1) {
		throw new Error(
			`max_contracts_per_trade must be >= 1 when set, got ${cfg.max_contracts_per_trade}`,
		);
	}
}
