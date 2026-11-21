# Repository notes

How this repository is organised, what came from where, and one thing worth stating
plainly about the commit history.

## Layout

| Path | Contents |
|---|---|
| `src/` | The Worker. `api/` HTTP endpoints, `cron/` scheduled jobs, `durable-objects/` the bot, `kalshi/` the exchange client, `risk/` the risk engine, `strategy/` the signal implementations, `lib/` shared types. |
| `test/` | 33 test files, 377 tests. |
| `migrations/` | D1 schema migrations, applied in order. |
| `models/` | RandomForest artifacts in the flat JSON tree format the runtime loads. |
| `public/` | The dashboard — static HTML, CSS and JavaScript, no framework. |
| `scripts/` | The auth vector generator and the demo-API smoke tests. |
| `research/` | The Python research harness and the static report generator. |
| `docs/` | Engineering notes. `venue-analysis.md` is the one to read first. |
| `CHANGELOG.md` | Commit-level history, generated from the git log. |

## Running it

```bash
npm ci
npm run typecheck
npm test
```

The test suite runs on `@cloudflare/vitest-pool-workers`, which emulates Durable
Objects and D1 in-process. No Cloudflare account, no credentials, and no network
access are needed to run it. The dashboard is static files served from `public/`.

The Python report generator is separate and optional:

```bash
python3 -m venv .venv && .venv/bin/pip install -r research/requirements.txt
.venv/bin/python -m research.build_report
```

## What came from a separate repository

The research pipeline — the market simulator, the backtester, the model trainer and
the `.joblib` exporter — is a Python project that lives in its own repository. This
repository contains its TypeScript port (the Worker) plus `scripts/gen-auth-vectors.py`,
which is a self-contained reimplementation of the same request-signing scheme and is
used to prove the two agree byte-for-byte.

Scripts that needed the Python project directly (the model exporter, the parity
verifier, the retrain pipeline and the weekly retrain workflow) were removed rather
than left in a state where they could not run.

## Repository history

The commit history was normalised before publication. Concretely:

- Internal build-plan vocabulary in commit messages was rewritten as conventional
  commits (`feat(scope): summary`).
- Authorship was unified under a single identity. The work was done by one person.
- References to a separate private project were removed from source comments,
  documentation and the dashboard's branding.
- Two string literals that resemble credentials — a private-key header quoted in a
  comment, and an example bot token — were replaced with descriptive placeholders.

**No behaviour changed.** The diff across `src/`, `scripts/` and `test/` consists of
comments, documentation, whitespace, and the service rename. Every test that passed
before the pass passes after it, with the same count.

Why it was done: the original vocabulary was meaningful only to one person, and the
history was not something to publish unedited. The code, the commit order, the dates
and the content of every commit are the original ones.
