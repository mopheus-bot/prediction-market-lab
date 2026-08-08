#!/usr/bin/env python3
"""
pm-bot — sklearn .joblib -> JSON tree conversion (chunk 4).

Mirrors the export step in
`Prediction Market Lab/.../model/trainer.py:save_model/load_model` but
emits a flat JSON the TS port can read without any external
inference dep.

The JSON shape:

  {
    "version": 1,
    "format": "sklearn-randomforest-v1",
    "n_features": 20,
    "n_classes": 2,
    "classes": [0, 1],
    "n_estimators": 200,
    "max_depth": 6,
    "feature_importances": [0.05, 0.02, ...],
    "trees": [
      {
        "n_nodes": 51,
        "feature": [3, 0, -2, -2, ...],   // -2 = leaf
        "threshold": [0.016, 0.63, ...],
        "left": [1, 2, -1, -1, ...],       // -1 = leaf
        "right": [4, 3, -1, -1, ...],
        "value": [[0.57, 0.43], ...]       // (n_nodes, n_classes)
      },
      ...
    ]
  }

Why arrays (not a recursive tree): cheaper to serialize
(no {"left": {...}} nesting per node), cheaper to walk in
TS (we just read `feature[i]`, `left[i]` etc. — no pointer
chasing), and trivially equivalent to the recursive form
since sklearn's `tree_` arrays are themselves a flat
node-table.

The .joblib files are wrapped dicts (see `trainer.save_model`
in the Python repo). The dict has `model` (the actual
RandomForestClassifier), `feature_importances`, and various
metrics. We only need the classifier itself + the
importances; we drop the rest.

Usage:

  # One model:
  PYTHONPATH=../the Python reference engine/src \
    python3 scripts/convert-models-to-json.py \
      --in  ../the Python reference engine/models/reversion_live-weather.joblib \
      --out models/reversion-weather-v1.json

  # All 4 verticals:
  for v in weather economic politics sports; do
    python3 scripts/convert-models-to-json.py \
      --in  ../the Python reference engine/models/reversion_live-${v}.joblib \
      --out models/reversion-${v}-v1.json
  done

Parity: `scripts/verify-model-parity.py` (separate script)
loads the original .joblib + the new JSON, runs the same
inputs through both, and asserts the predicted probabilities
are equal to ~1e-9.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def extract_forest(model) -> dict[str, Any]:
    """Convert a sklearn RandomForestClassifier to our JSON shape.

    Returns a dict ready to be `json.dump`'d. Caller adds the
    version + format fields.
    """
    if not hasattr(model, "estimators_") or not hasattr(model, "classes_"):
        raise ValueError(
            f"expected a fitted sklearn RandomForestClassifier, "
            f"got {type(model).__name__}"
        )
    classes = [int(c) for c in model.classes_]
    n_classes = len(classes)
    n_features = int(model.n_features_in_)
    n_estimators = int(model.n_estimators)
    max_depth = int(model.max_depth) if model.max_depth is not None else -1
    feature_importances = [float(x) for x in model.feature_importances_]

    trees: list[dict[str, Any]] = []
    for est in model.estimators_:
        t = est.tree_
        # sklearn's tree arrays are flat. We round floats to 9
        # digits (well within float64 precision and well under
        # the 1e-9 parity tolerance).
        feature = [int(x) for x in t.feature.tolist()]
        threshold = [round(float(x), 9) for x in t.threshold.tolist()]
        left = [int(x) for x in t.children_left.tolist()]
        right = [int(x) for x in t.children_right.tolist()]
        # value shape: (n_nodes, 1, n_classes) for classifiers.
        # Squeeze the middle dim.
        value = t.value.reshape(t.value.shape[0], n_classes).tolist()
        # Round to 9 digits for compactness.
        value = [[round(float(c), 9) for c in row] for row in value]
        trees.append(
            {
                "n_nodes": int(t.node_count),
                "feature": feature,
                "threshold": threshold,
                "left": left,
                "right": right,
                "value": value,
            }
        )

    return {
        "version": 1,
        "format": "sklearn-randomforest-v1",
        "n_features": n_features,
        "n_classes": n_classes,
        "classes": classes,
        "n_estimators": n_estimators,
        "max_depth": max_depth,
        "feature_importances": feature_importances,
        "trees": trees,
    }


def convert(in_path: Path, out_path: Path) -> dict[str, Any]:
    """Load a .joblib, convert, write JSON. Returns the
    converted dict (also useful for parity tests).
    """
    import joblib  # local import to keep --help fast

    raw = joblib.load(in_path)
    # The Python repo's .joblib files are wrapped dicts.
    if isinstance(raw, dict) and "model" in raw:
        model = raw["model"]
    else:
        model = raw
    converted = extract_forest(model)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as f:
        json.dump(converted, f, separators=(",", ":"))
    return converted


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--in", dest="in_path", required=True, type=Path)
    parser.add_argument("--out", dest="out_path", required=True, type=Path)
    args = parser.parse_args(argv)
    converted = convert(args.in_path, args.out_path)
    size_kb = args.out_path.stat().st_size / 1024
    print(
        f"wrote {args.out_path} "
        f"({size_kb:.1f} KiB, "
        f"{converted['n_estimators']} trees, "
        f"max_depth={converted['max_depth']}, "
        f"n_features={converted['n_features']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
