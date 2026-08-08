/**
 * pm-bot — kalshi-typescript SDK adapter (chunk 10.8).
 *
 * Thin wrapper around the OpenAPI-generated `kalshi-typescript`
 * SDK (v3.26.0, axios-based). The hand-rolled `client.ts` in
 * this directory predates the SDK; this adapter is the path
 * to "promote" the SDK for REST calls in pm-bot.
 *
 * **What this adapter does:**
 *  - Initializes the SDK with our `apiKey` + `privateKeyPem`
 *    (no `privateKeyPath` — avoids the `require('fs')` that
 *    won't work in CF Workers).
 *  - Wraps the small set of methods we actually use:
 *      getBalance, getPositions, getMarket, getOrderbook,
 *      listMarkets, getFills, createOrderV2, getOrder, getOrders.
 *  - Adds our 2 req/s throttle (mirrors the hand-rolled client).
 *  - Adds exponential-backoff retries on 5xx and 429 (the hand-rolled
 *    client has neither — this is the main "clean up" win).
 *  - Normalizes SDK error shapes into our `KalshiAPIError`.
 *
 * **CF Workers constraint:**
 *  The SDK uses axios, which works in CF Workers with
 *  `nodejs_compat` but the bundle is large (~120KB). The
 *  hand-rolled `client.ts` stays in the bundle for now as a
 *  fallback. This adapter is opt-in: callers must explicitly
 *  import from `./sdk-adapter.js` to use it.
 *
 * **Why not replace `client.ts` entirely:**
 *  The SDK's generated types are a near-perfect 1:1 of the
 *  Kalshi v2 spec, but the call sites in pm-bot use the
 *  `parse*` functions in `./models.ts` (lightweight,
 *  CF-Workers-friendly DTOs) for type narrowing. Swapping
 *  to the SDK's full-fat DTOs would touch every call site.
 *  This adapter keeps the parse layer untouched while
 *  delegating HTTP + auth + retry to the SDK.
 *
 * **Auth spec (chunk 10.6):**
 *  RSA-PSS with `saltLength = RSA_PSS_SALTLEN_DIGEST`. The
 *  SDK gets this right (matches our hand-rolled `auth.ts`).
 */

import {
	Configuration,
	PortfolioApi,
	OrdersApi,
	MarketApi,
	type CreateOrderV2Request,
} from "kalshi-typescript";
import { KalshiAPIError } from "./client.js";
import type { KalshiCredentials } from "./auth.js";

export interface SdkClientOptions {
	creds: KalshiCredentials;
	/** "prod" | "demo" — picks the base URL. */
	env: "prod" | "demo";
	/**
	 * Raw PEM string. The SDK needs the PEM as a string (axios
	 * signs with Node's `crypto`); our hand-rolled `KalshiCredentials`
	 * keeps a parsed `CryptoKey`. Pass the PEM separately.
	 */
	privateKeyPem: string;
	/** Default 2.0 req/s. Set 0 to disable. */
	requestsPerSecond?: number;
	/** Max retry attempts on 5xx / 429. Default 3. */
	maxRetries?: number;
	/** Initial retry backoff in ms. Default 500. Doubles each attempt. */
	initialBackoffMs?: number;
}

const PROD_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2";

export class KalshiSdkClient {
	private readonly cfg: Configuration;
	private readonly portfolio: PortfolioApi;
	private readonly orders: OrdersApi;
	private readonly market: MarketApi;
	private readonly minIntervalMs: number;
	private readonly maxRetries: number;
	private readonly initialBackoffMs: number;
	private lastRequestAt = 0;

	constructor(opts: SdkClientOptions) {
		const base = opts.env === "prod" ? PROD_BASE : DEMO_BASE;
		this.cfg = new Configuration({
			apiKey: opts.creds.keyId,
			privateKeyPem: opts.privateKeyPem,
			basePath: base,
		});
		this.portfolio = new PortfolioApi(this.cfg);
		this.orders = new OrdersApi(this.cfg);
		this.market = new MarketApi(this.cfg);
		const rps = opts.requestsPerSecond ?? 2.0;
		this.minIntervalMs = rps > 0 ? 1000 / rps : 0;
		this.maxRetries = opts.maxRetries ?? 3;
		this.initialBackoffMs = opts.initialBackoffMs ?? 500;
	}

	// ─── throttling + retry helpers ─────────────────────────────

	private async throttle(): Promise<void> {
		if (this.minIntervalMs <= 0) return;
		const now = Date.now();
		const wait = this.lastRequestAt + this.minIntervalMs - now;
		if (wait > 0) {
			await new Promise((r) => setTimeout(r, wait));
		}
		this.lastRequestAt = Date.now();
	}

	private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
		let lastErr: unknown;
		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			await this.throttle();
			try {
				return await fn();
			} catch (e) {
				lastErr = e;
				const status = extractStatus(e);
				const retriable =
					status === 429 || (status !== null && status >= 500 && status < 600);
				if (!retriable || attempt === this.maxRetries) {
					throw new KalshiAPIError(
						status ?? 0,
						extractBody(e),
						extractUrl(e),
					);
				}
				const backoff =
					this.initialBackoffMs * 2 ** attempt +
					Math.floor(Math.random() * 100);
				await new Promise((r) => setTimeout(r, backoff));
			}
		}
		// Unreachable; the loop returns or throws.
		throw new KalshiAPIError(0, String(lastErr), "(unknown)");
	}

	// ─── thin wrappers around the SDK methods we use ─────────────

	getBalance(): Promise<unknown> {
		return this.withRetry(async () => {
			const r = await this.portfolio.getBalance();
			return r.data;
		});
	}

	getPositions(): Promise<unknown> {
		return this.withRetry(async () => {
			const r = await this.portfolio.getPositions();
			return r.data;
		});
	}

	getFills(opts: { ticker?: string; limit?: number } = {}): Promise<unknown> {
		return this.withRetry(async () => {
			const r = await this.portfolio.getFills(
				opts.ticker,
				undefined,
				undefined,
				undefined,
				opts.limit,
			);
			return r.data;
		});
	}

	getMarket(ticker: string): Promise<unknown> {
		return this.withRetry(async () => {
			const r = await this.market.getMarket(ticker);
			return r.data;
		});
	}

	listMarkets(opts: { limit?: number; cursor?: string } = {}): Promise<unknown> {
		return this.withRetry(async () => {
			// Signature: getMarkets(limit?, cursor?, eventTicker?, seriesTicker?,
			//   minCreatedTs?, maxCreatedTs?, minUpdatedTs?, maxCloseTs?,
			//   minCloseTs?, minSettledTs?, maxSettledTs?, status?, tickers?,
			//   mveFilter?, options?).
			const r = await this.market.getMarkets(opts.limit);
			return r.data;
		});
	}

	createOrderV2(body: CreateOrderV2Request): Promise<unknown> {
		return this.withRetry(async () => {
			const r = await this.orders.createOrderV2(body);
			return r.data;
		});
	}

	cancelOrderV2(orderId: string): Promise<unknown> {
		return this.withRetry(async () => {
			const r = await this.orders.cancelOrderV2(orderId);
			return r.data;
		});
	}

	getOrder(orderId: string): Promise<unknown> {
		return this.withRetry(async () => {
			const r = await this.orders.getOrder(orderId);
			return r.data;
		});
	}
}

// ─── axios error helpers ──────────────────────────────────────

function extractStatus(e: unknown): number | null {
	if (typeof e === "object" && e !== null) {
		const r = (e as { response?: { status?: number } }).response;
		if (typeof r?.status === "number") return r.status;
	}
	return null;
}

function extractBody(e: unknown): string {
	if (typeof e === "object" && e !== null) {
		const r = (e as { response?: { data?: unknown } }).response;
		if (r?.data !== undefined) {
			return typeof r.data === "string" ? r.data : JSON.stringify(r.data);
		}
	}
	return e instanceof Error ? e.message : String(e);
}

function extractUrl(e: unknown): string {
	if (typeof e === "object" && e !== null) {
		const cfg = (e as { config?: { url?: string } }).config;
		if (typeof cfg?.url === "string") return cfg.url;
	}
	return "(unknown)";
}
