/**
 * pm-bot — Cloudflare Workers entry point.
 *
 * Routing (chunk 0 → 3):
 *   /health, /healthz                     — Worker health endpoint (200 JSON)
 *   /pm, /pm/, /pm/*                      — dashboard, served from public/ via env.ASSETS
 *   /api/pm/*                             — bot API (chunk 1+)
 *   /api/pm/bot/start                     — POST: start the live bot DO
 *   /api/pm/bot/stop                      — POST: stop the live bot DO
 *   /api/pm/bot/restart                   — POST: restart the live bot DO
 *   /api/pm/bot/status                    — GET: live bot DO state
 *   /                                     — root landing (200 JSON)
 *
 * The static-asset binding `env.ASSETS` is auto-created from the
 * `assets.directory` config in wrangler.jsonc.
 *
 * The Durable Object `LIVE_BOT` (chunk 3) is addressed by
 * `idFromName(`user:${userId}`)` so multi-tenancy is just a name change.
 */

import type { LiveBotConfig } from "./durable-objects/LiveBot.js";

export interface Env {
	ENVIRONMENT: string;
	SERVICE_NAME: string;
	DB?: D1Database;
	BUCKET?: R2Bucket;
	ASSETS: Fetcher;
	// Durable Object binding — populated from wrangler.jsonc `durable_objects`.
	LIVE_BOT?: DurableObjectNamespace;
	// Kalshi demo credentials (paper trading). Production creds land in
	// chunk 9 with the real-trading toggle.
	KALSHI_DEMO_KEY_ID?: string;
	KALSHI_DEMO_PRIVATE_KEY?: string;
	// Bot defaults (overridable per-/start call).
	DEFAULT_TICKERS?: string;
	DEFAULT_URL?: string;
}

export { LiveBot } from "./durable-objects/LiveBot.js";

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
