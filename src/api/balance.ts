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
 */

import { DEFAULT_PRODUCTION_BASE, KalshiAPIError, KalshiClient } from "../kalshi/client.js";
import { KalshiCredentials } from "../kalshi/auth.js";

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
		const credentials = await KalshiCredentials.fromPem(keyId, pem);
		const client = new KalshiClient({
			baseUrl: env.KALSHI_BASE_URL ?? DEFAULT_PRODUCTION_BASE,
			credentials,
		});
		const b = await client.getBalance();
		// Kalshi returns `balance` and `portfolio_value` in
		// cents. `balance_dollars` is a string with 2
		// decimals (e.g., "9.73"). We convert cents back
		// to a string for consistency.
		const balanceCents = Math.round(b.balance);
		const portfolioCents = Math.round(b.portfolio_value);
		const balanceDollars = (balanceCents / 100).toFixed(2);
		const portfolioDollars = (portfolioCents / 100).toFixed(2);
		const result: BalanceResponse = {
			ok: true,
			balance_cents: balanceCents,
			balance_dollars: balanceDollars,
			portfolio_value_cents: portfolioCents,
			portfolio_value_dollars: portfolioDollars,
			updated_ts: b.updated_ts,
		};
		return Response.json(result, {
			headers: {
				"Cache-Control": "public, max-age=30",
			},
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const code = e instanceof KalshiAPIError ? e.status : 502;
		return Response.json(
			{
				ok: false,
				error: "kalshi_balance_failed",
				detail: msg.slice(0, 300),
			} satisfies BalanceError,
			{ status: code >= 400 && code < 600 ? code : 502 },
		);
	}
}
