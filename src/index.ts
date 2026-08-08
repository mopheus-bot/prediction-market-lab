/**
 * pm-bot — Cloudflare Workers entry point.
 *
 * Chunk 0: hello-world that proves the deploy pipeline works.
 * Replaced by the real routing in Chunk 1+ as features land.
 */

export interface Env {
  ENVIRONMENT: string;
  SERVICE_NAME: string;
  DB?: D1Database;
  BUCKET?: R2Bucket;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const start = Date.now();

    // Health check — used by Fly.io, the dashboard, and uptime monitors.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: env.SERVICE_NAME,
          environment: env.ENVIRONMENT,
          uptime_ms: Date.now() - start,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // Root — version + build info.
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        JSON.stringify(
          {
            ok: true,
            service: env.SERVICE_NAME,
            environment: env.ENVIRONMENT,
            message: "pm-bot is live. see /health for a heartbeat.",
            deployed_at: new Date().toISOString(),
          },
          null,
          2,
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({ ok: false, error: "not found", path: url.pathname }),
      {
        status: 404,
        headers: { "content-type": "application/json" },
      },
    );
  },
};
