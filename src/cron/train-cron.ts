/**
 * pm-bot — train cron (chunk 8).
 *
 * Runs weekly on Sunday 00:00 UTC. The full Python retrain
 * pipeline (via the `train_reversion_quality_model_from_trades`
 * in the Python repo) is invoked by one of:
 *
 *   (a) An external webhook (`TRAIN_WEBHOOK_URL` env var).
 *       The webhook receiver is responsible for kicking the
 *       Python retrain and uploading the new model JSON to
 *       the conventional R2 key:
 *         models/reversion-{vertical}-{version}.json
 *       The cron then registers the new model in the D1
 *       `models` table (status=candidate) so the operator
 *       can promote it via the API.
 *
 *   (b) The cron directly lists R2 for new model artifacts
 *       since the last run and auto-registers them. The
 *       `train.cron` script does this every Sunday.
 *
 * **What this DOES do in chunk 8:**
 *   - Polls R2 for `models/reversion-{vertical}-*.json`
 *     objects not yet in the D1 registry.
 *   - Registers each new model with status=candidate.
 *   - Optionally POSTs to `TRAIN_WEBHOOK_URL` for the
 *     external retrain pipeline.
 *   - Optionally auto-promotes a model whose artifact is
 *     present in R2 (set `TRAIN_AUTO_PROMOTE=true` to enable;
 *     OFF by default — we want the operator to look at the
 *     model first).
 *
 * **Why auto-promote is OFF by default:** the chunk-4
 * models are trained on synthetic data; live retrains
 * (chunk 8+) are trained on real trade data which is
 * smaller and noisier. Auto-promote would let a poorly
 * trained model go live without review. Keep the
 * `promote` endpoint as the manual gate.
 */

import { DEFAULT_USER_ID, VERTICALS, type Vertical } from "../lib/types.js";
import { models as modelsDb } from "../lib/db.js";
import type { CronEnv, CronResult } from "./dispatcher.js";

// 2026-08-11: use the canonical VERTICALS list from lib/types.ts
// (17 verticals) instead of a hardcoded 4-vertical subset. The old
// list silently dropped models for the 13 new verticals — when a
// `models/reversion-elections-{version}.json` was uploaded, the
// parser would match the key but `isVertical("elections")` would
// return false, so the model was discarded as "unknown vertical."
const KNOWN_VERTICALS: ReadonlyArray<Vertical> = VERTICALS;

function isVertical(s: string): s is Vertical {
	return (KNOWN_VERTICALS as ReadonlyArray<string>).includes(s);
}

function modelKey(vertical: Vertical, version: string): string {
	return `models/reversion-${vertical}-${version}.json`;
}

function parseModelKey(key: string): { vertical: Vertical; version: string } | null {
	const m = key.match(/^models\/reversion-(\w+)-([^/]+)\.json$/);
	if (!m) return null;
	const vertical = m[1];
	const version = m[2];
	if (!vertical || !version || !isVertical(vertical)) return null;
	return { vertical, version };
}

export async function runTrainCron(env: CronEnv): Promise<CronResult> {
	const started = Date.now();
	try {
		const artifacts: {
			registered: string[];
			skipped: string[];
			promoted: string[];
		} = { registered: [], skipped: [], promoted: [] };

		// 1. Optional webhook POST — fires the external retrain.
		const webhook = (env as { TRAIN_WEBHOOK_URL?: string }).TRAIN_WEBHOOK_URL;
		if (webhook) {
			try {
				const resp = await fetch(webhook, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						event: "train_requested",
						user_id: DEFAULT_USER_ID,
						requested_at: new Date().toISOString(),
					}),
				});
				if (!resp.ok) {
					console.warn(`[cron:train] webhook returned ${resp.status}`);
				}
			} catch (e) {
				console.error(`[cron:train] webhook failed`, e);
			}
		}

		// 2. List R2 for new model artifacts + register them.
		if (env.DB && env.BUCKET) {
			const existing = await modelsDb.list(env.DB, DEFAULT_USER_ID);
			const knownVersions = new Set(existing.map((m) => m.version));
			// R2 list: paginate through `models/` prefix.
			let cursor: string | undefined;
			for (let page = 0; page < 20; page++) {
				const listed = await env.BUCKET.list({
					prefix: "models/reversion-",
					cursor,
					limit: 1000,
				});
				for (const obj of listed.objects) {
					const parsed = parseModelKey(obj.key);
					if (!parsed) continue;
					const { vertical, version } = parsed;
					// 2026-08-11: dedup key is now
					// (vertical, version) instead of version
					// alone. A single train run produces one
					// model per vertical with the same
					// version (e.g. "weather-20260811" and
					// "elections-20260811" both produced by
					// the 2026-08-11 wrapper run). The old
					// dedup would register the first one and
					// silently skip the rest. To match the
					// D1 PRIMARY KEY (user_id, version) we
					// also suffix the version with the
					// vertical so each row is unique.
					const dedupKey = `${vertical}:${version}`;
					if (knownVersions.has(dedupKey)) {
						artifacts.skipped.push(`${vertical}:${version}`);
						continue;
					}
					await modelsDb.upsert(env.DB, {
						user_id: DEFAULT_USER_ID,
						// Synthesize a unique D1 version from
						// the (vertical, version) pair. The
						// R2 key keeps the natural
						// `reversion-{vertical}-{version}.json`
						// naming; the D1 version is what the
						// rest of the system (status API,
						// /promote) addresses models by.
						version: `${vertical}-${version}`,
						vertical,
						artifact_path: obj.key,
						trained_on_data_until: null,
						train_metrics_json: null,
						deployed_at: null,
						retired_at: null,
						status: "candidate",
						notes: "registered by train-cron",
					});
					artifacts.registered.push(`${vertical}:${version}`);
					knownVersions.add(dedupKey);
				}
				if (!listed.truncated || !listed.cursor) break;
				cursor = listed.cursor;
			}

			// 3. Optional auto-promote.
			const autoPromote =
				(env as { TRAIN_AUTO_PROMOTE?: string }).TRAIN_AUTO_PROMOTE === "true";
			if (autoPromote) {
				const candidates = existing
					.concat([])
					.filter((m) => m.status === "candidate" && m.vertical !== "all");
				for (const c of candidates) {
					const v = c.vertical as Vertical;
					const current = await modelsDb.getActive(
						env.DB,
						DEFAULT_USER_ID,
						v,
					);
					if (current && current.version !== c.version) {
						await modelsDb.setStatus(
							env.DB,
							DEFAULT_USER_ID,
							current.version,
							"retired",
							Date.now(),
						);
					}
					await modelsDb.setStatus(
						env.DB,
						DEFAULT_USER_ID,
						c.version,
						"active",
						Date.now(),
					);
					artifacts.promoted.push(`${c.vertical}:${c.version}`);
				}
			}
		}

		return {
			ok: true,
			cron_name: "train",
			duration_ms: Date.now() - started,
			artifacts: {
				webhook_fired: !!webhook,
				...artifacts,
			},
		};
	} catch (e) {
		return {
			ok: false,
			cron_name: "train",
			duration_ms: Date.now() - started,
			error_message: e instanceof Error ? e.message : String(e),
		};
	}
}
