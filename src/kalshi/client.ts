/**
 * pm-bot — Kalshi REST client.
 *
 * Public + authenticated REST client for Kalshi v2.
 * Mirrors `live/kalshi_client.py`.
 *
 * Auth: when constructed with `credentials`, attaches the three
 * KALSHI-ACCESS-* headers to every request. The signature is
 * computed over the FULL URL path including the `/trade-api/v2`
 * prefix (per Kalshi's spec — same as the Python client).
 *
 * Throttling: 2 req/s default (well under Kalshi's soft limit).
 * Set `requestsPerSecond: 0` to disable.
 *
 * Used by:
 *  - Chunk 5 (cron scan): list_markets, iter_markets
 *  - Chunk 5 (cron news): get_market
 *  - Chunk 3 (live bot DO): get_market, get_orderbook, list_trades
 *  - Chunk 6 (status API): get_portfolio_balance, get_positions
 *  - Chunk 9 (real trading): post_order, delete, get_orders
 */

import type { KalshiCredentials, AuthHeaders } from "./auth.js";
import { buildAuthHeaders } from "./auth.js";
import {
	parseMarket,
	parseOrderbook,
	parseTrade,
	parseEvent,
	midCents,
	spreadCents,
	type KalshiMarket,
	type KalshiOrderbook,
	type KalshiTrade,
	type KalshiEvent,
} from "./models.js";

export const DEFAULT_PRODUCTION_BASE = "https://api.elections.kalshi.com/trade-api/v2";
export const DEFAULT_DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";

export interface KalshiClientOptions {
	baseUrl?: string;
	credentials?: KalshiCredentials;
	requestsPerSecond?: number;
	timeoutMs?: number;
	/** Override the fetcher (for testing). Defaults to global fetch. */
	fetcher?: typeof fetch;
	/**
	 * Max retry attempts on 5xx / 429. Default 3. Retries use
	 * exponential backoff (500ms × 2^attempt + jitter) and
	 * respect the server's `Retry-After` header when present.
	 * (chunk 10.8: the SDK adapter has retries; this brings the
	 * hand-rolled client to parity without rewriting call sites.)
	 */
	maxRetries?: number;
	/** Initial retry backoff in ms. Default 500. */
	initialBackoffMs?: number;
}

export class KalshiAPIError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string,
		public readonly url: string,
	) {
		super(`Kalshi API error: ${status} ${url}: ${body.slice(0, 200)}`);
		this.name = "KalshiAPIError";
	}
}

export class KalshiClient {
	private readonly baseUrl: string;
	private readonly pathPrefix: string;
	private readonly credentials: KalshiCredentials | undefined;
	private readonly minIntervalMs: number;
	private readonly timeoutMs: number;
	private readonly fetcher: typeof fetch;
	private readonly maxRetries: number;
	private readonly initialBackoffMs: number;
	private lastRequestAt = 0;

	constructor(opts: KalshiClientOptions = {}) {
		const baseUrl = (opts.baseUrl ?? DEFAULT_PRODUCTION_BASE).replace(/\/$/, "");
		// Parse the URL to extract the path prefix
		// (e.g. /trade-api/v2) — Kalshi signs the full path
		// from the root, not just the path-after-base.
		const u = new URL(baseUrl);
		this.baseUrl = baseUrl;
		this.pathPrefix = u.pathname; // "/trade-api/v2"
		this.credentials = opts.credentials;
		const rps = opts.requestsPerSecond ?? 2.0;
		this.minIntervalMs = rps > 0 ? 1000 / rps : 0;
		this.timeoutMs = opts.timeoutMs ?? 10_000;
		this.fetcher = opts.fetcher ?? fetch.bind(globalThis);
		this.maxRetries = opts.maxRetries ?? 3;
		this.initialBackoffMs = opts.initialBackoffMs ?? 500;
	}

	// --- request plumbing -------------------------------------------

	private async throttle(): Promise<void> {
		if (this.minIntervalMs <= 0) return;
		const elapsed = Date.now() - this.lastRequestAt;
		if (elapsed < this.minIntervalMs) {
			await sleep(this.minIntervalMs - elapsed);
		}
		this.lastRequestAt = Date.now();
	}

	private async authHeaders(method: string, path: string): Promise<AuthHeaders | {}> {
		if (!this.credentials) return {};
		const fullPath = `${this.pathPrefix}${path}`;
		return await this.credentials.authHeaders(method, fullPath);
	}

	private async request(
		method: string,
		path: string,
		opts: { params?: Record<string, unknown>; json?: unknown } = {},
	): Promise<unknown> {
		return this.withRetry(() => this.requestOnce(method, path, opts));
	}

	/**
	 * Chunk 10.8: exponential-backoff retries on 5xx + 429.
	 * Honors `Retry-After` from the server when present
	 * (Kalshi's rate limiter sends it). 4xx errors other than
	 * 429 are not retried — they're caller bugs, not transient
	 * failures.
	 */
	private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
		let lastErr: unknown;
		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			try {
				return await fn();
			} catch (e) {
				lastErr = e;
				if (!(e instanceof KalshiAPIError)) throw e;
				const retriable = e.status === 429 || (e.status >= 500 && e.status < 600);
				if (!retriable || attempt === this.maxRetries) throw e;
				const backoff = await this.computeBackoff(e, attempt);
				await sleep(backoff);
			}
		}
		// Unreachable — the loop either returns or throws.
		throw lastErr;
	}

	private async computeBackoff(err: KalshiAPIError, attempt: number): Promise<number> {
		// Server hint wins when present. `Retry-After` is in
		// seconds per HTTP spec; Kalshi sends it as an integer.
		const m = err.body.match(/retry-after[:=]?\s*(\d+)/i);
		if (m) {
			return parseInt(m[1], 10) * 1000;
		}
		const base = this.initialBackoffMs * 2 ** attempt;
		const jitter = Math.floor(Math.random() * 100);
		return base + jitter;
	}

	private async requestOnce(
		method: string,
		path: string,
		opts: { params?: Record<string, unknown>; json?: unknown },
	): Promise<unknown> {
		await this.throttle();
		const url = new URL(this.baseUrl + path);
		if (opts.params) {
			for (const [k, v] of Object.entries(opts.params)) {
				if (v === undefined || v === null) continue;
				url.searchParams.set(k, String(v));
			}
		}
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json",
			...((await this.authHeaders(method, path)) as Record<string, string>),
		};

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await this.fetcher(url.toString(), {
				method,
				headers,
				body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
				signal: controller.signal,
			});
			if (res.status < 200 || res.status >= 300) {
				const body = await res.text();
				throw new KalshiAPIError(res.status, body, url.toString());
			}
			// Some endpoints return 204; treat as null body.
			const text = await res.text();
			return text ? JSON.parse(text) : null;
		} finally {
			clearTimeout(timeout);
		}
	}

	private async get(path: string, params?: Record<string, unknown>): Promise<unknown> {
		return await this.request("GET", path, { params });
	}

	// --- raw accessors (escape hatches) -----------------------------

	async getRaw(path: string, params?: Record<string, unknown>): Promise<unknown> {
		return await this.get(path, params);
	}

	async postRaw(path: string, body: unknown): Promise<unknown> {
		return await this.request("POST", path, { json: body });
	}

	async deleteRaw(path: string): Promise<unknown> {
		return await this.request("DELETE", path);
	}

	// --- markets ----------------------------------------------------

	async getMarket(ticker: string): Promise<KalshiMarket> {
		const data = (await this.get(`/markets/${encodeURIComponent(ticker)}`)) as {
			market?: Record<string, unknown>;
		};
		return parseMarket(data.market ?? data);
	}

	async listMarkets(
		opts: {
			status?: string;
			limit?: number;
			cursor?: string;
			eventTicker?: string;
			seriesTicker?: string;
		} = {},
	): Promise<{ markets: KalshiMarket[]; cursor: string | null }> {
		const params: Record<string, unknown> = {
			status: opts.status ?? "open",
			limit: opts.limit ?? 100,
		};
		if (opts.cursor !== undefined) params.cursor = opts.cursor;
		if (opts.eventTicker !== undefined) params.event_ticker = opts.eventTicker;
		if (opts.seriesTicker !== undefined) params.series_ticker = opts.seriesTicker;
		const data = (await this.get("/markets", params)) as {
			markets?: Record<string, unknown>[];
			cursor?: string;
		};
		const markets = (data.markets ?? []).map(parseMarket);
		return { markets, cursor: data.cursor && data.cursor !== "" ? data.cursor : null };
	}

	async *iterMarkets(
		opts: {
			status?: string;
			limit?: number;
			maxPages?: number;
			eventTicker?: string;
			seriesTicker?: string;
		} = {},
	): AsyncGenerator<KalshiMarket, void, void> {
		let cursor: string | null = null;
		let pages = 0;
		while (true) {
			const page = await this.listMarkets({ ...opts, cursor: cursor ?? undefined });
			for (const m of page.markets) yield m;
			pages += 1;
			if (!page.cursor) return;
			if (opts.maxPages !== undefined && pages >= opts.maxPages) return;
			cursor = page.cursor;
		}
	}

	// --- orderbook --------------------------------------------------

	async getOrderbook(ticker: string): Promise<KalshiOrderbook> {
		const data = await this.get(`/markets/${encodeURIComponent(ticker)}/orderbook`);
		return parseOrderbook(ticker, data as Record<string, unknown>);
	}

	// --- public trades (price history) -----------------------------

	async listTrades(
		opts: {
			ticker?: string;
			limit?: number;
			cursor?: string;
			minTs?: number; // epoch SECONDS
			maxTs?: number;
		} = {},
	): Promise<{ trades: KalshiTrade[]; cursor: string | null }> {
		const params: Record<string, unknown> = { limit: opts.limit ?? 100 };
		if (opts.ticker !== undefined) params.ticker = opts.ticker;
		if (opts.cursor !== undefined) params.cursor = opts.cursor;
		if (opts.minTs !== undefined) params.min_ts = opts.minTs;
		if (opts.maxTs !== undefined) params.max_ts = opts.maxTs;
		const data = (await this.get("/markets/trades", params)) as {
			trades?: Record<string, unknown>[];
			cursor?: string;
		};
		const trades = (data.trades ?? []).map(parseTrade);
		return { trades, cursor: data.cursor && data.cursor !== "" ? data.cursor : null };
	}

	async *iterTrades(
		opts: {
			ticker?: string;
			limit?: number;
			maxPages?: number;
		} = {},
	): AsyncGenerator<KalshiTrade, void, void> {
		let cursor: string | null = null;
		let pages = 0;
		while (true) {
			const page = await this.listTrades({ ...opts, cursor: cursor ?? undefined });
			for (const t of page.trades) yield t;
			pages += 1;
			if (!page.cursor) return;
			if (opts.maxPages !== undefined && pages >= opts.maxPages) return;
			cursor = page.cursor;
		}
	}

	// --- events -----------------------------------------------------

	async listEvents(
		opts: { status?: string; limit?: number; cursor?: string; seriesTicker?: string } = {},
	): Promise<{ events: KalshiEvent[]; cursor: string | null }> {
		const params: Record<string, unknown> = {
			status: opts.status ?? "open",
			limit: opts.limit ?? 100,
		};
		if (opts.cursor !== undefined) params.cursor = opts.cursor;
		if (opts.seriesTicker !== undefined) params.series_ticker = opts.seriesTicker;
		const data = (await this.get("/events", params)) as {
			events?: Record<string, unknown>[];
			cursor?: string;
		};
		const events = (data.events ?? []).map(parseEvent);
		return { events, cursor: data.cursor && data.cursor !== "" ? data.cursor : null };
	}

	// 2026-08-11 (Phase 4, LLM-PIPELINE Bug A): single-event
	// fetch by ticker. Used by the LLM cron to ground its
	// verdicts on the parent event's title, sub_title,
	// rules_primary, and (for parlays) the
	// mve_selected_legs. Without this, the LLM sees a
	// market title like "yes Tanner Bibee: 4+,yes Eury
	// Pérez: 6+,yes Paul Skenes: 6+" and has to guess what
	// bundle of outcomes is in the market (per
	// docs/LLM-PIPELINE.md Bug A: high confidence = high
	// hallucination). The endpoint returns the event
	// object including all nested markets.
	async getEvent(
		eventTicker: string,
		opts: { withNestedMarkets?: boolean } = {},
	): Promise<KalshiEvent> {
		const params: Record<string, unknown> = {};
		if (opts.withNestedMarkets !== undefined) {
			params.with_nested_markets = opts.withNestedMarkets;
		}
		const data = (await this.get(
			`/events/${encodeURIComponent(eventTicker)}`,
			params,
		)) as { event?: Record<string, unknown> };
		if (!data.event) {
			throw new Error(`event ${eventTicker} not found`);
		}
		return parseEvent(data.event);
	}

	// --- portfolio (auth required) ----------------------------------

	async getBalance(): Promise<{
		balance: number;
		portfolio_value: number;
		updated_ts: number;
		balance_dollars: string;
	}> {
		return (await this.get("/portfolio/balance")) as {
			balance: number;
			portfolio_value: number;
			updated_ts: number;
			balance_dollars: string;
		};
	}

	async getPositions(): Promise<{
		market_positions: Record<string, unknown>[];
		event_positions: Record<string, unknown>[];
		cursor: string;
	}> {
		return (await this.get("/portfolio/positions")) as {
			market_positions: Record<string, unknown>[];
			event_positions: Record<string, unknown>[];
			cursor: string;
		};
	}

	async getOrders(
		opts: { status?: string; limit?: number; cursor?: string } = {},
	): Promise<{ orders: Record<string, unknown>[]; cursor: string | null }> {
		const params: Record<string, unknown> = { limit: opts.limit ?? 100 };
		if (opts.status !== undefined) params.status = opts.status;
		if (opts.cursor !== undefined) params.cursor = opts.cursor;
		const data = (await this.get("/portfolio/orders", params)) as {
			orders?: Record<string, unknown>[];
			cursor?: string;
		};
		return {
			orders: data.orders ?? [],
			cursor: data.cursor && data.cursor !== "" ? data.cursor : null,
		};
	}

	// --- orders (chunk 9) ------------------------------------------

	/**
	 * Place an order on Kalshi using the V2 endpoint
	 * (`POST /portfolio/events/orders`). The legacy
	 * `/portfolio/orders` endpoint was deprecated in 2026-05 and
	 * returns `deprecated_v1_order_endpoint` if hit directly.
	 *
	 * V2 body shape (per docs.kalshi.com/api-reference/orders/create-order-v2):
	 *   - ticker: market ticker (e.g. "KXWARMING-50")
	 *   - side: "bid" (buy YES) | "ask" (sell YES). Note: "bid"
	 *     is buying YES; "ask" is selling YES. Selling YES is
	 *     economically equivalent to buying NO at 1 - price.
	 *   - count: fixed-point string with 2 decimals (e.g. "1.00")
	 *   - price: fixed-point dollar string (e.g. "0.0100" for 1c)
	 *   - time_in_force: "fill_or_kill" | "good_till_canceled" | "immediate_or_cancel"
	 *   - self_trade_prevention_type: "taker_at_cross" | "maker"
	 *   - post_only: optional bool
	 *
	 * Returns the V2 response shape: `{order_id, fill_count,
	 * remaining_count, ts_ms, ...}`. Throws KalshiAPIError on
	 * non-2xx.
	 */
	async placeOrder(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		return (await this.postRaw(
			"/portfolio/events/orders",
			body,
		)) as Record<string, unknown>;
	}

	async cancelOrder(orderId: string): Promise<Record<string, unknown>> {
		return (await this.deleteRaw(
			`/portfolio/orders/${encodeURIComponent(orderId)}`,
		)) as Record<string, unknown>;
	}
}

// Re-export the model helpers so consumers can do
// `import { KalshiClient, midCents, spreadCents } from "./kalshi.js"`.
export { midCents, spreadCents };

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
