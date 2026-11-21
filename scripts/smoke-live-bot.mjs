#!/usr/bin/env node
/**
 * prediction-market-lab — live bot DO smoke test.
 *
 * Run after `npm run deploy` to verify the bot DO is wired correctly
 * end-to-end against the deployed Worker. Hits the public endpoints
 * (the CF Access auth sits in front, so this is meant to run from a
 * machine with an active CF Access session — e.g. with a
 * `--header "Cookie: CF_Authorization=..."` for testing).
 *
 * Usage:
 *   BOT_URL=https:// node scripts/smoke-live-bot.mjs
 *   BOT_URL=http://localhost:8787 node scripts/smoke-live-bot.mjs   # wrangler dev
 *
 * Checks:
 *   1. /api/pm/bot/status returns a JSON body with the default state.
 *   2. /api/pm/bot/start accepts a config JSON and persists it.
 *   3. /api/pm/bot/status reflects the new config.
 *   4. /api/pm/bot/stop clears the alarm.
 *
 * This script does NOT exercise the live Kalshi WS connection — that
 * requires demo creds + an actual WS roundtrip, which `smoke-demo-ws.mjs`
 * already covers for the WS client itself.
 */

import process from "node:process";

const BOT_URL = process.env.BOT_URL ?? "http://localhost:8787";

async function get(path) {
	const r = await fetch(`${BOT_URL}${path}`, { method: "GET" });
	const text = await r.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: r.status, body };
}

async function post(path, json) {
	const r = await fetch(`${BOT_URL}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(json),
	});
	const text = await r.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: r.status, body };
}

let failures = 0;
function check(label, cond, detail) {
	if (cond) {
		console.log(`  ✓ ${label}`);
	} else {
		console.error(`  ✘ ${label}${detail ? `: ${JSON.stringify(detail)}`: ""}`);
		failures += 1;
	}
}

console.log(`[smoke-live-bot] target: ${BOT_URL}`);

// 1. /status baseline
{
	const r = await get("/api/pm/bot/status");
	check("status 200", r.status === 200, r);
	check("status ok=true", r.body?.ok === true, r.body);
	check("status connected=false (no /start yet)", r.body?.connected === false, r.body);
	check("status has counts", typeof r.body?.counts === "object", r.body?.counts);
}

// 2. /start with a config
{
	const r = await post("/api/pm/bot/start", {
		tickers: ["KXWARMING-50"],
		ticker_verticals: { "KXWARMING-50": "weather" },
		bankroll_cents: 250_000,
	});
	check("start 200", r.status === 200, r);
	check("start ok=true", r.body?.ok === true, r.body);
}

// 3. /status reflects the new config
{
	const r = await get("/api/pm/bot/status");
	check("status 200 (post-start)", r.status === 200, r);
	const cfg = r.body?.config;
	check("config has bankroll_cents=250000", cfg?.bankroll_cents === 250_000, cfg);
	check("config has 1 ticker", Array.isArray(cfg?.tickers) && cfg.tickers.length === 1, cfg);
	check("config has tickers=[KXWARMING-50]", cfg?.tickers?.[0] === "KXWARMING-50", cfg);
}

// 4. /stop
{
	const r = await post("/api/pm/bot/stop", {});
	check("stop 200", r.status === 200, r);
	check("stop ok=true", r.body?.ok === true, r.body);
}

if (failures > 0) {
	console.error(`[smoke-live-bot] ${failures} check(s) failed.`);
	process.exit(1);
}
console.log("[smoke-live-bot] all checks passed.");
