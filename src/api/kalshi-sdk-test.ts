/**
 * prediction-market-lab — kalshi-typescript SDK smoke test.
 *
 * Calls `getBalance` + `getPositions` on the Kalshi demo
 * endpoint via the SDK adapter and returns the raw response.
 * This is the runtime test for whether axios + the SDK
 * (with `nodejs_compat`) actually work in CF Workers.
 *
 * **Why demo, not prod:** this endpoint exists primarily
 * to verify the SDK works; demo creds are always available
 * and there are no side effects.
 *
 * **Why GET, not POST:** the operator runs this from a
 * browser tab; no body needed.
 */

import { KalshiSdkClient } from "../kalshi/sdk-adapter.js";
import { loadPrivateKey } from "../kalshi/auth.js";

export interface KalshiSdkTestEnv {
	KALSHI_DEMO_KEY_ID?: string;
	KALSHI_DEMO_PRIVATE_KEY?: string;
}

export async function handleKalshiSdkTest(env: KalshiSdkTestEnv): Promise<Response> {
	if (!env.KALSHI_DEMO_KEY_ID || !env.KALSHI_DEMO_PRIVATE_KEY) {
		return Response.json(
			{
				ok: false,
				error: "missing_demo_creds",
				message: "KALSHI_DEMO_KEY_ID and KALSHI_DEMO_PRIVATE_KEY must be set",
			},
			{ status: 500 },
		);
	}
	try {
		// We need BOTH the parsed CryptoKey (for the
		// KalshiCredentials object) and the raw PEM (for
		// the SDK adapter). loadPrivateKey returns a
		// CryptoKey, but the SDK wants a PEM string.
		const pem = env.KALSHI_DEMO_PRIVATE_KEY;
		const pk = await loadPrivateKey(pem);
		// Lazy-import the credentials to avoid the
		// class constructor's no-empty-keyId check.
		const { KalshiCredentials } = await import("../kalshi/auth.js");
		const creds = new KalshiCredentials(env.KALSHI_DEMO_KEY_ID, pk);

		const client = new KalshiSdkClient({
			creds,
			privateKeyPem: pem,
			env: "demo",
			requestsPerSecond: 0, // smoke test — no throttle
		});

		const t0 = Date.now();
		const balance = await client.getBalance();
		const tBalance = Date.now() - t0;

		const t1 = Date.now();
		const positions = await client.getPositions();
		const tPositions = Date.now() - t1;

		return Response.json({
			ok: true,
			sdk: "kalshi-typescript@3.26.0",
			balance: balance,
			positions: positions,
			latency_ms: { balance: tBalance, positions: tPositions },
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message: String(e);
		const stack = e instanceof Error ? e.stack: undefined;
		return Response.json(
			{
				ok: false,
				error: "sdk_call_failed",
				message: msg.slice(0, 1000),
				stack: stack?.slice(0, 1500),
			},
			{ status: 500 },
		);
	}
}
