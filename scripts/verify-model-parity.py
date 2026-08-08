#!/usr/bin/env python3
"""
pm-bot — Python-side parity check for chunk 4 (chunk-4 hot path).

Runs the original .joblib model and a set of hand-crafted
feature vectors through `predict_proba`, and writes a
`test/fixtures/model-parity.json` fixture that the TS
inference tests import. The TS side runs the SAME feature
vectors through its pure-TS inference and asserts equal
probabilities to ~1e-9.

This is a one-shot verification — not a CI step. Run once
after `convert-models-to-json.py` to seed the parity fixture,
and re-run only when the model format changes (e.g. a
new model version lands).

Output fixture shape:

  {
    "model_path": "models/reversion-weather-v1.json",
    "n_features": 20,
    "cases": [
      {
        "name": "all-zeros",
        "features": [0.0, 0.0, ..., 0.0],
        "expected_proba": [0.42, 0.58]
      },
      ...
    ]
  }

We use 5-6 representative cases per model:
  - all zeros (the "I have no info" baseline)
  - mid-price at 50, no spread, modest move
  - high-vol + tight spread (typical weather reversion)
  - extremes (very high or very low price)
  - vertical one-hot variants
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np


def build_cases() -> list[dict[str, Any]]:
    """Hand-crafted feature vectors exercising the model.

    Layout matches the 20-feature order from
    `features.py:FEATURE_NAMES`:
      0  price                (0..1)
      1  spread               (cents)
      2  time_to_resolution   (0..1)
      3  volatility           (normalized)
      4  orderbook_imbalance  (-1..1)
      5  news_shock_magnitude (0..1)
      6  news_shock_age_hours (0..24)
      7  recent_move_pct      (any)
      8  vertical_politics
      9  vertical_sports
      10 vertical_weather
      11 vertical_economic
      12-19: per-vertical fundamentals (commit 6)
    """
    # 5 vertical variants: 0=unknown, 1=politics, 2=sports, 3=weather, 4=economic
    POL, SPO, WEA, ECO = [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]
    POL[0] = 1
    SPO[1] = 1
    WEA[2] = 1
    ECO[3] = 1
    NO_VERT = [0, 0, 0, 0]
    NO_FUND = [0.0] * 8

    def make(
        name: str,
        price: float,
        spread: float,
        ttr: float,
        vol: float,
        ob_imb: float,
        shock_mag: float,
        shock_age: float,
        recent_move: float,
        vertical_oh: list[int],
        fundamentals: list[float],
    ) -> dict[str, Any]:
        fv = [
            price, spread, ttr, vol, ob_imb, shock_mag, shock_age, recent_move,
            *vertical_oh,
            *fundamentals,
        ]
        assert len(fv) == 20, f"feature vector has {len(fv)} dims, expected 20"
        return {"name": name, "features": fv}

    return [
        make(
            "all-zeros",
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            NO_VERT, NO_FUND,
        ),
        make(
            "weather-typical-revert",
            0.50, 2.0, 0.5, 0.05, 0.1, 0.0, 24.0, 0.02,
            WEA, [0.50, 0.80] + [0.0] * 6,  # weather fundamentals
        ),
        make(
            "weather-elevated-mean-revert-set",
            0.65, 2.0, 0.5, 0.04, -0.2, 0.0, 24.0, 0.05,
            WEA, [0.55, 0.85] + [0.0] * 6,
        ),
        make(
            "weather-depressed-mean-revert-set",
            0.35, 2.0, 0.5, 0.04, 0.2, 0.0, 24.0, -0.05,
            WEA, [0.45, 0.85] + [0.0] * 6,
        ),
        make(
            "economic-typical",
            0.50, 3.0, 0.5, 0.06, 0.0, 0.2, 4.0, 0.01,
            ECO, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.1],
        ),
        make(
            "politics-typical",
            0.55, 2.0, 0.5, 0.03, 0.0, 0.0, 24.0, 0.01,
            POL, [0.02, 0.7] + [0.0] * 6,
        ),
        make(
            "sports-typical",
            0.48, 2.0, 0.5, 0.05, 0.0, 0.0, 24.0, 0.0,
            SPO, [0.5, 0.0] + [0.0] * 6,
        ),
    ]


def run_parity(
    joblib_path: Path,
    json_path: Path,
    cases: list[dict[str, Any]],
) -> dict[str, Any]:
    """Run all cases through the .joblib model and return
    the expected_proba + features. The TS test imports this
    fixture and asserts equal probabilities.
    """
    import joblib

    raw = joblib.load(joblib_path)
    model = raw["model"] if isinstance(raw, dict) and "model" in raw else raw
    # We need the .json's classes to label the proba array
    # correctly (RandomForestClassifier's `classes_` is the
    # ground truth; the .json's "classes" mirrors it).
    expected: list[dict[str, Any]] = []
    for c in cases:
        X = np.array(c["features"], dtype=np.float64).reshape(1, -1)
        proba = model.predict_proba(X)[0]
        # `proba[i]` corresponds to `model.classes_[i]`. We
        # store as a list of class -> probability in the
        # canonical (0, 1) order — same as our JSON model.
        expected.append(
            {
                "name": c["name"],
                "features": c["features"],
                "expected_proba": [float(p) for p in proba],
            }
        )
    return {
        "model_path": str(json_path.name),
        "n_features": int(model.n_features_in_),
        "n_classes": int(len(model.classes_)),
        "classes": [int(c) for c in model.classes_],
        "cases": expected,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--in", dest="in_path", required=True, type=Path)
    parser.add_argument("--json", dest="json_path", required=True, type=Path)
    parser.add_argument("--out", dest="out_path", required=True, type=Path)
    args = parser.parse_args(argv)
    cases = build_cases()
    fixture = run_parity(args.in_path, args.json_path, cases)
    args.out_path.parent.mkdir(parents=True, exist_ok=True)
    with args.out_path.open("w") as f:
        json.dump(fixture, f, indent=2)
    print(
        f"wrote {args.out_path} "
        f"({len(fixture['cases'])} cases, "
        f"n_features={fixture['n_features']}, "
        f"n_classes={fixture['n_classes']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
