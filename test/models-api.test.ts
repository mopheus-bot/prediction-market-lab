/**
 * pm-bot — model registry API integration tests.
 *
 * Verifies the register / list / get-active / promote / retire
 * endpoints. Uses vitest-pool-workers for the D1 binding.
 */

import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import migration0001 from "../migrations/0001_initial_schema.sql?raw";
import {
	handleGetActiveModels,
	handleGetModel,
	handleListModels,
	handlePromoteModel,
	handleRegisterModel,
	handleRetireModel,
} from "../src/api/models";

const MIGRATIONS = [
	{
		name: "0001_initial_schema.sql",
		queries: migration0001
			.split(/-->\s*statement-breakpoint/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0),
	},
];

beforeAll(async () => {
	await applyD1Migrations(env.DB, MIGRATIONS);
});

async function clearModels() {
	await env.DB!.prepare(`DELETE FROM models`).run();
}

describe("/api/pm/models (registry)", () => {
	beforeEach(clearModels);

	it("register + list round-trip", async () => {
		const regResp = await handleRegisterModel(
			{ DB: env.DB },
			new Request("https://x/", {
				method: "POST",
				body: JSON.stringify({
					version: "v2",
					vertical: "weather",
					notes: "test",
				}),
			}),
		);
		const regBody = (await regResp.json()) as { ok: boolean; registered: string };
		expect(regBody.ok).toBe(true);
		expect(regBody.registered).toBe("v2");

		const listUrl = new URL("https://x/?vertical=weather");
		const listResp = await handleListModels({ DB: env.DB }, listUrl);
		const listBody = (await listResp.json()) as { models: Array<{ version: string; status: string }> };
		expect(listBody.models.length).toBe(1);
		expect(listBody.models[0]!.version).toBe("v2");
		expect(listBody.models[0]!.status).toBe("candidate");
	});

	it("promote retires the current active + sets the new one", async () => {
		// Seed an active v1.
		await env.DB!.prepare(
			`INSERT INTO models (user_id, version, vertical, artifact_path, status, deployed_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		)
			.bind("default", "v1", "weather", "models/reversion-weather-v1.json", "active", 1)
			.run();

		// Register + promote v2.
		await handleRegisterModel(
			{ DB: env.DB },
			new Request("https://x/", {
				method: "POST",
				body: JSON.stringify({ version: "v2", vertical: "weather" }),
			}),
		);
		const promoResp = await handlePromoteModel(
			{ DB: env.DB },
			new Request("https://x/", {
				method: "POST",
				body: JSON.stringify({ version: "v2", vertical: "weather" }),
			}),
		);
		const promoBody = (await promoResp.json()) as {
			ok: boolean;
			promoted: string;
			retired: string | null;
		};
		expect(promoBody.ok).toBe(true);
		expect(promoBody.promoted).toBe("v2");
		expect(promoBody.retired).toBe("v1");

		// v1 should be retired, v2 should be active.
		const v1 = await env.DB!.prepare(
			`SELECT status, retired_at FROM models WHERE version = ?1`,
		)
			.bind("v1")
			.first<{ status: string; retired_at: number | null }>();
		const v2 = await env.DB!.prepare(
			`SELECT status, deployed_at FROM models WHERE version = ?1`,
		)
			.bind("v2")
			.first<{ status: string; deployed_at: number | null }>();
		expect(v1?.status).toBe("retired");
		expect(v1?.retired_at).not.toBeNull();
		expect(v2?.status).toBe("active");
		expect(v2?.deployed_at).not.toBeNull();
	});

	it("getActive returns the active row per vertical", async () => {
		// Seed weather=v1 active, economic=v3 active.
		await env.DB!.prepare(
			`INSERT INTO models (user_id, version, vertical, artifact_path, status, deployed_at)
			 VALUES ('default', 'v1', 'weather', 'models/reversion-weather-v1.json', 'active', 1)`,
		).run();
		await env.DB!.prepare(
			`INSERT INTO models (user_id, version, vertical, artifact_path, status, deployed_at)
			 VALUES ('default', 'v3', 'economic', 'models/reversion-economic-v3.json', 'active', 1)`,
		).run();

		const resp = await handleGetActiveModels({ DB: env.DB });
		const body = (await resp.json()) as { active: { weather?: { version: string }; economic?: { version: string } } };
		expect(body.active.weather?.version).toBe("v1");
		expect(body.active.economic?.version).toBe("v3");
	});

	it("getModel returns 404 for missing versions", async () => {
		const resp = await handleGetModel({ DB: env.DB }, "v999");
		expect(resp.status).toBe(404);
	});

	it("retire marks a model as retired with retired_at", async () => {
		await env.DB!.prepare(
			`INSERT INTO models (user_id, version, vertical, artifact_path, status)
			 VALUES ('default', 'v1', 'weather', 'models/reversion-weather-v1.json', 'active')`,
		).run();
		const resp = await handleRetireModel(
			{ DB: env.DB },
			new Request("https://x/", {
				method: "POST",
				body: JSON.stringify({ version: "v1" }),
			}),
		);
		const body = (await resp.json()) as { ok: boolean; retired: string };
		expect(body.ok).toBe(true);
		const row = await env.DB!.prepare(
			`SELECT status, retired_at FROM models WHERE version = ?1`,
		)
			.bind("v1")
			.first<{ status: string; retired_at: number | null }>();
		expect(row?.status).toBe("retired");
		expect(row?.retired_at).not.toBeNull();
	});

	it("rejects invalid vertical on register", async () => {
		const resp = await handleRegisterModel(
			{ DB: env.DB },
			new Request("https://x/", {
				method: "POST",
				body: JSON.stringify({ version: "v1", vertical: "crypto" }),
			}),
		);
		expect(resp.status).toBe(400);
	});
});
