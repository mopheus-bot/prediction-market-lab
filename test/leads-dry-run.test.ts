/**
 * pm-bot — leads-cron DRY-RUN test (2026-08-09+).
 *
 * Exercises the same buildPrompt + chat() + parseLlmResponse +
 * validateAndDedupe pipeline that runLeadsCron uses, but:
 *   - reads bot state from a hard-coded constant (not the DO)
 *   - fetches a real Kalshi scout snapshot (so the LLM prompt
 *     is constrained to actually-existing tickers, not
 *     hallucinations)
 *   - prints the prompt + parsed + validated output to stdout
 *   - does NOT write to D1 / does NOT touch the bot
 *
 * **The point:** preview what the LLM will produce with the
 * 2026-08-09 restructured prompt + Kalshi scout, BEFORE
 * redeploying. The user can review the output and sign off
 * (or ask for prompt tweaks) without a full prod cycle.
 *
 * **Cron cadence (2026-08-09):** leads runs every 6h +30min
 * (00:30/06:30/12:30/18:30 UTC), offset from news so the LLM
 * has fresh news data to weigh against. Each new run supersedes
 * the prior `pending` suggestions before inserting.
 *
 * **How to run:**
 *   # Stub mode (no MMX key — shows the prompt only):
 *   npx vitest run --project unit test/leads-dry-run.test.ts
 *
 *   # Real LLM mode (needs MMX_API_KEY in env):
 *   MMX_API_KEY=sk-... npx vitest run --project unit test/leads-dry-run.test.ts
 *
 * **2026-08-09+: the scout requires KALSHI_DEMO creds** to fetch
 * the real market list. The test reads them from ~/keys/ if env
 * is not set. Without Kalshi creds the test still runs (in
 * "unfiltered" mode — the LLM gets no market list and is more
 * likely to hallucinate, which is the OLD behavior).
 *
 * **What "good" output looks like:**
 *   - 4-6 ADD suggestions, spread across all 4 verticals
 *     (weather / economic / politics / sports)
 *   - All ADD tickers appear in the real Kalshi market snapshot
 *     (no `unverified` warnings)
 *   - Each suggestion has fit / edge / risk reasoning
 *   - 0-2 DROP suggestions (often 0 — silence is honest)
 *   - Tickers all match the long UUID-style format Kalshi uses
 *     (the only short ticker is KXWARMING-50)
 *   - No "validators excluded" warnings that suggest the
 *     LLM is hallucinating format
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPrivateKey } from "node:crypto";
import { chat, DEFAULT_MODEL } from "../src/llm/index.js";
import {
	SYSTEM_PROMPT,
	buildPromptForDryRun,
	parseLlmResponse,
	validateAndDedupe,
	type BotState,
	type TickerStats,
} from "../src/cron/leads-cron.js";
import {
	fetchAndFilterMarkets,
	formatScoutForPrompt,
	type ScoutResult,
} from "../src/kalshi/leads-scout.js";
import { KalshiClient, DEFAULT_PRODUCTION_BASE } from "../src/kalshi/client.js";
import { KalshiCredentials, loadPrivateKey } from "../src/kalshi/auth.js";

function readKalshiCreds(): { keyId: string; pem: string } | null {
	const keyFromEnv = process.env.KALSHI_PROD_KEY_ID ?? process.env.KALSHI_DEMO_KEY_ID;
	const pemFromEnv = process.env.KALSHI_PROD_PRIVATE_KEY ?? process.env.KALSHI_DEMO_PRIVATE_KEY;
	if (keyFromEnv && pemFromEnv) {
		return { keyId: keyFromEnv, pem: pemFromEnv };
	}
	try {
		const baseDir = join(homedir(), "keys");
		// Try demo first (less prod risk), then prod.
		const candidates = [
			{ key: "kalshi-demo-keyid.txt", pem: "kalshi-demo.pem" },
			{ key: "kalshi-prod-keyid.txt", pem: "kalshi-prod.pem" },
		];
		for (const c of candidates) {
			try {
				const keyId = readFileSync(join(baseDir, c.key), "utf8").trim();
				const pem = readFileSync(join(baseDir, c.pem), "utf8");
				return { keyId, pem };
			} catch {
				continue;
			}
		}
	} catch {
		// ignore
	}
	return null;
}

// ─── Current bot state (mirror wrangler.jsonc DEFAULT_TICKERS) ────
// As of 2026-08-09. If the bot's universe changes, update this.
const CURRENT_UNIVERSE: BotState = {
	tickers: ["KXWARMING-50", "KXWARMING-60", "KXGDP-Q3", "KXPRES-26", "KXNFL-CHAMP"],
	ticker_verticals: {
		"KXWARMING-50": "weather",
		"KXWARMING-60": "weather",
		"KXGDP-Q3": "economic",
		"KXPRES-26": "politics",
		"KXNFL-CHAMP": "sports",
	},
	bankroll_cents: 50_00,
	max_notional_cents_per_trade: 25,
	daily_notional_cents_cap: 150,
	trading_mode: "paper",
	per_vertical_max_notional_cents: null,
};

function makeStats(state: BotState): Map<string, TickerStats> {
	const stats = new Map<string, TickerStats>();
	for (const t of state.tickers) {
		stats.set(t, {
			ticker: t,
			vertical: state.ticker_verticals[t] ?? "unknown",
			n_signals_30d: 0,
			n_trades_30d: 0,
			pnl_cents_30d: 0,
			last_signal_ms: null,
			days_since_last_signal: null,
		});
	}
	return stats;
}

describe("leads-cron / dry-run (2026-08-09 restructure)", () => {
	it("previews the new prompt + LLM output (if MMX_API_KEY is set)", async () => {
		const env = {
			MMX_API_KEY: process.env.MMX_API_KEY,
			MMX_BASE_URL: process.env.MMX_BASE_URL,
			MMX_MODEL: process.env.MMX_MODEL,
		};
		const stubMode = !env.MMX_API_KEY;

		console.log("\n────────────────────────────────────────────────────────────");
		console.log("LEADS DRY-RUN — 2026-08-09 (prompt + Kalshi scout + verify)");
		console.log("────────────────────────────────────────────────────────────");
		console.log(`LLM mode: ${stubMode ? "STUB (no MMX_API_KEY in env)" : "REAL LLM (" + (env.MMX_MODEL ?? DEFAULT_MODEL) + ")"}`);
		console.log(`Current universe: ${CURRENT_UNIVERSE.tickers.join(", ")}`);
		console.log(`Bot bankroll: $${(CURRENT_UNIVERSE.bankroll_cents / 100).toFixed(2)}`);
		console.log("");

		// 1. Fetch the real Kalshi market snapshot (the
		// scout). This is the key change vs the 2026-08-09
		// morning version: the LLM is now GIVEN real tickers
		// to pick from, so it can't hallucinate short symbolic
		// tickers like KXGDP-Q3.
		let scout: ScoutResult | null = null;
		const creds = readKalshiCreds();
		if (creds) {
			const pem8 = creds.pem.includes("BEGIN RSA PRIVATE KEY")
				? createPrivateKey(creds.pem).export({ type: "pkcs8", format: "pem" }) as string
				: creds.pem;
			const pk = await loadPrivateKey(pem8);
			const kc = new KalshiCredentials(creds.keyId, pk);
			const client = new KalshiClient({
				baseUrl: DEFAULT_PRODUCTION_BASE,
				credentials: kc,
				requestsPerSecond: 4,
			});
			console.log("Fetching Kalshi market snapshot…");
			scout = await fetchAndFilterMarkets({ kalshiClient: client });
			if (scout.ok) {
				console.log(`✓ Scout: ${scout.total_scanned} open markets scanned, ${scout.markets.length} matched verticals`);
			} else {
				console.log(`✗ Scout failed: ${scout.error}`);
			}
		} else {
			console.log("(no Kalshi creds — running without scout; LLM will be unfiltered and likely hallucinate)");
		}
		console.log("");

		// 2. Build the prompt using the same path the cron uses.
		const stats = makeStats(CURRENT_UNIVERSE);
		const rejected = new Set<string>();
		const userPrompt = buildPromptForDryRun(CURRENT_UNIVERSE, stats, rejected, scout);

		console.log("USER PROMPT (truncated to first 2000 chars):");
		console.log("─".repeat(60));
		console.log(userPrompt.slice(0, 2000) + (userPrompt.length > 2000 ? "\n... [truncated]" : ""));
		console.log("─".repeat(60));
		console.log("");

		// 3. Call the LLM. In stub mode (no key) this
		// returns a deterministic stub. In real mode it
		// hits the API.
		console.log("SYSTEM PROMPT (full):");
		console.log("─".repeat(60));
		console.log(SYSTEM_PROMPT);
		console.log("─".repeat(60));
		console.log("");

		const result = await chat(env, SYSTEM_PROMPT, userPrompt, { max_tokens: 8000 });

		console.log("LLM RESPONSE:");
		console.log("─".repeat(60));
		console.log(`ok: ${result.ok}`);
		console.log(`stub: ${result.stub}`);
		console.log(`duration_ms: ${result.duration_ms}`);
		console.log(`input_tokens: ${result.input_tokens ?? "?"}`);
		console.log(`output_tokens: ${result.output_tokens ?? "?"}`);
		if (!result.ok) {
			console.log(`error_message: ${result.error_message}`);
		}
		console.log("");
		console.log("RAW TEXT (first 2000 chars):");
		console.log(result.text.slice(0, 2000));
		if (result.text.length > 2000) {
			console.log(`... [${result.text.length - 2000} more chars]`);
		}
		console.log("─".repeat(60));
		console.log("");

		// In stub mode we just show the prompt structure
		// — there's nothing to validate further.
		if (stubMode) {
			console.log("STUB MODE — skipping parse + validate.");
			console.log("To preview real LLM output, set MMX_API_KEY in env and re-run.");
			console.log("────────────────────────────────────────────────────────────");
			expect(userPrompt.length).toBeGreaterThan(500);
			return;
		}

		// 4. Parse + validate the real LLM response,
		//    with the scout as the per-ticker verifier.
		const parsed = parseLlmResponse(result.text);
		if (!parsed) {
			console.log("PARSE FAILED — LLM returned no JSON object.");
			console.log("────────────────────────────────────────────────────────────");
			expect.fail("LLM returned no parseable JSON");
		}

		const validation = validateAndDedupe(parsed, CURRENT_UNIVERSE, rejected, scout);

		console.log("PARSED + VALIDATED:");
		console.log("─".repeat(60));
		console.log(`Overall reasoning: ${parsed.overall_reasoning}`);
		console.log("");
		console.log(`ADD suggestions (${validation.add.length} accepted, ${parsed.add.length - validation.add.length} excluded):`);
		for (const s of validation.add) {
			console.log(`  + ${s.ticker} [${s.vertical}]`);
			console.log(`    ${s.reasoning}`);
		}
		console.log("");
		console.log(`DROP suggestions (${validation.drop.length} accepted, ${parsed.drop.length - validation.drop.length} excluded):`);
		for (const s of validation.drop) {
			console.log(`  - ${s.ticker} [${s.vertical ?? "—"}]`);
			console.log(`    ${s.reasoning}`);
		}
		console.log("");
		if (validation.unverified.length > 0) {
			console.log(`UNVERIFIED (${validation.unverified.length} — LLM suggested but NOT in Kalshi snapshot):`);
			for (const t of validation.unverified) {
				console.log(`  ? ${t}`);
			}
			console.log("");
		}
		if (validation.excluded.length > 0) {
			console.log(`EXCLUDED (${validation.excluded.length}):`);
			for (const e of validation.excluded) {
				console.log(`  × ${e.ticker} [${e.kind}] — ${e.reason}`);
			}
			console.log("");
		}
		if (validation.warnings.length > 0) {
			console.log(`WARNINGS (${validation.warnings.length}):`);
			for (const w of validation.warnings) {
				console.log(`  ! ${w}`);
			}
			console.log("");
		}

		// 5. Sanity checks. The KEY invariant is
		//    "no unverified tickers" — every LLM suggestion
		//    must be in the real Kalshi snapshot. The count
		//    can legitimately be 0 (Kalshi's vertical
		//    landscape doesn't match the bot's verticals, or
		//    all matches are structurally untradeable like
		//    the 4,065 multi-game parlays on 2026-08-09).
		expect(result.ok).toBe(true);
		expect(parsed).not.toBeNull();
		expect(validation.add.length).toBeLessThanOrEqual(15);
		if (scout && scout.ok) {
			expect(validation.unverified).toEqual([]);
		}
		for (const s of validation.add) {
			expect(["weather", "economic", "politics", "sports"]).toContain(s.vertical);
			expect(CURRENT_UNIVERSE.tickers).not.toContain(s.ticker);
			expect(s.reasoning.length).toBeGreaterThan(0);
		}
		for (const s of validation.drop) {
			expect(CURRENT_UNIVERSE.tickers).toContain(s.ticker);
			expect(s.reasoning.length).toBeGreaterThan(0);
		}

		console.log("ALL ASSERTIONS PASSED.");
		console.log("────────────────────────────────────────────────────────────");
	}, 120_000);
});
