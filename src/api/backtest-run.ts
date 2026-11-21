/**
 * prediction-market-lab — backtest manual trigger (.8c).
 *
 * POST /api/pm/backtest/run — runs the backtest
 * retrospective immediately and returns the metrics. The
 * Sunday cron auto-runs the same code; this endpoint
 * exists for:
 *   - smoke-testing the code path against live data
 *   - operator-driven runs after a strategy change
 *
 * Body (optional):
 *   { "window_days": 7, "register_candidate": true }
 *
 * Default: 7-day window, register a `backtest-{ts}` candidate
 * model in the registry. Pass `register_candidate: false`
 * for a dry run (just compute + return metrics, don't
 * touch the registry).
 */

import { runBacktest, metricsSummary, type BacktestMetrics } from "../lib/backtest.js";
import { models as modelsDb } from "../lib/db.js";
import { DEFAULT_USER_ID } from "../lib/types.js";

export interface BacktestRunEnv {
	DB?: D1Database;
}

interface BacktestRunBody {
	window_days?: number;
	register_candidate?: boolean;
}

interface BacktestRunResponse {
	ok: true;
	metrics: BacktestMetrics;
	summary: string;
	candidate_model_id: number | null;
	candidate_model_version: string | null;
}

export async function handleBacktestRun(
	env: BacktestRunEnv,
	request: Request,
): Promise<Response> {
	if (!env.DB) {
		return Response.json(
			{ ok: false, error: "missing_db" },
			{ status: 500 },
		);
	}
	let body: BacktestRunBody = {};
	try {
		body = (await request.json()) as BacktestRunBody;
	} catch {
		// Empty body is fine — use defaults.
	}
	const windowDays = Math.max(1, Math.min(90, body.window_days ?? 7));
	const registerCandidate = body.register_candidate ?? true;
	const now = Date.now();

	try {
		const metrics = await runBacktest(env, now, windowDays);
		if (!metrics) {
			return Response.json(
				{ ok: false, error: "backtest_unavailable", detail: "DB missing or empty" },
				{ status: 500 },
			);
		}
		const summary = metricsSummary(metrics);

		let candidateModelId: number | null = null;
		let candidateModelVersion: string | null = null;
		if (registerCandidate) {
			const ts = Math.floor(now / 1000);
			candidateModelVersion = `backtest-${ts}`;
			try {
				// The backtest doesn't have a single vertical —
				// it's an aggregate over all verticals. Use
				// "weather" as the registered vertical since
				// the models table requires one; the actual
				// metrics are stored in train_metrics_json.
				await modelsDb.upsert(env.DB, {
					user_id: DEFAULT_USER_ID,
					version: candidateModelVersion,
					vertical: "weather",
					artifact_path: "",
					trained_on_data_until: now,
					train_metrics_json: JSON.stringify(metrics),
					deployed_at: now,
					retired_at: null,
					status: "candidate",
					notes: summary,
				});
				candidateModelId = ts; // surrogate ID — operator
				// can find it via list endpoint.
			} catch (e) {
				const msg = e instanceof Error ? e.message: String(e);
				console.warn("[backtest-run] register candidate failed:", msg);
			}
		}

		const response: BacktestRunResponse = {
			ok: true,
			metrics,
			summary,
			candidate_model_id: candidateModelId,
			candidate_model_version: candidateModelVersion,
		};
		return Response.json(response);
	} catch (e) {
		const msg = e instanceof Error ? e.message: String(e);
		return Response.json(
			{ ok: false, error: "backtest_failed", detail: msg.slice(0, 500) },
			{ status: 500 },
		);
	}
}
