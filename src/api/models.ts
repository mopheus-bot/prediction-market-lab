/**
 * prediction-market-lab — model registry API.
 *
 * Read + write endpoints for the `models` D1 table. The
 * table is the source of truth for "which model_version
 * is active for which vertical." The LiveBot reads from
 * here on /start (replacing the step-4 `config.model_version`
 * field as the source of truth).
 *
 * **Endpoints:**
 *   - `GET    /api/pm/models`                  — list all model versions
 *   - `GET    /api/pm/models/active`          — list active models per vertical
 *   - `GET    /api/pm/models/:version`        — get a single model version
 *   - `POST   /api/pm/models/register`        — register a new model (status=candidate)
 *   - `POST   /api/pm/models/promote`         — promote a candidate to active
 *                                              (retires the current active)
 *   - `POST   /api/pm/models/retire`          — retire a model (status=retired)
 *
 * **Auth:** CF Access sits in front of `/api/pm/*`. No
 * additional auth in the handlers.
 *
 * **Multi-tenant:** all queries scope to the default
 * user. The (user_id, version) PK in the `models` table
 * is per-user; a future multi-tenant refactor just changes
 * the user_id passed in.
 */

import { models as modelsDb } from "../lib/db.js";
import {
	DEFAULT_USER_ID,
	type ModelRow,
	type Vertical,
} from "../lib/types.js";

export interface ModelRegistryEnv {
	DB?: D1Database;
	BUCKET?: R2Bucket;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function err(message: string, status = 500): Response {
	return json({ ok: false, error: message }, status);
}

const VALID_VERTICALS: ReadonlyArray<Vertical> = [
	"weather",
	"economic",
	"politics",
	"sports",
];

function isVertical(s: string): s is Vertical {
	return (VALID_VERTICALS as ReadonlyArray<string>).includes(s);
}

// ─── List + get ──────────────────────────────────────────────────────

/** GET /api/pm/models?status=&vertical= */
export async function handleListModels(
	env: ModelRegistryEnv,
	url: URL,
): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	try {
		const status = url.searchParams.get("status") as
			| "candidate"
			| "active"
			| "retired"
			| "shadow"
			| null;
		const vertical = url.searchParams.get("vertical");
		const rows = await modelsDb.list(env.DB, DEFAULT_USER_ID, {
			status: status ?? undefined,
			vertical: vertical && isVertical(vertical) ? vertical: undefined,
		});
		return json({ ok: true, n: rows.length, models: rows });
	} catch (e) {
		return err(e instanceof Error ? e.message: String(e));
	}
}

/** GET /api/pm/models/active */
export async function handleGetActiveModels(
	env: ModelRegistryEnv,
): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	try {
		const out: Record<string, ModelRow> = {};
		for (const v of VALID_VERTICALS) {
			const m = await modelsDb.getActive(env.DB, DEFAULT_USER_ID, v);
			if (m) out[v] = m;
		}
		return json({ ok: true, active: out });
	} catch (e) {
		return err(e instanceof Error ? e.message: String(e));
	}
}

/** GET /api/pm/models/:version */
export async function handleGetModel(
	env: ModelRegistryEnv,
	version: string,
): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	try {
		const rows = await modelsDb.list(env.DB, DEFAULT_USER_ID);
		const match = rows.find((r) => r.version === version);
		if (!match) return json({ ok: false, found: false }, 404);
		return json({ ok: true, model: match });
	} catch (e) {
		return err(e instanceof Error ? e.message: String(e));
	}
}

// ─── Register / promote / retire ────────────────────────────────────

interface RegisterBody {
	version: string;
	vertical: Vertical;
	artifact_path?: string;
	trained_on_data_until?: number;
	train_metrics_json?: string;
	notes?: string;
}

/** POST /api/pm/models/register */
export async function handleRegisterModel(
	env: ModelRegistryEnv,
	request: Request,
): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	let body: RegisterBody;
	try {
		body = (await request.json()) as RegisterBody;
	} catch {
		return err("invalid JSON body", 400);
	}
	if (!body?.version) return err("version is required", 400);
	if (!body?.vertical || !isVertical(body.vertical)) {
		return err(`vertical must be one of: ${VALID_VERTICALS.join(", ")}`, 400);
	}
	try {
		await modelsDb.upsert(env.DB, {
			user_id: DEFAULT_USER_ID,
			version: body.version,
			vertical: body.vertical,
			artifact_path:
				body.artifact_path ?? `models/reversion-${body.vertical}-${body.version}.json`,
			trained_on_data_until: body.trained_on_data_until ?? null,
			train_metrics_json: body.train_metrics_json ?? null,
			deployed_at: null,
			retired_at: null,
			status: "candidate",
			notes: body.notes ?? null,
		});
		return json({ ok: true, registered: body.version, vertical: body.vertical });
	} catch (e) {
		return err(e instanceof Error ? e.message: String(e));
	}
}

interface PromoteBody {
	version: string;
	vertical: Vertical;
}

/** POST /api/pm/models/promote
 *
 * Sets the (user_id, version) row to status=active, and
 * retires the current active row for the same vertical.
 * If the version is already active, this is a no-op
 * (idempotent).
 */
export async function handlePromoteModel(
	env: ModelRegistryEnv,
	request: Request,
): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	let body: PromoteBody;
	try {
		body = (await request.json()) as PromoteBody;
	} catch {
		return err("invalid JSON body", 400);
	}
	if (!body?.version) return err("version is required", 400);
	if (!body?.vertical || !isVertical(body.vertical)) {
		return err(`vertical must be one of: ${VALID_VERTICALS.join(", ")}`, 400);
	}
	try {
		const now = Date.now();
		// 1. Retire the current active row for this vertical.
		const current = await modelsDb.getActive(
			env.DB,
			DEFAULT_USER_ID,
			body.vertical,
		);
		if (current && current.version !== body.version) {
			await modelsDb.setStatus(
				env.DB,
				DEFAULT_USER_ID,
				current.version,
				"retired",
				now,
			);
		}
		// 2. Promote the new version. The row may not exist
		//    yet (the caller can register + promote in two
		//    steps, or just promote a known version that
		//    was uploaded to R2 directly).
		const rows = await modelsDb.list(env.DB, DEFAULT_USER_ID);
		const exists = rows.find((r) => r.version === body.version);
		if (!exists) {
			// Create on the fly with status=active and
			// artifact_path = models/reversion-{vertical}-{version}.json
			// (the conventional path the bot reads from).
			await modelsDb.upsert(env.DB, {
				user_id: DEFAULT_USER_ID,
				version: body.version,
				vertical: body.vertical,
				artifact_path: `models/reversion-${body.vertical}-${body.version}.json`,
				trained_on_data_until: null,
				train_metrics_json: null,
				deployed_at: now,
				retired_at: null,
				status: "active",
				notes: null,
			});
		} else {
			await modelsDb.setStatus(
				env.DB,
				DEFAULT_USER_ID,
				body.version,
				"active",
				now,
			);
		}
		return json({
			ok: true,
			promoted: body.version,
			vertical: body.vertical,
			retired: current?.version ?? null,
			deployed_at: now,
		});
	} catch (e) {
		return err(e instanceof Error ? e.message: String(e));
	}
}

interface RetireBody {
	version: string;
}

/** POST /api/pm/models/retire */
export async function handleRetireModel(
	env: ModelRegistryEnv,
	request: Request,
): Promise<Response> {
	if (!env.DB) return err("DB binding missing");
	let body: RetireBody;
	try {
		body = (await request.json()) as RetireBody;
	} catch {
		return err("invalid JSON body", 400);
	}
	if (!body?.version) return err("version is required", 400);
	try {
		await modelsDb.setStatus(
			env.DB,
			DEFAULT_USER_ID,
			body.version,
			"retired",
			Date.now(),
		);
		return json({ ok: true, retired: body.version });
	} catch (e) {
		return err(e instanceof Error ? e.message: String(e));
	}
}
