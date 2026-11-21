# Strategy and ONNX-style models (2026-08-08)

The ML inference path lands. RandomForest models are converted
from sklearn `.joblib` to a flat JSON tree format, loaded
from R2, and run through a pure-TS inference engine (no
external deps, no WASM). The 20-dim feature vector is ported
from Python with documented live-vs-synthetic gaps. The
per-vertical router now uses the reversion-quality model for
weather + economic (per the 2026-08-04 sweep) and NaiveSignal
for politics + sports.

## What ships

### New modules

- `src/strategy/forest.ts` — `RandomForestModel` (immutable
  inference engine) + `loadForestFromJSON()`. Reads the
  flat JSON tree format and produces `predict_proba`-style
  class probabilities. The walker is a tight loop over typed
  arrays (`Int32Array` for node references, `Float64Array`
  for thresholds and leaf values). No external deps.

- `src/strategy/features.ts` — `extractFeatures(ctx)` +
  `FEATURE_NAMES` + the per-vertical `FUNDAMENTAL_FEATURES_BY_VERTICAL`
  index. Mirrors `Prediction Market Lab/.../features.py:extract_features`.
  20-dim output: 8 numeric + 4 one-hot + 8 fundamentals.

- `src/strategy/reversion.ts` — `ReversionQualitySignal`.
  Mirrors `model/reversion.py:ReversionQualitySignal`. Takes
  a `RandomForestModel`, computes `p_revert` from the model,
  compares the current price to the rolling mean, and
  fades the deviation with the appropriate side.

- `src/strategy/model-loader.ts` — `loadModelFromR2(env,
  vertical, version)` + `loadModelFromInline(json)`. The
  R2 path is the production path; the inline path is the
  test path. Both return `RandomForestModel | null`; null
  means "fall back to NaiveSignal."

### Updated

- `src/strategy/router.ts` — default profiles now use
  `ReversionQualitySignal` for weather + economic when a
  reversion model is supplied, and `NaiveSignal` for
  politics + sports. Single-strategy profiles (the default)
  bypass the agreement stacker. Multi-strategy profiles
  still go through the agreement-only stacker (mirrors
  the Python `StackedMetaRouter`).

- `src/strategy/index.ts` — barrel export extended with
  `reversion`, `forest`, `features`, `model-loader`.

- `src/durable-objects/LiveBot.ts`:
  - New `LiveBotState.config.model_version` (default `"v1"`).
  - New `LiveBotConfig.model_version` (override at /start).
  - New private `_models: { weather, economic }` cache.
  - `start()` calls `loadModels(version)` after opening the
    Kalshi WS; failure to load is non-fatal (engine falls
    back to `NaiveSignal` for the affected vertical).
  - `maybeSignalAll()` builds the router with the loaded
    models. Verticals without a loaded model use the
    default profile (NaiveSignal).
  - `loadModels(version)` fetches the weather + economic
    models from R2 in parallel via `env.BUCKET.get()`.
  - The bot's `/status` output now includes the loaded
    model metadata (count, version) for diagnostics.

### New scripts

- `scripts/convert-models-to-json.py` — one-shot helper
  that takes a `.joblib` (the Python trainer's output)
  and emits the flat JSON tree format. Accepts both
  wrapped dicts (`{"model": RandomForestClassifier,...}`)
  and bare classifiers.

- `scripts/verify-model-parity.py` — runs the original
  `.joblib` model and a set of hand-crafted feature
  vectors through `predict_proba`, and writes a
  `test/fixtures/model-parity-{vertical}.json` fixture
  that the TS inference tests import.

### New artifacts (committed)

- `models/reversion-{weather,economic,politics,sports}-v1.json` —
  the converted models (~1MB total, parsed once per bot start).

- `test/fixtures/model-parity-{vertical}.json` — the parity
  fixture (7 hand-crafted feature vectors per vertical,
  with the expected `predict_proba` output from the.joblib).

## Why a flat JSON tree, not ONNX

The plan called for ONNX conversion via `skl2onnx`. We
went with a hand-rolled flat-JSON format instead because:

1. **No runtime dep.** `onnxruntime-web` is a ~5MB WASM
   blob that's loaded at runtime — fine for a Worker but
   heavy for a Durable Object's first request. The flat
   JSON walker is ~150 lines of TS and runs in <1ms per
   inference (200 trees * ~50 nodes = 10K comparisons per
   call).
2. **Trivial to ship.** The.joblib → JSON converter is
   ~50 lines of Python. No skl2onnx dep, no onnx runtime
   to keep updated.
3. **1e-9 parity** with the original `.joblib` (verified
   by `scripts/verify-model-parity.py` + the `forest.test.ts`
   parity check).

The trade-off: when  swaps to a real model upgrade
path (e.g. gradient-boosted trees, neural nets, etc.), we'd
need a different format. The flat-JSON approach is fine for
the RandomForest family.

## The 20-feature gap (live vs. synthetic)

The Python trainer's reversion model uses 20 features.
The live paper engine has access to:

| Feature | Source | Live availability |
|---|---|---|
| price, spread, orderbook_imbalance | orderbook | yes |
| time_to_resolution | market.createdAtTick + ttlSeconds | partial (we default to 0.5) |
| volatility | price history | yes |
| news_shock_magnitude, news_shock_age_hours | sim shock tracking | NO (defaults to 0) |
| recent_move_pct | price history | yes |
| vertical one-hot (4) | market.vertical | yes |
| per-vertical fundamentals (8) | market.fundamentals | NO (defaults to 0) |

The model was trained on synthetic data with all 20
features populated. At live inference, 9 of the 20
features default to 0 — the model will see them as
"no info available" and ignore them (the model's
feature_importances shows the relevant ones for live
are price, spread, recent_move_pct, and the vertical
one-hot).

**Forward work ( — model registry + shadow mode):**
retrain on live trade data. The `train_reversion_quality_model_from_trades`
in the Python repo already supports this. When the
retrain lands, the JSON conversion + parity check is
the same — only the model artifacts change.

## Multi-tenant

Models are loaded per-DO (one DO per user). R2 access
goes through `env.BUCKET` which the Worker routes per
the user's CF Access policy. The model artifacts are
shared across all users (they're just files in R2); the
DO is per-user. A future "per-tenant model" feature
would be a per-user R2 prefix.

## Tests

- 28 new forest tests (parity, walker, format, batch, errors).
- 6 new reversion tests (validation, walker, signal shape).
- 14 new feature tests (every named feature, live vs synthetic
  defaults, batch).
- 6 new model-loader tests (R2 happy path, R2 missing, R2
  error, inline parse, malformed JSON, key builder).

**Total:** 114 tests, all pass.

| Project | Tests | Time |
|---|---|---|
| Unit (`npm run test:unit`) | 81 | ~0.14s |
| Integration (`npm run test:integration`) | 33 | ~0.5s |
| All (`npm test`) | 114 | ~1s |

## Verification

- `tsc --noEmit` — clean.
- `npm run test:unit` — 81/81 pass in ~0.14s.
- `npm run test:integration` — 33/33 pass in ~0.5s.
- `npm test` — 114/114 in ~1s.
- `wrangler deploy --dry-run` — bindings look right, DO
  registered, models NOT in the bundle (loaded from R2
  on /start).

## Operational notes

### Loading the models into R2

After deploy, upload the converted models to the R2 bucket
so the bot can find them:

```bash
cd prediction-market-lab
# (bucket already exists; the wrangler.jsonc creates it on
# first deploy)
for v in weather economic politics sports; do
  npx wrangler r2 object put prediction-market-lab/models/reversion-${v}-v1.json \
    --file models/reversion-${v}-v1.json
done
```

(Or just `npx wrangler r2 bulk put` from a manifest.)

### Switching model version

```bash
# Generate v2 models (after retrain in the Python repo)
python3 scripts/convert-models-to-json.py --in <new>.joblib --out models/reversion-weather-v2.json
npx wrangler r2 object put prediction-market-lab/models/reversion-weather-v2.json --file models/reversion-weather-v2.json
# Tell the bot to use v2 (no restart of the WS needed):
curl -X POST -H "content-type: application/json" \
  -d '{"model_version":"v2"}' \
  api/pm/bot/start
```

## What's still TODO (forward work)

- ** (cron jobs)**: the daily-recap cron reads
  `models` to log the active model version. The
  `/api/pm/cron/{scan,news,daily,train}` endpoints don't
  exist yet.

- ** (status API + Telegram)**: the live trades
  + model_version need to be queryable via the status
  API; the dashboard's per-vertical breakdown shows which
  model is active.

- ** (model registry + shadow mode + retrain)**: the
  `models` D1 table is the source of truth for "active
  model_version per vertical."  wires the D1 row
  into the bot's loadModels() so changing the active
  row flips the running model. The Python
  `train_reversion_quality_model_from_trades` is the
  retrain entry point.
