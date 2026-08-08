/**
 * pm-bot — train cron (chunk 5).
 *
 * Runs weekly on Sunday 00:00 UTC. Kicks the Python
 * retrain pipeline that updates the per-vertical
 * reversion models with the latest live trade data.
 *
 * **Status in chunk 5:** STUB. The actual training is
 * a Python process that needs `sklearn` + the full
 * `the Python reference engine/` source. There
 * are three ways to wire this in; chunk 5 ships the
 * record-keeping layer and the dispatch is wired up in
 * chunk 8 (model registry + shadow mode):
 *
 *   (a) **External cron + CLI:** the user's local cron
 *       kicks the Python retrain script on its schedule
 *       and uploads the new `.joblib` to a known R2
 *       location. The TS train-cron just records
 *       "external train completed" to `cron_runs`.
 *
 *   (b) **CF Workflow (chunk 8+):** a Cloudflare Workflow
 *       runs the retrain as a long-lived compute job. The
 *       TS train-cron starts a Workflow execution.
 *
 *   (c) **Manual trigger:** the user runs
 *       `npm run models:convert -- --in <new>.joblib --out
 *       models/reversion-{vertical}-v2.json` and uploads
 *       to R2. Then `POST /api/pm/bot/start` with
 *       `{"model_version": "v2"}` to flip the bot.
 *
 * For now the TS train-cron just records an "ok, train
 * requested" entry to `cron_runs` (with a note that the
 * actual retrain is external). When chunk 8 lands, this
 * will dispatch to (b).
 *
 * **What this DOES do in chunk 5:**
 *   - Write a `train_requested` row to `cron_runs` so
 *     "did the weekly train fire?" is answerable.
 *   - Optionally POST to an external retrain endpoint
 *     (`TRAIN_WEBHOOK_URL` env var) if set.
 */

import { DEFAULT_USER_ID } from "../lib/types.js";
import type { CronEnv, CronResult } from "./dispatcher.js";

const NOTE =
	"stub: actual training runs externally; this entry records the cron fired. " +
	"See docs/changelog for chunk 5 / chunk 8 plan.";

export async function runTrainCron(env: CronEnv): Promise<CronResult> {
	const started = Date.now();
	try {
		// Optional external webhook. If TRAIN_WEBHOOK_URL is set,
		// POST a "train requested" event to it. The receiver
		// (local cron, GitHub Action, CF Workflow) does the
		// actual retrain.
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
					console.warn(
						`[cron:train] webhook returned ${resp.status}`,
					);
				}
			} catch (e) {
				console.error(`[cron:train] webhook failed`, e);
			}
		}
		return {
			ok: true,
			cron_name: "train",
			duration_ms: Date.now() - started,
			artifacts: {
				webhook_fired: !!webhook,
				note: NOTE,
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
