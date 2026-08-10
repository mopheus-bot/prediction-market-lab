/**
 * pm-bot — LiveBot Durable Object (chunk 3).
 *
 * The 24/7 paper-trading engine. Owns:
 *   - An outgoing WebSocket connection to the Kalshi public WS feed
 *     (orderbook deltas, trades, ticker, lifecycle).
 *   - A per-ticker state machine: orderbook, price history, position,
 *     market metadata, trade counter.
 *   - The risk engine's state (bankroll, open positions, circuit
 *     breakers).
 *   - Persistent state in `ctx.storage` so the DO can be evicted and
 *     resume cleanly on the next request / alarm.
 *
 * Hibernation model (per docs/PLAN.md §"Decisions to honor"):
 *   - The INCOMING control WS (clients connecting to the bot to issue
 *     commands like /start, /stop, /status) uses
 *     `state.acceptWebSocket()` so the DO can hibernate between
 *     messages. This is where the cost saving comes from.
 *   - The OUTGOING Kalshi WS is a regular long-lived WebSocket held
 *     in `this._kalshiWs`. We open it on demand (when the bot is
 *     started) and close it on stop / cycle.
 *   - The "90-min cycle" closes and reopens the Kalshi WS every 90
 *     minutes via a `state.storage.setAlarm()`. This avoids idle
 *     disconnects, recovers from any session drift, and gives the
 *     engine a clean snapshot of state at each cycle boundary.
 *
 * All persistent state lives in `ctx.storage` — the engine NEVER
 * holds critical state in instance variables that would be lost on
 * eviction. Instance variables are caches that can be reconstructed
 * from storage.
 *
 * Wire-format handling: incoming WS messages from Kalshi are routed
 * by `type` (orderbook_snapshot, orderbook_delta, trade, ticker,
 * market_lifecycle, subscribed, error). Each frame may trigger a
 * strategy call → signal → risk check → trade record → D1 write.
 *
 * Fill simulation: every signal is treated as an immediate fill at
 * the limit price. Mirrors the backtester's `use_signal_price=True`
 * path. A more realistic fill model (order book queue, partial
 * fills, walk-away) lands in a follow-up.
 *
 * Multi-tenant: addressed by `idFromName(`user:${userId}`)`. The
 * `user_id` is passed in the initial config and stored alongside the
 * rest of the engine state. All D1 writes scope to that user.
 */

import {
	orderbookMidCents,
	parseOrderbook,
	type KalshiOrderbookLevel,
} from "../kalshi/models.js";
import { isStructurallyUnprofitable, kalshiTakerFeeCents } from "../lib/fees.js";
import {
	makeRiskState,
	dailyNotionalCents,
	recordNotionalCents,
	type RiskState,
} from "../risk/state.js";
import { sendMessage as sendTelegramMessage } from "../telegram/index.js";
import { RiskEngine } from "../risk/engine.js";
import { defaultRiskConfig, type RiskConfig } from "../risk/config.js";
import type { Side, Vertical } from "../lib/types.js";
import {
	type Signal,
	type SignalContext,
	type SignalStrategy,
} from "../strategy/signal.js";
import { VerticalStrategyRouter } from "../strategy/router.js";
import { loadModelFromR2, type ModelLoaderEnv } from "../strategy/model-loader.js";
import type { RandomForestModel } from "../strategy/forest.js";

// ─── Persistent state shape ────────────────────────────────────────────

export interface LiveBotState {
	user_id: string;
	/** Per-ticker live state. Keyed by ticker. */
	tickers: Record<
		string,
		{
			vertical: Vertical | string;
			event_ticker: string;
			title: string;
			/** Orderbook: latest snapshot. */
			book: { yes_levels: KalshiOrderbookLevel[]; no_levels: KalshiOrderbookLevel[] } | null;
			/** Price history (cents, oldest first, maxlen=lookback). */
			price_history: number[];
			/** Last YES-side trade price (cents). Used for settlement exit. */
			last_trade_price_cents: number | null;
			/** Per-ticker trade count (for the auto-close horizon). */
			trade_count: number;
			/** Open position, if any. The engine does NOT pyramid. */
			position: {
				side: Side;
				size: number;
				entry_price_cents: number;
				entry_ts_ms: number;
				rationale: string;
				entry_signal_p: number;
			} | null;
		}
	>;
	risk_state: RiskState;
	/** Counters. */
	n_signals: number;
	n_frames: number;
	n_trades: number;
	total_fees_cents: number;
	/** Engine config. Captured at start() for the summary. */
	config: {
		tickers: string[];
		ticker_verticals: Record<string, string>;
		bankroll_cents: number;
		url: string;
		lookback: number;
		started_ts_ms: number;
		// Run knobs (mirror the Python CLI flags).
		disable_flips: boolean;
		no_flip_verticals: string[] | null;
		min_entry_p: number;
		close_after_trades: number | null;
		exit_mode: "mtm" | "settlement";
		profit_target_pct: number | null;
		stop_loss_pct: number | null;
		/** Chunk 4: model version for the reversion-quality models.
		 * Defaults to "v1"; the DO looks up
		 * `models/reversion-{weather,economic}-${model_version}.json`
		 * in R2 on /start. */
		model_version: string;
		/** Chunk 9: trading mode. */
		trading_mode: "paper" | "real" | "off";
		/** Chunk 9: caps. */
		max_notional_cents_per_trade: number;
		daily_notional_cents_cap: number;
		/** Chunk 9: kill switch. */
		kill_switch: boolean;
		/** Chunk 11b: per-vertical caps. Optional override
		 *  of the global `max_notional_cents_per_trade` per
		 *  vertical (weather / economic / politics / sports).
		 *  When a vertical is in this map, that cap is used;
		 *  else the global cap. Useful because weather is more
		 *  predictable than politics — you can cap politics at
		 *  5¢/trade while keeping 25¢/trade on weather. */
		per_vertical_max_notional_cents?: Record<string, number> | null;
		/** Chunk 11b: per-ticker blocklist. The bot skips
		 *  trades on these tickers even when the global kill
		 *  switch is OFF. Useful for "I don't want to trade
		 *  KXTICKER because the model isn't reliable for it"
		 *  without flipping the global kill switch. */
		disabled_tickers?: string[] | null;
	/** Chunk 10.8c: per-vertical blocklist. The bot skips
	 *  trades on any ticker whose vertical is in this list. */
	disabled_verticals?: string[] | null;
	/** 2026-08-10: per-vertical NaiveSignal fade threshold
	 *  override. The default 5% is calibrated to synthetic
	 *  high-vol data; live Kalshi markets (especially weather
	 *  + single-game sports) rarely move 5% in 60 polls.
	 *  Map of vertical (weather/economic/politics/sports) to
	 *  threshold fraction (0.02 = 2%). Missing verticals fall
	 *  back to the default 5%. Set via /start config. */
	per_vertical_fade_threshold?: Record<string, number> | null;
	/** 2026-08-10: per-vertical min absolute move (cents).
	 *  Combined with `per_vertical_fade_threshold` via OR:
	 *  the signal fires when EITHER the percentage OR the
	 *  absolute threshold is exceeded. Use this for stable
	 *  markets (KXWARMING-50 at 78¢) where a 1¢ move is
	 *  meaningful edge but below any reasonable percentage
	 *  threshold. Map of vertical to cents (1 = 1¢). */
	per_vertical_min_absolute_move_cents?: Record<string, number> | null;
};
	/** The most recent risk reject reason (per-ticker, for /status). */
	last_reject: { ts_ms: number; ticker: string; code: string; message: string } | null;
}

// ─── Engine config (constructor input) ────────────────────────────────

export interface LiveBotConfig {
	user_id?: string;
	bankroll_cents?: number;
	url?: string;
	lookback?: number;
	ticker_verticals?: Record<string, string>;
	disable_flips?: boolean;
	no_flip_verticals?: string[] | null;
	min_entry_p?: number;
	close_after_trades?: number | null;
	exit_mode?: "mtm" | "settlement";
	profit_target_pct?: number | null;
	stop_loss_pct?: number | null;
	risk_config?: RiskConfig;
	/** Chunk 4: model version (e.g. "v1", "v2"). The DO loads
	 * `models/reversion-{weather,economic}-${model_version}.json`
	 * from R2 on /start. */
	model_version?: string;
	/** Chunk 9: trading mode. "paper" = log only (default),
	 * "real" = also place live orders on Kalshi, "off" = log
	 * nothing (bot is paused; the WS keeps running so we
	 * still see state). */
	trading_mode?: "paper" | "real" | "off";
	/** Chunk 9: max cents per single trade. Default 100c
	 * ($1.00). When a signal wants to trade more than this,
	 * it's rejected with `per_trade_cap_exceeded`. Conservative
	 * default for safety; the user can override via /start. */
	max_notional_cents_per_trade?: number;
	/** Chunk 9: max cents deployed in the last 24h (sliding
	 * window). Default 1000c ($10.00). When a new trade
	 * would push the 24h total over this, it's rejected
	 * with `daily_cap_exceeded`. The cap is tracked in the
	 * bot's risk state (persisted to ctx.storage on every
	 * trade). */
	daily_notional_cents_cap?: number;
	/** Chunk 9: kill switch. When true, the engine refuses
	 * all new trades (paper + real) AND closes any open
	 * positions at the next mark. Use this as the panic
	 * button. */
	kill_switch?: boolean;
	/** Chunk 11b: per-vertical caps. Optional override of
	 * the global `max_notional_cents_per_trade` per vertical
	 * (weather / economic / politics / sports). When a
	 * vertical is in this map, that cap is used; else the
	 * global cap. */
	per_vertical_max_notional_cents?: Record<string, number> | null;
	/** Chunk 11b: per-ticker blocklist. The bot skips trades
	 * on these tickers even when the global kill switch is
	 * OFF. */
	disabled_tickers?: string[] | null;
	/** Chunk 10.8c: per-vertical blocklist. The bot skips
	 * trades on any ticker whose vertical is in this list.
	 * Useful for "I want to disable politics while keeping
	 * weather + economic" without touching the per-ticker
	 * blocklist. Vertical is the `ticker_verticals[t]` value
	 * (lowercased). */
	disabled_verticals?: string[] | null;
	/** Chunk 10.8c: when true, /start re-pulls bankroll_cents
	 * from Kalshi (only meaningful when trading_mode === "real").
	 * Lets the operator add/withdraw money, hit /start, and
	 * have position sizing adjust to the new balance. */
	refresh_bankroll?: boolean;
	/** 2026-08-10: per-vertical NaiveSignal fade threshold
	 * override. Map of vertical (weather/economic/politics/sports)
	 * to threshold fraction (0.02 = 2%). The default 5% rarely
	 * fires on live Kalshi markets. Set per-vertical thresholds
	 * for verticals where the bot has data but the default
	 * threshold is too tight. Missing verticals fall back to 5%. */
	per_vertical_fade_threshold?: Record<string, number> | null;
	/** 2026-08-10: per-vertical min absolute move (cents).
	 *  OR-combined with `per_vertical_fade_threshold`. The
	 *  signal fires if EITHER threshold is exceeded. Use
	 *  this for stable markets (KXWARMING-50) where 1¢
	 *  moves are meaningful edge. Map of vertical to cents. */
	per_vertical_min_absolute_move_cents?: Record<string, number> | null;
}

// ─── Env (subset we need) ─────────────────────────────────────────────

interface LiveBotEnv {
	DB?: D1Database;
	BUCKET?: R2Bucket;
	KALSHI_PROD_KEY_ID?: string;
	KALSHI_PROD_PRIVATE_KEY?: string; // PKCS#8 PEM
	KALSHI_DEMO_KEY_ID?: string;
	KALSHI_DEMO_PRIVATE_KEY?: string;
	ENVIRONMENT?: string;
	SERVICE_NAME?: string;
	// Default paper-trading universe when none is provided.
	DEFAULT_TICKERS?: string;
	DEFAULT_URL?: string;
	// Optional JSON-serialized RiskConfig override. Allows per-deployment
	// risk tuning without redeploying the Worker.
	RISK_CONFIG_OVERRIDE?: string;
	// Telegram (chunk 11a). The bot sends a Telegram message on every
	// REAL fill (when trading_mode === "real"). Paper + off don't post.
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
}

// ─── The DO class ──────────────────────────────────────────────────────

const STORAGE_KEY = "state:v1";
const ALARM_KEY_CYCLE = "alarm:cycle";
const CYCLE_MS = 90 * 60 * 1000; // 90 minutes

export class LiveBot implements DurableObject {
	private readonly ctx: DurableObjectState;
	private readonly env: LiveBotEnv;

	// Non-persistent caches — rebuilt from ctx.storage on each
	// request. The SDK client is also a transient in-memory
	// object (rebuilt from env on each alarm fire).
	private _connected = false;

	// 2026-08-09: WS→polling migration. The data feed is a
	// REST polling loop driven by the kalshi-typescript SDK
	// and scheduled via the DO's `setAlarm` (durable across
	// evictions; setTimeout was unreliable in the DO).
	private _sdkClient: import("../kalshi/sdk-adapter.js").KalshiSdkClient | null = null;
	// Polling intent is stored in DO storage (key "is_polling"),
	// NOT in memory — DOs are evicted when idle, and an
	// in-memory flag would reset to false on re-instantiation
	// even though the alarm is still set. The alarm is the
	// "is polling supposed to be happening" signal; the storage
	// flag is the "did the user say stop" signal. Both are
	// durable.
	/** Round-robin cursor into state.config.tickers. */
	private _pollIndex = -1;
	/** Wall-clock duration of the last poll, in ms. */
	private _lastPollMs: number | null = null;
	/** Total successful polls. Mirrors `n_frames` for the WS feed. */
	private _nPolls = 0;
	/** Total failed polls. Useful for the dashboard's "data feed" panel. */
	private _nPollErrors = 0;
	/** Last poll error (network, 429, parse). Cleared on next success. */
	private _lastPollError: { ts_ms: number; code: string; message: string } | null = null;
	// Model cache (chunk 4). Loaded from R2 on /start, reused
	// across every signal call. Re-loaded if the model_version
	// changes via a subsequent /start call. We don't persist
	// the loaded model in storage — it's a few hundred KB and
	// rebuilding it from the JSON blob is fast.
	private _models: { weather: RandomForestModel | null; economic: RandomForestModel | null } = {
		weather: null,
		economic: null,
	};
	private _modelVersion: string = "v1";

	constructor(ctx: DurableObjectState, env: LiveBotEnv) {
		this.ctx = ctx;
		this.env = env;
	}

	// ─── Polling-intent flag (durable) ────────────────────────────
	//
	// Stored in DO storage so it survives idle evictions.
	// The in-memory equivalent (`_isPolling`) used to live
	// here but it reset to false when the DO was
	// re-instantiated, even though the alarm kept firing.
	// Reading from storage on every status poll is a few
	// hundred microseconds — negligible.

	private async isPollingActive(): Promise<boolean> {
		return (await this.ctx.storage.get("is_polling")) === true;
	}

	private async setPollingActive(active: boolean): Promise<void> {
		if (active) {
			await this.ctx.storage.put("is_polling", true);
		} else {
			await this.ctx.storage.delete("is_polling");
		}
	}

	// ─── Persistent state helpers ─────────────────────────────────

	private async loadState(): Promise<LiveBotState | null> {
		return (await this.ctx.storage.get<LiveBotState>(STORAGE_KEY)) ?? null;
	}

	private async saveState(state: LiveBotState): Promise<void> {
		await this.ctx.storage.put(STORAGE_KEY, state);
	}

	private async ensureState(): Promise<LiveBotState> {
		let s = await this.loadState();
		if (s) return s;
		// First touch — build a default state from the constructor config
		// (the Worker will call /start with the real config before any
		// trading, but we want the DO to be queryable from the start).
		s = this.buildDefaultState();
		await this.saveState(s);
		// Mirror the relevant config fields to D1 so the
		// Worker's /api/pm/verticals endpoint can read them
		// without an extra round-trip to the DO.
		await this.mirrorConfigToD1(s);
		return s;
	}

	/**
	 * Chunk 10.8c: write a denormalized subset of the bot
	 * config to D1 so the Worker's read-only endpoints
	 * (currently /api/pm/verticals) can serve fresh data
	 * without instantiating the DO. The DO is the source of
	 * truth; this is a one-way cache.
	 */
	private async mirrorConfigToD1(state: LiveBotState): Promise<void> {
		if (!this.env.DB) return;
		const value = JSON.stringify({
			disabled_verticals: state.config.disabled_verticals ?? null,
			disabled_tickers: state.config.disabled_tickers ?? null,
			per_vertical_max_notional_cents:
				state.config.per_vertical_max_notional_cents ?? null,
			per_vertical_fade_threshold:
				state.config.per_vertical_fade_threshold ?? null,
			per_vertical_min_absolute_move_cents:
				state.config.per_vertical_min_absolute_move_cents ?? null,
			ticker_verticals: state.config.ticker_verticals ?? null,
			trading_mode: state.config.trading_mode,
			bankroll_cents: state.config.bankroll_cents,
		});
		try {
			await this.env.DB
				.prepare(
					`INSERT INTO bot_config (user_id, key, value, ts_ms)
					 VALUES (?1, 'config', ?2, ?3)
					 ON CONFLICT (user_id, key) DO UPDATE
					   SET value = excluded.value, ts_ms = excluded.ts_ms`,
				)
				.bind(state.user_id, value, Date.now())
				.run();
		} catch (e) {
			console.warn(
				"[live-bot] mirrorConfigToD1 failed (non-fatal):",
				e instanceof Error ? e.message : String(e),
			);
		}
	}

	private buildDefaultState(): LiveBotState {
		const tickersCsv = this.env.DEFAULT_TICKERS ?? "KXWARMING-50";
		const defaultTickers = tickersCsv.split(",").map((t) => t.trim()).filter(Boolean);
		// 2026-08-09: WS→polling migration. The defaultUrl
		// used to point at the Kalshi WS endpoint. Polling
		// doesn't use a WS URL, so DEFAULT_URL is now just
		// a placeholder string for backward-compat in the
		// bot's config.url field — nothing reads it at
		// runtime.
		const defaultUrl = this.env.DEFAULT_URL ?? "polling://kalshi-rest";
		const bankrollCents = 1_000_000; // $10K paper
		const tickers: LiveBotState["tickers"] = {};
		for (const t of defaultTickers) {
			tickers[t] = {
				vertical: "unknown",
				event_ticker: "",
				title: "",
				book: null,
				price_history: [],
				last_trade_price_cents: null,
				trade_count: 0,
				position: null,
			};
		}
		return {
			user_id: "default",
			tickers,
			risk_state: makeRiskState(bankrollCents),
			n_signals: 0,
			n_frames: 0,
			n_trades: 0,
			total_fees_cents: 0,
			config: {
				tickers: defaultTickers,
				ticker_verticals: {},
				bankroll_cents: bankrollCents,
				url: defaultUrl,
				lookback: 30,
				started_ts_ms: Date.now(),
				disable_flips: false,
				no_flip_verticals: null,
				min_entry_p: 0,
				close_after_trades: null,
				exit_mode: "mtm",
				profit_target_pct: null,
				stop_loss_pct: null,
				model_version: "v1",
				// Chunk 9.6 defaults (revised for a $9.73
				// account). 25c per trade = 2.5% of balance;
				// 150c daily deployed notional = 15% of
				// balance. Operators bump via /start when
				// ready to test with a bigger bag.
				trading_mode: "paper",
				max_notional_cents_per_trade: 25, // $0.25
				daily_notional_cents_cap: 150, // $1.50
				kill_switch: false,
				// Chunk 11b: per-vertical caps + per-ticker
				// blocklist. Default to "no override" (null)
				// which falls back to the global cap. Operators
				// set these via /start to enforce tighter
				// caps on risky verticals.
				per_vertical_max_notional_cents: null,
				disabled_tickers: null,
				disabled_verticals: null,
				// 2026-08-10: default to 2% for weather (the only
				// vertical with real data right now). Other
				// verticals stay at 5% until they get real data.
				per_vertical_fade_threshold: { weather: 0.02 },
				// 2026-08-10: default to 1¢ absolute move for
				// weather. KXWARMING-50 sits at 78¢ and
				// rarely moves 2% in 60 polls; a 1¢ move is
				// 1.3% — meaningful absolute edge. Other
				// verticals stay at 0 (percentage only).
				per_vertical_min_absolute_move_cents: { weather: 1 },
			},
			last_reject: null,
		};
	}

	private makeRiskEngine(state: LiveBotState): RiskEngine {
		const cfg = this.env.RISK_CONFIG_OVERRIDE
			? JSON.parse(this.env.RISK_CONFIG_OVERRIDE) as RiskConfig
			: defaultRiskConfig();
		return new RiskEngine({ config: cfg, state: state.risk_state });
	}

	/**
	 * Load the reversion-quality models from R2 for the verticals
	 * where they outperform naive (weather, economic). Failure to
	 * load is non-fatal — the engine falls back to NaiveSignal for
	 * the affected vertical.
	 *
	 * **Chunk 8 update:** the `models` D1 table is the source of
	 * truth for "which model_version is active per vertical." When
	 * `loadActiveFromRegistry` is true (the default), we query the
	 * `models` table for the active row per vertical and use that
	 * version. The `version` argument is then a fallback (used
	 * when the registry is empty, e.g. before any model has been
	 * registered). This keeps backward compat with the chunk-4
	 * `config.model_version` field while making the registry
	 * the canonical source.
	 */
	private async loadModels(
		version: string,
		opts: { loadActiveFromRegistry?: boolean } = {},
	): Promise<void> {
		const { loadActiveFromRegistry = true } = opts;
		// Resolve the per-vertical version: registry first, then
		// the fallback. If the registry is empty, every vertical
		// uses the fallback (preserves chunk-4 behavior).
		let weatherVersion = version;
		let economicVersion = version;
		if (loadActiveFromRegistry && this.env.DB) {
			const [w, e] = await Promise.all([
				this.env.DB
					.prepare(
						`SELECT version FROM models
						 WHERE user_id = ?1 AND vertical = ?2 AND status = 'active'
						 ORDER BY deployed_at DESC NULLS LAST LIMIT 1`,
					)
					.bind("default", "weather")
					.first<{ version: string }>(),
				this.env.DB
					.prepare(
						`SELECT version FROM models
						 WHERE user_id = ?1 AND vertical = ?2 AND status = 'active'
						 ORDER BY deployed_at DESC NULLS LAST LIMIT 1`,
					)
					.bind("default", "economic")
					.first<{ version: string }>(),
			]);
			if (w?.version) weatherVersion = w.version;
			if (e?.version) economicVersion = e.version;
		}
		this._modelVersion = weatherVersion; // primary, for display
		// Load in parallel; each loader is independent.
		const [weather, economic] = await Promise.all([
			loadModelFromR2(this.env, "weather", weatherVersion),
			loadModelFromR2(this.env, "economic", economicVersion),
		]);
		this._models = { weather, economic };
		if (weather && economic) {
			console.log(
				`[live-bot] loaded reversion models (weather=${weatherVersion} economic=${economicVersion})`,
			);
		} else if (weather || economic) {
			console.warn(
				`[live-bot] partial model load: weather=${!!weather} economic=${!!economic}; ` +
					`missing verticals fall back to NaiveSignal`,
			);
		} else {
			console.warn(
				`[live-bot] no reversion models in R2 (version=${version}); ` +
					`engine will use NaiveSignal for every vertical`,
			);
		}
	}

	// ─── fetch() — control endpoint ──────────────────────────────

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// WebSocket upgrade for the control channel (start/stop/status
		// over a single connection). Uses hibernation: we accept the
		// WS, then process commands as messages arrive.
		if (request.headers.get("Upgrade") === "websocket") {
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];
			this.ctx.acceptWebSocket(server, ["control"]);
			return new Response(null, { status: 101, webSocket: client });
		}

		const state = await this.ensureState();

		switch (path) {
			case "/status": {
				// Compute unrealized PnL per open position.
				// Mark is the latest of: orderbook mid, last
				// trade price, entry price (no PnL without
				// a mark). Unrealized PnL is computed in
				// cents: positive = winning, negative = losing.
				const openPositionsWithPnl = Object.values(state.risk_state.open_positions).map(
					(p) => {
						const ts = state.tickers[p.ticker];
						let markCents: number | null = null;
						if (ts?.book) {
							markCents = orderbookMidCents({
								ticker: p.ticker,
								yes_levels: ts.book.yes_levels,
								no_levels: ts.book.no_levels,
							});
						}
						if (markCents === null) markCents = ts?.last_trade_price_cents ?? null;
						if (markCents === null) markCents = p.entry_price; // no mark yet → PnL = 0
						const unrealizedCents =
							p.side === "yes"
								? (markCents - p.entry_price) * p.size
								: (p.entry_price - (100 - markCents)) * p.size;
						return {
							ticker: p.ticker,
							side: p.side,
							size: p.size,
							entry_price: p.entry_price,
							cost_cents: p.cost_cents,
							mark_cents: markCents,
							unrealized_pnl_cents: unrealizedCents,
						};
					},
				);
				const totalUnrealizedCents = openPositionsWithPnl.reduce(
					(sum, p) => sum + p.unrealized_pnl_cents,
					0,
				);
				return Response.json({
					ok: true,
					connected: this._connected,
					user_id: state.user_id,
					config: state.config,
					counts: {
						n_signals: state.n_signals,
						n_frames: state.n_frames,
						n_trades: state.n_trades,
						total_fees_cents: state.total_fees_cents,
					},
					risk: {
						bankroll_cents: state.risk_state.bankroll_cents,
						peak_bankroll_cents: state.risk_state.peak_bankroll_cents,
						open_positions: openPositionsWithPnl,
						total_unrealized_pnl_cents: totalUnrealizedCents,
						consecutive_losses: state.risk_state.consecutive_losses,
						drawdown_pause_until_tick: state.risk_state.drawdown_pause_until_tick,
						cooldown_until_tick: state.risk_state.cooldown_until_tick,
						// Chunk 9: 24h notional deployed.
						daily_notional_cents: dailyNotionalCents(state.risk_state),
						daily_notional_cap_cents: state.config.daily_notional_cents_cap,
						daily_notional_history_len: state.risk_state.daily_notional_history.length,
					},
					tickers: Object.fromEntries(
						Object.entries(state.tickers).map(([t, ts]) => [
							t,
							{
								vertical: ts.vertical,
								has_book: ts.book !== null,
								price_history_len: ts.price_history.length,
								// 2026-08-10: expose first/last/current
								// so the operator can see what the
								// strategy is actually working with
								// (the movePct math needs all three).
								price_history_first_cents: ts.price_history[0] ?? null,
								price_history_last_cents:
									ts.price_history[ts.price_history.length - 1] ?? null,
								last_trade_price_cents: ts.last_trade_price_cents,
								trade_count: ts.trade_count,
								position: ts.position,
							},
						]),
					),
					last_reject: state.last_reject,
					// 2026-08-09: WS→polling migration. The
					// last_ws_error field is gone — the data
					// feed is REST polling, not a WS connection.
					// The bot status now exposes the polling
					// feed state. The `active` flag is read from
					// durable storage (key: "is_polling") so it
					// survives DO idle-evictions and re-instantiations.
					poll: {
						active: await this.isPollingActive(),
						connected: this._connected,
						n_polls: this._nPolls,
						n_errors: this._nPollErrors,
						last_poll_ms: this._lastPollMs,
						last_error: this._lastPollError,
						tickers: state.config.tickers,
					},
				});
			}

			case "/start": {
				const config = (await request.json().catch(() => ({}))) as LiveBotConfig;
				await this.start(config);
				// Re-read state so the response reflects the
				// new config (start() mutates and saves to
				// storage; the local `state` variable was
				// captured before start() ran).
				const freshState = await this.loadState();
				return Response.json({
					ok: true,
					started: true,
					config: freshState?.config ?? state.config,
				});
			}

			case "/auto-start": {
				// Idempotent: if the WS is actually
				// connected, return the current state
				// without restarting. Otherwise start
				// with default config. The check is on
				// `this._connected` (not the configured
				// tickers) because state.config may be
				// set from a prior /start even if the
				// current isolate is fresh after a
				// deploy — the user expects the bot
				// to be running, and re-starting is
				// cheap.
				if (this._connected) {
					return Response.json({
						ok: true,
						started: false,
						already_running: true,
						connected: this._connected,
						config: state.config,
					});
				}
				await this.start({});
				return Response.json({
					ok: true,
					started: true,
					already_running: false,
					connected: this._connected,
					config: state.config,
				});
			}

			case "/stop": {
				await this.stop();
				return Response.json({ ok: true, stopped: true });
			}

			case "/restart": {
				await this.restart();
				return Response.json({ ok: true, restarted: true });
			}

			case "/reload-models": {
				// Chunk 8: re-read the active model_version from
				// the models D1 table and reload from R2. The
				// caller doesn't have to know the per-vertical
				// version; the registry is the source of truth.
				const state = await this.ensureState();
				await this.loadModels(state.config.model_version ?? this._modelVersion);
				return Response.json({
					ok: true,
					reloaded: true,
					models: {
						weather: this._models.weather ? "loaded" : "missing",
						economic: this._models.economic ? "loaded" : "missing",
					},
				});
			}

			case "/trading-mode": {
				// Chunk 9: set the trading mode. Body:
				// { "trading_mode": "paper" | "real" | "off" }
				const body = (await request.json().catch(() => ({}))) as {
					trading_mode?: "paper" | "real" | "off";
				};
				const mode = body.trading_mode;
				if (mode !== "paper" && mode !== "real" && mode !== "off") {
					return Response.json(
						{
							ok: false,
							error: "invalid_trading_mode",
							message: `trading_mode must be 'paper' | 'real' | 'off', got ${JSON.stringify(mode)}`,
						},
						{ status: 400 },
					);
				}
				const s = await this.ensureState();
				const previous = s.config.trading_mode;
				s.config.trading_mode = mode;
				// Chunk 10.8c: when going to "real", re-pull
				// bankroll from Kalshi so position sizing matches
				// the operator's actual balance. Failure to pull
				// is non-fatal — keep the previous bankroll.
				let bankrollRefresh: {
					ok: boolean;
					bankrollCents?: number;
					reasonCode?: string;
					message?: string;
				} | null = null;
				if (mode === "real") {
					const r = await this.refreshBankrollFromKalshi(s);
					if (r.ok) {
						s.config.bankroll_cents = r.bankrollCents;
						bankrollRefresh = { ok: true, bankrollCents: r.bankrollCents };
					} else {
						console.warn(
							"[live-bot] /trading-mode bankroll refresh failed:",
							r.reasonCode,
							r.message,
						);
						bankrollRefresh = {
							ok: false,
							reasonCode: r.reasonCode,
							message: r.message,
						};
					}
				}
				await this.saveState(s);
				await this.mirrorConfigToD1(s);
				return Response.json({
					ok: true,
					trading_mode: mode,
					previous_trading_mode: previous,
					bankroll_refresh: bankrollRefresh,
				});
			}

			case "/kill-switch": {
				// Chunk 9: toggle the kill switch. Body:
				// { "on": true | false } (default true = activate)
				const body = (await request.json().catch(() => ({}))) as {
					on?: boolean;
				};
				const on = body.on !== false; // default: activate
				const s = await this.ensureState();
				s.config.kill_switch = on;
				await this.saveState(s);
				return Response.json({
					ok: true,
					kill_switch: on,
					trading_mode: s.config.trading_mode,
				});
			}

			case "/place-test-order": {
				// Chunk 9: manual operator trigger to place a
				// real order. Use this to verify the real-money
				// path end-to-end without waiting for a signal.
				// Body: { "ticker": "KXWARMING-50", "side":
				// "yes"|"no", "price_cents": 1, "size": 1 }.
				// Side is optional (defaults to "yes"). The
				// per-trade cap is still enforced server-side
				// (refuses if `notional > max_notional_cents_per_trade`).
				const body = (await request.json().catch(() => ({}))) as {
					ticker?: string;
					side?: "yes" | "no";
					price_cents?: number;
					size?: number;
				};
				const ticker = String(body.ticker ?? "").trim();
				const side: "yes" | "no" = body.side === "no" ? "no" : "yes";
				const priceCents = Number(body.price_cents ?? 1);
				const size = Number(body.size ?? 1);
				if (!ticker) {
					return Response.json(
						{ ok: false, error: "missing_ticker", message: "ticker is required" },
						{ status: 400 },
					);
				}
				if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99) {
					return Response.json(
						{
							ok: false,
							error: "invalid_price",
							message: `price_cents must be 1..99, got ${priceCents}`,
						},
						{ status: 400 },
					);
				}
				if (!Number.isFinite(size) || size < 1) {
					return Response.json(
						{ ok: false, error: "invalid_size", message: `size must be >= 1, got ${size}` },
						{ status: 400 },
					);
				}
				const s = await this.ensureState();
				if (s.config.kill_switch) {
					return Response.json(
						{
							ok: false,
							error: "kill_switch_active",
							message: "kill switch is on; turn it off first",
						},
						{ status: 400 },
					);
				}
				// Chunk 10.8c: per-ticker + per-vertical blocklist.
				// Blocked tickers (or tickers in blocked verticals)
				// can't be traded even via /place-test-order.
				if (
					s.config.disabled_tickers !== null &&
					s.config.disabled_tickers !== undefined &&
					s.config.disabled_tickers.includes(ticker)
				) {
					return Response.json(
						{
							ok: false,
							error: "ticker_blocklisted",
							message: `ticker ${ticker} is on the blocklist`,
						},
						{ status: 400 },
					);
				}
				const tState = s.tickers[ticker];
				const tv = tState?.vertical
					? String(tState.vertical)
					: (s.config.ticker_verticals?.[ticker] ?? "unknown");
				if (
					s.config.disabled_verticals !== null &&
					s.config.disabled_verticals !== undefined &&
					s.config.disabled_verticals.length > 0 &&
					s.config.disabled_verticals.includes(tv)
				) {
					return Response.json(
						{
							ok: false,
							error: "vertical_blocklisted",
							message: `vertical ${tv} is on the blocklist`,
						},
						{ status: 400 },
					);
				}
				// Enforce per-trade cap. Chunk 11b: prefer the
				// per-vertical cap if the ticker's vertical is
				// in the override map; else fall back to the
				// global cap. (`tState` and `tv` were computed
				// earlier for the per-vertical blocklist check.)
				const notionalCents = side === "yes" ? priceCents * size : (100 - priceCents) * size;
				const verticalCap =
					(s.config.per_vertical_max_notional_cents ?? {})[tv] ??
					s.config.max_notional_cents_per_trade;
				if (notionalCents > verticalCap) {
					return Response.json(
						{
							ok: false,
							error: "per_trade_cap_exceeded",
							message:
								`notional=${notionalCents}c > cap=${verticalCap}c. ` +
								`bump the cap via /start (per-vertical: per_vertical_max_notional_cents, global: max_notional_cents_per_trade).`,
						},
						{ status: 400 },
					);
				}
				// Force trading_mode=real for this endpoint, since
				// placing a real order when the engine is in paper
				// mode would be confusing. We DON'T mutate the
				// engine mode — the order is one-off, but we do
				// stamp the resulting trade with `trading_mode=real`.
				const orderResult = await this.placeKalshiOrder(
					s,
					ticker,
					{ side, price: priceCents, p: 0, rationale: "manual_test_order" } as Signal,
					size,
				);
				if (!orderResult.ok) {
					return Response.json(
						{
							ok: false,
							error: orderResult.reasonCode,
							message: orderResult.message,
						},
						{ status: 502 },
					);
				}
				// Record the trade row so the dashboard shows it.
				await this.writeTradeRow(s, {
					action: "open",
					ticker,
					side,
					price: priceCents,
					size,
					rationale: "manual_test_order",
					signal_p: null,
					vertical: s.tickers[ticker]?.vertical
						? String(s.tickers[ticker].vertical)
						: "unknown",
					trading_mode: "real",
					real_order_id: orderResult.orderId,
				});
				// 2026-08-09: capture the taker fee. The
				// /place-test-order path was missing this —
				// fees were paid to Kalshi but not tracked
				// in `total_fees_cents` and the bankroll was
				// not debited, so the dashboard's "fees paid"
				// stat was stuck at $0.00 and the bankroll
				// was slightly overstated (~1-2¢ per 10c
				// contract). Mirror the signal-driven path:
				// subtract cost + fee from bankroll, add fee
				// to total_fees_cents.
				//
				// Note: the 7 historical manual test orders
				// placed BEFORE this fix are missing their
				// fees (~7-14¢ total). The next
				// /trading-mode or /start refresh will
				// re-pull the bankroll from Kalshi and
				// correct it; `total_fees_cents` will be
				// slightly understated until the first
				// close, but it self-corrects over time.
				const entryFeeCents = kalshiTakerFeeCents(
					side,
					size,
					priceCents,
				);
				s.risk_state.bankroll_cents -= notionalCents + entryFeeCents;
				s.total_fees_cents += entryFeeCents;
				// Record the notional in the 24h window so
				// the daily cap reflects manual + signal
				// trades consistently.
				const { history: notionalHistory } = recordNotionalCents(
					s.risk_state,
					notionalCents,
					Date.now(),
				);
				s.risk_state.daily_notional_history = notionalHistory;
				s.n_trades += 1;
				await this.saveState(s);

				// Chunk 10.8: Telegram on manual test orders too.
				// The Telegram send in maybeRecordTrade only
				// fires for signal-driven trades; /place-test-order
				// bypasses that path. Mirror the same alert so
				// the operator gets a Telegram for every real
				// fill, signal-driven or manual.
				try {
					const text = [
						`🟢 real fill (manual): ${ticker}`,
						`side=${side} size=${size} price=${priceCents}¢`,
						`notional=${notionalCents}¢`,
						`rationale=manual_test_order`,
						orderResult.orderId ? `kalshi order: ${orderResult.orderId}` : null,
					]
						.filter(Boolean)
						.join("\n");
					const tg = await sendTelegramMessage(this.env, text);
					if (!tg.ok) {
						console.warn(
							"[live-bot] /place-test-order telegram send failed",
							tg.error_message ?? "(no error_message)",
						);
					} else {
						console.log(
							`[live-bot] /place-test-order telegram sent message_id=${tg.message_id}`,
						);
					}
				} catch (e) {
					console.warn(
						"[live-bot] /place-test-order telegram threw",
						e instanceof Error ? e.message : String(e),
					);
				}

				return Response.json({
					ok: true,
					order_id: orderResult.orderId,
					ticker,
					side,
					price_cents: priceCents,
					size,
					notional_cents: notionalCents,
				});
			}

			case "/close-position": {
				// Chunk 10.9: manual operator exit. Body:
				// { "ticker": "KXWARMING-50" } — closes the open
				// position at the current mark. Works for both
				// paper + real positions. Returns the realized
				// PnL + the close trade id.
				const body = (await request.json().catch(() => ({}))) as {
					ticker?: string;
					rationale?: string;
				};
				const ticker = String(body.ticker ?? "").trim();
				if (!ticker) {
					return Response.json(
						{ ok: false, error: "missing_ticker", message: "ticker is required" },
						{ status: 400 },
					);
				}
				const s = await this.ensureState();
				const t = s.tickers[ticker];
				if (!t || !t.position) {
					return Response.json(
						{ ok: false, error: "no_position", message: `no open position on ${ticker}` },
						{ status: 400 },
					);
				}
				// Use the current mid as the mark. If the book
				// is empty, fall back to the entry price (so the
				// close still records at a known mark).
				let markCents = t.last_trade_price_cents ?? t.position.entry_price_cents;
				if (t.book) {
					const yesCents = orderbookMidCents({
						ticker,
						yes_levels: t.book.yes_levels,
						no_levels: t.book.no_levels,
					});
					if (yesCents != null) markCents = yesCents;
				}
				const openedPnlCents = t.position.size > 0 && markCents > 0
					? t.position.side === "yes"
						? (markCents - t.position.entry_price_cents) * t.position.size
						: (t.position.entry_price_cents - markCents) * t.position.size
					: 0;
				const pos = t.position;
				this.autoCloseAtMark(s, ticker, markCents, body.rationale ?? "manual_close");
				await this.saveState(s);
				return Response.json({
					ok: true,
					ticker,
					side: pos.side,
					size: pos.size,
					entry_price_cents: pos.entry_price_cents,
					mark_cents: markCents,
					pnl_cents: openedPnlCents,
					rationale: body.rationale ?? "manual_close",
				});
			}

			case "/cancel-order": {
				// Chunk 10.9: cancel a GTC order. Body:
				// { "order_id": "..." }. Returns the cancellation
				// status from Kalshi. Only meaningful when
				// trading_mode === "real" — paper orders are
				// local-only and don't need cancellation.
				const body = (await request.json().catch(() => ({}))) as {
					order_id?: string;
				};
				const orderId = String(body.order_id ?? "").trim();
				if (!orderId) {
					return Response.json(
						{ ok: false, error: "missing_order_id", message: "order_id is required" },
						{ status: 400 },
					);
				}
				const s = await this.ensureState();
				if (s.config.trading_mode !== "real") {
					return Response.json(
						{
							ok: false,
							error: "not_real_mode",
							message: "cancel-order is only meaningful in real mode (paper orders don't go to Kalshi)",
						},
						{ status: 400 },
					);
				}
				const useDemo = s.config.url.includes("demo");
				const keyId =
					(useDemo ? this.env.KALSHI_DEMO_KEY_ID : this.env.KALSHI_PROD_KEY_ID) ?? "";
				const pem =
					(useDemo ? this.env.KALSHI_DEMO_PRIVATE_KEY : this.env.KALSHI_PROD_PRIVATE_KEY) ?? "";
				if (!keyId || !pem) {
					return Response.json(
						{ ok: false, error: "missing_credentials", message: "Kalshi creds not set" },
						{ status: 500 },
					);
				}
				try {
					const { KalshiSdkClient } = await import("../kalshi/sdk-adapter.js");
					const { loadPrivateKey, KalshiCredentials } = await import("../kalshi/auth.js");
					const pk = await loadPrivateKey(pem);
					const credentials = new KalshiCredentials(keyId, pk);
					const client = new KalshiSdkClient({
						creds: credentials,
						privateKeyPem: pem,
						env: useDemo ? "demo" : "prod",
						requestsPerSecond: 0,
					});
					const result = (await client.cancelOrderV2(orderId)) as Record<string, unknown>;
					return Response.json({
						ok: true,
						order_id: orderId,
						result,
					});
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					return Response.json(
						{
							ok: false,
							error: "kalshi_cancel_failed",
							detail: msg.slice(0, 300),
						},
						{ status: 502 },
					);
				}
			}

			case "/":
			case "/index.html": {
				return Response.json({
					ok: true,
					service: "live-bot",
					endpoints: [
						"GET  /status",
						"POST /start  (json: LiveBotConfig)",
						"POST /stop",
						"POST /restart",
						"POST /reload-models  (chunk 8: hot-swap from registry)",
						"POST /trading-mode  (chunk 9: {trading_mode: paper|real|off})",
						"POST /kill-switch  (chunk 9: {on: bool})",
						"POST /place-test-order  (chunk 9: {ticker, side, price_cents, size})",
						"WS   /  (Upgrade: websocket) — control channel",
					],
				});
			}

			default:
				return new Response("not found", { status: 404 });
		}
	}

	// ─── Incoming WS (control channel, hibernated) ───────────────

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") return; // we only accept JSON
		let cmd: { cmd?: string; args?: Record<string, unknown> };
		try {
			cmd = JSON.parse(message);
		} catch {
			ws.send(JSON.stringify({ ok: false, error: "invalid_json" }));
			return;
		}
		switch (cmd.cmd) {
			case "start":
				await this.start((cmd.args ?? {}) as LiveBotConfig);
				ws.send(JSON.stringify({ ok: true, started: true }));
				break;
			case "stop":
				await this.stop();
				ws.send(JSON.stringify({ ok: true, stopped: true }));
				break;
			case "status": {
				const state = await this.ensureState();
				ws.send(JSON.stringify({ ok: true, status: this.summarize(state) }));
				break;
			}
			case "ping":
				ws.send(JSON.stringify({ ok: true, pong: Date.now() }));
				break;
			default:
				ws.send(JSON.stringify({ ok: false, error: "unknown_cmd", cmd: cmd.cmd }));
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		// Best-effort log; nothing to clean up — the control WS is
		// ephemeral and the bot's running state lives in storage + the
		// outgoing Kalshi WS.
		console.log(
			`[live-bot] control ws closed code=${code} reason=${reason} clean=${wasClean}`,
		);
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		console.error(`[live-bot] control ws error`, error);
	}

	// ─── Alarm — 90-min cycle ────────────────────────────────────

	async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
		// 2026-08-09: the alarm handler is now poll-only.
		// The legacy 90-min cycle (which refreshed the WS
		// connection) is gone — polling doesn't need a
		// periodic refresh since each poll is a fresh REST
		// call.
		//
		// **Important:** we don't check the in-memory
		// `_isPolling` flag here. The DO may have been
		// idle-evicted and re-instantiated between the
		// previous poll and this alarm firing, in which
		// case `_isPolling` is back to its default `false`
		// value. The alarm itself is the durable intent —
		// if it's set, polling is meant to be running, and
		// we re-initialize state from env + storage before
		// doing the next poll. `/stop` deletes the alarm,
		// which is the only way to truly halt polling.
		console.log(
			`[live-bot] alarm fired (${alarmInfo?.isRetry ? "retry" : "scheduled"}); polling`,
		);
		await this.pollTick();
	}

	// ─── Start / stop / restart ──────────────────────────────────

	async start(config: LiveBotConfig = {}): Promise<void> {
		let state = await this.ensureState();

		// Update config from the call.
		const tickers = config.ticker_verticals
			? Object.keys(config.ticker_verticals)
			: (config as { tickers?: string[] }).tickers ?? state.config.tickers;
		const newTickers: typeof state.tickers = {};
		for (const t of tickers) {
			const cur = state.tickers[t];
			newTickers[t] = cur ?? {
				vertical: config.ticker_verticals?.[t] ?? "unknown",
				event_ticker: "",
				title: "",
				book: null,
				price_history: [],
				last_trade_price_cents: null,
				trade_count: 0,
				position: null,
			};
			// Always refresh vertical from the latest config.
			if (config.ticker_verticals?.[t]) {
				newTickers[t].vertical = config.ticker_verticals[t];
			}
		}
		state.tickers = newTickers;
		state.config = {
			...state.config,
			tickers,
			ticker_verticals: config.ticker_verticals ?? state.config.ticker_verticals,
			bankroll_cents: config.bankroll_cents ?? state.config.bankroll_cents,
			url: config.url ?? state.config.url,
			lookback: config.lookback ?? state.config.lookback,
			disable_flips: config.disable_flips ?? state.config.disable_flips,
			no_flip_verticals: config.no_flip_verticals ?? state.config.no_flip_verticals,
			min_entry_p: config.min_entry_p ?? state.config.min_entry_p,
			close_after_trades: config.close_after_trades ?? state.config.close_after_trades,
			exit_mode: config.exit_mode ?? state.config.exit_mode,
			profit_target_pct: config.profit_target_pct ?? state.config.profit_target_pct,
			stop_loss_pct: config.stop_loss_pct ?? state.config.stop_loss_pct,
			model_version: config.model_version ?? state.config.model_version,
			// Chunk 9: trading mode + caps. Note: `kill_switch`
			// is intentionally NOT restored from `config` here —
			// once the operator flips the kill switch, it stays
			// on until they explicitly unset it. Toggling
			// trading_mode through /start is a separate path.
			trading_mode: config.trading_mode ?? state.config.trading_mode,
			max_notional_cents_per_trade:
				config.max_notional_cents_per_trade ??
				state.config.max_notional_cents_per_trade,
			daily_notional_cents_cap:
				config.daily_notional_cents_cap ?? state.config.daily_notional_cents_cap,
			// Chunk 11b: per-vertical caps + per-ticker blocklist.
			// null is an explicit value (operator cleared the
			// override), undefined means "leave the current
			// value alone" (don't accidentally wipe the
			// blocklist by passing an unrelated /start).
			per_vertical_max_notional_cents:
				config.per_vertical_max_notional_cents !== undefined
					? config.per_vertical_max_notional_cents
					: state.config.per_vertical_max_notional_cents,
			disabled_tickers:
				config.disabled_tickers !== undefined
					? config.disabled_tickers
					: state.config.disabled_tickers,
			// Chunk 10.8c: per-vertical blocklist + bankroll
			// refresh flag.
			disabled_verticals:
				config.disabled_verticals !== undefined
					? config.disabled_verticals
					: state.config.disabled_verticals,
			// 2026-08-10: per-vertical NaiveSignal fade threshold.
			// null = explicit clear (use defaults), undefined = leave
			// alone. Mirrors the pattern used for the other per-vertical
			// maps above.
			per_vertical_fade_threshold:
				config.per_vertical_fade_threshold !== undefined
					? config.per_vertical_fade_threshold
					: state.config.per_vertical_fade_threshold,
			// 2026-08-10: per-vertical min absolute move (cents).
			// OR-combined with the fade threshold above. Same null/
			// undefined semantics — explicit clear vs leave alone.
			per_vertical_min_absolute_move_cents:
				config.per_vertical_min_absolute_move_cents !== undefined
					? config.per_vertical_min_absolute_move_cents
					: state.config.per_vertical_min_absolute_move_cents,
			started_ts_ms: Date.now(),
		};
		if (config.user_id) state.user_id = config.user_id;
		await this.saveState(state);

		// Chunk 10.8c: optional bankroll refresh from Kalshi.
		// Lets the operator deposit/withdraw money, hit /start,
		// and have position sizing match the new balance.
		// Only fires when explicitly requested (or when
		// transitioning to real — see /trading-mode). Failure
		// is non-fatal: keep the prior bankroll.
		if (config.refresh_bankroll) {
			const r = await this.refreshBankrollFromKalshi(state);
			if (r.ok) {
				state.config.bankroll_cents = r.bankrollCents;
				await this.saveState(state);
			}
		}

		state = await this.ensureState(); // re-read in case anything else changed
		// Mirror the config to D1 so the Worker's read-only
		// endpoints (e.g. /api/pm/verticals) see the new values
		// without instantiating the DO. Fire on every /start,
		// not just when bankroll_refresh is set — config can
		// change without a bankroll pull.
		await this.mirrorConfigToD1(state);

		// 2026-08-09: WS→polling migration. The data feed
		// is now a 1.5s round-robin REST poll via the
		// kalshi-typescript SDK. The WS code below is
		// still in the file (commented-out references) for
		// git history but is no longer called.
		await this.startPolling(state);

		// Load the reversion models from R2 (chunk 4). Failure to
		// load is non-fatal — we fall back to NaiveSignal for the
		// affected vertical. The model_version defaults to "v1" and
		// can be overridden via /start config.
		await this.loadModels(state.config.model_version ?? this._modelVersion);
	}

	async stop(): Promise<void> {
		// 2026-08-09: stop the polling loop. The WS code is
		// gone — no separate closeKalshiWs / reconnect timer
		// to clean up.
		await this.stopPolling();
	}

	async restart(): Promise<void> {
		await this.stopPolling();
		const state = await this.ensureState();
		await this.startPolling(state);
	}


	// ─── Polling data feed (2026-08-09, replaces the WS) ──────────
	//
	// We poll Kalshi's REST API via the kalshi-typescript SDK
	// on a 1.5s round-robin across the configured tickers. Each
	// poll pulls a full orderbook snapshot (no deltas — at 1.5s
	// cadence the deltas would cost more than they save). The
	// strategy consumes the same state shape as before, so the
	// signal/auto-close logic is unchanged.
	//
	// Trade-off vs WS streaming: 1-2s data lag instead of
	// sub-second. For pm-bot's paper-trading strategy this is
	// invisible — the bot's decisions don't depend on
	// sub-second precision.

	private async startPolling(state: LiveBotState): Promise<void> {
		// Read the durable flag instead of an in-memory one.
		// After a DO eviction, the new instance has no
		// in-memory state, but the storage flag survives.
		if (await this.isPollingActive()) return; // already polling
		const isProd = this.env.ENVIRONMENT === "production";
		const keyId = isProd
			? this.env.KALSHI_PROD_KEY_ID
			: this.env.KALSHI_DEMO_KEY_ID;
		const pem = isProd
			? this.env.KALSHI_PROD_PRIVATE_KEY
			: this.env.KALSHI_DEMO_PRIVATE_KEY;
		if (!keyId || !pem) {
			this._lastPollError = {
				ts_ms: Date.now(),
				code: "missing_creds",
				message: isProd
					? "KALSHI_PROD creds not set on the Worker"
					: "KALSHI_DEMO creds not set on the Worker",
			};
			console.error("[live-bot:polling]", this._lastPollError.message);
			return;
		}
		const { KalshiSdkClient } = await import("../kalshi/sdk-adapter.js");
		const { loadPrivateKey, KalshiCredentials } = await import("../kalshi/auth.js");
		const pk = await loadPrivateKey(pem);
		const creds = new KalshiCredentials(keyId, pk);
		this._sdkClient = new KalshiSdkClient({
			creds,
			privateKeyPem: pem,
			env: isProd ? "prod" : "demo",
			requestsPerSecond: 2,
		});
		this._pollIndex = -1;
		this._nPolls = 0;
		this._nPollErrors = 0;
		this._lastPollMs = null;
		this._lastPollError = null;
		// Mark the polling intent in storage BEFORE setting
		// the alarm. If we crash between the two, on the next
		// invocation we see "polling intent: true" but no
		// alarm — startPolling is idempotent so the next
		// call kicks off the first alarm.
		await this.setPollingActive(true);
		console.log(
			`[live-bot:polling] starting; env=${isProd ? "prod" : "demo"} tickers=${state.config.tickers.length}`,
		);
		// Kick off the first poll in 100ms via the alarm. setAlarm
		// is durable (survives DO evictions), unlike setTimeout
		// which dies when the DO goes idle. The 1.5s poll cadence
		// is well within CF's alarm limits.
		await this.ctx.storage.setAlarm(Date.now() + 100);
		this._connected = true;
	}

	private async stopPolling(): Promise<void> {
		// Mark the polling intent false in storage FIRST.
		// If pollTick is mid-execution and races with
		// /stop, it will see `is_polling = false` at its
		// reschedule check and not set a new alarm. The
		// alarm itself is deleted after — the order
		// matters: a pollTick that started before /stop
		// might still call setAlarm after the delete, but
		// the reschedule check guards against that.
		await this.setPollingActive(false);
		this._sdkClient = null;
		this._connected = false;
		// Clear the alarm so the polling loop truly stops.
		await this.ctx.storage.deleteAlarm();
	}

	private async pollTick(): Promise<void> {
		const POLL_INTERVAL_MS = 1500;
		// Re-initialize the SDK client if it's gone (DO was
		// idle-evicted and re-instantiated between polls).
		// The alarm is durable, but the in-memory client is
		// not, so we rebuild it on every alarm fire.
		if (!this._sdkClient) {
			const isProd = this.env.ENVIRONMENT === "production";
			const keyId = isProd
				? this.env.KALSHI_PROD_KEY_ID
				: this.env.KALSHI_DEMO_KEY_ID;
			const pem = isProd
				? this.env.KALSHI_PROD_PRIVATE_KEY
				: this.env.KALSHI_DEMO_PRIVATE_KEY;
			if (!keyId || !pem) {
				this._lastPollError = {
					ts_ms: Date.now(),
					code: "missing_creds",
					message: isProd
						? "KALSHI_PROD creds not set on the Worker"
						: "KALSHI_DEMO creds not set on the Worker",
				};
				this._nPollErrors += 1;
				// Reschedule so we keep trying.
				await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
				return;
			}
			try {
				const { KalshiSdkClient } = await import("../kalshi/sdk-adapter.js");
				const { loadPrivateKey, KalshiCredentials } = await import("../kalshi/auth.js");
				const pk = await loadPrivateKey(pem);
				const creds = new KalshiCredentials(keyId, pk);
				this._sdkClient = new KalshiSdkClient({
					creds,
					privateKeyPem: pem,
					env: isProd ? "prod" : "demo",
					requestsPerSecond: 2,
				});
				this._connected = true;
				this._lastPollError = null;
				console.log("[live-bot:polling] SDK client re-initialized after DO eviction");
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this._lastPollError = {
					ts_ms: Date.now(),
					code: "sdk_init_failed",
					message: msg.slice(0, 300),
				};
				this._nPollErrors += 1;
				await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
				return;
			}
		}
		let state: LiveBotState;
		try {
			state = await this.ensureState();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[live-bot:polling] ensureState failed", msg);
			this._lastPollError = {
				ts_ms: Date.now(),
				code: "state_load_failed",
				message: msg,
			};
			this._nPollErrors += 1;
			await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
			return;
		}
		const tickers = state.config.tickers;
		if (tickers.length === 0) {
			await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
			return;
		}
		this._pollIndex = (this._pollIndex + 1) % tickers.length;
		const ticker = tickers[this._pollIndex];
		const t = state.tickers[ticker];
		if (!t) {
			await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
			return;
		}
		const pollStart = Date.now();
		try {
			const wire = (await this._sdkClient.getOrderbook(ticker)) as Record<
				string,
				unknown
			>;
			const ob = parseOrderbook(ticker, wire);
			await this.ctx.blockConcurrencyWhile(async () => {
				t.book = { yes_levels: ob.yes_levels, no_levels: ob.no_levels };
				// Approximate "last trade price" from the orderbook
				// mid. The strategy uses this for the price
				// history (vol calc) and last_trade_price_cents
				// (PnL mark). The true trade prints came from
				// the WS `trade` channel — we no longer have
				// that, so the orderbook mid is the next best
				// thing for a paper-trading bot.
				const mid = orderbookMidCents(ob);
				if (mid !== null) {
					t.last_trade_price_cents = mid;
					t.price_history.push(mid);
					const max = state.config.lookback;
					if (t.price_history.length > max) {
						t.price_history.splice(0, t.price_history.length - max);
					}
				}
				// Approximate trade count (one tick = one event).
				// Used by the auto-close-after-N-trades logic.
				// Less accurate than the WS trade count but good
				// enough for paper.
				t.trade_count += 1;
				state.n_frames += 1;
				this._nPolls += 1;
				this._lastPollMs = Date.now() - pollStart;
				this._lastPollError = null;
				// Profit target / stop loss (mark-based, same
				// as the WS trade handler).
				if (t.position !== null && mid !== null) {
					const pos = t.position;
					const profitPct =
						pos.side === "yes"
							? (mid - pos.entry_price_cents) / pos.entry_price_cents
							: (pos.entry_price_cents - (100 - mid)) /
								pos.entry_price_cents;
					if (
						state.config.profit_target_pct !== null &&
						profitPct >= state.config.profit_target_pct
					) {
						this.autoCloseAtMark(state, ticker, mid, "pm_target");
					} else if (
						state.config.stop_loss_pct !== null &&
						profitPct <= -state.config.stop_loss_pct
					) {
						this.autoCloseAtMark(state, ticker, mid, "pm_stop");
					}
				}
				// Run the strategy (same path the WS handler uses).
				await this.maybeSignalAll(state);
				await this.saveState(state);
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[live-bot:polling] poll failed for", ticker, msg);
			this._lastPollError = {
				ts_ms: Date.now(),
				code: "poll_failed",
				message: msg.slice(0, 300),
			};
			this._nPollErrors += 1;
		}
		// Reschedule the next poll. The alarm is the durable
		// intent — `/stop` is the only way to halt polling
		// (it sets the durable `is_polling` flag to false
		// AND deletes the alarm). We check the flag here so
		// a pollTick that started before /stop was called
		// doesn't accidentally re-arm the alarm.
		if (await this.isPollingActive()) {
			await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
		}
	}


	// ─── Trade recording ────────────────────────────────────────

	private async maybeSignalAll(state: LiveBotState): Promise<void> {
		// Build the per-vertical router. Chunk 4 uses the loaded
		// reversion models for weather + economic; the router falls
		// back to NaiveSignal for any vertical where the model is
		// missing (e.g. R2 not provisioned yet).
		const router = new VerticalStrategyRouter({
			models: {
				reversion: {
					weather: this._models.weather ?? undefined,
					economic: this._models.economic ?? undefined,
				},
			},
			// 2026-08-10: per-vertical NaiveSignal fade thresholds.
			// Live Kalshi markets are lower-vol than the synthetic
			// data the default 5% was calibrated against, so each
			// vertical usually needs its own override. The default
			// (missing entry) is 5% — operators tune this from
			// /start config.per_vertical_fade_threshold.
			fade_thresholds: state.config.per_vertical_fade_threshold ?? undefined,
			// 2026-08-10: per-vertical min absolute move (cents).
			// OR-combined with the percentage threshold. Default
			// 0 (disabled). Operators set this for stable markets
			// (KXWARMING-50) where 1¢ moves are real edge.
			min_absolute_move_cents: state.config.per_vertical_min_absolute_move_cents ?? undefined,
		});
		for (const [ticker, t] of Object.entries(state.tickers)) {
			if (t.price_history.length < 2) continue;
			const ctx: SignalContext = {
				ticker,
				priceHistory: t.price_history,
				currentTick: state.n_frames,
				orderbook: t.book
					? {
							ticker,
							yesLevels: t.book.yes_levels.map((l) => ({
								priceCents: l.price_cents,
								count: l.count,
							})),
							noLevels: t.book.no_levels.map((l) => ({
								priceCents: l.price_cents,
								count: l.count,
							})),
						}
					: null,
				market: {
					ticker,
					eventTicker: t.event_ticker,
					vertical: t.vertical,
					title: t.title,
				},
			};
			const sig = router.__call(ctx);
			if (sig === null) continue;
			state.n_signals += 1;
			await this.maybeRecordTrade(state, ticker, sig);
		}
	}

	private async maybeRecordTrade(
		state: LiveBotState,
		ticker: string,
		signal: Signal,
	): Promise<void> {
		const t = state.tickers[ticker];
		if (!t) return;
		const pos = t.position;

		// Chunk 11b: per-ticker blocklist. Skip tickers the
		// operator has explicitly disabled, even when the
		// global kill switch is OFF. Useful for "I don't want
		// to trade KXTICKER because the model isn't reliable
		// for it" without flipping the global kill switch.
		if (
			state.config.disabled_tickers !== null &&
			state.config.disabled_tickers !== undefined &&
			state.config.disabled_tickers.includes(ticker)
		) {
			state.last_reject = {
				ts_ms: Date.now(),
				ticker,
				code: "ticker_blocklisted",
				message: `ticker ${ticker} is on the blocklist`,
			};
			return;
		}

		// Chunk 10.8c: per-vertical blocklist. Skip tickers
		// whose vertical is on the blocklist, even when the
		// ticker isn't. Useful for "I want to disable all
		// politics while keeping weather + economic" without
		// touching the per-ticker blocklist.
		if (
			state.config.disabled_verticals !== null &&
			state.config.disabled_verticals !== undefined &&
			state.config.disabled_verticals.length > 0
		) {
			const tv = t.vertical ? String(t.vertical) : "unknown";
			if (state.config.disabled_verticals.includes(tv)) {
				state.last_reject = {
					ts_ms: Date.now(),
					ticker,
					code: "vertical_blocklisted",
					message: `vertical ${tv} is on the blocklist`,
				};
				return;
			}
		}

		// Chunk 9: kill switch — refuse all new trades. The
		// open positions are NOT auto-closed here (that's a
		// separate operator-driven path: /kill-switch with
		// `{"action":"close_all"}` will be added in a follow-up).
		if (state.config.kill_switch) {
			state.last_reject = {
				ts_ms: Date.now(),
				ticker,
				code: "kill_switch_active",
				message: "kill switch is on; no new trades",
			};
			return;
		}

		// Same-side check: skip (no pyramid).
		if (pos !== null && pos.side === signal.side) return;

		// Min entry-p threshold.
		if (
			pos === null &&
			state.config.min_entry_p > 0 &&
			signal.p < state.config.min_entry_p
		) {
			return;
		}

		// No-flip mode: skip opposite signals when a position is open.
		if (pos !== null) {
			let blockFlip = state.config.disable_flips;
			if (
				!blockFlip &&
				state.config.no_flip_verticals !== null &&
				state.config.no_flip_verticals.includes(String(t.vertical))
			) {
				blockFlip = true;
			}
			if (blockFlip) return;
		}

		// Flip-filter (the 2026-08-06 logic): if the new signal is
		// opposite the open position, and the position is in profit,
		// and the new signal is NOT significantly more confident, keep
		// the open position. The Python engine has full knobs; we keep
		// the conservative defaults (5c profit floor + 1.5x ratio).
		if (pos !== null) {
			const minFlipProfitCents = 5;
			const minFlipSignalRatio = 1.5;
			if (t.book) {
				const mark = orderbookMidCents({
					ticker,
					yes_levels: t.book.yes_levels,
					no_levels: t.book.no_levels,
				});
				const markCents = mark ?? pos.entry_price_cents;
				const profitCents =
					pos.side === "yes"
						? markCents - pos.entry_price_cents
						: pos.entry_price_cents - (100 - markCents);
				const hasProfit = profitCents >= minFlipProfitCents;
				let isStrongEnough = true;
				if (pos.entry_signal_p > 0 && signal.p > 0) {
					isStrongEnough =
						signal.p >= pos.entry_signal_p * minFlipSignalRatio;
				} else {
					isStrongEnough = false;
				}
				if (hasProfit && !isStrongEnough) {
					// Skip the flip; keep the open position.
					return;
				}
			}
		}

		// Flip handling: close the existing position at mark first, so
		// the new signal can pass `can_open_position`'s "already in
		// market" check.
		let flipPnlCents = 0;
		if (pos !== null && t.book) {
			const mark = orderbookMidCents({
				ticker,
				yes_levels: t.book.yes_levels,
				no_levels: t.book.no_levels,
			});
			const markCents = mark ?? pos.entry_price_cents;
			flipPnlCents = this.closeAtMarkInternal(state, ticker, markCents, "replay_flip");
		}

		// Risk check.
		const risk = this.makeRiskEngine(state);
		const decision = risk.canOpenPosition(ticker, signal.price, state.n_frames);
		if (!decision.allowed || decision.size <= 0) {
			if (decision.reason) {
				state.last_reject = {
					ts_ms: Date.now(),
					ticker,
					code: decision.reason.code,
					message: decision.reason.message,
				};
			}
			return;
		}
		const size = decision.size;

		// Min-edge-after-fees guardrail (user-flagged 2026-08-07).
		if (isStructurallyUnprofitable(signal.price, size)) {
			state.last_reject = {
				ts_ms: Date.now(),
				ticker,
				code: "structurally_unprofitable",
				message: `max gain <= 2x entry fee at price=${signal.price}c size=${size}`,
			};
			return;
		}

		// Cost (notional deployed by this single trade, in cents).
		const costCents =
			signal.side === "yes"
				? signal.price * size
				: (100 - signal.price) * size;
		const entryFeeCents = kalshiTakerFeeCents(signal.side, size, signal.price);

		// Chunk 9: per-trade cap. Conservative default $1.00 =
		// 100 cents. The notional is `price * size` for YES
		// positions and `(100 - price) * size` for NO. (Matches
		// the cost formula above.) Operators can bump via
		// /start when ready to test with more capital.
		if (costCents > state.config.max_notional_cents_per_trade) {
			state.last_reject = {
				ts_ms: Date.now(),
				ticker,
				code: "per_trade_cap_exceeded",
				message:
					`notional=${costCents}c > cap=${state.config.max_notional_cents_per_trade}c ` +
					`(price=${signal.price}c side=${signal.side} size=${size})`,
			};
			return;
		}

		// Chunk 9: daily cap (sliding 24h window). Compute the
		// current deployed notional + this trade's notional; if
		// it would exceed the cap, reject.
		const nowMs = Date.now();
		const currentDaily = dailyNotionalCents(state.risk_state, nowMs);
		if (currentDaily + costCents > state.config.daily_notional_cents_cap) {
			state.last_reject = {
				ts_ms: nowMs,
				ticker,
				code: "daily_cap_exceeded",
				message:
					`would deploy ${currentDaily + costCents}c in 24h ` +
					`(current=${currentDaily}c + new=${costCents}c) ` +
					`> cap=${state.config.daily_notional_cents_cap}c`,
			};
			return;
		}

		// Chunk 9: real-mode order placement. When
		// `trading_mode === "real"`, we place the order on
		// Kalshi FIRST. If Kalshi rejects (insufficient
		// balance, market closed, etc.), we abort the
		// fill entirely — no D1 write, no position, no
		// bankroll debit. This keeps the live book in
		// sync with the local log.
		//
		// When `trading_mode === "off"`, the engine is
		// paused: we skip the entire path. The WS keeps
		// running so we still see state, but no trades
		// are recorded or placed.
		if (state.config.trading_mode === "off") {
			// Off mode: log only at the per-tick level (no D1).
			// No reject reason — this is the expected behavior.
			return;
		}

		let realOrderId: string | null = null;
		if (state.config.trading_mode === "real") {
			const orderResult = await this.placeKalshiOrder(state, ticker, signal, size);
			if (!orderResult.ok) {
				state.last_reject = {
					ts_ms: nowMs,
					ticker,
					code: orderResult.reasonCode,
					message: orderResult.message,
				};
				return;
			}
			realOrderId = orderResult.orderId;
		}

		// Record the fill in the risk engine.
		risk.recordFill(ticker, String(t.vertical), signal.side, signal.price, size, state.n_frames);
		// Mirror the bankroll debit.
		risk.state.bankroll_cents -= costCents + entryFeeCents;
		state.total_fees_cents += entryFeeCents;
		// Record the notional in the 24h window.
		const { history: notionalHistory } = recordNotionalCents(state.risk_state, costCents, nowMs);
		state.risk_state.daily_notional_history = notionalHistory;
		state.risk_state = risk.state;

		// Set the open position on the per-ticker state.
		t.position = {
			side: signal.side,
			size,
			entry_price_cents: signal.price,
			entry_ts_ms: nowMs,
			rationale: signal.rationale,
			entry_signal_p: signal.p,
		};

		// Persist trades + signals to D1 (best-effort; failures are
		// logged but don't break the loop).
		await this.writeTradeRow(state, {
			action: "open",
			ticker,
			side: signal.side,
			price: signal.price,
			size,
			rationale: signal.rationale,
			signal_p: signal.p,
			vertical: String(t.vertical),
			trading_mode: state.config.trading_mode,
			real_order_id: realOrderId,
		});
		state.n_trades += 1;

		// If a flip happened, record the close trade too.
		if (pos !== null && flipPnlCents !== 0) {
			await this.writeTradeRow(state, {
				action: "close",
				ticker,
				side: pos.side,
				price: pos.entry_price_cents,
				size: pos.size,
				rationale: "replay_flip",
				signal_p: null,
				vertical: String(t.vertical),
				pnl_cents: flipPnlCents,
			});
		}

		// Chunk 11a: Telegram alert on every real fill. The user
		// wants to know the moment a real-money trade goes
		// through. We post the trade details + (for closes)
		// the PnL. Paper + off mode don't post (would be
		// noisy). Best-effort: a Telegram failure is logged
		// but never breaks the loop.
		if (state.config.trading_mode === "real") {
			const text = [
				`🟢 real fill: ${ticker}`,
				`side=${signal.side} size=${size} price=${signal.price}¢`,
				`p(model)=${(signal.p * 100).toFixed(1)}%`,
				`rationale=${signal.rationale.slice(0, 200)}`,
				realOrderId ? `kalshi order: ${realOrderId}` : null,
			]
				.filter(Boolean)
				.join("\n");
			const tg = await sendTelegramMessage(this.env, text);
			if (!tg.ok) {
				console.warn("[live-bot] telegram post failed:", tg.error_message);
			}
		}
	}

	// Chunk 10.8c: re-pull bankroll from Kalshi. Called by
	// /trading-mode (when going to "real") and by /start when
	// `refresh_bankroll: true`. Lets the operator add or
	// withdraw money, hit /start, and have position sizing
	// adjust to the new balance. Returns the new bankroll
	// (cash + portfolio value) on success; on failure returns
	// null + reason (caller keeps the existing config value).
	private async refreshBankrollFromKalshi(
		state: LiveBotState,
	): Promise<
		| { ok: true; bankrollCents: number; cash: number; portfolio: number; source: "kalshi" }
		| { ok: false; reasonCode: string; message: string }
	> {
		const useDemo = state.config.url.includes("demo");
		const keyId =
			(useDemo ? this.env.KALSHI_DEMO_KEY_ID : this.env.KALSHI_PROD_KEY_ID) ?? "";
		const pem =
			(useDemo ? this.env.KALSHI_DEMO_PRIVATE_KEY : this.env.KALSHI_PROD_PRIVATE_KEY) ?? "";
		if (!keyId || !pem) {
			return {
				ok: false,
				reasonCode: "missing_credentials",
				message: `Kalshi ${useDemo ? "demo" : "prod"} creds are not set on the Worker`,
			};
		}
		try {
			// Chunk 10.8c: use the kalshi-typescript SDK
			// adapter (axios + Node crypto + retries) instead
			// of the hand-rolled client. Same auth, same
			// response shape, built-in 5xx/429 retry.
			const { KalshiSdkClient } = await import("../kalshi/sdk-adapter.js");
			const { loadPrivateKey, KalshiCredentials } = await import("../kalshi/auth.js");
			const pk = await loadPrivateKey(pem);
			const credentials = new KalshiCredentials(keyId, pk);
			const client = new KalshiSdkClient({
				creds: credentials,
				privateKeyPem: pem,
				env: useDemo ? "demo" : "prod",
				requestsPerSecond: 0, // one-shot — no throttle
			});
			const data = (await client.getBalance()) as {
				balance?: number;
				portfolio_value?: number;
			};
			const cash = Number(data.balance ?? 0);
			const portfolio = Number(data.portfolio_value ?? 0);
			const bankrollCents = cash + portfolio;
			console.log(
				`[live-bot] refreshBankroll cash=${cash}c portfolio=${portfolio}c → bankroll=${bankrollCents}c`,
			);
			return { ok: true, bankrollCents, cash, portfolio, source: "kalshi" };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				ok: false,
				reasonCode: "kalshi_balance_failed",
				message: msg.slice(0, 300),
			};
		}
	}

	// Chunk 9: place a real order on Kalshi. Returns the order id
	// on success; on failure returns an error reason. NEVER throws
	// — the caller needs to log + skip without breaking the loop.
	private async placeKalshiOrder(
		state: LiveBotState,
		ticker: string,
		signal: Signal,
		size: number,
	): Promise<
		| { ok: true; orderId: string }
		| { ok: false; reasonCode: string; message: string }
	> {
		const useDemo = state.config.url.includes("demo");
		const keyId =
			(useDemo ? this.env.KALSHI_DEMO_KEY_ID : this.env.KALSHI_PROD_KEY_ID) ?? "";
		const pem =
			(useDemo ? this.env.KALSHI_DEMO_PRIVATE_KEY : this.env.KALSHI_PROD_PRIVATE_KEY) ?? "";
		if (!keyId || !pem) {
			return {
				ok: false,
				reasonCode: "missing_credentials",
				message:
					`trading_mode=real but Kalshi ${useDemo ? "demo" : "prod"} creds are not set in env`,
			};
		}
		try {
			// Chunk 10.8c: migrate to the kalshi-typescript
			// SDK adapter. The SDK is the OpenAPI-generated
			// client (axios + Node crypto) wrapped with our
			// 2 req/s throttle + exponential-backoff retries
			// on 5xx/429. The body shape is the same V2
			// schema the hand-rolled client used; we just
			// delegate the HTTP + auth to the SDK.
			const { KalshiSdkClient } = await import("../kalshi/sdk-adapter.js");
			const { loadPrivateKey } = await import("../kalshi/auth.js");
			const pemContent = pem;
			const pk = await loadPrivateKey(pemContent);
			const { KalshiCredentials } = await import("../kalshi/auth.js");
			const creds = new KalshiCredentials(keyId, pk);
			const client = new KalshiSdkClient({
				creds,
				privateKeyPem: pemContent,
				env: useDemo ? "demo" : "prod",
				requestsPerSecond: 0, // one-shot — no throttle
				maxRetries: 3,
				initialBackoffMs: 500,
			});
			// V2 schema (POST /portfolio/events/orders):
			//   - side: "bid" (buy YES) or "ask" (sell YES).
			//     Selling YES is economically equivalent to
			//     buying NO at 1 - price.
			//   - price: fixed-point dollar string. Our internal
			//     `signal.price` is in cents (1..99); convert to
			//     a 4-decimal dollar string for V2.
			//   - count: fixed-point string with 2 decimals.
			//   - time_in_force + self_trade_prevention_type are
			//     required by the V2 spec; we use safe defaults.
			const v2Side = signal.side === "yes" ? "bid" : "ask";
			const priceDollars = (signal.price / 100).toFixed(4);
			const countStr = size.toFixed(2);
			const resp = (await client.createOrderV2({
				ticker,
				side: v2Side,
				count: countStr,
				price: priceDollars,
				time_in_force: "good_till_canceled",
				self_trade_prevention_type: "taker_at_cross",
			})) as Record<string, unknown>;
			// V2 response shape: { order_id, fill_count,
			// remaining_count, ts_ms } at the top level (NOT
			// nested under `order` — that was V1).
			const orderId = (resp.order_id as string | undefined) ?? null;
			if (!orderId) {
				return {
					ok: false,
					reasonCode: "no_order_id_in_response",
					message: `Kalshi placeOrder returned no order_id: ${JSON.stringify(resp).slice(0, 200)}`,
				};
			}
			return { ok: true, orderId };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				ok: false,
				reasonCode: "kalshi_place_order_failed",
				message: msg.slice(0, 300),
			};
		}
	}

	private autoCloseAtMark(
		state: LiveBotState,
		ticker: string,
		markCents: number,
		rationale = "auto_close",
	): void {
		this.closeAtMarkInternal(state, ticker, markCents, rationale);
	}

	private closeAtMarkInternal(
		state: LiveBotState,
		ticker: string,
		markCents: number,
		rationale: string,
	): number {
		const t = state.tickers[ticker];
		if (!t || !t.position) return 0;
		// Capture the closing position's details BEFORE we null it out.
		const pos = t.position;
		const risk = this.makeRiskEngine(state);
		const closed = risk.closePositionAtMark(ticker, markCents, state.n_frames);
		if (!closed) {
			t.position = null;
			state.risk_state = risk.state;
			return 0;
		}
		// Charge taker fee on the close (the close is a market order).
		const closeFeeCents = kalshiTakerFeeCents(pos.side, pos.size, markCents);
		risk.state.bankroll_cents -= closeFeeCents;
		state.total_fees_cents += closeFeeCents;
		state.risk_state = risk.state;
		t.position = null;
		// Persist the close to D1. Use the captured `pos` (not the
		// nulled-out `t.position`).
		void this.writeTradeRow(state, {
			action: "close",
			ticker,
			side: pos.side,
			price: markCents,
			size: pos.size,
			rationale,
			signal_p: null,
			vertical: String(t.vertical),
			pnl_cents: closed.pnl_cents,
		}).catch((e) => console.error("[live-bot] trade write failed", e));
		return closed.pnl_cents;
	}

	private closeAtSettlement(state: LiveBotState, ticker: string, settlementCents: number): void {
		this.closeAtMarkInternal(state, ticker, settlementCents, "market_settled");
	}

	// ─── D1 persistence ─────────────────────────────────────────

	private async writeTradeRow(
		state: LiveBotState,
		row: {
			action: "open" | "close";
			ticker: string;
			side: Side;
			price: number;
			size: number;
			rationale: string;
			signal_p: number | null;
			vertical: string;
			pnl_cents?: number;
			trading_mode?: "paper" | "real" | "off";
			real_order_id?: string | null;
		},
	): Promise<void> {
		const db = this.env.DB;
		if (!db) return; // test env / no D1 binding
		// Chunk 9: trading_mode + real_order_id land in D1 so
		// the dashboard can split paper vs real PnL and link
		// back to Kalshi orders. Defaults preserve chunk-1-8
		// behavior (every legacy row is "paper" + null order).
		const tradingMode = row.trading_mode ?? "paper";
		const realOrderId = row.real_order_id ?? null;
		const isPaper = tradingMode === "paper" ? 1 : 0;
		await db
			.prepare(
				`INSERT INTO trades
				 (user_id, ts, ticker, vertical, side, action, price_cents, size,
				  signal_p, signal_rationale, model_version, pnl_cents, fill_type,
				  is_paper, trading_mode, real_order_id)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
				         ?15, ?16)`,
			)
			.bind(
				state.user_id,
				Date.now(),
				row.ticker,
				row.vertical,
				row.side,
				row.action,
				row.price,
				row.size,
				row.signal_p,
				row.rationale,
				"v0-naive", // chunk 4 swaps in real model version
				row.pnl_cents ?? null,
				"limit", // fill_type: chunk 9 distinguishes paper vs real
				isPaper,
				tradingMode,
				realOrderId,
			)
			.run();
	}

	// ─── Status summary ─────────────────────────────────────────

	private summarize(state: LiveBotState): Record<string, unknown> {
		return {
			ok: true,
			connected: this._connected,
			user_id: state.user_id,
			config: state.config,
			counts: {
				n_signals: state.n_signals,
				n_frames: state.n_frames,
				n_trades: state.n_trades,
				total_fees_cents: state.total_fees_cents,
			},
			risk: {
				bankroll_cents: state.risk_state.bankroll_cents,
				open_positions: Object.keys(state.risk_state.open_positions).length,
				consecutive_losses: state.risk_state.consecutive_losses,
			},
		};
	}
}
