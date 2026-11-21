/**
 * Smoke test: connect to Kalshi demo WebSocket, subscribe to
 * orderbook_delta for one ticker, and verify at least one
 * frame arrives within 10 seconds.
 *
 * Run:  node scripts/smoke-demo-ws.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
	KalshiWSClient,
	DEFAULT_DEMO_WS,
	KalshiCredentials,
} from "../dist-tsc/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PEM_PATH =
	process.env.KALSHI_DEMO_PRIVATE_KEY_PATH ??
	join(__dirname, "..", "test", "fixtures", "kalshi-demo.pkcs8.pem");
const PKCS8_PEM = readFileSync(PEM_PATH, "utf8");
const KEY_ID = readFileSync(process.env.HOME + "/keys/kalshi-demo-keyid.txt", "utf8").trim();

const creds = await KalshiCredentials.fromPem(KEY_ID, PKCS8_PEM);
const client = new KalshiWSClient({ url: DEFAULT_DEMO_WS, credentials: creds });

let openAt = 0;
let received = 0;
let firstFrameType = null;
let subscribedSid = null;

client.onOpen(() => {
	openAt = Date.now();
	console.log(`[+] WS open @ ${new Date(openAt).toISOString()}`);
	subscribedSid = client.subscribe({
		channels: ["orderbook_delta", "ticker"],
		market_tickers: ["KXRAINSHARD2-26AUG09-SFO"],
	});
	console.log(`    subscribed (sid=${subscribedSid}) to orderbook_delta + ticker`);
});

client.onMessage((msg) => {
	received += 1;
	if (firstFrameType === null) {
		firstFrameType = msg.type;
		console.log(`[msg] first frame: type=${msg.type} (after ${Date.now() - openAt}ms)`);
	}
	// Print a few more to confirm the stream is alive.
	if (received <= 5) {
		const summary =
			msg.type === "orderbook_delta"
				? `delta ${msg.msg?.market_ticker} ${msg.msg?.side}@${msg.msg?.price}c qty=${msg.msg?.delta}`
				: msg.type === "ticker"
					? `ticker ${msg.msg?.market_ticker} yes_bid=${msg.msg?.yes_bid_dollars}`
					: msg.type;
		console.log(`[msg #${received}] ${msg.type} ${summary}`);
	}
});

client.onError((err) => {
	console.error(`[!] WS error: ${err.message}`);
});

client.onClose((code, reason) => {
	console.log(`[-] WS close: ${code} ${reason}`);
});

await client.connect();

// Wait up to 12 seconds for at least 2 messages
const deadline = Date.now() + 12_000;
while (Date.now() < deadline && received < 2) {
	await new Promise((r) => setTimeout(r, 100));
}

console.log(`\nReceived ${received} frame(s) in ${Date.now() - openAt}ms`);
console.log(`First frame type: ${firstFrameType}`);

client.close();

if (received < 2) {
	console.error("❌ Expected at least 2 frames, got", received);
	process.exit(1);
}
console.log("✅ WS smoke test passed");
