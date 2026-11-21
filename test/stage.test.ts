/**
 * prediction-market-lab — stage + cadence API unit tests.
 *
 * The stage endpoint derives a single badge from the bot's
 * current state. The cadence endpoint aggregates the
 * per-service "last ran" / "next in" / status. These tests
 * pin the unit-level helpers.
 */

import { describe, it, expect } from "vitest";

// ─── stage derivation logic (mirrors handleStage) ─────────────

type Color = "ok" | "warn" | "err" | "off" | "live";
type Stage =
	| "idle"
	| "starting"
	| "streaming"
	| "real"
	| "paused"
	| "killed"
	| "backtesting"
	| "retraining"
	| "error";

interface BotStatusLike {
	connected?: boolean;
	counts?: { n_frames?: number; n_trades?: number };
	config?: {
		trading_mode?: "paper" | "real" | "off";
		kill_switch?: boolean;
	};
	last_ws_error?: { ts_ms: number; code: string; message: string } | null;
}

function deriveStage(
	status: BotStatusLike,
	runningCron: string | null,
): { stage: Stage; color: Color; action_label: string | null; action_path: string | null } {
	const config = status.config ?? {};
	const wsConnected = Boolean(status.connected);
	const nFrames = Number(status.counts?.n_frames ?? 0);
	const killSwitch = Boolean(config.kill_switch);
	const tradingMode = config.trading_mode ?? "paper";
	const lastError = status.last_ws_error ?? null;

	if (runningCron === "train")
		return { stage: "retraining", color: "warn", action_label: null, action_path: null };
	if (runningCron === "backtest")
		return { stage: "backtesting", color: "warn", action_label: null, action_path: null };
	if (killSwitch)
		return { stage: "killed", color: "err", action_label: "Resume", action_path: "kill-switch?on=false" };
	if (tradingMode === "off")
		return { stage: "paused", color: "warn", action_label: "Resume paper", action_path: "trading-mode?mode=paper" };
	if (lastError && !wsConnected)
		return { stage: "error", color: "err", action_label: "Restart WS", action_path: "restart" };
	if (wsConnected && tradingMode === "real")
		return { stage: "real", color: "live", action_label: "Kill switch", action_path: "kill-switch?on=true" };
	if (wsConnected)
		return { stage: "streaming", color: "ok", action_label: null, action_path: null };
	if (nFrames === 0)
		return { stage: "starting", color: "warn", action_label: "Force restart", action_path: "restart" };
	return { stage: "idle", color: "off", action_label: "Start", action_path: "start" };
}

describe("deriveStage", () => {
	it("returns 'streaming' when WS connected + paper", () => {
		const s = deriveStage(
			{ connected: true, counts: { n_frames: 5 }, config: { trading_mode: "paper" } },
			null,
		);
		expect(s.stage).toBe("streaming");
		expect(s.color).toBe("ok");
	});

	it("returns 'real' when WS connected + real", () => {
		const s = deriveStage(
			{ connected: true, counts: { n_frames: 5 }, config: { trading_mode: "real" } },
			null,
		);
		expect(s.stage).toBe("real");
		expect(s.color).toBe("live");
		expect(s.action_path).toBe("kill-switch?on=true");
	});

	it("returns 'killed' when kill switch is on (overrides everything)", () => {
		const s = deriveStage(
			{ connected: true, counts: { n_frames: 100 }, config: { trading_mode: "real", kill_switch: true } },
			null,
		);
		expect(s.stage).toBe("killed");
		expect(s.color).toBe("err");
		expect(s.action_path).toBe("kill-switch?on=false");
	});

	it("returns 'paused' when trading_mode=off (no kill)", () => {
		const s = deriveStage(
			{ connected: true, counts: { n_frames: 10 }, config: { trading_mode: "off" } },
			null,
		);
		expect(s.stage).toBe("paused");
		expect(s.color).toBe("warn");
		expect(s.action_path).toBe("trading-mode?mode=paper");
	});

	it("returns 'error' when last_ws_error is set and WS not connected", () => {
		const s = deriveStage(
			{
				connected: false,
				counts: { n_frames: 0 },
				config: { trading_mode: "paper" },
				last_ws_error: { ts_ms: 1, code: "auth_sign_failed", message: "boom" },
			},
			null,
		);
		expect(s.stage).toBe("error");
		expect(s.color).toBe("err");
		expect(s.action_path).toBe("restart");
	});

	it("returns 'starting' when never connected, no error", () => {
		const s = deriveStage(
			{ connected: false, counts: { n_frames: 0 }, config: { trading_mode: "paper" } },
			null,
		);
		expect(s.stage).toBe("starting");
		expect(s.color).toBe("warn");
	});

	it("returns 'idle' when connected=false but n_frames>0 (transient)", () => {
		const s = deriveStage(
			{ connected: false, counts: { n_frames: 3 }, config: { trading_mode: "paper" } },
			null,
		);
		expect(s.stage).toBe("idle");
		expect(s.color).toBe("off");
		expect(s.action_path).toBe("start");
	});

	it("returns 'retraining' when train cron is running (overrides WS state)", () => {
		const s = deriveStage(
			{ connected: true, counts: { n_frames: 5 }, config: { trading_mode: "real" } },
			"train",
		);
		expect(s.stage).toBe("retraining");
	});

	it("returns 'backtesting' when backtest cron is running", () => {
		const s = deriveStage(
			{ connected: true, counts: { n_frames: 5 }, config: { trading_mode: "paper" } },
			"backtest",
		);
		expect(s.stage).toBe("backtesting");
	});
});

// ─── cadence summary math (mirrors handleCadence's summary) ──

function summaryCounts(services: Array<{ status: string }>) {
	return {
		n_services: services.length,
		n_ok: services.filter((s) => s.status === "ok" || s.status === "running").length,
		n_error: services.filter((s) => s.status === "error").length,
		n_off: services.filter((s) => s.status === "off").length,
		n_starting: services.filter((s) => s.status === "starting").length,
	};
}

describe("cadence summary", () => {
	it("counts ok/running/error/starting correctly", () => {
		const s = summaryCounts([
			{ status: "ok" },
			{ status: "ok" },
			{ status: "running" },
			{ status: "error" },
			{ status: "starting" },
			{ status: "starting" },
			{ status: "starting" },
		]);
		expect(s.n_services).toBe(7);
		expect(s.n_ok).toBe(3);
		expect(s.n_error).toBe(1);
		expect(s.n_off).toBe(0);
		expect(s.n_starting).toBe(3);
	});

	it("handles all-ok", () => {
		const s = summaryCounts([{ status: "ok" }, { status: "ok" }]);
		expect(s.n_ok).toBe(2);
		expect(s.n_error).toBe(0);
		expect(s.n_starting).toBe(0);
	});
});
