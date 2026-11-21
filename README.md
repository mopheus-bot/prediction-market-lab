# Prediction Market Lab

A quant research platform for prediction-market trading, built on Cloudflare's edge
runtime. Multi-vertical market simulator, an ML signal pipeline, a risk and execution
engine, a live Durable Object bot, and a static research report.

**The headline result is negative, and that is the point.** This repository documents
a system that was built carefully enough to *prove* a strategy does not work — with a
pre-committed evaluation gate, a naive baseline to compare against, and a live
paper-trading run that confirmed the backtest. The methodology is the deliverable.

```
Cloudflare Workers + Durable Objects + D1 + R2
├── Durable Objects   live bot (one per user), shadow bot (one per candidate model)
├── Cron Triggers     scan · research · news · daily recap · auto-pilot · heartbeat
│                     · lead generation · LLM opinions · weekly train · weekly backtest
├── D1                trades · signals · market snapshots · model registry · cron runs
├── R2                model artifacts, market-data archive, generated reports
└── Dashboard         static HTML/CSS/JS, server-sent events, no framework
```

---

## The result

### The evaluation gate

Before running the experiment, the go/no-go criterion was written down in advance:

> *"At least one vertical has Sharpe > naive baseline"* — **failed**

| Vertical | Naive baseline | | ML model | | |
|---|---|---|---|---|---|
| | Sharpe | Hit rate | Sharpe | Hit rate | Test accuracy |
| weather | **+1.511** | 55.1% | −2.251 | 22.0% | 0.525 |
| economic | **+0.784** | 50.6% | +0.052 | 40.0% | 0.400 |
| sports | **+0.219** | 47.2% | −0.870 | 40.5% | 0.562 |
| politics | **−0.773** | 45.1% | −2.162 | 25.3% | 0.750 |
| **all** | **+0.335** | 48.4% | — | — | — |

**The ML model underperformed a trivial fade signal on every single vertical.** The
politics column is the clearest illustration: the model reached 75% classification
accuracy on its own test set while producing a Sharpe of −2.16. Accuracy on a
synthetic distribution is not edge.

### The live paper run

Backtests are not evidence. The bot was run against the live Kalshi API in paper mode
for 3.7 days, with the risk engine and execution layer enabled:

| Metric | Value |
|---|---|
| Sharpe | **−1.005** |
| Max drawdown | 3.53% |
| Hit rate | 22.2% |
| Total PnL | **−$353.04** on a $10,000 bankroll |
| Trades filled | 9 (from 9 signals fired, 17,191 skipped) |
| Fill rate | 100% — 0 walked away, 0 cancelled |

The live result confirmed the backtest. Note the signal filter: 17,191 signals skipped
to 9 fired. A strategy that needs to reject 99.95% of its own signals is a strategy
that has been over-fitted to noise.

### Why the backtests are not what they look like

**The backtests run against a synthetic simulator, not historical market data.**
`sim/generators.py` builds deterministic, seeded markets whose `true_probability` is
derived from *fundamentals stubs*; `sim/backtester.py` runs against `KalshiSim`, not
the Kalshi REST client.

So the Sharpe numbers above measure *"can the model fit my own simulator"* — not
*"does this strategy make money"*. That is why the model scores well on classification
accuracy and badly on Sharpe. The live paper run is the only real-world number in
this repository.

This is stated here rather than buried, because it is the most important caveat in
the project.

### The venue conclusion

The instrumented run led to a decision: Kalshi's 1¢ tick and 2¢ typical spread, thin
volume, daily ticker rotation and IP throttling make it a poor venue for signals
priced at this cadence — regardless of model quality. The full analysis, with the
per-strategy P&L and the microstructure reasoning, is in
**[`docs/venue-analysis.md`](docs/venue-analysis.md)**.

The architecture is venue-agnostic and was kept; the venue was not.

---

## Architecture

```
                      ┌──────────────────────────────┐
   Cloudflare Cron ──►│  Worker (src/index.ts)       │
                      │  routes /api/pm/*, /pm/*      │
                      └───────┬──────────────┬───────┘
                              │              │
                ┌─────────────▼───┐   ┌──────▼─────────────┐
                │ Durable Object  │   │ Cron dispatcher    │
                │ LiveBot         │   │ scan · research    │
                │  - poll feed    │   │ news · daily       │
                │  - signal router│   │ train · backtest   │
                │  - risk engine  │   │ leads · llm        │
                │  - execution    │   └────────────────────┘
                └──────┬──────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   ┌─────────┐   ┌──────────┐   ┌──────────────┐
   │ D1      │   │ R2       │   │ Kalshi API   │
   │ trades  │   │ models   │   │ (REST + WS)  │
   │ signals │   │ archive  │   └──────────────┘
   │ models  │   └──────────┘
   └─────────┘
```

### The pieces worth reading

| Path | What it does |
|---|---|
| `src/durable-objects/LiveBot.ts` | The trading bot. Alarm-driven polling feed, signal routing, risk evaluation, order placement, SSE event fan-out. |
| `src/risk/engine.ts` | Risk state machine: drawdown pause, consecutive-loss cooldown, position and notional caps, per-vertical limits, kill switch. |
| `src/strategy/router.ts` | Vertical strategy dispatch — per-vertical signal implementations, priority routing. |
| `src/strategy/forest.ts` | RandomForest inference over the flat JSON tree format (no native inference dependency). |
| `src/kalshi/auth.ts` | RSA-PSS request signing for the Kalshi API, byte-for-byte compatible with the Python reference implementation. |
| `src/cron/dispatcher.ts` | Cron expression → job dispatch, matched against `wrangler.jsonc`. |
| `src/api/` | The HTTP surface: bot control, status, models, positions, trades, research, leads. |
| `public/app/` | The dashboard — 10k lines of hand-written HTML/CSS/JS with no framework. |

### The auth parity check

The Kalshi API signs every private request with RSA-PSS over
`timestamp + METHOD + path`. Two independent implementations exist — this
TypeScript one and a Python one in `scripts/gen-auth-vectors.py` — and the test suite
proves they agree:

- **Internal:** TS signs, TS verifies.
- **Cross-implementation:** TS verifies a signature produced by the Python
  implementation.
- **Real-world:** `scripts/smoke-demo-auth.mjs` hits `demo.kalshi.co` with
  TS-generated headers; a 200 confirms Kalshi accepts them.

The signing key used by the test suite is a throwaway RSA-2048 key committed as
base64 PKCS#8 (no PEM armor), so that generic secret scanners and GitHub push
protection do not treat it as a leaked credential. It is not registered with any
Kalshi account and cannot authenticate against one.

---

## Quickstart

```bash
npm ci
npm run typecheck
npm test
```

That is the whole setup. The test suite runs entirely on
`@cloudflare/vitest-pool-workers` — Durable Objects and D1 are emulated in-process,
so **no Cloudflare account, no credentials, and no network are required.**

To run the Worker locally:

```bash
npm run dev                 # http://localhost:8787
npm run d1:migrate:local    # apply the D1 migrations
```

### Deploying

```bash
wrangler d1 create prediction-market-lab     # then paste the id into wrangler.jsonc
wrangler r2 bucket create prediction-market-lab
npm run deploy
```

Set the secrets before the first deploy:

```bash
wrangler secret put KALSHI_DEMO_KEY_ID
wrangler secret put KALSHI_DEMO_PRIVATE_KEY     # PKCS#8 PEM
```

See [`.env.example`](.env.example) for the full list of variables the Worker reads.

### The research report

```bash
python3 -m venv .venv && .venv/bin/pip install matplotlib jinja2
.venv/bin/python -m research.build_report
```

This renders a static HTML report from the research JSON — per-vertical performance,
the ML-vs-naive comparison, the evaluation gate, and the paper-run equity curve —
into `research/report/index.html`.

---

## Testing

```
Test Files  33 passed (33)
Tests       377 passed (377)
Duration    ~10s
```

The suite covers the auth parity check, the risk engine's state transitions, the
signal router, the model loader and its parity fixtures, the backtest metrics, the
Sharpe computation, the cron dispatcher, and the Durable Object and D1 integration
paths.

---

## Repository map

```
├── src/
│   ├── api/              HTTP endpoints
│   ├── cron/             scheduled jobs + dispatcher
│   ├── durable-objects/  LiveBot, ShadowBot
│   ├── kalshi/           REST + WS client, RSA auth, category mapper
│   ├── llm/              LLM client + opinion signal
│   ├── risk/             risk engine, config, state
│   ├── strategy/         router, naive + forest signals, features
│   └── lib/              shared types, fees, config
├── test/                 33 test files
├── test/fixtures/        model-parity fixtures, auth vectors, test key
├── migrations/           D1 schema migrations
├── models/               RandomForest artifacts in flat JSON tree format
├── public/               dashboard — static HTML/CSS/JS
├── scripts/              auth vector generator, demo smoke tests
├── research/             Python research harness and report generator
├── docs/
│   ├── changelog/        per-feature engineering notes
│   ├── venue-analysis.md the negative result, in full
│   ├── EVENT-DRIVEN-UI.md
│   ├── LLM-PIPELINE.md
│   ├── ONBOARDING.md
│   ├── RESEARCH-PLAN.md
│   ├── STRATEGY-PARLAYS.md
│   └── operations.md
└── CHANGELOG.md          commit-level history
```

---

## What is real, and what is a stub

Being explicit about this is the point of the repository.

| Area | Status |
|---|---|
| Worker, D1 schema, migrations, risk engine, signal router, model loader, cron dispatch | **Real.** Implemented, tested, deployed. |
| Kalshi REST + WebSocket clients, RSA-PSS auth | **Real.** Cross-implementation verified; smoke-tested against the demo API. |
| Dashboard, SSE event bus, operator controls | **Real.** 10k lines of hand-written front end. |
| The market simulator and the backtester | **Real code, synthetic data.** Deterministic generators with stubbed fundamentals — useful for exercising the pipeline, not evidence about markets. |
| The RandomForest models in `models/` | **Real artifacts**, trained on simulator output. That is why they do not generalise. |
| The strategy edge | **Does not exist.** The gate failed, and the live run confirmed it. |
| The venue port | **Scoped, never started.** See `docs/venue-analysis.md`. |
| The Python reference implementation (simulator, backtester, trainer, model exporter) | Lives in a separate repository. This repo contains its TypeScript port and the auth vector generator. |

---

## Known limitations

1. **The strategy does not work.** Documented above and in `docs/venue-analysis.md`.
   This is a research result, not a product.
2. **Backtests are synthetic.** They validate the pipeline, not the edge.
3. **The paper run is small** — 3.7 days, 9 closed trades. Enough to confirm the
   direction, not enough to estimate a Sharpe with any confidence.
4. **The LLM signal is not a predictive model.** It is a small model asked for a
   directional view on a market. It answered "no view" 89% of the time.
5. **Single author.** Every commit is one person.
6. **The venue port was never started**, so the broker adapter is not
   exchange-agnostic in practice — only in design.

---

## License

MIT — see [LICENSE](LICENSE).
