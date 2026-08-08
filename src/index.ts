/**
 * pm-bot — Cloudflare Workers entry point.
 *
 * Routing (chunk 0 + later chunks):
 *   /health, /healthz     — Worker health endpoint (200 JSON)
 *   /pm, /pm/, /pm/*      — dashboard, served from public/ via env.ASSETS
 *   /api/pm/*             — bot API (chunks 1+)
 *   /                     — root landing (200 JSON)
 *
 * The static-asset binding `env.ASSETS` is auto-created from the
 * `assets.directory` config in wrangler.jsonc.
 */

export interface Env {
  ENVIRONMENT: string;
  SERVICE_NAME: string;
  DB?: D1Database;
  BUCKET?: R2Bucket;
  ASSETS: Fetcher;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ─── Health check (used by uptime monitors, CF Access, the bot itself) ───
    if (path === "/health" || path === "/healthz") {
      return jsonResponse({
        ok: true,
        service: env.SERVICE_NAME,
        environment: env.ENVIRONMENT,
        bindings: {
          db: !!env.DB,
          bucket: !!env.BUCKET,
          assets: !!env.ASSETS,
        },
      });
    }

    // ─── Dashboard: /pm/* → serve from public/ ────────────────────────────
    if (path === "/pm" || path === "/pm/" || path.startsWith("/pm/")) {
      // /pm or /pm/         → public/index.html
      // /pm/foo             → public/foo
      // /pm/foo/bar.css     → public/foo/bar.css
      const assetPath =
        path === "/pm" || path === "/pm/"
          ? "/index.html"
          : path.replace(/^\/pm/, "") || "/index.html";
      const assetUrl = new URL(assetPath, url);
      const assetResp = await env.ASSETS.fetch(assetUrl);
      // If the asset doesn't exist, fall through to a 404 instead of
      // serving the assets-binding's own 404 (which has weird content).
      if (assetResp.status === 404) {
        return jsonResponse(
          { ok: false, error: "not found", path },
          404,
        );
      }
      return assetResp;
    }

    // ─── API: /api/pm/* ─────────────────────────────────────────────────────
    if (path.startsWith("/api/pm/")) {
      return jsonResponse({
        ok: true,
        message: "pm-bot API",
        path,
        note: "Endpoints land in chunks 1–6. /api/pm/health is the only one that works today.",
      });
    }

    // ─── Root landing ───────────────────────────────────────────────────────
    if (path === "/" || path === "") {
      return jsonResponse({
        ok: true,
        service: env.SERVICE_NAME,
        environment: env.ENVIRONMENT,
        message:
          "pm-bot is live. visit /pm/ for the dashboard (CF Access protected).",
        deployed_at: new Date().toISOString(),
      });
    }

    return jsonResponse({ ok: false, error: "not found", path }, 404);
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
