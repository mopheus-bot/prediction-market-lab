/**
 * pm-bot — verticals API tests (chunk 10.8c).
 *
 * Verifies the per-vertical state returned by /api/pm/verticals:
 *   - all 4 known verticals are returned (weather, economic,
 *     politics, sports)
 *   - active flag flips when the bot_config has the vertical
 *     in disabled_verticals
 *   - 24h + all-time trade aggregates are surfaced
 *   - the strategy label + ELI5 is populated for each vertical
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { handleVerticals } from "../src/api/verticals.js";
import { ALL_MIGRATIONS } from "./helpers/migrations";

beforeAll(async () => {
	await applyD1Migrations(env.DB, ALL_MIGRATIONS);
});

async function setBotConfig(value: Record<string, unknown>): Promise<void> {
	await env.DB
		.prepare(
			`INSERT INTO bot_config (user_id, key, value, ts_ms)
			 VALUES ('default', 'config', ?1, ?2)
			 ON CONFLICT (user_id, key) DO UPDATE
			   SET value = excluded.value, ts_ms = excluded.ts_ms`,
		)
		.bind(JSON.stringify(value), Date.now())
		.run();
}

describe("/api/pm/verticals (chunk 10.8c)", () => {
	it("returns all 4 known verticals with stats + strategy", async () => {
		await setBotConfig({
			disabled_verticals: null,
			per_vertical_max_notional_cents: { weather: 10 },
			ticker_verticals: { "KXWARMING-50": "weather" },
		});
		const r = await handleVerticals({ DB: env.DB }, new URL("https://x/pm/verticals"));
		const body = (await r.json()) as {
			ok: boolean;
			verticals: Array<{
				id: string;
				label: string;
				emoji: string;
				active: boolean;
				model_version: string;
				strategy: string;
				strategy_label: string;
				strategy_eli5: string;
				n_trades_24h: number;
				pnl_cents_24h: number;
				cap_cents: number | null;
				tickers: string[];
			}>;
		};
		expect(body.ok).toBe(true);
		expect(body.verticals).toHaveLength(4);
		const ids = body.verticals.map((v) => v.id).sort();
		expect(ids).toEqual(["economic", "politics", "sports", "weather"]);

		const weather = body.verticals.find((v) => v.id === "weather")!;
		expect(weather.active).toBe(true);
		expect(weather.strategy).toBe("reversion");
		expect(weather.strategy_label).toBe("Reversion v1");
		expect(weather.strategy_eli5).toMatch(/revert/i);
		expect(weather.cap_cents).toBe(10);
		expect(weather.tickers).toEqual(["KXWARMING-50"]);

		const politics = body.verticals.find((v) => v.id === "politics")!;
		expect(politics.strategy).toBe("naive");
		expect(politics.strategy_label).toBe("Naive baseline");
	});

	it("marks verticals inactive when in disabled_verticals", async () => {
		await setBotConfig({
			disabled_verticals: ["politics", "sports"],
			per_vertical_max_notional_cents: null,
			ticker_verticals: {},
		});
		const r = await handleVerticals({ DB: env.DB }, new URL("https://x/pm/verticals"));
		const body = (await r.json()) as { verticals: Array<{ id: string; active: boolean }> };
		const byId = Object.fromEntries(body.verticals.map((v) => [v.id, v.active]));
		expect(byId.weather).toBe(true);
		expect(byId.economic).toBe(true);
		expect(byId.politics).toBe(false);
		expect(byId.sports).toBe(false);
	});

	it("returns zero stats when no trades are recorded", async () => {
		await setBotConfig({});
		const r = await handleVerticals({ DB: env.DB }, new URL("https://x/pm/verticals"));
		const body = (await r.json()) as { verticals: Array<{ n_trades_24h: number; n_trades_total: number }> };
		for (const v of body.verticals) {
			expect(v.n_trades_24h).toBe(0);
			expect(v.n_trades_total).toBe(0);
		}
	});

	it("includes a strategy ELI5 for every vertical", async () => {
		await setBotConfig({});
		const r = await handleVerticals({ DB: env.DB }, new URL("https://x/pm/verticals"));
		const body = (await r.json()) as { verticals: Array<{ strategy_eli5: string }> };
		for (const v of body.verticals) {
			expect(v.strategy_eli5.length).toBeGreaterThan(20);
		}
	});
});
