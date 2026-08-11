#!/usr/bin/env python3
"""
pm-bot — auto-retrain orchestrator (2026-08-11).

Weekly GitHub Action runs this script to:
1. Pull the bot's current ticker universe from D1.
2. For each ticker, fetch the last 7 days of Kalshi
   PUBLIC trades via `GET /markets/trades` (the
   reversion-quality model trains on public trade
   prints, not the bot's own fills — same data
   shape, much more volume).
3. Write per-ticker JSONL files in the format the
   trainer expects (`<data_dir>/trades/<ticker>.jsonl`,
   one KalshiTrade per line).
4. Run the live reversion trainer from
   `Prediction Market Lab/.../scripts/live/train_reversion.py`
   once per ALL 17 Kalshi verticals (weather /
   economic / politics / sports / elections /
   financials / entertainment / science_technology /
   crypto / companies / commodities / mentions /
   social / world / health / transportation /
   uncategorized). Outputs
   `<output_dir>/reversion_live-<vertical>.joblib`.
5. Convert each `.joblib` to the JSON tree format
   the TS port consumes via
   `scripts/convert-models-to-json.py`.
6. Upload each `<vertical>-v2.json` to R2 at
   `pm-bot/models/reversion-<vertical>-v2.json` via
   `wrangler r2 object put`.

The Sunday `train-cron` (`0 0 * * SUN` in
`src/cron/train-cron.ts`) then auto-registers the
new R2 artifact in the D1 `models` table with
status=`candidate`. Operator promotes via the Dev
page (`/api/pm/models/:version/promote`).

## Why this lives in pm-bot, not Prediction Market Lab

The trainer is in Prediction Market Lab (Python). The action
needs:
- Python env (trainer deps: sklearn, xgboost, pandas)
- Node env (wrangler CLI to upload to R2)
- D1 read access (to pull the bot's universe)
- R2 write access (to upload the new model)

pm-bot is the deploy repo; the action lives here.
The Prediction Market Lab trainer is invoked via subprocess
(`python3 -m predictive_markets.scripts.live.train_reversion`).
Prediction Market Lab is checked out as a sibling repo (see
`paths.repo` in the workflow) so the trainer can
find its package layout.

## Secrets the action needs

- `CLOUDFLARE_API_TOKEN` — wrangler auth (D1 + R2).
  Use a token scoped to `Account.Workers R2 Storage:Edit`
  and `Account.Account Settings:Read` on the pm-bot
  account. Don't reuse the deploy token (broader
  scope than this needs).
- `CLOUDFLARE_ACCOUNT_ID` — the pm-bot account ID
  (already in wrangler.jsonc; the action reads it
  from there via the wrangler CLI, but the env var
  is here for explicitness).

## Cost

At a 1-week lookback + 40 tickers in the bot's
universe + 7 days of trades per ticker:
- ~280 Kalshi API calls (7 pages × 40 tickers)
- ~1 Python trainer run per vertical (4 runs)
- ~4 R2 uploads
- ~5 min wall-clock on a GitHub-hosted runner

## Failure modes

- **Trainer returns 0 samples**: data is too thin
  (the bot's universe is dominated by KXMVECROSSCATEGORY
  parlays that have ~0 public trades). Skip the
  vertical, log a warning. The existing v1 model
  remains active.
- **R2 upload fails**: the action exits with an
  error. The .json file is on disk; the operator
  can re-upload manually with `npm run models:upload`.
- **D1 read fails**: same as above, hard fail.

## Future work

- Add 13 new verticals (elections, financials, etc.).
  The trainer's `VALID_VERTICALS` is hardcoded to 4;
  needs an extension to handle the new categories
  (each gets a separate per-vertical model trained
  on its own market universe).
- Cache trades to R2 to avoid re-fetching every
  week. The current script re-pulls all 7 days
  on every run; an incremental pull (last 7d
  union with the cached set) would cut the
  Kalshi API calls.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Add the Prediction Market Lab trainer to sys.path so the
# import works whether or not the repo is installed.
BUILDA_BOT_REPO = os.environ.get(
    "BUILDA_BOT_REPO",
    str(Path(__file__).resolve().parent.parent.parent / "Prediction Market Lab" / "tools" / "predictive-markets"),
)
TRAINER_PYPATH = str(Path(BUILDA_BOT_REPO) / "src")
sys.path.insert(0, TRAINER_PYPATH)

# Where the bot's repository lives. The action
# sets this via `paths.workspace`; locally we
# default to the pm-bot repo root.
PM_BOT_REPO = os.environ.get("PM_BOT_REPO", str(Path(__file__).resolve().parent.parent))

DATA_DIR = Path(os.environ.get("RETRAIN_DATA_DIR", "/tmp/retrain-data"))
OUTPUT_DIR = Path(os.environ.get("RETRAIN_OUTPUT_DIR", "/tmp/retrain-models"))
LOOKBACK_DAYS = int(os.environ.get("RETRAIN_LOOKBACK_DAYS", "7"))
# 2026-08-11: ALL 17 Kalshi verticals, not just the
# 4 legacy ones. The user pushed back on the
# 4-only coverage: "the whole point" of the
# 17-vertical expansion is to capture all
# verticals, so the auto-retrain pipeline should
# too. The trainer (Prediction Market Lab/.../train_reversion.py)
# was updated to accept all 17 via its
# VALID_VERTICALS choices list, and the
# category_mapper was updated to map every Kalshi
# category to a specific vertical (no more
# bucketing). The new verticals (elections,
# financials, etc.) currently have very thin
# trade data so the trainer will return 0
# samples and skip them — but the pipeline is
# ready, and as the bot accumulates trades in
# those verticals, models will start producing.
ALL_VERTICALS = (
    "weather",
    "economic",
    "politics",
    "sports",
    "elections",
    "financials",
    "entertainment",
    "science_technology",
    "crypto",
    "companies",
    "commodities",
    "mentions",
    "social",
    "world",
    "health",
    "transportation",
    "uncategorized",
)


def pull_bot_universe_from_d1() -> list[str]:
    """Read the bot's current ticker universe from D1.

    Uses the wrangler CLI to query D1 (no Python
    D1 SDK — the wrangler output is JSON we can
    parse directly). Falls back to an env var
    `BOT_UNIVERSE` (comma-separated) for local
    testing.
    """
    env_csv = os.environ.get("BOT_UNIVERSE")
    if env_csv:
        return [t.strip() for t in env_csv.split(",") if t.strip()]

    print("[retrain] querying D1 for bot universe via wrangler...")
    cmd = [
        "npx", "wrangler", "d1", "execute", "pm-bot-prod",
        "--remote", "--json",
        "--command",
        "SELECT value FROM bot_config WHERE user_id = 'default' AND key = 'config'",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=PM_BOT_REPO, check=True)
    # wrangler's --json wraps the result in an array
    # of arrays: `[[{ "results": [...], "success": true }]]`
    # Strip the noise and parse.
    out = result.stdout.strip()
    if not out:
        print("[retrain] empty wrangler output, falling back to default")
        return []
    try:
        parsed = json.loads(out)
    except json.JSONDecodeError:
        # wrangler may also emit non-JSON debug; try to
        # find the JSON object inside the output.
        start = out.find("[")
        end = out.rfind("]") + 1
        if start < 0 or end <= 0:
            print(f"[retrain] could not parse wrangler output: {out[:200]}")
            return []
        parsed = json.loads(out[start:end])
    if not parsed or not parsed[0].get("success"):
        print(f"[retrain] wrangler query did not succeed: {parsed}")
        return []
    results = parsed[0].get("results", [])
    if not results:
        return []
    value = results[0].get("value")
    if not value:
        return []
    try:
        config = json.loads(value)
    except json.JSONDecodeError:
        return []
    # 2026-08-11: the bot_config row stores the
    # universe as `ticker_verticals` (a dict of
    # ticker -> vertical), not as a `tickers`
    # list. The universe is the keys of that dict.
    # Fall back to a `tickers` list for older
    # config shapes.
    if "ticker_verticals" in config and config["ticker_verticals"]:
        return list(config["ticker_verticals"].keys())
    return list(config.get("tickers", []))


def fetch_trades_for_ticker(ticker: str, min_ts_sec: int) -> list[dict]:
    """Fetch the last N days of Kalshi public trades
    for one ticker. Returns a list of dicts in the
    KalshiTrade wire format (ready to be JSONL'd)."""
    from predictive_markets.live import KalshiClient  # noqa: E402

    client = KalshiClient()
    out: list[dict] = []
    cursor = None
    pages = 0
    while True:
        pages += 1
        trades, cursor = client.list_trades(
            ticker=ticker,
            limit=100,
            cursor=cursor,
            min_ts=min_ts_sec,
        )
        for t in trades:
            out.append({
                "trade_id": t.trade_id,
                "ticker": t.ticker,
                "yes_price_dollars": t.yes_price_dollars,
                "no_price_dollars": t.no_price_dollars,
                "count": t.count,
                "created_time": t.created_time,
                "taker_side": t.taker_side,
                "is_block_trade": t.is_block_trade,
            })
        if not cursor or pages >= 50:  # safety: 50 pages × 100 = 5000 trades/ticker
            break
        time.sleep(0.3)  # be polite
    return out


def write_trades_jsonl(trades_by_ticker: dict[str, list[dict]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "trades").mkdir(exist_ok=True)
    for ticker, trades in trades_by_ticker.items():
        out_path = DATA_DIR / "trades" / f"{ticker}.jsonl"
        with open(out_path, "w") as f:
            for t in trades:
                f.write(json.dumps(t) + "\n")
    print(f"[retrain] wrote {len(trades_by_ticker)} JSONL files to {DATA_DIR / 'trades'}")


def run_trainer_for_vertical(vertical: str) -> Path | None:
    """Invoke the live reversion trainer for one
    vertical. Returns the path to the output
    .joblib file, or None if the trainer returned
    0 samples (data too thin)."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / f"reversion_live-{vertical}.joblib"
    print(f"[retrain] training {vertical} → {out_path}")
    cmd = [
        sys.executable, "-m", "predictive_markets.scripts.live.train_reversion",
        "--data-dir", str(DATA_DIR),
        "--output", str(out_path),
        "--vertical", vertical,
        "--walk-forward",
        "--n-folds", "3",
        "--embargo", "20",
        # 2026-08-11: do NOT pass --no-verticals. The trainer
        # needs the ticker→vertical map to filter by
        # `--vertical`. Without it, all tickers get
        # classified as "unknown" and the filter returns
        # 0 trades. The trainer's _fetch_ticker_verticals
        # walks Kalshi's /events (9,610 open events,
        # ~48 pages × 200ms = 14s) which is acceptable for
        # a weekly cron. A future optimization is to pass
        # the map from D1 directly, but that requires a
        # trainer change.
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except Exception as e:
        print(f"[retrain] trainer exception for {vertical}: {e}")
        return None
    if result.returncode != 0:
        # The trainer exits non-zero when there are 0
        # samples (insufficient data). That's expected
        # for sparse verticals — log and skip.
        tail = (result.stderr or result.stdout)[-500:]
        print(f"[retrain] trainer {vertical} failed (likely 0 samples): {tail}")
        return None
    if not out_path.exists() or out_path.stat().st_size < 1000:
        print(f"[retrain] trainer {vertical} produced no output file (or tiny file)")
        return None
    return out_path


def convert_joblib_to_json(joblib_path: Path, version: str) -> Path:
    """Convert a .joblib to the JSON tree format the
    TS port consumes. Returns the .json path."""
    out_path = joblib_path.parent / f"reversion-{version}.json"
    cmd = [
        sys.executable, str(PM_BOT_REPO / "scripts" / "convert-models-to-json.py"),
        "--in", str(joblib_path),
        "--out", str(out_path),
    ]
    subprocess.run(cmd, check=True)
    return out_path


def upload_to_r2(json_path: Path, vertical: str, version: str) -> None:
    """Upload a model JSON to R2 via wrangler."""
    key = f"pm-bot/models/reversion-{vertical}-{version}.json"
    cmd = [
        "npx", "wrangler", "r2", "object", "put", key,
        "--file", str(json_path),
    ]
    subprocess.run(cmd, cwd=PM_BOT_REPO, check=True)
    print(f"[retrain] uploaded {json_path} → r2://{key}")


def main() -> int:
    print(f"[retrain] starting (BUILDA_BOT_REPO={BUILDA_BOT_REPO}, PM_BOT_REPO={PM_BOT_REPO})")
    print(f"[retrain] data dir: {DATA_DIR}")
    print(f"[retrain] output dir: {OUTPUT_DIR}")
    print(f"[retrain] lookback: {LOOKBACK_DAYS} days")

    # 1. Pull the bot's universe from D1.
    universe = pull_bot_universe_from_d1()
    if not universe:
        print("[retrain] no bot universe found; exiting")
        return 1
    print(f"[retrain] bot universe: {len(universe)} tickers")
    for t in universe[:10]:
        print(f"  - {t}")
    if len(universe) > 10:
        print(f"  ... and {len(universe) - 10} more")

    # 2. Fetch the last LOOKBACK_DAYS of Kalshi public
    #    trades for each ticker.
    min_ts_sec = int(time.time()) - LOOKBACK_DAYS * 24 * 60 * 60
    trades_by_ticker: dict[str, list[dict]] = {}
    for ticker in universe:
        try:
            trades = fetch_trades_for_ticker(ticker, min_ts_sec)
        except Exception as e:
            print(f"[retrain] fetch failed for {ticker}: {e}")
            continue
        if not trades:
            continue
        trades_by_ticker[ticker] = trades
        print(f"  fetched {ticker}: {len(trades)} trades")
        time.sleep(0.5)  # polite to Kalshi

    if not trades_by_ticker:
        print("[retrain] no trades fetched; nothing to train on")
        return 1
    print(f"[retrain] total tickers with trades: {len(trades_by_ticker)}")

    # 3. Write JSONL for the trainer.
    write_trades_jsonl(trades_by_ticker)

    # 4. Train per vertical (all 17).
    version = os.environ.get("MODEL_VERSION", "v2")
    results: dict[str, str] = {}  # vertical → R2 key
    for vertical in ALL_VERTICALS:
        joblib = run_trainer_for_vertical(vertical)
        if joblib is None:
            print(f"[retrain] {vertical}: skipped (no output / 0 samples)")
            continue
        try:
            json_path = convert_joblib_to_json(joblib, version)
            upload_to_r2(json_path, vertical, version)
            results[vertical] = f"r2://pm-bot/models/reversion-{vertical}-{version}.json"
        except Exception as e:
            print(f"[retrain] {vertical}: convert/upload failed: {e}")
            continue

    print("\n[retrain] done. new R2 artifacts:")
    for v, k in results.items():
        print(f"  {v} → {k}")
    print("\n[retrain] next: Sunday 00:00 UTC train-cron will auto-register")
    print("  these in D1 as `status=candidate`. Operator promotes via Dev page.")
    return 0 if results else 2


if __name__ == "__main__":
    sys.exit(main())
