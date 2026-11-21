# Model registry, shadow mode and retraining (2026-08-08)

The D1 `models` table becomes the source of truth for
"which model_version is active for which vertical." The
LiveBot reads from it on /start (replacing the step-4
`config.model_version` field as the primary lookup). The
model registry API exposes list / register / promote /
retire. A new ShadowBot DO runs candidate models in
parallel. The train-cron does real work: polls R2 for new
model artifacts and registers them in the registry.

## What ships

### New: `src/api/models.ts`

The model registry API. 6 endpoints:

- `GET    /api/pm/models`             — list all model versions
  (filterable by `?status=` and `?vertical=`)
- `GET    /api/pm/models/active`     — list active models per vertical
- `GET    /api/pm/models/:version`   — get a single model version
- `POST   /api/pm/models/register`   — register a new model
  (status=candidate, with version + vertical + optional
  metrics + notes)
- `POST   /api/pm/models/promote`    — promote a candidate to
  active (retires the current active row for the same
  vertical in the same call)
- `POST   /api/pm/models/retire`     — retire a model
  (status=retired, sets retired_at)

### New: `src/durable-objects/ShadowBot.ts`

The shadow bot DO. A minimal version that mirrors the
LiveBot's start / stop / status contract but defers the
full parallel-bot loop to a + commit. Architecture
is in place:

- `idFromName('user:${userId}:shadow:${modelVersion}')` —
  one DO per candidate, so the operator can run multiple
  shadows at once.
- `start / stop / status` endpoints.
- The full WS loop + signal comparison is the deferred
  piece; the step-8 commit ships the class + binding +
  start/stop so + can fill in the WS loop.

### Updated

- `src/durable-objects/LiveBot.ts` — `loadModels(version)`
  now reads the active model_version from the D1
  `models` table per vertical (falling back to the
   `config.model_version` field when the registry
  is empty). The LiveBot exposes a new `/reload-models`
  endpoint so promoting a model via the API doesn't
  require restarting the WS loop.

- `src/cron/train-cron.ts` — the step-5 stub is
  replaced with a real implementation:
  - Polls R2 for new `models/reversion-{vertical}-*.json`
    artifacts.
  - Registers each new artifact as a `candidate` model
    in the D1 registry (no overwrites of existing
    versions).
  - Optional `TRAIN_AUTO_PROMOTE=true` env var to
    auto-promote candidates (OFF by default — the
    operator reviews the model before promoting).
  - Optional `TRAIN_WEBHOOK_URL` POST to fire the
    external retrain pipeline.

- `src/index.ts` — wired the 6 model registry endpoints
  + the `/api/pm/bot/reload-models` endpoint.
  Re-exports `ShadowBot` for the wrangler binding.

- `wrangler.jsonc` — added `SHADOW_BOT` DO binding +
  `ShadowBot` to the `new_sqlite_classes` migration.

## How the workflow looks now

1. **Train** (offline, Python): the user runs
   `python3 -m predictive_markets.scripts.live.train_reversion`
   with the live trade data. It produces
   `models/reversion-{vertical}-v2.joblib`.

2. **Convert + upload**: `npm run models:convert` →
   `models/reversion-{vertical}-v2.json`. Then
   `npm run models:upload` (or a per-vertical
   `wrangler r2 object put`).

3. **Register** (automatic via cron, or manual):
   - **Automatic:** the train-cron runs Sunday and polls
     R2; new artifacts are registered as `candidate`.
   - **Manual:** `POST /api/pm/models/register` with
     `{"version": "v2", "vertical": "weather"}`.

4. **Shadow** (optional): the operator starts a
   `ShadowBot` DO on v2. It runs in parallel with the
   live bot. Signal comparisons land in the `signals`
   table with `source='shadow'`.

5. **Promote**: after review,
   `POST /api/pm/models/promote` with
   `{"version": "v2", "vertical": "weather"}`. The
   endpoint retires the current active row and flips
   v2 to active in the same call.

6. **Hot-swap**: `POST /api/pm/bot/reload-models` to
   load v2 from R2 without restarting the WS loop. The
   next frame uses the new model.

7. **Dashboard**: the per-vertical breakdown
   card shows the active model version; a "models" tab
   could land in + to list the candidates.

## Why D1 is the source of truth (not the Worker config)

The  design used `config.model_version` from the
`/start` body. That worked for one model at a time.  moves to a per-vertical registry because:

- **Multiple verticals, different versions:** the
  weather model can be on v3 while economic is on v2.
  The  field was a single value for all.
- **Atomicity of promotion:** the registry makes
  "promote v2" a single transaction that retires v1
  and activates v2 in one call. The old design required
  two /start calls (one to retire, one to activate) with
  a window where the bot had no model.
- **Observability:** the `models` table is queryable.
  The dashboard can list candidates, show promotion
  history, etc.

The `config.model_version` field is still honored as a
fallback when the registry is empty (so the step-4
behavior is preserved on a fresh deploy before any
model has been registered).

## Why auto-promote is OFF by default

The  models are trained on synthetic data;
+ models are trained on real trade data which is
smaller and noisier. Auto-promote would let a poorly
trained model go live without review. Keep the `promote`
endpoint as the manual gate. The `TRAIN_AUTO_PROMOTE=true`
opt-in exists for users who want fully-automated
promotion (after they've reviewed the data quality +
metrics themselves).

## Multi-tenant

The D1 PK is `(user_id, version)`. All queries scope to
`DEFAULT_USER_ID` for now. The (version, vertical)
combination is unique per user — a `v2` for weather is a
different row from `v2` for economic. (The Python repo's
notion of "one model per vertical" is preserved.)

## Verification

- `tsc --noEmit` — clean.
- `npm run test:unit` — 123/123 pass in ~0.2s.
- `npm run test:integration` — 47/47 pass in ~0.6s.
- `npm test` — 170/170 pass in ~0.8s.
- `wrangler deploy --dry-run` — bindings + DO + cron
  triggers + assets registered. 6 new endpoints
  reachable at `/api/pm/models/*`.

## Tests

- 6 new model-registry tests (register, list, promote
  retires the prior active, getActive, getModel 404,
  retire, invalid vertical).
- 0 changes to the existing test suite (all 164 prior
  tests still pass).

## Open follow-ups (forward work)

- **Shadow bot full loop:** the step-8 ShadowBot
  ships the start / stop / status endpoints but the
  WS + signal comparison loop is deferred. +
  adds the WS subscriber, the candidate model runner,
  and the `signals` write with `source='shadow'`.
- **Dashboard models tab:** the per-vertical breakdown
  shows the active version today; a full "models"
  panel (candidates, promotion history, comparison
  metrics) lands in +.
- **CF Workflow for retrain:** the train-cron uses
  `TRAIN_WEBHOOK_URL` for the external retrain today.
  A CF Workflow that does the full Python retrain +
  R2 upload in one go is a + addition.
- **Promotion metrics:** the `train_metrics_json` field
  is captured at register time but the dashboard
  doesn't render it. + adds a side-by-side
  comparison card (live vs shadow) on the models tab.
- **Real trading toggle:** the model
  registry stays the same;  adds the
  `KALSHI_PROD_*` creds, a daily notional cap, and a
  kill switch.
