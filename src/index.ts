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
