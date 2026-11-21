/**
 * prediction-market-lab — Stage API.
 *
 * The single badge in the brand bar — what is the bot
 * doing right now? Derived from the bot's /status +
 * the latest cron_runs. Returns the stage label,
 * color, ELI5 description, and the action the
 * operator can take next.
 *
 * Stage values:
 *   - idle        — never started, or stopped
 *   - starting    — auto-start fired, WS not yet open
 *   - streaming   — WS connected, receiving data
 *   - real        — WS connected, trading_mode = real
 *   - paused      — trading_mode = off
 *   - killed      — kill_switch on
 *   - backtesting — backtest sweep running
 *   - retraining  — train cron running
 *   - error       — last WS error
 *
 * Response shape:
 *   {
 *     ok: true,
 *     stage: "streaming",
 *     label: "Streaming live data",
 *     description: "WebSocket connected, watching 1 ticker for opportunities.",
 *     color: "ok" | "warn" | "err" | "off",
 *     action_label: "Kill switch" | "Start" | null,
 *     action_path: "kill-switch" | "start" | null,
 *     ts_ms: 1786193000000
 *   }
 */

import { cronRuns as cronRunsDb } from "../lib/db.js";
import { DEFAULT_USER_ID } from "../lib/types.js";

export interface StageEnv {
	DB?: D1Database;
	LIVE_BOT?: DurableObjectNamespace;
}

interface BotStatusLike {
	connected?: boolean;
	counts?: { n_frames?: number; n_trades?: number };
	config?: {
		trading_mode?: "paper" | "real" | "off";
		kill_switch?: boolean;
	};
	last_ws_error?: { ts_ms: number; code: string; message: string } | null;
}

interface StageResponse {
	ok: true;
	stage:
		| "idle"
		| "starting"
		| "streaming"
		| "real"
		| "paused"
		| "killed"
		| "backtesting"
		| "retraining"
		| "error";
	label: string;
	description: string;
	color: "ok" | "warn" | "err" | "off" | "live";
	action_label: string | null;
	action_path: string | null;
	ts_ms: number;
}

export async function handleStage(env: StageEnv, _url: URL): Promise<Response> {
	const ts_ms = Date.now();
	const user_id = DEFAULT_USER_ID;

	let status: BotStatusLike = {};
	if (env.LIVE_BOT) {
		try {
			const id = env.LIVE_BOT.idFromName(`user:${user_id}`);
			const stub = env.LIVE_BOT.get(id);
			const resp = await stub.fetch("https://bot.local/status");
			if (resp.ok) {
				status = (await resp.json()) as BotStatusLike;
			}
		} catch {
			// LiveBot unavailable — leave defaults.
		}
	}

	// Latest running cron (if any).
	let runningCron: string | null = null;
	if (env.DB) {
		try {
			const row = await env.DB
				.prepare(
					`SELECT cron_name FROM cron_runs
					 WHERE user_id = ?1 AND status = 'running'
					 ORDER BY ts DESC LIMIT 1`,
				)
				.bind(user_id)
				.first<{ cron_name: string }>();
			runningCron = row?.cron_name ?? null;
		} catch {
			// ignore
		}
	}

	const config = status.config ?? {};
	const wsConnected = Boolean(status.connected);
	const nFrames = Number(status.counts?.n_frames ?? 0);
	const nTrades = Number(status.counts?.n_trades ?? 0);
	const killSwitch = Boolean(config.kill_switch);
	const tradingMode = config.trading_mode ?? "paper";
	const lastError = status.last_ws_error ?? null;

	let stage: StageResponse["stage"];
	let label: string;
	let description: string;
	let color: StageResponse["color"];
	let action_label: string | null = null;
	let action_path: string | null = null;

	// Derive the stage.
	if (runningCron === "train") {
		stage = "retraining";
		label = "Retraining models";
		description = "The weekly train cron is running — scanning R2 for new model artifacts.";
		color = "warn";
	} else if (runningCron === "backtest") {
		stage = "backtesting";
		description = "A backtest sweep is running over recent trades to update the candidate model.";
		label = "Running backtest";
		color = "warn";
	} else if (killSwitch) {
		stage = "killed";
		label = "Killed";
		description =
			"Kill switch is on. The engine refuses all new trades. Flip the switch in the trading-mode panel to resume.";
		color = "err";
		action_label = "Resume";
		action_path = "kill-switch?on=false";
	} else if (tradingMode === "off") {
		stage = "paused";
		label = "Paused";
		description = "Trading is paused (trading_mode=off). Live data still flows; the engine just doesn't act.";
		color = "warn";
		action_label = "Resume paper";
		action_path = "trading-mode?mode=paper";
	} else if (lastError && !wsConnected) {
		stage = "error";
		label = "Connection error";
		description = `WebSocket not connected: ${lastError.message} (${lastError.code}). Auto-retry in progress.`;
		color = "err";
		action_label = "Restart WS";
		action_path = "restart";
	} else if (wsConnected && tradingMode === "real") {
		stage = "real";
		label = "Trading real money";
		description = `Live. Watching ${nFrames >= 0 ? nFrames: 0} frames in. ${nTrades} trade(s) executed so far.`;
		color = "live";
		action_label = "Kill switch";
		action_path = "kill-switch?on=true";
	} else if (wsConnected) {
		stage = "streaming";
		label = "Streaming live data";
		description = `Connected. Watching the orderbook, trade prints, and ticker for ${nFrames} frame(s) so far. Paper trading.`;
		color = "ok";
	} else if (nFrames === 0) {
		stage = "starting";
		label = "Connecting…";
		description = "Opening the WebSocket to Kalshi. This usually takes a few seconds.";
		color = "warn";
		action_label = "Force restart";
		action_path = "restart";
	} else {
		stage = "idle";
		label = "Idle";
		description = "The bot is stopped. Push Start (or refresh the page to auto-start).";
		color = "off";
		action_label = "Start";
		action_path = "start";
	}

	const body: StageResponse = {
		ok: true,
		stage,
		label,
		description,
		color,
		action_label,
		action_path,
		ts_ms,
	};
	return Response.json(body, { headers: { "cache-control": "no-store" } });
}
