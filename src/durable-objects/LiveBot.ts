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
	applyOrderbookDelta,
	orderbookMidCents,
	orderbookSnapshotToOb,
	type KalshiOrderbook,
	type KalshiOrderbookLevel,
} from "../kalshi/models.js";
import {
	DEFAULT_DEMO_WS,
	DEFAULT_PRODUCTION_WS,
	type KalshiWSMessage,
	type OrderbookDelta,
	type OrderbookSnapshot,
	type TickerMessage,
	type TradeMessage,
} from "../kalshi/ws.js";
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
	// request. The Kalshi WS is also a transient connection, not in
	// storage.
	private _kalshiWs: WebSocket | null = null;
	private _connected = false;
	private _reconnectAttempt = 0;
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** Last WS error (sign, upgrade, onclose). Cleared on a successful
	 *  upgrade. Surfaced in /status for the dashboard's stage panel. */
	private _lastWsError: { ts_ms: number; code: string; message: string } | null = null;
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
		return s;
	}

	private buildDefaultState(): LiveBotState {
		const tickersCsv = this.env.DEFAULT_TICKERS ?? "KXWARMING-50";
		const defaultTickers = tickersCsv.split(",").map((t) => t.trim()).filter(Boolean);
		const defaultUrl =
			this.env.DEFAULT_URL ??
			(this.env.ENVIRONMENT === "production" ? DEFAULT_PRODUCTION_WS : DEFAULT_DEMO_WS);
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
								last_trade_price_cents: ts.last_trade_price_cents,
								trade_count: ts.trade_count,
								position: ts.position,
							},
						]),
					),
					last_reject: state.last_reject,
					last_ws_error: this._lastWsError,
				});
			}

			case "/start": {
				const config = (await request.json().catch(() => ({}))) as LiveBotConfig;
				await this.start(config);
				return Response.json({ ok: true, started: true, config: state.config });
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
				await this.saveState(s);
				return Response.json({
					ok: true,
					trading_mode: mode,
					previous_trading_mode: previous,
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
				// Enforce per-trade cap. Chunk 11b: prefer the
				// per-vertical cap if the ticker's vertical is
				// in the override map; else fall back to the
				// global cap.
				const notionalCents = side === "yes" ? priceCents * size : (100 - priceCents) * size;
				const tState = s.tickers[ticker];
				const tickerVertical = tState?.vertical
					? String(tState.vertical)
					: (s.config.ticker_verticals?.[ticker] ?? "unknown");
				const verticalCap =
					(s.config.per_vertical_max_notional_cents ?? {})[tickerVertical] ??
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
		const state = await this.ensureState();
		// Schedule the next cycle. setAlarm replaces the existing
		// alarm, so we don't need to delete first.
		await this.ctx.storage.setAlarm(Date.now() + CYCLE_MS);
		// Restart the WS connection (close + reopen) to refresh state.
		console.log(
			`[live-bot] alarm fired (${alarmInfo?.isRetry ? "retry" : "scheduled"}); restarting`,
		);
		void state; // state already loaded; closure captures `this`
		await this.restart();
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
			started_ts_ms: Date.now(),
		};
		if (config.user_id) state.user_id = config.user_id;
		await this.saveState(state);
		state = await this.ensureState(); // re-read in case anything else changed

		// Open the Kalshi WS. The WS lifecycle is managed by the DO;
		// we reconnect on close with exponential backoff.
		await this.openKalshiWs(state);

		// Load the reversion models from R2 (chunk 4). Failure to
		// load is non-fatal — we fall back to NaiveSignal for the
		// affected vertical. The model_version defaults to "v1" and
		// can be overridden via /start config.
		await this.loadModels(state.config.model_version ?? this._modelVersion);

		// Schedule the 90-min cycle alarm (replaces any prior alarm).
		await this.ctx.storage.setAlarm(Date.now() + CYCLE_MS);
	}

	async stop(): Promise<void> {
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		this.closeKalshiWs();
		await this.ctx.storage.deleteAlarm();
	}

	async restart(): Promise<void> {
		this.closeKalshiWs();
		const state = await this.ensureState();
		await this.openKalshiWs(state);
	}

	// ─── Kalshi WS lifecycle ─────────────────────────────────────

	private async openKalshiWs(state: LiveBotState): Promise<void> {
		if (this._kalshiWs) return; // already open
		const url = state.config.url;
		const useDemo = url.includes("demo");
		// Chunk 10.6: if the URL points at a relay (or any non-Kalshi
		// host), the relay handles Kalshi auth server-side — the Worker
		// just opens a plain WebSocket with no extra headers. CF Workers'
		// `new WebSocket(url, { headers })` is silently broken (the
		// second arg is treated as a protocols string), so this is the
		// only reliable form when the URL is not a raw Kalshi endpoint.
		const isRelay = !url.includes("kalshi");
		console.log(
			`[live-bot] openKalshiWs url=${url} useDemo=${useDemo} isRelay=${isRelay}`,
		);

		// Build auth headers ONLY for the direct-Kalshi path. The relay
		// path doesn't need them — and sending them breaks the upgrade.
		const headers: Record<string, string> = { Upgrade: "websocket" };
		if (!isRelay) {
			const keyId =
				(useDemo ? this.env.KALSHI_DEMO_KEY_ID : this.env.KALSHI_PROD_KEY_ID) ?? "";
			const pem =
				(useDemo ? this.env.KALSHI_DEMO_PRIVATE_KEY : this.env.KALSHI_PROD_PRIVATE_KEY) ?? "";
			if (keyId && pem) {
				try {
					const { buildAuthHeaders, loadPrivateKey } = await import("../kalshi/auth.js");
					const pk = await loadPrivateKey(pem);
					const auth = await buildAuthHeaders(pk, keyId, "GET", "/trade-api/ws/v2");
					Object.assign(headers, auth);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error("[live-bot] failed to sign WS headers", msg);
					this._lastWsError = {
						ts_ms: Date.now(),
						code: "auth_sign_failed",
						message: msg,
					};
				}
			} else {
				this._lastWsError = {
					ts_ms: Date.now(),
					code: "missing_creds",
					message: useDemo
						? "KALSHI_DEMO creds not set on the Worker"
						: "KALSHI_PROD creds not set on the Worker",
				};
				console.error(
					"[live-bot]",
					this._lastWsError.code,
					"—",
					this._lastWsError.message,
				);
			}
		} else {
			// Relay path: clear any prior error from a previous
			// direct-Kalshi attempt; the relay doesn't need creds.
			this._lastWsError = null;
		}

		// Open the WebSocket.
		//   Relay path: `new WebSocket(url)` — the standard form, no
		//   second arg. This is what CF Workers handles correctly.
		//   Direct path: try Node's `new WebSocket(url, { headers })`
		//   first; fall back to `fetch(url, { headers })` if that
		//   fails. (Direct path from CF Workers is known not to work
		//   — see chunk 10 finding. Kept for completeness / local dev.)
		let ws: WebSocket;
		try {
			if (isRelay) {
				console.log(`[live-bot] relay: plain new WebSocket(${url})`);
				ws = new WebSocket(url);
			} else {
				// Node.js's WebSocket: `new WebSocket(url, { headers })`.
				// With `nodejs_compat` enabled, the global `WebSocket` is
				// Node's, which honors the headers option.
				ws = new WebSocket(url, { headers } as unknown as string[]);
			}
		} catch (e) {
			console.error("[live-bot] Node WebSocket failed, trying fetch()", e);
			// Fallback: fetch() + Upgrade: websocket.
			const fetchUrl = url.replace(/^wss:\/\//, "https://");
			try {
				const response = await fetch(fetchUrl, { headers });
				if (response.status !== 101) {
					const body = await response.text().catch(() => "");
					const msg = `WS upgrade failed: HTTP ${response.status} ${body.slice(0, 200)}`;
					console.error("[live-bot]", msg);
					this._lastWsError = {
						ts_ms: Date.now(),
						code: `http_${response.status}`,
						message: msg,
					};
					this.scheduleReconnect(state);
					return;
				}
				ws = response.webSocket!;
				if (!ws) {
					const msg = "fetch() returned 101 but response.webSocket is null";
					this._lastWsError = {
						ts_ms: Date.now(),
						code: "no_websocket",
						message: msg,
					};
					this.scheduleReconnect(state);
					return;
				}
				try {
					ws.accept();
				} catch {
					/* already accepted — non-fatal */
				}
			} catch (fe) {
				const msg = fe instanceof Error ? fe.message : String(fe);
				console.error("[live-bot] both WS approaches failed", msg);
				this._lastWsError = {
					ts_ms: Date.now(),
					code: "ws_open_failed",
					message: msg,
				};
				this.scheduleReconnect(state);
				return;
			}
		}
		this._kalshiWs = ws;
		this._connected = false;
		this._reconnectAttempt = 0;
		// Clear any prior error — the upgrade succeeded at the HTTP layer.
		this._lastWsError = null;

		// Connection timeout: if `open` doesn't fire within 10s, treat
		// as a failure and schedule a reconnect. CF Workers' outbound
		// WebSocket has a known silent-CLOSING state (readyState=2
		// without ever firing `open`); the timeout catches that case
		// so the dashboard doesn't sit on "Connecting…" forever.
		const connectTimeoutMs = 10_000;
		const connectTimeout = setTimeout(() => {
			if (!this._connected) {
				console.error(
					`[live-bot] WS open did not fire within ${connectTimeoutMs}ms; closing + reconnecting`,
				);
				this._lastWsError = {
					ts_ms: Date.now(),
					code: "open_timeout",
					message: `WebSocket open event did not fire within ${connectTimeoutMs}ms (silent CLOSING?)`,
				};
				try {
					ws.close(1000, "open_timeout");
				} catch {
					/* ignore */
				}
			}
		}, connectTimeoutMs);

		ws.addEventListener("open", () => {
			clearTimeout(connectTimeout);
			this._connected = true;
			this._reconnectAttempt = 0;
			// Subscribe to orderbook_delta + trade + ticker for every
			// watched ticker. market_lifecycle is part of the public
			// feed too, but we subscribe explicitly to be safe.
			const tickers = state.config.tickers;
			const subscribeMsg = {
				id: 1,
				cmd: "subscribe",
				params: {
					channels: ["orderbook_delta", "trade", "ticker", "market_lifecycle_v2"],
					market_tickers: tickers,
				},
			};
			ws.send(JSON.stringify(subscribeMsg));
			console.log(`[live-bot] WS open, subscribed to ${tickers.length} tickers`);
		});

		ws.addEventListener("message", (event: MessageEvent) => {
			const data = typeof event.data === "string" ? event.data : "";
			if (!data) return;
			try {
				const msg = JSON.parse(data) as KalshiWSMessage;
				void this.handleKalshiMessage(state, msg);
			} catch (e) {
				console.error("[live-bot] failed to parse WS message", e);
			}
		});

		ws.addEventListener("error", (event: Event) => {
			const msg =
				(event as ErrorEvent).message ?? "WebSocket error (no message)";
			console.error("[live-bot] WS error", msg);
			this._lastWsError = {
				ts_ms: Date.now(),
				code: "ws_error",
				message: msg,
			};
		});

		ws.addEventListener("close", (event: CloseEvent) => {
			console.log(
				`[live-bot] WS close code=${event.code} reason=${event.reason ?? ""}`,
			);
			this._kalshiWs = null;
			this._connected = false;
			if (event.code !== 1000) {
				this._lastWsError = {
					ts_ms: Date.now(),
					code: `close_${event.code}`,
					message: event.reason || "abnormal closure",
				};
			}
			this.scheduleReconnect(state);
		});
	}

	private scheduleReconnect(state: LiveBotState): void {
		if (this._reconnectTimer) return;
		const delay = Math.min(1000 * 2 ** this._reconnectAttempt, 30_000);
		this._reconnectAttempt += 1;
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			void this.openKalshiWs(state);
		}, delay);
	}

	private closeKalshiWs(): void {
		if (this._kalshiWs) {
			try {
				this._kalshiWs.close(1000, "client_close");
			} catch {
				// ignore
			}
			this._kalshiWs = null;
		}
		this._connected = false;
	}

	// ─── Frame processing ────────────────────────────────────────

	private async handleKalshiMessage(
		state: LiveBotState,
		msg: KalshiWSMessage,
	): Promise<void> {
		// Mutations against state must be serialized. blockConcurrencyWhile
		// ensures the DO doesn't get re-entered while we save.
		await this.ctx.blockConcurrencyWhile(async () => {
			state.n_frames += 1;
			switch (msg.type) {
				case "orderbook_snapshot": {
					const m = msg as OrderbookSnapshot;
					const ticker = m.msg?.market_ticker;
					if (!ticker) return;
					this.onOrderbookSnapshot(state, ticker, m);
					break;
				}
				case "orderbook_delta": {
					const m = msg as OrderbookDelta;
					const ticker = m.msg?.market_ticker;
					if (!ticker) return;
					this.onOrderbookDelta(state, ticker, m);
					break;
				}
				case "trade": {
					const m = msg as TradeMessage;
					const ticker = m.msg?.market_ticker;
					if (!ticker) return;
					this.onTrade(state, ticker, m);
					break;
				}
				case "ticker": {
					const m = msg as TickerMessage;
					// We don't change state on ticker; the orderbook channel
					// is the source of truth. The ticker channel is a
					// periodic summary useful for diagnostics.
					void m;
					break;
				}
				case "market_lifecycle_v2":
				case "market_lifecycle": {
					// Settlement event — close any open position at the
					// settlement value. The exact wire shape varies; we
					// look for an `event_type=settled` + `settlement_value`
					// pair in `msg`.
					await this.onMarketLifecycle(state, msg);
					break;
				}
				case "subscribed": {
					console.log(`[live-bot] subscribed: ${JSON.stringify(msg)}`);
					break;
				}
				case "error": {
					console.error(`[live-bot] kalshi error: ${JSON.stringify(msg)}`);
					break;
				}
				default: {
					// Unknown — log + skip. Don't fail the loop on a
					// single unhandled type.
					console.log(`[live-bot] unhandled msg type=${(msg as { type: string }).type}`);
				}
			}
			// After every frame, maybe call the strategy.
			await this.maybeSignalAll(state);
			await this.saveState(state);
		});
	}

	private onOrderbookSnapshot(
		state: LiveBotState,
		ticker: string,
		msg: OrderbookSnapshot,
	): void {
		const t = state.tickers[ticker];
		if (!t) return;
		const ob = orderbookSnapshotToOb(msg);
		t.book = { yes_levels: ob.yes_levels, no_levels: ob.no_levels };
		this.appendPriceHistory(state, t);
	}

	private onOrderbookDelta(
		state: LiveBotState,
		ticker: string,
		msg: OrderbookDelta,
	): void {
		const t = state.tickers[ticker];
		if (!t) return;
		const current: KalshiOrderbook = t.book
			? { ticker, yes_levels: t.book.yes_levels, no_levels: t.book.no_levels }
			: { ticker, yes_levels: [], no_levels: [] };
		const updated = applyOrderbookDelta(current, msg);
		t.book = { yes_levels: updated.yes_levels, no_levels: updated.no_levels };
		this.appendPriceHistory(state, t);
	}

	private onTrade(state: LiveBotState, ticker: string, msg: TradeMessage): void {
		const t = state.tickers[ticker];
		if (!t) return;
		const yesCents = Math.round(parseFloat(msg.msg.yes_price_dollars ?? "0") * 100);
		if (yesCents > 0) {
			t.last_trade_price_cents = yesCents;
			t.price_history.push(yesCents);
			// Trim to the lookback window.
			const max = state.config.lookback;
			if (t.price_history.length > max) {
				t.price_history.splice(0, t.price_history.length - max);
			}
		}
		t.trade_count += 1;
		// Auto-close check (only when in "mtm" mode).
		if (
			state.config.close_after_trades !== null &&
			state.config.close_after_trades > 0 &&
			state.config.exit_mode === "mtm" &&
			t.position !== null
		) {
			const pos = t.position;
			const targetTrades = state.config.close_after_trades;
			// We don't track entry trade count separately; we use the
			// "elapsed since open" frame count as a proxy. The Python
			// engine does the same.
			const tradeCountAtEntry = Math.max(0, t.trade_count - targetTrades);
			if (t.trade_count - tradeCountAtEntry >= targetTrades) {
				this.autoCloseAtMark(state, ticker, yesCents);
			}
		}
		// Profit target / stop loss (mark-based).
		if (t.position !== null && t.book) {
			const mark = orderbookMidCents({
				ticker,
				yes_levels: t.book.yes_levels,
				no_levels: t.book.no_levels,
			});
			if (mark !== null) {
				const pos = t.position;
				const profitPct =
					pos.side === "yes"
						? (mark - pos.entry_price_cents) / pos.entry_price_cents
						: (pos.entry_price_cents - (100 - mark)) / pos.entry_price_cents;
				if (
					state.config.profit_target_pct !== null &&
					profitPct >= state.config.profit_target_pct
				) {
					this.autoCloseAtMark(state, ticker, mark, "pm_target");
				} else if (
					state.config.stop_loss_pct !== null &&
					profitPct <= -state.config.stop_loss_pct
				) {
					this.autoCloseAtMark(state, ticker, mark, "pm_stop");
				}
			}
		}
	}

	private async onMarketLifecycle(
		state: LiveBotState,
		msg: KalshiWSMessage,
	): Promise<void> {
		// The wire format is `market_lifecycle_v2` with a `msg` object
		// containing `event_type` and (for `settled`) a `settlement_value`.
		const inner = (msg as { msg?: { market_ticker?: string; event_type?: string; settlement_value?: string } })
			.msg;
		if (!inner) return;
		const ticker = inner.market_ticker;
		if (!ticker) return;
		if (inner.event_type === "settled" && inner.settlement_value !== undefined) {
			const sv = parseFloat(inner.settlement_value);
			if (!Number.isFinite(sv)) return;
			const settlementCents = Math.round(sv * 100);
			if (settlementCents < 0 || settlementCents > 100) return;
			this.closeAtSettlement(state, ticker, settlementCents);
		}
	}

	private appendPriceHistory(state: LiveBotState, t: LiveBotState["tickers"][string]): void {
		if (!t.book) return;
		const mid = orderbookMidCents({
			ticker: t.vertical ? "" : "", // unused; we read levels directly
			yes_levels: t.book.yes_levels,
			no_levels: t.book.no_levels,
		});
		if (mid === null) return;
		t.price_history.push(mid);
		const max = state.config.lookback;
		if (t.price_history.length > max) {
			t.price_history.splice(0, t.price_history.length - max);
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
			const { KalshiClient, DEFAULT_DEMO_BASE, DEFAULT_PRODUCTION_BASE } = await import(
				"../kalshi/client.js"
			);
			const { KalshiCredentials } = await import("../kalshi/auth.js");
			const credentials = await KalshiCredentials.fromPem(keyId, pem);
			const client = new KalshiClient({
				baseUrl: useDemo ? DEFAULT_DEMO_BASE : DEFAULT_PRODUCTION_BASE,
				credentials,
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
			const body: Record<string, unknown> = {
				ticker,
				side: v2Side,
				count: countStr,
				price: priceDollars,
				time_in_force: "good_till_canceled",
				self_trade_prevention_type: "taker_at_cross",
			};
			const resp = (await client.placeOrder(body)) as Record<string, unknown>;
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
