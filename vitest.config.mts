import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * pm-bot — vitest projects.
 *
 * Two projects so we don't pay the `vitest-pool-workers` startup cost
 * for tests that don't need a Worker runtime:
 *
 *   - `unit` (Node, no Worker): fees, strategy, risk engine math. Pure
 *     functions, no D1/DO/WS. Runs in milliseconds per test.
 *
 *   - `integration` (Workers pool): auth (uses WebCrypto), db (uses D1),
 *     live-bot (uses Durable Objects). One Worker spinup per test file.
 *
 * Run individually:
 *   npx vitest run --project unit            # CPU-light, runs in ~1s
 *   npx vitest run --project integration     # worker spinup, ~1s per file
 *
 * Or both (the default `npm test`):
 *   npx vitest run
 *
 * Why split: the `cloudflareTest` plugin compiles the Worker + binds
 * D1/DO per test file. For tests that only test pure functions, this
 * is overkill and pegs CPU at 80-95% on the dev Mac. The split keeps
 * fast unit feedback cheap while still covering the integration paths.
 */
const cloudflarePlugin = cloudflareTest({
	wrangler: { configPath: "./wrangler.jsonc" },
});

export default defineConfig({
	test: {
		projects: [
			{
				// Unit tests — pure Node, no Worker bindings, no D1, no DO.
				// Covers: fees, strategy, risk engine, forest inference,
				// feature extraction, reversion signal, model loader, cron,
				// telegram, llm, cost.
				extends: true,
				test: {
					name: "unit",
					include: [
						"test/fees.test.ts",
						"test/strategy.test.ts",
						"test/risk.test.ts",
						"test/forest.test.ts",
						"test/reversion.test.ts",
						"test/features.test.ts",
						"test/model-loader.test.ts",
						"test/cron.test.ts",
						"test/telegram.test.ts",
						"test/llm.test.ts",
						"test/cost.test.ts",
						"test/cost-monthly.test.ts",
						"test/backtest.test.ts",
						"test/sharpe.test.ts",
						"test/stage.test.ts",
						"test/ws-relay.test.ts",
					],
					environment: "node",
				},
			},
			{
				// Integration tests — uses the Worker pool with full
				// D1/DO bindings. Covers: auth, db, live-bot DO, status
				// API, model registry API.
				plugins: [cloudflarePlugin],
				test: {
					name: "integration",
					include: [
						"test/auth.test.ts",
						"test/db.test.ts",
						"test/live-bot.test.ts",
						"test/api-status.test.ts",
						"test/models-api.test.ts",
					],
				},
			},
		],
	},
});
