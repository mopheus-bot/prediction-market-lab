"""Chart generation for the research report.

Headless matplotlib only — the output is a set of PNG files that the Jinja2
template embeds. Nothing here needs a display.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

# ─── Palette ────────────────────────────────────────────────────────────
INK = "#16181d"
MUTED = "#6b7280"
FAINT = "#e6e7ea"
GRID = "#eceef1"
POS = "#15803d"
NEG = "#b3261e"
ML = "#4338ca"
NAIVE = "#9aa3af"
BAND = "#f7f8fa"


def _apply_style() -> None:
    plt.rcParams.update(
        {
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "axes.edgecolor": GRID,
            "axes.labelcolor": MUTED,
            "axes.titlecolor": INK,
            "axes.titlesize": 12,
            "axes.titleweight": "bold",
            "axes.titlesize": 12,
            "axes.labelsize": 9,
            "axes.grid": True,
            "axes.axisbelow": True,
            "grid.color": GRID,
            "grid.linewidth": 0.8,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "xtick.labelsize": 9,
            "ytick.labelsize": 9,
            "legend.frameon": False,
            "legend.fontsize": 9,
            "font.family": "DejaVu Sans",
            "figure.dpi": 140,
        }
    )


def _clean(ax, spines=("top", "right", "left")) -> None:
    for side in spines:
        ax.spines[side].set_visible(False)


def _money(value: float, _pos: int = 0) -> str:
    return f"${value:,.0f}"


def sharpe_by_vertical(
    naive: dict[str, dict],
    ml: dict[str, dict],
    out_path: Path,
) -> Path:
    """Grouped bars: naive baseline vs ML model, per vertical."""
    _apply_style()
    verticals = [v for v in ("weather", "economic", "sports", "politics") if v in naive]
    naive_vals = [naive[v]["sharpe"] for v in verticals]
    ml_vals = [ml[v]["sharpe"] for v in verticals]

    x = range(len(verticals))
    width = 0.38

    fig, ax = plt.subplots(figsize=(7.2, 3.6))
    b1 = ax.bar([i - width / 2 for i in x], naive_vals, width, label="Naive baseline", color=NAIVE)
    b2 = ax.bar([i + width / 2 for i in x], ml_vals, width, label="ML model", color=ML)

    for bars in (b1, b2):
        for bar in bars:
            value = bar.get_height()
            ax.annotate(
                f"{value:+.2f}",
                xy=(bar.get_x() + bar.get_width() / 2, value),
                xytext=(0, 4 if value >= 0 else -12),
                textcoords="offset points",
                ha="center",
                fontsize=8.5,
                color=INK,
            )

    ax.axhline(0, color=INK, linewidth=1)
    ax.set_xticks(list(x))
    ax.set_xticklabels([v.capitalize() for v in verticals])
    ax.set_ylabel("Sharpe ratio")
    ax.set_title("ML underperformed the naive baseline on every vertical")
    ax.legend(loc="upper right", ncol=2)
    ax.grid(axis="x", visible=False)
    _clean(ax)

    # Headroom so the value labels on negative bars are not clipped.
    low = min(naive_vals + ml_vals)
    high = max(naive_vals + ml_vals)
    span = high - low or 1.0
    ax.set_ylim(low - 0.18 * span, high + 0.18 * span)

    fig.tight_layout()
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)
    return out_path


def equity_curve(trades: list[dict], out_path: Path, title: str, subtitle: str) -> Path:
    """Bankroll over the trade sequence, with drawdown beneath."""
    _apply_style()
    starting = trades[0]["bankroll_after"] - trades[0]["pnl_cents"] if trades else 0
    bank = [starting] + [t["bankroll_after"] for t in trades]
    xs = list(range(len(bank)))
    pnl = [t["pnl_cents"] for t in trades]

    fig, (ax1, ax2) = plt.subplots(
        2, 1, figsize=(7.2, 4.6), sharex=True, layout="constrained",
        height_ratios=[2.4, 1],
    )

    ax1.plot(xs, bank, color=ML, linewidth=1.8)
    ax1.fill_between(xs, bank, starting, where=[b < starting for b in bank], color=NEG, alpha=0.10)
    ax1.axhline(starting, color=FAINT, linewidth=1, linestyle="--")
    ax1.yaxis.set_major_formatter(FuncFormatter(_money))
    ax1.set_ylabel("Bankroll")
    ax1.set_title(title, pad=22)
    ax1.annotate(subtitle, xy=(0, 1.0), xycoords="axes fraction", xytext=(0, 6),
                 textcoords="offset points", fontsize=8.5, color=MUTED, va="bottom")
    ax1.grid(axis="x", visible=False)
    _clean(ax1)

    ax2.bar(xs[1:], pnl, color=[POS if p >= 0 else NEG for p in pnl], width=0.7)
    ax2.axhline(0, color=INK, linewidth=1)
    ax2.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"${v / 100:,.0f}"))
    ax2.set_ylabel("PnL")
    ax2.set_xlabel("Trades")
    ax2.grid(axis="x", visible=False)
    _clean(ax2)

    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)
    return out_path


def hit_rate_by_vertical(naive: dict[str, dict], ml: dict[str, dict], out_path: Path) -> Path:
    """Hit rate comparison. 50% is the break-even line for a binary market."""
    _apply_style()
    verticals = [v for v in ("weather", "economic", "sports", "politics") if v in naive]
    x = range(len(verticals))
    width = 0.38

    fig, ax = plt.subplots(figsize=(7.2, 3.2))
    ax.bar([i - width / 2 for i in x], [naive[v]["hit_rate"] for v in verticals], width,
           label="Naive baseline", color=NAIVE)
    ax.bar([i + width / 2 for i in x], [ml[v]["hit_rate"] for v in verticals], width,
           label="ML model", color=ML)

    ax.axhline(0.5, color=NEG, linewidth=1, linestyle="--")
    ax.annotate("break-even", xy=(len(verticals) - 0.5, 0.5), xytext=(-4, 4),
                textcoords="offset points", ha="right", fontsize=8, color=NEG)
    ax.set_xticks(list(x))
    ax.set_xticklabels([v.capitalize() for v in verticals])
    ax.set_ylim(0, 0.65)
    ax.set_ylabel("Hit rate")
    ax.set_title("Hit rate against the 50% break-even line")
    ax.legend(loc="upper right", ncol=2)
    ax.grid(axis="x", visible=False)
    _clean(ax)

    fig.tight_layout()
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)
    return out_path


def per_vertical_equity(trades_by_vertical: dict[str, list[dict]], out_path: Path) -> Path:
    """One equity line per vertical, all starting from the same bankroll."""
    _apply_style()
    fig, ax = plt.subplots(figsize=(7.2, 3.4))

    palette = ["#4338ca", "#b3261e", "#15803d", "#a16207"]
    for (vertical, trades), colour in zip(sorted(trades_by_vertical.items()), palette):
        if not trades:
            continue
        starting = trades[0]["bankroll_after"] - trades[0]["pnl_cents"]
        bank = [starting] + [t["bankroll_after"] for t in trades]
        ax.plot(range(len(bank)), bank, color=colour, linewidth=1.6, label=vertical.capitalize())

    ax.axhline(1_000_000, color=FAINT, linewidth=1, linestyle="--")
    ax.yaxis.set_major_formatter(FuncFormatter(_money))
    ax.set_xlabel("Trades")
    ax.set_ylabel("Bankroll")
    ax.set_title("Backtest equity by vertical (synthetic markets)")
    ax.legend(loc="upper right", ncol=4)
    ax.grid(axis="x", visible=False)
    _clean(ax)

    fig.tight_layout()
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)
    return out_path
