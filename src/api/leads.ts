/**
 * pm-bot — leads API (chunk 11+).
 *
 * The frontend for the leads-cron. The cron (daily 02:00 UTC)
 * writes LLM-generated add+drop suggestions to the
 * `lead_suggestions` table; the operator reviews them on the
 * Dev page and clicks Approve / Reject.
 *
 * Endpoints:
 *
 *   GET  /api/pm/leads
 *     → { ok, pending: [...], history: [...], last_run: { ts, n_add, n_drop, n_excluded, n_superseded, overall_reasoning } }
 *
 *   POST /api/pm/leads/:id/approve
 *     → applies the suggestion to the bot's universe and
 *       restarts. For an `add` suggestion, the ticker is
 *       appended to state.config.tickers and the vertical
 *       mapping is set. For a `drop` suggestion, the ticker
 *       is removed. Either way we POST /api/pm/bot/start
 *       (idempotent) to apply the change.
 *
 *   POST /api/pm/leads/:id/reject
 *     → marks the row rejected; the cron will not re-suggest
 *       this ticker for 30 days.
 *
 * **Why operator-approved, not auto-apply:** the LLM can
 * hallucinate tickers. The user explicitly chose manual
 * approval (2026-08-09) — they see the suggestion with
 * reasoning, decide yes/no, and the bot reflects their
 * decision. Auto-apply with a confidence threshold is a
 * future extension once we have ground truth on the LLM's
 * hit rate.
 *
 * **Idempotency on approve:** approving the same row twice
 * is a no-op (the SQL `setStatus` requires status='pending').
 * If the operator clicks twice, the second click returns
 * 409 Conflict and the bot isn't restarted twice.
 *
 * **Cache-Control: no-store** on every endpoint because the
 * Dev page polls every 10s and the suggestion set can change
 * between renders (operator clicks → row moves pending →
 * history).
 */

import { DEFAULT_USER_ID, type LeadSuggestionRow } from "../lib/types.js";
import { leadSuggestions as leadSuggestionsDb, cronRuns as cronRunsDb } from "../lib/db.js";

export interface LeadsEnv {
	DB?: D1Database;
	LIVE_BOT?: DurableObjectNamespace;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

const DEFAULT_USER = DEFAULT_USER_ID;

export async function handleGetLeads(env: LeadsEnv, _url: URL): Promise<Response> {
	if (!env.DB) {
		return Response.json({ ok: false, error: "no_db" }, { status: 503, headers: NO_STORE });
	}
	const { pending, history } = await leadSuggestionsDb
		.listRecent(env.DB, DEFAULT_USER, { limit: 25 })
		.catch((e) => {
			console.error("[leads] listRecent failed", e);
			return { pending: [], history: [] };
		});

	// Surface the most recent cron run's summary so the
	// Dev page can show "last run: added 2, dropped 0,
	// 1 excluded (already in universe)" next to the panel.
	const lastRun = await cronRunsDb
		.lastRun(env.DB, "leads", DEFAULT_USER)
		.catch(() => null);

	let lastRunSummary: Record<string, unknown> | null = null;
	if (lastRun) {
		try {
			const a = JSON.parse(lastRun.artifacts_json ?? "{}");
			lastRunSummary = {
				ts: lastRun.ts,
				ok: lastRun.status === "success",
				duration_ms: lastRun.duration_ms,
				n_add: a.n_add ?? 0,
				n_drop: a.n_drop ?? 0,
				n_excluded: a.n_excluded ?? 0,
				n_superseded: a.n_superseded ?? 0,
				overall_reasoning: a.overall_reasoning ?? "",
				llm_input_tokens: a.llm_input_tokens ?? null,
				llm_output_tokens: a.llm_output_tokens ?? null,
			};
		} catch {
			// Ignore — leave summary null.
		}
	}

	return Response.json(
		{
			ok: true,
			pending,
			history,
			last_run: lastRunSummary,
		},
		{ headers: NO_STORE },
	);
}

export async function handleApproveLead(env: LeadsEnv, id: number): Promise<Response> {
	if (!env.DB) {
		return Response.json({ ok: false, error: "no_db" }, { status: 503, headers: NO_STORE });
	}
	const row = await leadSuggestionsDb.getById(env.DB, id, DEFAULT_USER);
	if (!row) {
		return Response.json({ ok: false, error: "not_found" }, { status: 404, headers: NO_STORE });
	}
	if (row.status !== "pending") {
		return Response.json(
			{
				ok: false,
				error: "already_decided",
				status: row.status,
				message: `suggestion ${id} is already ${row.status}`,
			},
			{ status: 409, headers: NO_STORE },
		);
	}

	// Apply to the bot. Read current state, mutate the
	// ticker set, then POST /start. The /start endpoint
	// re-reads ticker_verticals from the body, so we pass
	// the new mapping explicitly.
	const applied = await applyToBot(env, row);
	if (!applied.ok) {
		// Don't mark approved if the apply failed — the
		// operator can retry. The status stays pending.
		return Response.json(applied, { status: 500, headers: NO_STORE });
	}

	const now = Date.now();
	const ok = await leadSuggestionsDb.setStatus(env.DB, id, DEFAULT_USER, "approved", now);
	if (!ok) {
		// Race: someone (or another approve click) decided
		// this row first. The bot was restarted but we
		// couldn't record the decision. Log and surface.
		console.warn(`[leads] race on approve id=${id}: setStatus returned false`);
		return Response.json(
			{
				ok: false,
				error: "race",
				message: "bot was restarted but the decision could not be recorded",
			},
			{ status: 409, headers: NO_STORE },
		);
	}

	// Mark the apply-side effect (the cron_runs.id of the
	// bot restart, when we have one). For now we don't
	// record a cron_runs row for the /start call, so we
	// leave applied_run_id null and only stamp the timestamp.
	await leadSuggestionsDb
		.markApplied(env.DB, id, DEFAULT_USER, now, applied.applied_run_id ?? null)
		.catch((e) => console.warn("[leads] markApplied failed", e));

	return Response.json(
		{
			ok: true,
			approved: true,
			id,
			kind: row.kind,
			ticker: row.ticker,
			vertical: row.vertical,
			applied: applied,
		},
		{ headers: NO_STORE },
	);
}

export async function handleRejectLead(env: LeadsEnv, id: number): Promise<Response> {
	if (!env.DB) {
		return Response.json({ ok: false, error: "no_db" }, { status: 503, headers: NO_STORE });
	}
	const row = await leadSuggestionsDb.getById(env.DB, id, DEFAULT_USER);
	if (!row) {
		return Response.json({ ok: false, error: "not_found" }, { status: 404, headers: NO_STORE });
	}
	if (row.status !== "pending") {
		return Response.json(
			{
				ok: false,
				error: "already_decided",
				status: row.status,
			},
			{ status: 409, headers: NO_STORE },
		);
	}
	const ok = await leadSuggestionsDb.setStatus(env.DB, id, DEFAULT_USER, "rejected", Date.now());
	if (!ok) {
		return Response.json({ ok: false, error: "race" }, { status: 409, headers: NO_STORE });
	}
	return Response.json(
		{ ok: true, rejected: true, id, ticker: row.ticker, kind: row.kind },
		{ headers: NO_STORE },
	);
}

// ─── Internal helpers ──────────────────────────────────────────────

/** Apply a single lead suggestion to the bot's universe.
 *  Reads state, mutates, calls /start. Returns a small
 *  status object the caller can surface to the operator. */
async function applyToBot(
	env: LeadsEnv,
	row: LeadSuggestionRow,
): Promise<{ ok: boolean; error?: string; new_universe?: string[]; applied_run_id?: number | null; bot_response?: unknown }> {
	if (!env.LIVE_BOT) {
		return { ok: false, error: "no_live_bot" };
	}
	try {
		const id = env.LIVE_BOT.idFromName(`user:${DEFAULT_USER}`);
		const stub = env.LIVE_BOT.get(id);

		// Read current state so we can mutate correctly.
		const statusResp = await stub.fetch("https://bot/status");
		if (!statusResp.ok) {
			return { ok: false, error: `bot status ${statusResp.status}` };
		}
		const statusData = (await statusResp.json()) as {
			config?: {
				tickers?: string[];
				ticker_verticals?: Record<string, string>;
			};
		};
		const cfg = statusData.config ?? {};
		const currentTickers = Array.isArray(cfg.tickers) ? cfg.tickers : [];
		const currentVerticals = cfg.ticker_verticals ?? {};

		// Build the new universe.
		let newTickers: string[];
		let newVerticals: Record<string, string>;
		if (row.kind === "add") {
			if (currentTickers.includes(row.ticker)) {
				// Already there (race?). No-op but return ok.
				return { ok: true, new_universe: currentTickers, bot_response: { already_in_universe: true } };
			}
			newTickers = [...currentTickers, row.ticker];
			// IMPORTANT: the bot's /start uses
			// Object.keys(ticker_verticals) as the source
			// of truth for the ticker list (not
			// config.tickers directly). So we MUST populate
			// ticker_verticals for every ticker, not just
			// the new one. Without this, /start would only
			// see the new ticker in the verticals map and
			// the rest of the universe would be silently
			// dropped.
			//
			// For tickers that don't yet have a vertical
			// mapping (e.g. the bot was started with
			// ticker_verticals={}), fall back to "unknown"
			// — the live book will populate the real
			// vertical on the first frame.
			newVerticals = { ...currentVerticals };
			for (const t of newTickers) {
				if (!newVerticals[t]) {
					newVerticals[t] = "unknown";
				}
			}
			newVerticals[row.ticker] = row.vertical ?? "unknown";
		} else {
			// drop
			if (!currentTickers.includes(row.ticker)) {
				// Already gone (race?). No-op.
				return { ok: true, new_universe: currentTickers, bot_response: { not_in_universe: true } };
			}
			newTickers = currentTickers.filter((t) => t !== row.ticker);
			newVerticals = { ...currentVerticals };
			delete newVerticals[row.ticker];
			// Same rule as above: populate verticals for
			// every remaining ticker so /start doesn't
			// silently drop them.
			for (const t of newTickers) {
				if (!newVerticals[t]) {
					newVerticals[t] = "unknown";
				}
			}
		}

		// POST /start with the new universe. The bot's
		// /start handler accepts {tickers, ticker_verticals}
		// and reconfigures without dropping WS state.
		const startResp = await stub.fetch("https://bot/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				tickers: newTickers,
				ticker_verticals: newVerticals,
			}),
		});
		const startData = (await startResp.json().catch(() => ({}))) as Record<string, unknown>;
		if (!startResp.ok) {
			return { ok: false, error: `bot /start ${startResp.status}`, bot_response: startData };
		}
		return {
			ok: true,
			new_universe: newTickers,
			bot_response: startData,
		};
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
