/**
 * Smoke test: hit the Kalshi demo API with a TS-generated signature
 * and verify the server returns 200. This is the end-to-end test that
 * proves the auth works for real — beyond unit tests.
 *
 * Run:  node scripts/smoke-demo-auth.mjs
 *
 * Requires Kalshi DEMO credentials, which are deliberately not committed:
 *   KALSHI_DEMO_KEY_ID            — your demo key id
 *   KALSHI_DEMO_PRIVATE_KEY_PATH  — path to a PKCS#8 PEM for that key
 * Sign up for a demo account at https://demo.kalshi.co
 */
import { readFileSync, readFileSync as read } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PEM_PATH =
	process.env.KALSHI_DEMO_PRIVATE_KEY_PATH ??
	join(__dirname, "..", "test", "fixtures", "kalshi-demo.pkcs8.pem");
const PKCS8_PEM = readFileSync(PEM_PATH, "utf8");
const KEY_ID = process.env.KALSHI_DEMO_KEY_ID || (() => {
	const id = readFileSync(
		process.env.HOME + "/keys/kalshi-demo-keyid.txt",
		"utf8",
	).trim();
	return id;
})();

const BASE = "https://demo-api.kalshi.co/trade-api/v2";
// Kalshi's auth spec: the SIGNED path includes the full URL path
// from the root — `/trade-api/v2/portfolio/balance`, not just
// `/portfolio/balance`. The base URL has the `/trade-api/v2`
// prefix, so when we hit `BASE + path`, the actual HTTP path is
// `<prefix><path>`. We sign the full path.
const PATH_PREFIX = "/trade-api/v2";

// Helper: import the PKCS#8 PEM as a non-extractable CryptoKey.
async function loadKey() {
	const stripped = PKCS8_PEM
		.replace(/-----BEGIN [^-]+-----/g, "")
		.replace(/-----END [^-]+-----/g, "")
		.replace(/\s+/g, "");
	const bin = Buffer.from(stripped, "base64");
	return await crypto.subtle.importKey(
		"pkcs8",
		bin,
		{ name: "RSA-PSS", hash: "SHA-256" },
		false,
		["sign"],
	);
}

async function signRequest(key, ts, method, path) {
	const pathOnly = path.split("?")[0];
	const msg = new TextEncoder().encode(`${ts}${method.toUpperCase()}${pathOnly}`);
	const sig = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, msg);
	return Buffer.from(sig).toString("base64");
}

async function authedFetch(key, method, path) {
	const ts = String(Date.now());
	// Sign the FULL path including the /trade-api/v2 prefix.
	const sig = await signRequest(key, ts, method, PATH_PREFIX + path);
	const headers = {
		"KALSHI-ACCESS-KEY": KEY_ID,
		"KALSHI-ACCESS-TIMESTAMP": ts,
		"KALSHI-ACCESS-SIGNATURE": sig,
		"Content-Type": "application/json",
	};
	const res = await fetch(BASE + path, { method, headers });
	return { status: res.status, body: await res.text() };
}

async function main() {
	console.log(`Using key id: ${KEY_ID.slice(0, 8)}…`);
	const key = await loadKey();

	// 1. Public endpoint (no auth) — should return 200 even without
	//    a valid signature. Smoke-test the connection.
	const publicRes = await fetch(BASE + "/markets?limit=2");
	console.log(`\n[public] GET /markets?limit=2 → ${publicRes.status}`);
	if (publicRes.status !== 200) {
		console.log("  body:", (await publicRes.text()).slice(0, 200));
		return;
	}
	const publicJson = await publicRes.json();
	console.log(`  ${publicJson.markets?.length ?? 0} markets returned`);

	// 2. Authed endpoint (portfolio balance) — the one that needs
	//    valid signatures. The whole point of this test.
	const bal = await authedFetch(key, "GET", "/portfolio/balance");
	console.log(`\n[authed] GET /portfolio/balance → ${bal.status}`);
	console.log(`  body: ${bal.body.slice(0, 300)}`);

	// 3. Authed endpoint (positions) — another sanity check.
	const pos = await authedFetch(key, "GET", "/portfolio/positions");
	console.log(`\n[authed] GET /portfolio/positions → ${pos.status}`);
	console.log(`  body: ${pos.body.slice(0, 300)}`);

	// Verdict
	const allOk = publicRes.status === 200 && bal.status === 200 && pos.status === 200;
	console.log(`\n${allOk ? "✅ ALL ENDPOINTS OK — auth is correct end-to-end": "❌ ONE OR MORE FAILED"}`);
	process.exit(allOk ? 0: 1);
}

main().catch((e) => {
	console.error("smoke run crashed:", e);
	process.exit(2);
});
