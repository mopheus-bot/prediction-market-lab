/**
 * pm-bot — Cloudflare Workers entry point.
 *
 * Routing (chunk 0 → 5):
 *   /health, /healthz                     — Worker health endpoint (200 JSON)
 *   /pm, /pm/, /pm/*                      — dashboard, served from public/ via env.ASSETS
 *   /api/pm/*                             — bot API (chunk 1+)
 *   /api/pm/bot/start                     — POST: start the live bot DO
 *   /api/pm/bot/stop                      — POST: stop the live bot DO
 *   /api/pm/bot/restart                   — POST: restart the live bot DO
 *   /api/pm/bot/status                    — GET: live bot DO state
 *   /                                     — root landing (200 JSON)
 *
 * Scheduled (chunk 5):
 *   CF Cron Triggers fire the `scheduled` handler; we dispatch
 *   to the 4 jobs (scan / news / daily / train) by inspecting
 *   `event.cron`. See src/cron/dispatcher.ts for the table.
 *
 * The static-asset binding `env.ASSETS` is auto-created from the
 * `assets.directory` config in wrangler.jsonc.
 *
 * The Durable Object `LIVE_BOT` (chunk 3) is addressed by
 * `idFromName(`user:${userId}`)` so multi-tenancy is just a name change.
 */

import { dispatchScheduledEvent, type CronEnv } from "./cron/dispatcher.js";
import {
	handleCronRuns,
	handleScans,
	handleSignals,
	handleStatus,
	handleSummary,
	handleTrades,
} from "./api/status.js";
import { handleCfAnalytics } from "./api/cf-analytics.js";
import { handleBotBalance } from "./api/balance.js";
import { handleCost } from "./api/cost.js";
import { handleCadence } from "./api/cadence.js";
import { handleStage } from "./api/stage.js";
import { handleKalshiSdkTest } from "./api/kalshi-sdk-test.js";
import { handleVerticals } from "./api/verticals.js";
import { handleBacktestRun } from "./api/backtest-run.js";
import { handleTelegramTest } from "./api/telegram-test.js";
import {
	handleGetActiveModels,
	handleGetModel,
	handleListModels,
	handlePromoteModel,
	handleRegisterModel,
	handleRetireModel,
} from "./api/models.js";
import { ShadowBot } from "./durable-objects/ShadowBot.js";
import type { LiveBotConfig } from "./durable-objects/LiveBot.js";

export interface Env extends CronEnv {
	ENVIRONMENT: string;
	SERVICE_NAME: string;
	DB?: D1Database;
	BUCKET?: R2Bucket;
	ASSETS: Fetcher;
	// Durable Object binding — populated from wrangler.jsonc `durable_objects`.
	LIVE_BOT?: DurableObjectNamespace;
	// ShadowBot DO (chunk 8). Optional; if the binding is
	// missing (e.g. the deployment hasn't migrated yet), the
	// /api/pm/shadow/* routes return 503.
	SHADOW_BOT?: DurableObjectNamespace;
	// Kalshi demo credentials (paper trading). Production creds land in
	// chunk 9 with the real-trading toggle.
	KALSHI_DEMO_KEY_ID?: string;
	KALSHI_DEMO_PRIVATE_KEY?: string;
	// Bot defaults (overridable per-/start call).
	DEFAULT_TICKERS?: string;
	DEFAULT_URL?: string;
	// Cloudflare API token for the /api/pm/cf-analytics
	// endpoint. Reads CF Workers Analytics via the GraphQL
	// API. Needs `account:read` scope. Set via
	// `wrangler secret put CF_API_TOKEN`.
	CF_API_TOKEN?: string;
	// Optional overrides for the cf-analytics endpoint.
	// Default values are the pm-bot account + script name.
	CF_ACCOUNT_TAG?: string;
	CF_SCRIPT_NAME?: string;
	// Chunk 10.5: cost tracking.
	// CF Workers Paid plan billing cycle start date (ISO YYYY-MM-DD).
	// The cost endpoint computes "resets in N days" from this.
	CF_BILLING_CYCLE_START?: string;
}

export { LiveBot } from "./durable-objects/LiveBot.js";
export { ShadowBot } from "./durable-objects/ShadowBot.js";

const DEFAULT_USER_ID = "default";

export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// ─── Health check ────────────────────────────────────────────────
		if (path === "/health" || path === "/healthz") {
			return jsonResponse({
				ok: true,
				service: env.SERVICE_NAME,
				environment: env.ENVIRONMENT,
				bindings: {
					db: !!env.DB,
					bucket: !!env.BUCKET,
					assets: !!env.ASSETS,
					live_bot: !!env.LIVE_BOT,
				},
			});
		}

		// ─── Dashboard: /pm/* → serve from public/ ──────────────────────
		if (path === "/pm" || path === "/pm/" || path.startsWith("/pm/")) {
			const assetPath =
				path === "/pm" || path === "/pm/"
					? "/index.html"
					: path.replace(/^\/pm/, "") || "/index.html";
			const assetUrl = new URL(assetPath, url);
			const assetResp = await env.ASSETS.fetch(assetUrl);
			if (assetResp.status === 404) {
				return jsonResponse(
					{ ok: false, error: "not found", path },
					404,
				);
			}
			return assetResp;
		}

		// ─── API: /api/pm/bot/* → live bot DO (chunk 3) ─────────────────
		if (path === "/api/pm/bot/status" && request.method === "GET") {
			return forwardToBot(env, request, "/status");
		}
		if (path === "/api/pm/bot/start" && request.method === "POST") {
			return forwardToBot(env, request, "/start");
		}
		if (path === "/api/pm/bot/stop" && request.method === "POST") {
			return forwardToBot(env, request, "/stop");
		}
		if (path === "/api/pm/bot/restart" && request.method === "POST") {
			return forwardToBot(env, request, "/restart");
		}
		// Reload models from R2 (chunk 8). After promoting a
		// new model version via /api/pm/models/promote, hit this
		// endpoint to load the new version without restarting
		// the bot's WS.
		if (path === "/api/pm/bot/reload-models" && request.method === "POST") {
			return forwardToBot(env, request, "/reload-models");
		}
		// ─── API: /api/pm/bot/* (chunk 9: real trading toggle) ─────
		// Set the trading mode (paper | real | off). Operators
		// flip this to "real" once they're ready to deploy
		// real capital; "off" pauses new trades without
		// disconnecting the WS.
		if (path === "/api/pm/bot/trading-mode" && request.method === "POST") {
			return forwardToBot(env, request, "/trading-mode");
		}
		// Toggle the kill switch. With {on: true} (default),
		// the engine refuses all new trades. With {on: false},
		// trading resumes.
		if (path === "/api/pm/bot/kill-switch" && request.method === "POST") {
			return forwardToBot(env, request, "/kill-switch");
		}
		// Manual order placement for the operator. Body:
		// { ticker, side, price_cents, size }. Per-trade cap
		// is enforced server-side.
		if (path === "/api/pm/bot/place-test-order" && request.method === "POST") {
			return forwardToBot(env, request, "/place-test-order");
		}
		// Manual close-position (chunk 10.9). Body: { ticker }.
		// Closes the open position at the current mark. Works
		// for paper + real positions.
		if (path === "/api/pm/bot/close-position" && request.method === "POST") {
			return forwardToBot(env, request, "/close-position");
		}
		// Manual cancel-order (chunk 10.9). Body: { order_id }.
		// Cancels a GTC order on Kalshi. Only meaningful in
		// real mode (paper orders are local-only).
		if (path === "/api/pm/bot/cancel-order" && request.method === "POST") {
			return forwardToBot(env, request, "/cancel-order");
		}
		// 2026-08-08: Telegram test endpoint. Verifies
		// the env's TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
		// without placing real orders. Used to debug the
		// "real fill didn't alert" issue.
		if (path === "/api/pm/bot/telegram-test" && request.method === "POST") {
			return handleTelegramTest(env);
		}
		// Auto-start (chunk 9.8): idempotent bot start. If
		// already running, returns current state. Otherwise
		// starts with default config. The dashboard calls
		// this on every page load so the user never has
		// to manually push Start.
		if (path === "/api/pm/bot/auto-start" && request.method === "POST") {
			return forwardToBot(env, request, "/auto-start");
		}

		// ─── API: /api/pm/{status,summary,trades,signals,scans,cron-runs} (chunk 6) ──
		if (path === "/api/pm/status" && request.method === "GET") {
			return handleStatus(env);
		}
		if (path === "/api/pm/summary" && request.method === "GET") {
			return handleSummary(env, url);
		}
		if (path === "/api/pm/trades" && request.method === "GET") {
			return handleTrades(env, url);
		}
		if (path === "/api/pm/signals" && request.method === "GET") {
			return handleSignals(env, url);
		}
		if (path === "/api/pm/scans" && request.method === "GET") {
			return handleScans(env);
		}
		if (path === "/api/pm/cron-runs" && request.method === "GET") {
			return handleCronRuns(env, url);
		}
		// ─── API: /api/pm/cf-analytics (chunk 9.5: Cloudflare inline analytics) ──
		// Proxies the CF GraphQL Analytics API. Reads the
		// same metrics the dash.cloudflare.com Workers
		// dashboard shows (requests, errors, subrequests)
		// for the last 24h by default (?hours= for 1..168).
		// Requires CF_API_TOKEN secret.
		if (path === "/api/pm/cf-analytics" && request.method === "GET") {
			return handleCfAnalytics(env, url);
		}
		// ─── API: /api/pm/bot/balance (chunk 9.6: Kalshi account balance) ──
		// Returns the live account balance + portfolio
		// value so the dashboard can show "Account: $X.XX"
		// in the trading-mode panel. Requires
		// KALSHI_PROD_KEY_ID + KALSHI_PROD_PRIVATE_KEY.
		if (path === "/api/pm/bot/balance" && request.method === "GET") {
			return handleBotBalance(env, url);
		}
		// ─── API: /api/pm/cost (chunk 9.7: cost estimate) ──
		// Combines CF Analytics (Workers requests) +
		// D1 (llm_calls + cron_runs + trades) + MMX
		// pricing into a single "what's this costing me"
		// number. Estimates, not invoiced. See
		// src/api/cost.ts for the assumptions.
		if (path === "/api/pm/cost" && request.method === "GET") {
			return handleCost(env, url);
		}
		// ─── API: /api/pm/cadence (chunk 10) ──
		// Every auto-running service + last-ran +
		// next-scheduled + status. The single source
		// of truth for the cadence panel.
		if (path === "/api/pm/cadence" && request.method === "GET") {
			return handleCadence(env, url);
		}
		// ─── API: /api/pm/bot/stage (chunk 10) ──
		// Single badge in the brand bar — what is the
		// bot doing right now? ELI5 description included.
		if (path === "/api/pm/bot/stage" && request.method === "GET") {
			return handleStage(env, url);
		}

		// ─── API: /api/pm/kalshi-sdk-test (chunk 10.8) ──
		// Smoke test the kalshi-typescript SDK adapter. Calls
		// getBalance + getPositions on the demo endpoint and
		// returns the raw response. Used to verify the SDK
		// (axios + Node crypto) actually works in CF Workers.
		if (path === "/api/pm/kalshi-sdk-test" && request.method === "GET") {
			return handleKalshiSdkTest(env);
		}
		// ─── API: /api/pm/verticals (chunk 10.8c) ──
		// Per-vertical state for the dashboard's Verticals
		// panel: active, model version, strategy, 24h + all-time
		// stats, per-vertical cap, tickers in the vertical.
		if (path === "/api/pm/verticals" && request.method === "GET") {
			return handleVerticals(env, url);
		}
		// ─── API: /api/pm/backtest/run (chunk 10.8c) ──
		// Manual trigger of the backtest retrospective. The
		// Sunday cron auto-runs this; the endpoint lets the
		// operator (and the smoke test) verify the code
		// path against live data without waiting for
		// Sunday 01:00 UTC.
		if (path === "/api/pm/backtest/run" && request.method === "POST") {
			return handleBacktestRun(env, request);
		}

		// ─── API: /api/pm/models/* (chunk 8) ───────────────────
		if (path === "/api/pm/models" && request.method === "GET") {
			return handleListModels(env, url);
		}
		if (path === "/api/pm/models/active" && request.method === "GET") {
			return handleGetActiveModels(env);
		}
		// /api/pm/models/:version — match anything under
		// /api/pm/models/ that isn't a known sub-path.
		if (
			path.startsWith("/api/pm/models/") &&
			request.method === "GET" &&
			path !== "/api/pm/models/active"
		) {
			const version = path.slice("/api/pm/models/".length);
			return handleGetModel(env, version);
		}
		if (path === "/api/pm/models/register" && request.method === "POST") {
			return handleRegisterModel(env, request);
		}
		if (path === "/api/pm/models/promote" && request.method === "POST") {
			return handlePromoteModel(env, request);
		}
		if (path === "/api/pm/models/retire" && request.method === "POST") {
			return handleRetireModel(env, request);
		}
		// Direct WS upgrade to the live bot DO (no auth — CF Access sits
		// in front, and the bot is single-user).
		if (path === "/api/pm/bot/ws" && request.headers.get("Upgrade") === "websocket") {
			return forwardUpgradeToBot(env, request);
		}

		// ─── API: /api/pm/* — placeholder for chunks 4-7 endpoints ──────
		if (path.startsWith("/api/pm/")) {
			return jsonResponse({
				ok: true,
				message: "pm-bot API",
				path,
				note: "Endpoints land in chunks 4-7. /api/pm/bot/* (chunk 3) is live.",
			});
		}

		// ─── Root landing ────────────────────────────────────────────────
		if (path === "/" || path === "") {
			return jsonResponse({
				ok: true,
				service: env.SERVICE_NAME,
				environment: env.ENVIRONMENT,
				message:
					"pm-bot is live. visit /pm/ for the dashboard (CF Access protected). " +
					"bot control: /api/pm/bot/{start,stop,restart,status,ws}.",
				deployed_at: new Date().toISOString(),
			});
		}

		return jsonResponse({ ok: false, error: "not found", path }, 404);
	},

	// ─── Scheduled handler (chunk 5) ─────────────────────────────────
	// CF Cron Triggers fire this method. The dispatcher maps
	// `event.cron` to a job name. We schedule the dispatch in
	// `ctx.waitUntil` so the response returns immediately and
	// the job runs to completion (or hits its budget) without
	// blocking the scheduler.
	async scheduled(
		event: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(dispatchScheduledEvent(event.cron, env));
	},
};

// ─── Bot DO forwarders ────────────────────────────────────────────────

function botStub(env: Env): DurableObjectStub {
	if (!env.LIVE_BOT) {
		throw new Error("LIVE_BOT binding missing — check wrangler.jsonc");
	}
	const id = env.LIVE_BOT.idFromName(`user:${DEFAULT_USER_ID}`);
	return env.LIVE_BOT.get(id);
}

async function forwardToBot(
	env: Env,
	request: Request,
	path: string,
): Promise<Response> {
	try {
		const stub = botStub(env);
		// Forward only the body + relevant headers — strip the
		// CF-Connecting-IP / Authorization chain (the user is
		// already authenticated by CF Access upstream).
		const init: RequestInit = {
			method: request.method,
			headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
		};
		if (request.method !== "GET" && request.method !== "HEAD") {
			init.body = await request.text();
		}
		const url = new URL(request.url);
		const target = new URL(path, url);
		return await stub.fetch(new Request(target, init));
	} catch (e) {
		return jsonResponse(
			{ ok: false, error: "bot_dispatch_failed", message: String(e) },
			500,
		);
	}
}

async function forwardUpgradeToBot(
	env: Env,
	request: Request,
): Promise<Response> {
	try {
		const stub = botStub(env);
		// For a WS upgrade we pass the request through unchanged.
		return await stub.fetch(request);
	} catch (e) {
		return jsonResponse(
			{ ok: false, error: "bot_dispatch_failed", message: String(e) },
			500,
		);
	}
}

// ─── helpers ──────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

// Re-export for type clarity.
export type { LiveBotConfig };
