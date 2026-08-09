/**
 * pm-bot — Cadence API (chunk 10).
 *
 * The single source of truth for the dashboard's "Cadence"
 * panel. Lists every auto-running service with:
 *   - name + ELI5 description
 *   - category (stream | cron | llm | data | model)
 *   - status (ok | starting | error | off | paused | killed)
 *   - last_ran_ms + last_ran_label ("3 min ago")
 *   - next_in_ms + next_label ("in 12 min")
 *   - details (free-form text about the most recent activity)
 *
 * Backed by:
 *   - D1 cron_runs table
 *   - D1 llm_calls table
 *   - D1 models table
 *   - LiveBot /status (for the WS stream)
 *
 * Response shape:
 *   {
 *     ok: true,
 *     ts_ms: 1786193000000,
 *     services: [
 *       { id, name, description, category, status, last_ran_ms, last_ran_label,
 *         next_in_ms, next_label, interval_label, details, icon }
 *     ],
 *     summary: { n_services, n_ok, n_error, n_off, n_paused, n_stale }
 *   }
 *
 * Cache-Control: 30s. The dashboard polls every 10s but the data
 * only changes when a cron fires or a model registers.
 */

import { cronRuns as cronRunsDb, llmCalls as llmCallsDb, models as modelsDb } from "../lib/db.js";
import { DEFAULT_USER_ID, type CronRunRow, type LlmCallRow, type ModelRow } from "../lib/types.js";

export interface CadenceEnv {
	DB?: D1Database;
	/** When provided, the live-bot status is included. */
	LIVE_BOT?: DurableObjectNamespace;
}

interface ServiceEntry {
	id: string;
	name: string;
	description: string;
	category: "stream" | "cron" | "llm" | "data" | "model";
	status: "ok" | "starting" | "error" | "off" | "paused" | "killed" | "running" | "skipped" | "stale";
	last_ran_ms: number | null;
	last_ran_label: string;
	next_in_ms: number | null;
	next_label: string;
	interval_label: string;
	details: string;
	icon: string;
}

const SERVICE_CATALOGUE: Array<{
	id: string;
	name: string;
	description: string;
	category: ServiceEntry["category"];
	interval_ms: number;
	interval_label: string;
	icon: string;
	/** Map a CronRun / LlmCall / ModelRow into a human-readable details string. */
	details_from: "cron" | "llm" | "model" | "none";
}> = [
	{
		id: "ws",
		name: "Live WebSocket",
		description: "Stream of orderbook + trade + ticker data from Kalshi.",
		category: "stream",
		interval_ms: 0,
		interval_label: "continuous",
		icon: "📡",
		details_from: "none",
	},
	{
		id: "scan",
		name: "Universe scan",
		description: "Searches Kalshi markets, ranks by volume, picks the most interesting.",
		category: "cron",
		interval_ms: 15 * 60 * 1000,
		interval_label: "every 15 min",
		icon: "🔭",
		details_from: "cron",
	},
	{
		id: "news",
		name: "News check",
		description: "For every open position, asks the LLM to check for breaking news.",
		category: "cron",
		interval_ms: 6 * 60 * 60 * 1000,
		interval_label: "every 6 hours",
		icon: "📰",
		details_from: "cron",
	},
	{
		id: "daily",
		name: "Daily recap",
		description: "Writes yesterday's trades + PnL to R2; posts a Telegram summary.",
		category: "cron",
		interval_ms: 24 * 60 * 60 * 1000,
		interval_label: "daily at 06:00 UTC",
		icon: "🌅",
		details_from: "cron",
	},
	{
		id: "train",
		name: "Model retrain",
		description: "Polls R2 for new model artifacts, registers them in the registry.",
		category: "model",
		interval_ms: 7 * 24 * 60 * 60 * 1000,
		interval_label: "weekly on Sunday 00:00 UTC",
		icon: "🧠",
		details_from: "model",
	},
	{
		id: "heartbeat",
		name: "Daily heartbeat",
		description: "Passive health check: LLM round-trip + Telegram config. Sends a Telegram alert if any check fails.",
		category: "cron",
		interval_ms: 24 * 60 * 60 * 1000,
		interval_label: "daily at 07:00 UTC",
		icon: "♥",
		details_from: "cron",
	},
	{
		id: "leads",
		name: "Lead suggestions",
		description: "Asks the LLM which Kalshi tickers to add or drop from the bot's universe. Writes suggestions to the lead_suggestions table; operator approves or rejects on the Dev page.",
		category: "cron",
		interval_ms: 24 * 60 * 60 * 1000,
		interval_label: "daily at 02:00 UTC",
		icon: "🎯",
		details_from: "cron",
	},
];

function relativeLabel(ms_ago: number): string {
	if (ms_ago < 0) return "in the future";
	if (ms_ago < 5_000) return "just now";
	if (ms_ago < 60_000) return `${Math.floor(ms_ago / 1000)}s ago`;
	if (ms_ago < 60 * 60_000) return `${Math.floor(ms_ago / 60_000)}m ago`;
	if (ms_ago < 24 * 60 * 60_000) return `${Math.floor(ms_ago / (60 * 60_000))}h ago`;
	return `${Math.floor(ms_ago / (24 * 60 * 60_000))}d ago`;
}

function nextLabelFromNow(next_in_ms: number | null): string {
	if (next_in_ms === null) return "—";
	if (next_in_ms <= 0) return "now";
	if (next_in_ms < 60_000) return `in ${Math.floor(next_in_ms / 1000)}s`;
	if (next_in_ms < 60 * 60_000) return `in ${Math.floor(next_in_ms / 60_000)}m`;
	if (next_in_ms < 24 * 60 * 60_000) return `in ${Math.floor(next_in_ms / (60 * 60_000))}h`;
	return `in ${Math.floor(next_in_ms / (24 * 60 * 60_000))}d`;
}

function detailsFromCron(row: CronRunRow | null): string {
	if (!row) return "never run";
	const dur = row.duration_ms != null ? ` in ${row.duration_ms}ms` : "";
	if (row.status === "success") return `last ok${dur}`;
	if (row.status === "error") return `error: ${row.error_message ?? "unknown"}${dur}`;
	return `last status: ${row.status}${dur}`;
}

function detailsFromModel(rows: ModelRow[]): string {
	if (rows.length === 0) return "no models registered yet";
	const latest = rows[0];
	return `latest: ${latest.version} (${latest.vertical}, ${latest.status})`;
}

export async function handleCadence(env: CadenceEnv, _url: URL): Promise<Response> {
	const ts_ms = Date.now();
	const user_id = DEFAULT_USER_ID;

	// Pull the per-cron last-runs in parallel.
	const cronJobs = ["scan", "news", "daily", "heartbeat", "leads", "train"] as const;
	const cronRows = await Promise.all(
		cronJobs.map((name) =>
			env.DB ? cronRunsDb.lastRun(env.DB, name, user_id).catch(() => null) : Promise.resolve(null),
		),
	);
	// Build cronByName dynamically so adding a new cron
	// to cronJobs doesn't require a parallel edit here.
	// (The previous hardcoded-by-index version broke when
	// heartbeat was added — train was reading heartbeat's
	// row and heartbeat showed 'never run'.)
	const cronByName: Record<string, CronRunRow | null> = {};
	for (let i = 0; i < cronJobs.length; i += 1) {
		cronByName[cronJobs[i]] = cronRows[i] ?? null;
	}

	// Pull latest LLM call.
	const latestLlm = env.DB
		? await llmCallsDb
				.costSince(env.DB, user_id, ts_ms - 24 * 60 * 60 * 1000)
				.catch(() => null)
		: null;

	// Pull latest model.
	const modelRows = env.DB ? await modelsDb.list(env.DB, user_id).catch(() => []) : [];

	// Pull bot status (for the WS stream).
	let wsConnected = false;
	let wsLastError: { ts_ms: number; code: string; message: string } | null = null;
	let wsFrames = 0;
	if (env.LIVE_BOT) {
		try {
			const id = env.LIVE_BOT.idFromName(`user:${user_id}`);
			const stub = env.LIVE_BOT.get(id);
			// The DO's status path is `/status` (not `/api/pm/bot/status`).
			// The host is irrelevant for DO stub fetches — only the path
			// matters. (chunk 10.7: previous code used the Worker's
			// /api/pm/bot/status path, which the DO doesn't recognize —
			// cadence always showed WS as "not connected" even when the
			// Worker-level /status said connected: true.)
			const resp = await stub.fetch("https://bot/status");
			if (resp.ok) {
				const data = (await resp.json()) as Record<string, unknown>;
				wsConnected = Boolean(data.connected);
				wsLastError = (data.last_ws_error as { ts_ms: number; code: string; message: string } | null) ?? null;
				wsFrames = Number((data.counts as { n_frames?: number } | undefined)?.n_frames ?? 0);
			}
		} catch {
			// LiveBot is unavailable — leave defaults.
		}
	}

	const services: ServiceEntry[] = [];

	// WS stream — derived from bot status, not from cron_runs.
	{
		const last_ran_ms = wsConnected ? ts_ms : wsLastError?.ts_ms ?? null;
		const status: ServiceEntry["status"] = wsConnected
			? "ok"
			: wsLastError
				? "error"
				: "starting";
		const errSummary = wsLastError ? ` (${wsLastError.code})` : "";
		services.push({
			id: "ws",
			name: "Live WebSocket",
			description: "Stream of orderbook + trade + ticker data from Kalshi.",
			category: "stream",
			status,
			last_ran_ms,
			last_ran_label: last_ran_ms ? relativeLabel(ts_ms - last_ran_ms) : "never connected",
			next_in_ms: null,
			next_label: "—",
			interval_label: "continuous",
			details: wsConnected
				? `connected — ${wsFrames} frames received`
				: wsLastError
					? `${wsLastError.message}${errSummary}`
					: "not connected",
			icon: "📡",
		});
	}

	// Crons.
	for (const cron of cronJobs) {
		const meta = SERVICE_CATALOGUE.find((s) => s.id === cron);
		if (!meta) continue;
		const row = cronByName[cron];
		const last_ran_ms = row?.ts ?? null;
		let status: ServiceEntry["status"] = "ok";
		if (!row) status = "starting";
		else if (row.status === "error") status = "error";

		// Stuck-cron detection: if a cron hasn't run in
		// 1.5x its expected interval, mark as "stale" so
		// the operator notices. The next_in_ms field on the
		// response will already show "in X" — when that
		// number goes negative, the operator gets the same
		// signal. The status field is the explicit one.
		if (last_ran_ms !== null && meta.interval_ms > 0) {
			const overdueBy = ts_ms - (last_ran_ms + meta.interval_ms);
			if (overdueBy > meta.interval_ms * 0.5) {
				status = "stale";
			}
		}

		const next_in_ms =
			last_ran_ms !== null && meta.interval_ms > 0
				? Math.max(0, last_ran_ms + meta.interval_ms - ts_ms)
				: null;

		services.push({
			id: cron,
			name: meta.name,
			description: meta.description,
			category: meta.category,
			status,
			last_ran_ms,
			last_ran_label: last_ran_ms ? relativeLabel(ts_ms - last_ran_ms) : "never run",
			next_in_ms,
			next_label: nextLabelFromNow(next_in_ms),
			interval_label: meta.interval_label,
			details: detailsFromCron(row),
			icon: meta.icon,
		});
	}

	// LLM calls — synthesized from llm_calls table (last 24h aggregate).
	{
		const lastLlm = await (env.DB
			? env.DB
					.prepare(
						`SELECT * FROM llm_calls WHERE user_id = ?1 ORDER BY ts DESC LIMIT 1`,
					)
					.bind(user_id)
					.first<LlmCallRow>()
			: Promise.resolve(null));
		const last_ran_ms = lastLlm?.ts ?? null;
		const status: ServiceEntry["status"] = !lastLlm ? "off" : lastLlm.status === "error" ? "error" : "ok";
		services.push({
			id: "llm",
			name: "LLM calls",
			description: "Daily recap, news verdicts, and (in chunk 11) backtest summaries.",
			category: "llm",
			status,
			last_ran_ms,
			last_ran_label: last_ran_ms ? relativeLabel(ts_ms - last_ran_ms) : "never called",
			next_in_ms: null,
			next_label: "on cron",
			interval_label: "on demand + cron",
			details: latestLlm
				? `${latestLlm.n_calls} calls in 24h, ${latestLlm.input_tokens.toLocaleString()} in / ${latestLlm.output_tokens.toLocaleString()} out tokens`
				: "no LLM usage in 24h",
			icon: "✨",
		});
	}

	// Model registry (already computed for the train-cron).
	{
		const lastModel = modelRows[0];
		const last_ran_ms = lastModel?.deployed_at ?? lastModel?.retired_at ?? null;
		const status: ServiceEntry["status"] = modelRows.length === 0 ? "starting" : "ok";
		services.push({
			id: "model_registry",
			name: "Model registry",
			description: "Source of truth for which model version is active per vertical.",
			category: "model",
			status,
			last_ran_ms,
			last_ran_label: last_ran_ms ? relativeLabel(ts_ms - last_ran_ms) : "no models yet",
			next_in_ms: null,
			next_label: "on train cron",
			interval_label: "managed by train cron",
			details: detailsFromModel(modelRows),
			icon: "🧬",
		});
	}

	const summary = {
		n_services: services.length,
		n_ok: services.filter((s) => s.status === "ok" || s.status === "running").length,
		n_error: services.filter((s) => s.status === "error").length,
		n_off: services.filter((s) => s.status === "off").length,
		n_starting: services.filter((s) => s.status === "starting").length,
		n_stale: services.filter((s) => s.status === "stale").length,
	};

	return Response.json(
		{ ok: true, ts_ms, services, summary },
		{ headers: { "cache-control": "public, max-age=30" } },
	);
}
