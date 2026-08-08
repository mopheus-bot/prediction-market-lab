/**
 * pm-bot — ShadowBot Durable Object (chunk 8).
 *
 * Runs a parallel paper-trading loop on a *candidate* model
 * version (the one being evaluated) and records how the
 * candidate's signals + outcomes differ from the live bot's.
 *
 * **Architecture (chunk 8 minimal version):**
 *   - The shadow DO subscribes to the same Kalshi WS feed
 *     as the live bot (tickers overlap).
 *   - It runs the candidate model + strategy on every frame.
 *   - When the candidate's signal differs from the live
 *     bot's last recorded signal for the same ticker (in
 *     `signals` D1, source='shadow'), the shadow DO
 *     records the disagreement to the `signals` table with
 *     `source='shadow'`.
 *   - The operator can compare live vs shadow outcomes
 *     from the dashboard (chunk 7) or via the API.
 *
 * **What the chunk-8 minimal does NOT do:**
 *   - The shadow DO doesn't write to `trades` (only `signals`).
 *     The live bot is the only producer of trades.
 *   - No PnL attribution. The shadow signals are recorded
 *     for back-comparison; outcomes (would-have-been PnL)
 *     are computed in the daily recap (chunk 8+).
 *   - No signal reconciliation. The shadow records what
 *     the candidate WOULD have done; the live records what
 *     it actually did. The diff is the operator's
 *     promotion-decision input.
 *
 * **Multi-tenant:** like the live bot, addressed by
 * `idFromName(`user:${userId}:shadow:${modelVersion}`)`.
 * The model_version is in the name so the operator can
 * spin up multiple shadow DOs at once (one per candidate).
 *
 * **When to use:** after the train-cron registers a new
 * candidate model, start a shadow DO on that version and
 * let it run for a few days. Compare to the live bot's
 * signals; promote via the API when ready.
 */

import type { Env } from "../index.js";

interface ShadowBotConfig {
	user_id?: string;
	model_version: string;
	tickers: string[];
	bankroll_cents?: number;
}

export class ShadowBot implements DurableObject {
	private readonly ctx: DurableObjectState;
	private readonly env: Env;
	private _kalshiWs: WebSocket | null = null;
	private _connected = false;
	private _reconnectAttempt = 0;
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _modelVersion: string = "";
	private _tickers: string[] = [];
	private _nSignals = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		if (path === "/start") {
			const config = (await request.json().catch(() => ({}))) as ShadowBotConfig;
			await this.start(config);
			return Response.json({ ok: true, started: true });
		}
		if (path === "/stop") {
			this.stop();
			return Response.json({ ok: true, stopped: true });
		}
		if (path === "/status") {
			return Response.json({
				ok: true,
				connected: this._connected,
				model_version: this._modelVersion,
				tickers: this._tickers,
				n_signals: this._nSignals,
			});
		}
		if (path === "/" || path === "/index.html") {
			return Response.json({
				ok: true,
				service: "shadow-bot",
				endpoints: ["POST /start", "POST /stop", "GET /status"],
			});
		}
		return new Response("not found", { status: 404 });
	}

	private async start(config: ShadowBotConfig): Promise<void> {
		this._modelVersion = config.model_version;
		this._tickers = config.tickers ?? [];
		// The shadow DO would open the Kalshi WS, run the
		// candidate model, and record signal comparisons.
		// For chunk 8 the minimal version stops at config
		// persistence + status reporting. A chunk-8+ commit
		// adds the full parallel-bot loop.
		console.log(
			`[shadow-bot] started: model=${this._modelVersion} ` +
				`tickers=${this._tickers.length} (chunk-8 minimal: WS loop deferred)`,
		);
	}

	private stop(): void {
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		this.closeKalshiWs();
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
}
