"""Build the static research report.

Reads the research JSON in `research/data/`, renders charts, and writes a
self-contained HTML report to `research/report/index.html`.

    python3 -m research.build_report

Requires: matplotlib, jinja2.
"""

from __future__ import annotations

import json
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from research import charts

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = ROOT / "report"
ASSETS = OUT / "assets"

VERTICAL_ORDER = ("weather", "economic", "sports", "politics")


def load(name: str) -> dict:
    return json.loads((DATA / name).read_text())


def money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}${abs(cents) / 100:,.2f}"


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def build() -> Path:
    ASSETS.mkdir(parents=True, exist_ok=True)

    sharpe = load("vertical-sharpe.json")
    paper = load("paper.json")
    backtest = load("backtest.json")

    per_vertical = {v: load(f"vertical-{v}.json") for v in VERTICAL_ORDER}

    # ─── ML vs naive ────────────────────────────────────────────────────
    naive = sharpe["results"]["naive"]["per_vertical"]
    ml = sharpe["results"]["ml"]["per_vertical"]
    gate = sharpe["go_no_go_gate"]

    comparison = []
    for vertical in VERTICAL_ORDER:
        if vertical not in naive:
            continue
        n, m = naive[vertical], ml[vertical]
        comparison.append(
            {
                "vertical": vertical,
                "naive_sharpe": n["sharpe"],
                "naive_hit": n["hit_rate"],
                "naive_pnl": n["total_pnl_cents"],
                "naive_trades": n["n_trades"],
                "ml_sharpe": m["sharpe"],
                "ml_hit": m["hit_rate"],
                "ml_pnl": m["total_pnl_cents"],
                "ml_trades": m["n_trades"],
                "ml_accuracy": m.get("test_accuracy"),
            }
        )

    # The row where the gap between "looks accurate" and "loses money" is widest.
    scored = [r for r in comparison if r["ml_accuracy"] is not None]
    sharpest = max(scored, key=lambda r: r["ml_accuracy"]) if scored else comparison[0]

    charts.sharpe_by_vertical(naive, ml, ASSETS / "sharpe-by-vertical.png")
    charts.hit_rate_by_vertical(naive, ml, ASSETS / "hit-rate-by-vertical.png")

    # ─── Backtest equity per vertical ───────────────────────────────────
    charts.per_vertical_equity(
        {v: per_vertical[v].get("trades", []) for v in VERTICAL_ORDER},
        ASSETS / "backtest-equity.png",
    )

    # ─── Live paper run ─────────────────────────────────────────────────
    paper_trades = paper.get("trades", [])
    charts.equity_curve(
        paper_trades,
        ASSETS / "paper-equity.png",
        "Live paper run — bankroll over 9 filled trades",
        f"3.7 days · {paper['n_signals_skipped']:,} signals skipped to {paper['n_signals_fired']} fired",
    )

    paper_rows = [
        {
            "ticker": t["ticker"],
            "vertical": t["vertical"],
            "side": t["side"].upper(),
            "entry": f"{t['entry_price']}c",
            "outcome": t["settlement_outcome"].upper(),
            "pnl": money(t["pnl_cents"]),
            "pnl_raw": t["pnl_cents"],
            "bankroll": money(t["bankroll_after"]),
        }
        for t in paper_trades
    ]

    # ─── Render ─────────────────────────────────────────────────────────
    env = Environment(
        loader=FileSystemLoader(ROOT / "templates"),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    template = env.get_template("report.html.j2")

    html = template.render(
        gate=gate,
        comparison=comparison,
        sharpest=sharpest,
        naive_all=sharpe["results"]["naive"].get("all", {}),
        paper=paper,
        paper_rows=paper_rows,
        backtest=backtest,
        money=money,
        pct=pct,
        experiment=sharpe.get("experiment"),
        experiment_date=sharpe.get("date"),
        params=sharpe.get("params", {}),
    )

    OUT.mkdir(parents=True, exist_ok=True)
    index = OUT / "index.html"
    index.write_text(html, encoding="utf-8")
    return index


if __name__ == "__main__":
    path = build()
    print(f"Wrote {path}")
