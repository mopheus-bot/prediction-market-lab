/**
 * pm-bot — Kalshi WebSocket client.
 *
 * Mirrors `live/kalshi_ws.py`.
 *
 * The Kalshi WebSocket is a public-channel feed: real-time
 * orderbook deltas, trade prints, and market tickers. The
 * connection carries the same three KALSHI-ACCESS-* headers
 * as REST; the signed path is the literal WebSocket path
 * (`/trade-api/ws/v2`).
 *
 * **Channels (subscribe via `subscribe({channels, market_tickers})`):**
 *   - `orderbook_delta` — incremental orderbook updates
 *   - `ticker` — periodic market price summaries
 *   - `trade` — public trade prints
 *   - `fill` — your own order fills (private; auth required)
 *
 * **Hibernation:** the WS client itself is stateless — the
 * Durable Object in Chunk 3 wraps it. The DO calls
 * `state.acceptWebSocket()` to enable hibernation, and the
 * client just produces / consumes WebSocket events through
 * that interface.
 *
 * **Reconnection:** on unexpected close, the client retries with
 * exponential backoff (1s → 2s → 4s → ... → 30s cap). The caller
 * can cancel via the returned `close()` method.
 *
 * This module uses the standard `WebSocket` interface (Node 22+,
 * modern browsers, and CF Workers all support it).
 */

import type { KalshiCredentials } from "./auth.js";
import { buildAuthHeaders } from "./auth.js";

export const DEFAULT_PRODUCTION_WS = "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
export const DEFAULT_DEMO_WS = "wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2";

export interface KalshiWSOptions {
	url?: string;
	credentials?: KalshiCredentials;
	/** Auto-reconnect on close. Default true. */
	reconnect?: boolean;
	/** Max reconnect interval in ms. Default 30_000. */
	maxReconnectMs?: number;
	/** Optional hook for the WebSocket constructor (for testing). */
	WebSocketImpl?: typeof WebSocket;
}

export type WSMessageHandler = (msg: KalshiWSMessage) => void;
export type WSErrorHandler = (err: Error) => void;
export type WSCloseHandler = (code: number, reason: string) => void;
export type WSOpenHandler = () => void;

export interface SubscribeOptions {
	channels: WSChannel[];
	market_tickers?: string[];
}

export type WSChannel = "orderbook_delta" | "ticker" | "trade" | "fill";

// ─── Wire types (matches kalshi_ws.py docstring) ───────────────────────

export interface OrderbookSnapshot {
	type: "orderbook_snapshot";
	sid: number;
	seq: number;
	msg: {
		market_ticker: string;
		yes_dollars: [string, string][];
		no_dollars: [string, string][];
	};
}

export interface OrderbookDelta {
	type: "orderbook_delta";
	sid: number;
	seq: number;
	msg: {
		market_ticker: string;
		price: number; // cents
		price_dollars: string;
		delta: number;
		side: "yes" | "no";
		ts: string;
	};
}

export interface TradeMessage {
	type: "trade";
	seq: number;
	msg: {
		trade_id: string;
		market_ticker: string;
		yes_price_dollars: string;
		no_price_dollars: string;
		count: string;
		taker_side: "yes" | "no";
		ts: string;
	};
}

export interface TickerMessage {
	type: "ticker";
	seq: number;
	msg: {
		market_ticker: string;
		yes_bid_dollars: string;
		yes_ask_dollars: string;
		no_bid_dollars: string;
		no_ask_dollars: string;
		last_price_dollars: string;
		volume: string;
		open_interest: string;
	};
}

export interface FillMessage {
	type: "fill";
	seq: number;
	msg: Record<string, unknown>;
}

export interface SubscriptionAck {
	type: "subscribed";
	sid: number;
	msg?: Record<string, unknown>;
}

export interface ErrorMessage {
	type: "error";
	msg?: { code?: string; message?: string };
}

export type KalshiWSMessage =
	| OrderbookSnapshot
	| OrderbookDelta
	| TradeMessage
	| TickerMessage
	| FillMessage
	| SubscriptionAck
	| ErrorMessage
	| { type: string; seq?: number; sid?: number; msg?: unknown };

// ─── Client ─────────────────────────────────────────────────────────────

export class KalshiWSClient {
	private readonly url: string;
	private readonly credentials: KalshiCredentials | undefined;
	private readonly reconnect: boolean;
	private readonly maxReconnectMs: number;
	private readonly WebSocketImpl: typeof WebSocket;
	private ws: WebSocket | null = null;
	private sidCounter = 0;
	private closed = false;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	private onOpenHandler: WSOpenHandler | null = null;
	private onMessageHandler: WSMessageHandler | null = null;
	private onErrorHandler: WSErrorHandler | null = null;
	private onCloseHandler: WSCloseHandler | null = null;

	constructor(opts: KalshiWSOptions = {}) {
		this.url = opts.url ?? DEFAULT_PRODUCTION_WS;
		this.credentials = opts.credentials;
		this.reconnect = opts.reconnect ?? true;
		this.maxReconnectMs = opts.maxReconnectMs ?? 30_000;
		this.WebSocketImpl = opts.WebSocketImpl ?? globalThis.WebSocket;
	}

	// ─── lifecycle ───────────────────────────────────────────────

	onOpen(h: WSOpenHandler): void {
		this.onOpenHandler = h;
	}
	onMessage(h: WSMessageHandler): void {
		this.onMessageHandler = h;
	}
	onError(h: WSErrorHandler): void {
		this.onErrorHandler = h;
	}
	onClose(h: WSCloseHandler): void {
		this.onCloseHandler = h;
	}

	async connect(): Promise<void> {
		if (this.closed) throw new Error("KalshiWSClient is closed");
		if (this.ws) return; // already connected

		const headers: Record<string, string> = {};
		if (this.credentials) {
			// Sign the WebSocket path. Per Kalshi's spec, this is
			// the literal WebSocket path — same as the Python client.
			const auth = await buildAuthHeaders(
				this.credentials.privateKey,
				this.credentials.keyId,
				"GET",
				"/trade-api/ws/v2",
			);
			Object.assign(headers, auth);
		}

		// The standard WebSocket constructor in Node 22+ / Workers
		// accepts headers via the second arg.
		const ws = new this.WebSocketImpl(this.url, { headers } as unknown as string[]);
		this.ws = ws;

		ws.addEventListener("open", () => {
			this.reconnectAttempt = 0;
			this.onOpenHandler?.();
		});

		ws.addEventListener("message", (event: MessageEvent) => {
			const data = typeof event.data === "string" ? event.data : "";
			if (!data) return;
			try {
				const msg = JSON.parse(data) as KalshiWSMessage;
				this.onMessageHandler?.(msg);
			} catch (e) {
				this.onErrorHandler?.(e instanceof Error ? e : new Error(String(e)));
			}
		});

		ws.addEventListener("error", (event: Event) => {
			const err = new Error(
				(event as ErrorEvent).message || "WebSocket error",
			);
			this.onErrorHandler?.(err);
		});

		ws.addEventListener("close", (event: CloseEvent) => {
			this.onCloseHandler?.(event.code, event.reason);
			this.ws = null;
			if (this.reconnect && !this.closed) {
				this.scheduleReconnect();
			}
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		const delay = Math.min(
			1000 * 2 ** this.reconnectAttempt,
			this.maxReconnectMs,
		);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect().catch((e) => {
				this.onErrorHandler?.(e instanceof Error ? e : new Error(String(e)));
				if (!this.closed) this.scheduleReconnect();
			});
		}, delay);
	}

	close(): void {
		this.closed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.close(1000, "client_close");
			this.ws = null;
		}
	}

	// ─── messaging ───────────────────────────────────────────────

	subscribe(opts: SubscribeOptions): number {
		const sid = ++this.sidCounter;
		const msg = {
			id: sid,
			cmd: "subscribe",
			params: {
				channels: opts.channels,
				market_tickers: opts.market_tickers ?? [],
			},
		};
		this.send(msg);
		return sid;
	}

	unsubscribe(sid: number): void {
		this.send({ id: sid, cmd: "unsubscribe" });
	}

	private send(payload: unknown): void {
		if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
			throw new Error("WebSocket not open");
		}
		this.ws.send(JSON.stringify(payload));
	}

	// ─── accessors ────────────────────────────────────────────────

	get isConnected(): boolean {
		return this.ws !== null && this.ws.readyState === this.WebSocketImpl.OPEN;
	}

	/** Underlying socket — escape hatch for tests + DO integration. */
	get raw(): WebSocket | null {
		return this.ws;
	}
}
