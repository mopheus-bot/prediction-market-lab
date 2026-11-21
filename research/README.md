# Research harness

The Python half of this repository: the research inputs and the report generator.

## What lives here

```
research/
├── build_report.py           entry point — python3 -m research.build_report
├── charts.py                 matplotlib chart rendering (headless)
├── templates/report.html.j2  Jinja2 template
├── data/                     research JSON produced by the research pipeline
└── report/                   generated output — index.html + assets/*.png
```

`report/` is committed so a reader can open `research/report/index.html` directly in a
browser without installing anything. Regenerate it with one command.

## Generating the report

```bash
python3 -m venv .venv
.venv/bin/pip install -r research/requirements.txt
.venv/bin/python -m research.build_report
```

Output: `research/report/index.html`, plus four PNG charts in `research/report/assets/`.

The report is a static page — no client-side JavaScript, no network requests.

## What the data is

| File | Contents |
|---|---|
| `vertical-sharpe.json` | The experiment record: the naive baseline and the ML model compared per vertical, with the pre-committed go/no-go gate. |
| `vertical-<name>.json` | Per-vertical backtest result — metrics plus every individual trade. |
| `backtest.json` | The all-vertical economic backtest. |
| `paper.json` | The live paper-trading run against the Kalshi API. |
| `daily.md` | The daily summary report the bot emits on schedule. |

## The caveat that matters

**The backtests run against a synthetic simulator, not historical market data.**

`sim/generators.py` in the research pipeline builds deterministic, seeded markets
whose `true_probability` is derived from fundamentals stubs, and the backtester runs
against that simulator rather than the exchange API. The Sharpe ratios in these
files therefore measure *whether the model can fit the simulator*, not whether the
strategy makes money.

`paper.json` is the only file here that comes from real market data, and it covers
3.7 days and nine closed trades — enough to confirm a direction, not enough to
estimate a Sharpe.

The report states this in its own body rather than burying it. If you change the
data, keep that caveat in the template.

## Dependencies

`matplotlib` and `jinja2`. Both are pure build-time dependencies — nothing in
`src/` imports them, and the Worker does not run this code.
