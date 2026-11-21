/**
 * prediction-market-lab — model loader unit tests.
 *
 * Tests the R2 fetch path (with a mocked R2 bucket) and the
 * inline JSON path. The actual /start flow is exercised in
 * the live-bot integration tests.
 */

import { describe, it, expect, vi } from "vitest";
import {
	loadModelFromInline,
	loadModelFromR2,
	modelKey,
} from "../src/strategy/model-loader";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SAMPLE_MODEL = readFileSync(
	join(process.cwd(), "models", "reversion-weather-v1.json"),
	"utf8",
);

describe("modelKey", () => {
	it("builds the canonical R2 path", () => {
		expect(modelKey("weather", "v1")).toBe("models/reversion-weather-v1.json");
		expect(modelKey("economic", "v2")).toBe("models/reversion-economic-v2.json");
	});
});

describe("loadModelFromInline", () => {
	it("parses a JSON model and produces a usable RandomForestModel", () => {
		const m = loadModelFromInline(SAMPLE_MODEL);
		expect(m.n_features).toBe(20);
		expect(m.n_classes).toBe(2);
		expect(m.trees.length).toBe(200);
	});
	it("rejects malformed JSON", () => {
		expect(() => loadModelFromInline("not json")).toThrow();
	});
});

describe("loadModelFromR2", () => {
	it("returns the model when R2 has it", async () => {
		const env = {
			BUCKET: {
				get: vi.fn().mockResolvedValue({
					text: () => Promise.resolve(SAMPLE_MODEL),
				}),
			},
		};
		const m = await loadModelFromR2(env, "weather", "v1");
		expect(m).not.toBeNull();
		expect(m?.n_features).toBe(20);
		expect(env.BUCKET.get).toHaveBeenCalledWith("models/reversion-weather-v1.json");
	});

	it("returns null when the bucket is missing", async () => {
		const m = await loadModelFromR2({}, "weather", "v1");
		expect(m).toBeNull();
	});

	it("returns null when the key is not in the bucket", async () => {
		const env = {
			BUCKET: {
				get: vi.fn().mockResolvedValue(null),
			},
		};
		const m = await loadModelFromR2(env, "weather", "v1");
		expect(m).toBeNull();
	});

	it("returns null when R2 read fails", async () => {
		const env = {
			BUCKET: {
				get: vi.fn().mockResolvedValue({
					text: () => Promise.reject(new Error("R2 network error")),
				}),
			},
		};
		const m = await loadModelFromR2(env, "weather", "v1");
		expect(m).toBeNull();
	});

	it("returns null when the JSON is malformed", async () => {
		const env = {
			BUCKET: {
				get: vi.fn().mockResolvedValue({
					text: () => Promise.resolve("not json"),
				}),
			},
		};
		const m = await loadModelFromR2(env, "weather", "v1");
		expect(m).toBeNull();
	});
});
