/**
 * prediction-market-lab — model loader.
 *
 * Loads a `RandomForestModel` from R2 (the production path) or
 * from an inline string (the test / local-dev path). The DO
 * caches the loaded model in instance memory after the first
 * load — the JSON parse + typed-array construction is a few
 * hundred ms, so we want to do it once.
 *
 * **R2 path** (production): the model lives at
 * `models/reversion-<vertical>-v<n>.json`. The DO fetches it
 * with `env.BUCKET.get(key)` and parses the response body.
 *
 * **Inline path** (tests / local dev): the caller passes a
 * JSON string directly. Used by the unit tests.
 *
 * **Failure mode:** if the model is missing from R2, the
 * loader returns `null`. The caller (LiveBot) falls back to
 * `NaiveSignal` for that vertical — the engine never crashes
 * on a missing model.
 */

import { loadForestFromJSON, type RandomForestModel } from "./forest.js";
import type { Vertical } from "../lib/types.js";

export interface ModelLoaderEnv {
	BUCKET?: R2Bucket;
	/** Optional env var that pins the model version. */
	MODEL_VERSION?: string;
}

/** Build the R2 key for a vertical + model version. */
export function modelKey(vertical: Vertical, version: string = "v1"): string {
	return `models/reversion-${vertical}-${version}.json`;
}

/** Build the inline dev/test model key (uses an env-driven path). */
export function inlineModelKey(vertical: Vertical): string {
	return `inline:reversion-${vertical}-v1`;
}

/**
 * Try to load a model from R2. Returns null on any failure
 * (missing key, network error, malformed JSON). Callers must
 * handle the null case (fall back to NaiveSignal).
 */
export async function loadModelFromR2(
	env: ModelLoaderEnv,
	vertical: Vertical,
	version: string = "v1",
): Promise<RandomForestModel | null> {
	if (!env.BUCKET) return null;
	const key = modelKey(vertical, version);
	let object: R2ObjectBody | null;
	try {
		object = await env.BUCKET.get(key);
	} catch (e) {
		console.error(`[model-loader] R2 get failed for ${key}`, e);
		return null;
	}
	if (!object) return null;
	let text: string;
	try {
		text = await object.text();
	} catch (e) {
		console.error(`[model-loader] R2 read failed for ${key}`, e);
		return null;
	}
	try {
		return loadForestFromJSON(text);
	} catch (e) {
		console.error(`[model-loader] parse failed for ${key}`, e);
		return null;
	}
}

/**
 * Load a model from an inline JSON string. Used by the
 * unit tests and by /start when an inline `model_json` is
 * passed in the config (for local dev).
 */
export function loadModelFromInline(json: string): RandomForestModel {
	return loadForestFromJSON(json);
}
