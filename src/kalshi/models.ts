/**
 * pm-bot — Kalshi wire-format types.
 *
 * Mirrors the Pydantic models in
 * live/models.py
 * (KalshiEvent, KalshiMarket, KalshiOrderbook, KalshiTrade).
 *
 * Kalshi returns numbers as **decimal strings** (fixed-point precision).
 * We parse to cents (integer) at the model boundary — the engine
 * uses cents internally, never floats for prices.
 *
 * Fields ending in `_dollars` on the wire are `dollars: number` on
 * the model. Use the `_cents` getters for integer-cents.
 */

export interface KalshiMarketWire {
	ticker: string;
	event_ticker: string;
	market_type?: string;
	title?: string;
	sub_title?: string;
	status?: string;
	last_price_dollars?: string;
	yes_bid_dollars?: string;
	yes_ask_dollars?: string;
	no_bid_dollars?: string;
	no_ask_dollars?: string;
	previous_price_dollars?: string;
	previous_yes_bid_dollars?: string;
	previous_yes_ask_dollars?: string;
	open_interest?: string | number;
	volume?: string | number;
	volume_24h?: string | number;
	liquidity_dollars?: string | number;
	close_time?: string;
	open_time?: string;
	expiration_time?: string;
	[key: string]: unknown;
}

export interface KalshiMarket {
	ticker: string;
	event_ticker: string;
	market_type: string;
	title: string;
	sub_title: string;
	status: string;
	last_price_cents: number;
	yes_bid_cents: number;
	yes_ask_cents: number;
	no_bid_cents: number;
	no_ask_cents: number;
	previous_price_cents: number;
	open_interest: number;
	volume: number;
	volume_24h: number;
	liquidity_cents: number;
	close_time: string | null;
	open_time: string | null;
	expiration_time: string | null;
}

export function parseMarket(wire: KalshiMarketWire | Record<string, unknown>): KalshiMarket {
	const w = wire as Record<string, unknown>;
	return {
		ticker: String(w.ticker ?? ""),
		event_ticker: String(w.event_ticker ?? ""),
		market_type: String(w.market_type ?? "binary"),
		title: String(w.title ?? ""),
		sub_title: String(w.sub_title ?? ""),
		status: String(w.status ?? "open"),
		last_price_cents: toCents(w.last_price_dollars),
		yes_bid_cents: toCents(w.yes_bid_dollars),
		yes_ask_cents: toCents(w.yes_ask_dollars),
		no_bid_cents: toCents(w.no_bid_dollars),
		no_ask_cents: toCents(w.no_ask_dollars),
		previous_price_cents: toCents(w.previous_price_dollars),
		open_interest: toNum(w.open_interest),
		volume: toInt(w.volume),
		volume_24h: toNum(w.volume_24h),
		liquidity_cents: toCents(w.liquidity_dollars),
		close_time: w.close_time ? String(w.close_time) : null,
		open_time: w.open_time ? String(w.open_time) : null,
		expiration_time: w.expiration_time ? String(w.expiration_time) : null,
	};
}

export function midCents(m: KalshiMarket): number {
	if (m.yes_bid_cents > 0 && m.yes_ask_cents > 0) {
		return Math.round((m.yes_bid_cents + m.yes_ask_cents) / 2);
	}
	if (m.last_price_cents > 0) return m.last_price_cents;
	return 50;
}

export function spreadCents(m: KalshiMarket): number {
	if (m.yes_bid_cents > 0 && m.yes_ask_cents > 0) {
		return m.yes_ask_cents - m.yes_bid_cents;
	}
	return 0;
}

// ─── Orderbook ───────────────────────────────────────────────────────────

export interface KalshiOrderbookLevelWire {
	price_dollars: string;
	count: string;
}

export interface KalshiOrderbookLevel {
	price_cents: number;
	count: number;
}

export interface KalshiOrderbook {
	ticker: string;
	yes_levels: KalshiOrderbookLevel[];
	no_levels: KalshiOrderbookLevel[];
}

export interface KalshiOrderbookEnvelope {
	orderbook_fp?: {
		yes_dollars?: string[][];
		no_dollars?: string[][];
		yes?: string[][];
		no?: string[][];
	};
	yes?: string[][];
	no?: string[][];
	yes_dollars?: string[][];
	no_dollars?: string[][];
}

export function parseOrderbook(
	ticker: string,
	wire: KalshiOrderbookEnvelope | Record<string, unknown>,
): KalshiOrderbook {
	const w = wire as Record<string, unknown>;
	const ob = (w.orderbook_fp ?? w) as Record<string, unknown>;
	const yesWire =
		(ob.yes_dollars as string[][] | undefined) ??
		(ob.yes as string[][] | undefined) ??
		[];
	const noWire =
		(ob.no_dollars as string[][] | undefined) ??
		(ob.no as string[][] | undefined) ??
		[];

	const yes_levels: KalshiOrderbookLevel[] = yesWire.map((pair) => ({
		price_cents: toCents(pair[0]),
		count: toNum(pair[1]),
	}));
	const no_levels: KalshiOrderbookLevel[] = noWire.map((pair) => ({
		price_cents: toCents(pair[0]),
		count: toNum(pair[1]),
	}));

	return { ticker, yes_levels, no_levels };
}

export function bestYesBidCents(ob: KalshiOrderbook): number | null {
	if (ob.yes_levels.length === 0) return null;
	return Math.max(...ob.yes_levels.map((l) => l.price_cents));
}

export function bestNoBidCents(ob: KalshiOrderbook): number | null {
	if (ob.no_levels.length === 0) return null;
	return Math.max(...ob.no_levels.map((l) => l.price_cents));
}

export function yesAskCents(ob: KalshiOrderbook): number | null {
	const no = bestNoBidCents(ob);
	return no === null ? null : 100 - no;
}

export function noAskCents(ob: KalshiOrderbook): number | null {
	const yes = bestYesBidCents(ob);
	return yes === null ? null : 100 - yes;
}

export function orderbookMidCents(ob: KalshiOrderbook): number | null {
	const yb = bestYesBidCents(ob);
	const ya = yesAskCents(ob);
	if (yb === null || ya === null) return null;
	return Math.round((yb + ya) / 2);
}

// ─── Trade ───────────────────────────────────────────────────────────────

export interface KalshiTradeWire {
	trade_id: string;
	ticker: string;
	yes_price_dollars: string;
	no_price_dollars: string;
	count: string | number;
	count_fp?: string | number;
	created_time: string;
	taker_side?: string;
	is_block_trade?: boolean;
	[key: string]: unknown;
}

export interface KalshiTrade {
	trade_id: string;
	ticker: string;
	yes_price_cents: number;
	no_price_cents: number;
	count: number;
	created_at: string; // RFC 3339
	taker_side: string;
	is_block_trade: boolean;
	created_at_unix_ms: number;
}

export function parseTrade(wire: KalshiTradeWire | Record<string, unknown>): KalshiTrade {
	const w = wire as Record<string, unknown>;
	const count = w.count ?? w.count_fp ?? "0";
	const created = String(w.created_time ?? "");
	return {
		trade_id: String(w.trade_id ?? ""),
		ticker: String(w.ticker ?? ""),
		yes_price_cents: toCents(w.yes_price_dollars),
		no_price_cents: toCents(w.no_price_dollars),
		count: toNum(count),
		created_at: created,
		taker_side: String(w.taker_side ?? "yes"),
		is_block_trade: Boolean(w.is_block_trade ?? false),
		created_at_unix_ms: parseRfc3339ToUnixMs(created),
	};
}

export interface KalshiEventWire {
	event_ticker: string;
	title: string;
	category?: string;
	sub_title?: string;
	series_ticker?: string;
	status?: string;
	markets?: KalshiMarketWire[];
	[key: string]: unknown;
}

export interface KalshiEvent {
	event_ticker: string;
	title: string;
	category: string;
	sub_title: string;
	series_ticker: string | null;
	status: string;
	markets: KalshiMarket[];
}

export function parseEvent(wire: KalshiEventWire | Record<string, unknown>): KalshiEvent {
	const w = wire as Record<string, unknown>;
	const markets = Array.isArray(w.markets)
		? (w.markets as KalshiMarketWire[]).map(parseMarket)
		: [];
	return {
		event_ticker: String(w.event_ticker ?? ""),
		title: String(w.title ?? ""),
		category: String(w.category ?? ""),
		sub_title: String(w.sub_title ?? ""),
		series_ticker: w.series_ticker ? String(w.series_ticker) : null,
		status: String(w.status ?? "open"),
		markets,
	};
}

// ─── Helpers ────────────────────────────────────────────────────────────

function toCents(v: unknown): number {
	if (v === null || v === undefined || v === "") return 0;
	const n = typeof v === "number" ? v : parseFloat(String(v));
	if (Number.isNaN(n)) return 0;
	return Math.round(n * 100);
}

function toNum(v: unknown): number {
	if (v === null || v === undefined || v === "") return 0;
	const n = typeof v === "number" ? v : parseFloat(String(v));
	if (Number.isNaN(n)) return 0;
	return n;
}

function toInt(v: unknown): number {
	if (v === null || v === undefined || v === "") return 0;
	const n = typeof v === "number" ? v : parseInt(String(v), 10);
	if (Number.isNaN(n)) return 0;
	return n;
}

/**
 * Parse an RFC 3339 timestamp to unix milliseconds.
 * Handles the "Z" suffix and variable-precision fractional seconds
 * (Kalshi's live API uses 5-digit fractional seconds, e.g. .87086).
 */
export function parseRfc3339ToUnixMs(s: string): number {
	if (!s) return 0;
	// Normalize "Z" to "+00:00" for Date constructor compatibility
	const normalized = s.endsWith("Z") ? s.slice(0, -1) + "+00:00" : s;
	const ms = Date.parse(normalized);
	return Number.isNaN(ms) ? 0 : ms;
}
