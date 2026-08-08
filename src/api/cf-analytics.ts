/**
 * pm-bot — Cloudflare Workers Analytics API endpoint (chunk 9.5).
 *
 * Surfaces the same metrics that live at dash.cloudflare.com
 * (Workers & Pages → pm-bot → Metrics) but inline in the
 * dashboard. The query is a read against the CF GraphQL
 * Analytics API using a CF API token. No new CF product is
 * enabled — Workers Analytics is on by default for every
 * deployed Worker, and the GraphQL API is a free read.
 *
 * **Auth:** `CF_API_TOKEN` secret. The token needs
 * `account:read` scope (the `cfut_*` token in
 * `~/Documents/clients/dev/tokens/cloudflare-tokens.md`
 * already has this). The `cfoat_*` OAuth token used by
 * wrangler would also work but it's tied to a single user
 * and has a short TTL — the API token is the right call.
 *
 * **Why not the GraphQL API directly from the dashboard?**
 * The CF GraphQL API requires a server-side secret (the
 * token). Putting it in the browser would leak it. The
 * Worker is the right proxy: it holds the secret, queries
 * CF, and returns a sanitized summary to the dashboard.
 *
 * **Caching:** the Worker doesn't cache. CF's own GraphQL
 * API is the source of truth and it's fast. If we ever
 * hit rate limits, the right place to add a 30s cache is
 * here.
 *
 * **Data freshness:** CF Analytics has a ~1-minute delay
 * (the GraphQL API returns the last completed minute plus
 * all earlier data). Polling faster than 60s is wasteful.
 */

const CF_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

const QUERY = `
query PmBotAnalytics(
  $accountTag: String!,
  $scriptName: String!,
  $since: Time!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 500,
        filter: {
          scriptName: $scriptName
          datetime_geq: $since
        }
      ) {
        sum {
          requests
          errors
          subrequests
          cpuTime
        }
        dimensions {
          datetime
        }
      }
    }
  }
}
`;

/** Compact request summary for the dashboard. */
export interface CfAnalyticsSummary {
	ok: true;
	account_tag: string;
	script_name: string;
	since: string;
	until: string;
	totals: {
		requests: number;
		errors: number;
		subrequests: number;
		cpu_ms: number;
		error_rate_pct: number;
		success_rate_pct: number;
	};
	/** Last 24 hourly buckets. */
	hourly: Array<{
		datetime: string;
		requests: number;
		errors: number;
	}>;
	/** Link to the full CF dashboard. */
	dashboard_url: string;
}

/** Error variant — what we return when the upstream CF
 *  query fails. The dashboard shows the error message
 *  inline. */
export interface CfAnalyticsError {
	ok: false;
	error: string;
	detail?: string;
	dashboard_url: string;
}

export type CfAnalyticsResponse = CfAnalyticsSummary | CfAnalyticsError;

export interface CfAnalyticsEnv {
	CF_API_TOKEN?: string;
	CF_ACCOUNT_TAG?: string;
	CF_SCRIPT_NAME?: string;
}

/** Default account tag (pm-bot lives here). Hardcoded so
 *  the dashboard works even without the env var; the user
 *  can override if they fork. */
const DEFAULT_ACCOUNT_TAG = "8c995c329fee2ee6ab33d9d3d6a30e55";
const DEFAULT_SCRIPT_NAME = "pm-bot";
/** How many hours back to pull. 24h is the dashboard
 *  default; users can pass ?hours=168 for 7d if they
 *  want a longer view (CF keeps 30 days of hourly
 *  granularity for Workers). */
const DEFAULT_HOURS = 24;

export async function handleCfAnalytics(
	env: CfAnalyticsEnv,
	url: URL,
): Promise<Response> {
	const token = env.CF_API_TOKEN;
	const accountTag = env.CF_ACCOUNT_TAG ?? DEFAULT_ACCOUNT_TAG;
	const scriptName = env.CF_SCRIPT_NAME ?? DEFAULT_SCRIPT_NAME;
	const dashboardUrl =
		`https://dash.cloudflare.com/${accountTag}` +
		`/workers/services/view/${scriptName}/production/metrics`;

	if (!token) {
		return Response.json(
			{
				ok: false,
				error: "missing_cf_api_token",
				detail: "CF_API_TOKEN secret not set; cannot query CF GraphQL Analytics API",
				dashboard_url: dashboardUrl,
			} satisfies CfAnalyticsError,
			{ status: 503 },
		);
	}

	// Parse the `?hours=` query (default 24).
	const hoursRaw = Number(url.searchParams.get("hours") ?? DEFAULT_HOURS);
	const hours = Math.max(1, Math.min(168, Number.isFinite(hoursRaw) ? hoursRaw : DEFAULT_HOURS));
	const sinceDate = new Date(Date.now() - hours * 60 * 60 * 1000);
	// CF's Time scalar is RFC3339.
	const since = sinceDate.toISOString();

	try {
		const variables = {
			accountTag,
			scriptName,
			since,
		};
		const reqBody = JSON.stringify({
			query: QUERY,
			variables,
		});
		const resp = await fetch(CF_GRAPHQL_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: reqBody,
		});
		if (!resp.ok) {
			const text = await resp.text();
			return Response.json(
				{
					ok: false,
					error: "cf_graphql_http_error",
					detail: `status=${resp.status}: ${text.slice(0, 300)}`,
					dashboard_url: dashboardUrl,
				} satisfies CfAnalyticsError,
				{ status: 502 },
			);
		}
		const json = (await resp.json()) as {
			data?: {
				viewer?: {
					accounts?: Array<{
						workersInvocationsAdaptive?: Array<{
							sum?: { requests?: number; errors?: number; subrequests?: number; cpuTime?: number };
							dimensions?: { datetime?: string };
						}>;
					}>;
				};
			};
			errors?: Array<{ message?: string }>;
		};
		if (json.errors && json.errors.length > 0) {
			return Response.json(
				{
					ok: false,
					error: "cf_graphql_query_error",
					detail: json.errors.map((e) => e.message ?? "").join("; "),
					dashboard_url: dashboardUrl,
				} satisfies CfAnalyticsError,
				{ status: 502 },
			);
		}
		const buckets =
			json.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
		// Aggregate totals across all hourly buckets.
		let totalRequests = 0;
		let totalErrors = 0;
		let totalSubrequests = 0;
		let totalCpuMs = 0;
		const hourly: CfAnalyticsSummary["hourly"] = [];
		for (const b of buckets) {
			const r = b.sum?.requests ?? 0;
			const e = b.sum?.errors ?? 0;
			const s = b.sum?.subrequests ?? 0;
			const c = b.sum?.cpuTime ?? 0;
			totalRequests += r;
			totalErrors += e;
			totalSubrequests += s;
			totalCpuMs += c;
			if (b.dimensions?.datetime) {
				hourly.push({
					datetime: b.dimensions.datetime,
					requests: r,
					errors: e,
				});
			}
		}
		// Sort hourly by datetime ascending (oldest first).
		hourly.sort((a, b) => a.datetime.localeCompare(b.datetime));
		const errorRatePct =
			totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
		const successRatePct = 100 - errorRatePct;
		const summary: CfAnalyticsSummary = {
			ok: true,
			account_tag: accountTag,
			script_name: scriptName,
			since,
			until: new Date().toISOString(),
			totals: {
				requests: totalRequests,
				errors: totalErrors,
				subrequests: totalSubrequests,
				cpu_ms: totalCpuMs,
				error_rate_pct: Math.round(errorRatePct * 100) / 100,
				success_rate_pct: Math.round(successRatePct * 100) / 100,
			},
			hourly,
			dashboard_url: dashboardUrl,
		};
		return Response.json(summary, {
			headers: {
				// 60s cache — the underlying data is ~1m delayed anyway.
				"Cache-Control": "public, max-age=60",
			},
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return Response.json(
			{
				ok: false,
				error: "cf_graphql_fetch_failed",
				detail: msg.slice(0, 300),
				dashboard_url: dashboardUrl,
			} satisfies CfAnalyticsError,
			{ status: 502 },
		);
	}
}
