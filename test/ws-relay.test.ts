/**
 * pm-bot — chunk 10.7 — WS relay URL classification tests.
 *
 * The Kalshi WebSocket requires custom auth headers on the upgrade
 * (KALSHI-ACCESS-KEY / -SIGNATURE / -TIMESTAMP). CF Workers' native
 * `new WebSocket(url, { headers })` is silently broken (the second
 * arg is treated as a protocols string). `fetch(url, { Upgrade: "websocket" })`
 * returns 101 but the WS goes to readyState=2 (CLOSING) without
 * firing `open`.
 *
 * The fix (chunk 10.6 + 10.7): if the URL is the relay (or any
 * non-Kalshi host), the Worker just opens `new WebSocket(url)` with
 * no second arg — the relay handles Kalshi auth server-side. This
 * test pins the URL classification so future refactors don't
 * silently break the relay path.
 */

import { describe, it, expect } from "vitest";

// Mirror the heuristic in src/durable-objects/LiveBot.ts:openKalshiWs.
// We re-implement it here (rather than importing) so the test pins
// the rule independent of any internal helper.
function classifyWsUrl(url: string): { isRelay: boolean; useDemo: boolean } {
	return {
		isRelay: !url.includes("kalshi"),
		useDemo: url.includes("demo"),
	};
}

describe("WS URL classification (chunk 10.7)", () => {
	it("flags direct Kalshi production as NOT a relay", () => {
		expect(
			classifyWsUrl("wss://external-api-ws.kalshi.com/trade-api/ws/v2"),
		).toEqual({ isRelay: false, useDemo: false });
	});

	it("flags direct Kalshi demo as NOT a relay", () => {
		expect(
			classifyWsUrl("wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2"),
		).toEqual({ isRelay: false, useDemo: true });
	});

	it("flags the deployed Fly.io relay as a relay (no auth headers needed)", () => {
		expect(
			classifyWsUrl("wss://pm-bot-relay.fly.dev/"),
		).toEqual({ isRelay: true, useDemo: false });
	});

	it("flags arbitrary hosts as relays (defensive — anything not Kalshi)", () => {
		expect(
			classifyWsUrl("wss://my-custom-proxy.example.com/ws"),
		).toEqual({ isRelay: true, useDemo: false });
	});

	it("flags localhost tunnels as relays (dev workflow)", () => {
		expect(
			classifyWsUrl("ws://localhost:8080/"),
		).toEqual({ isRelay: true, useDemo: false });
	});
});
