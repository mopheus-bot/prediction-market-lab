/**
 * Smoke test: hit the Kalshi demo API with the TS REST client.
 *
 * Verifies the public + authed endpoints parse correctly into
 * the typed models. Run with:
 *   node scripts/smoke-demo-rest.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { KalshiClient, DEFAULT_DEMO_BASE, KalshiCredentials, midCents, spreadCents, bestYesBidCents, orderbookMidCents } from "../dist-tsc/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PEM_PATH =
	process.env.KALSHI_DEMO_PRIVATE_KEY_PATH ??
	join(__dirname, "..", "test", "fixtures", "kalshi-demo.pkcs8.pem");
const PKCS8_PEM = readFileSync(PEM_PATH, "utf8");
const KEY_ID = readFileSync(process.env.HOME + "/keys/kalshi-demo-keyid.txt", "utf8").trim();

const creds = await KalshiCredentials.fromPem(KEY_ID, PKCS8_PEM);
const client = new KalshiClient({ baseUrl: DEFAULT_DEMO_BASE, credentials: creds });

async function main() {
	console.log(`Using key id: ${KEY_ID.slice(0, 8)}…\n`);

	// 1. Public — list open markets (first 5)
	console.log("=== public: list_markets ===");
	const { markets, cursor } = await client.listMarkets({ limit: 5 });
	console.log(`  Got ${markets.length} markets (cursor: ${cursor ?? "none"})`);
	for (const m of markets.slice(0, 3)) {
		console.log(`  - ${m.ticker}  mid=${midCents(m)}c  spread=${spreadCents(m)}c  vol24h=${m.volume_24h}  status=${m.status}`);
	}
	if (markets.length === 0) {
		throw new Error("expected at least one open market in demo");
	}

	// 2. Public — get a specific market
	const ticker = markets[0].ticker;
	console.log(`\n=== public: get_market(${ticker}) ===`);
	const m = await client.getMarket(ticker);
	console.log(`  ${m.ticker}  yes_bid=${m.yes_bid_cents}c  yes_ask=${m.yes_ask_cents}c  vol24h=${m.volume_24h}`);
	if (m.ticker !== ticker) throw new Error(`get_market returned ${m.ticker}, expected ${ticker}`);

	// 3. Public — orderbook snapshot
	console.log(`\n=== public: get_orderbook(${ticker}) ===`);
	const ob = await client.getOrderbook(ticker);
	console.log(`  yes_levels: ${ob.yes_levels.length}, no_levels: ${ob.no_levels.length}`);
	const yb = bestYesBidCents(ob);
	const mid = orderbookMidCents(ob);
	console.log(`  best_yes_bid=${yb}c  mid=${mid}c`);

	// 4. Public — recent trades for this ticker
	console.log(`\n=== public: list_trades(${ticker}, limit=5) ===`);
	const { trades } = await client.listTrades({ ticker, limit: 5 });
	console.log(`  Got ${trades.length} trades`);
	for (const t of trades.slice(0, 3)) {
		console.log(`  - ${t.trade_id.slice(0, 12)}  yes=${t.yes_price_cents}c  count=${t.count}  ${t.created_at}`);
	}

	// 5. Authed — balance
	console.log(`\n=== authed: get_balance ===`);
	const bal = await client.getBalance();
	console.log(`  balance=${bal.balance}  portfolio_value=${bal.portfolio_value}  updated_ts=${bal.updated_ts}`);

	// 6. Authed — positions
	console.log(`\n=== authed: get_positions ===`);
	const pos = await client.getPositions();
	console.log(`  market_positions: ${pos.market_positions.length}  event_positions: ${pos.event_positions.length}`);

	// 7. Authed — orders
	console.log(`\n=== authed: get_orders ===`);
	const ords = await client.getOrders();
	console.log(`  orders: ${ords.orders.length}`);

	console.log("\n✅ ALL REST ENDPOINTS OK");
}

main().catch((e) => {
	console.error("smoke run crashed:", e);
	process.exit(1);
});
