/**
 * pm-bot — Kalshi account balance endpoint.
 *
 * Returns the live Kalshi account balance (in cents +
 * formatted dollars) so the dashboard can show "Account
 * balance: $X.XX" in the trading-mode panel and the
 * go-live confirmation modal. Auth is via the
 * KALSHI_PROD_* secrets — same creds the bot uses when
 * going live.
 *
 * Caching: 30s. The balance can change between requests
 * (open positions move value) but it doesn't change
 * second-to-second, so a 30s cache keeps the dashboard
 * snappy without burning the Kalshi rate limit.
 *
 * Chunk 10.8c: uses the kalshi-typescript SDK adapter
 * (axios + Node crypto + retries) instead of the
 * hand-rolled client. Same auth, same response shape,
 * built-in 5xx/429 retry with exponential backoff.
 */

import { KalshiSdkClient } from "../kalshi/sdk-adapter.js";
import { loadPrivateKey } from "../kalshi/auth.js";

export interface BalanceEnv {
	KALSHI_PROD_KEY_ID?: string;
	KALSHI_PROD_PRIVATE_KEY?: string;
	// Override the base URL for testing against demo.
	KALSHI_BASE_URL?: string;
}

export interface BalanceResponse {
	ok: true;
	balance_cents: number;
	balance_dollars: string;
	portfolio_value_cents: number;
	portfolio_value_dollars: string;
	updated_ts: number;
}

export interface BalanceError {
	ok: false;
	error: string;
	detail?: string;
}

export type BalanceResult = BalanceResponse | BalanceError;

export async function handleBotBalance(
	env: BalanceEnv,
	_url: URL,
): Promise<Response> {
	const keyId = env.KALSHI_PROD_KEY_ID;
	const pem = env.KALSHI_PROD_PRIVATE_KEY;
	if (!keyId || !pem) {
		return Response.json(
			{
				ok: false,
				error: "missing_credentials",
				detail: "KALSHI_PROD_KEY_ID and KALSHI_PROD_PRIVATE_KEY must be set",
			} satisfies BalanceError,
			{ status: 503 },
		);
	}
	try {
		// Lazy-import the credentials class (avoids pulling
		// it into bundles that don't need it).
		const { KalshiCredentials } = await import("../kalshi/auth.js");
		const pk = await loadPrivateKey(pem);
		const credentials = new KalshiCredentials(keyId, pk);
		const useDemo = (env.KALSHI_BASE_URL ?? "").includes("demo");
		const client = new KalshiSdkClient({
			creds: credentials,
			privateKeyPem: pem,
			env: useDemo ? "demo" : "prod",
			requestsPerSecond: 0, // one-shot — no throttle
		});
		const data = (await client.getBalance()) as {
			balance: number;
			portfolio_value: number;
			updated_ts: number;
			balance_dollars?: string;
		};
		// Kalshi returns `balance` and `portfolio_value` in
		// cents. `balance_dollars` is a string with 2
		// decimals (e.g., "9.73"). We convert cents back
		// to a string for consistency.
		const balanceCents = Math.round(data.balance);
		const portfolioCents = Math.round(data.portfolio_value);
		const balanceDollars = (balanceCents / 100).toFixed(2);
		const portfolioDollars = (portfolioCents / 100).toFixed(2);
		const result: BalanceResponse = {
			ok: true,
			balance_cents: balanceCents,
			balance_dollars: balanceDollars,
			portfolio_value_cents: portfolioCents,
			portfolio_value_dollars: portfolioDollars,
			updated_ts: data.updated_ts,
		};
		return Response.json(result, {
			headers: {
				// Real-time (changes on every fill). 2026-08-11: was
				// `public, max-age=30` which lagged the hero behind
				// the stage panel + signals.
				"Cache-Control": "no-store",
			},
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return Response.json(
			{
				ok: false,
				error: "kalshi_balance_failed",
				detail: msg.slice(0, 300),
			} satisfies BalanceError,
			{ status: 502 },
		);
	}
}
