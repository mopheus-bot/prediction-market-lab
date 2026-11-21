# Status API and Telegram bridge (2026-08-08)

The status API + Telegram IM bridge land. The news + daily
cron jobs get their LLM call + Telegram wiring. The dashboard has the data it needs.

## What ships

### New modules

- `src/telegram/index.ts` — thin wrapper over the Telegram
  Bot API. `sendMessage(env, text, opts)` +
  `sendMarkdown(env, text, opts)`. Truncates at 4000 chars
  (Telegram's limit is 4096). No external deps. Configured
  via `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.

- `src/llm/index.ts` — direct HTTP client for the MiniMax
  Messages API (the `mmx` CLI's underlying API). `chat(env,
  system, user, opts)` returns the assistant text + token
  usage + duration. Stub mode when `MMX_API_KEY` is missing
  (returns a deterministic stub so callers can be tested
  without a real API).

- `src/api/status.ts` — read-only status endpoints:
  - `GET /api/pm/status`     — overall state (counts, PnL,
    latest daily cron)
  - `GET /api/pm/summary`    — last 24h (R2 daily-recap if
    available, live aggregate fallback)
  - `GET /api/pm/trades`     — recent trades
    (`?ticker= ?since= ?limit=`)
  - `GET /api/pm/signals`    — recent signals
    (`?ticker= ?source= ?limit=`)
  - `GET /api/pm/scans`      — latest scan candidates
  - `GET /api/pm/cron-runs`  — recent cron runs
    (`?cron= ?limit=`)

- `src/api/daily-recap.ts` — `readDailyRecap(env, date?)`
  reads the R2 `daily-recap/YYYY-MM-DD.json` produced by
  the daily cron.

### Updated

- `src/index.ts` — wired all 6 status endpoints into the
  routing. The endpoint list is in `/api/pm/*` so the CF
  Access policy in front of `/api/pm/*` covers them.

- `src/cron/news-cron.ts` — replaces the step-5 stub with
  the real LLM call (`MiniMax-M2.7-highspeed` via the
  MiniMax Messages API). Pulls the vertical hint per ticker
  and builds the news-check prompt. Calls the LLM, logs
  the call to `llm_calls` (always, even on failure), and
  posts the verdict to Telegram when the bot token is
  configured. Posts on `AT RISK` / `BROKEN` verdicts (not
  on `INTACT`).

- `src/cron/daily-cron.ts` — after writing the R2 recap,
  calls the LLM for a one-paragraph markdown summary and
  posts to Telegram. The R2 JSON is the canonical record;
  the Telegram message is a notification.

- `src/lib/db.ts` — `signals.list` now accepts an optional
  `ticker` filter (parity with `trades.list`).

- `src/cron/dispatcher.ts` — `CronEnv` now extends
  `LLMEnv` + `TelegramEnv` so the cron jobs share the same
  env shape as the LLM + Telegram clients.

## Why direct HTTP for the LLM (not the `mmx` CLI)

The Python advisor uses the `mmx` CLI to call the MiniMax
Messages API. Workers can't shell out, so we call the API
directly. The API is a standard OpenAI-compatible
`/chat/completions` endpoint — the same payload shape that
`mmx text chat` produces. The result: zero deps, the same
model (`MiniMax-M2.7-highspeed`), and identical text output.

## Telegram: first-class IM bridge

Per the plan: "Telegram as primary IM bridge. the secondary channel
secondary if a webhook URL is exposed." Telegram is the
most reliable channel for a single-user trading bot:

- No public webhook URL needed (the Worker calls Telegram
  outbound, not the other way).
- No dependency on the secondary channel (works even if the secondary channel is down).
- Free, low-latency, end-to-end reliable.
- The chat_id is your personal one — only your phone
  sees the messages.

`a secondary IM channel` would be a `the secondary channel → Telegram` relay
or a `the secondary channel → Telegram` route. Out of scope
for; the news + daily crons already have
`a secondary IM bridge` integration via the secondary channel's own Telegram
channel (if you want it).

## Stub mode (no MMX_API_KEY)

When `MMX_API_KEY` is missing:
- `chat()` returns a deterministic stub response (verdict-
  or recap-style depending on the system prompt).
- `news-cron` still logs the call to `llm_calls`.
- `daily-cron` still writes the R2 recap.
- Telegram messages still go out (with the stub text).

This lets you deploy without an LLM key configured and
verify the cron + Telegram wiring end-to-end. When you
add `MMX_API_KEY` via `wrangler secret put`, the next cron
fires use the real LLM — no code change needed.

## Config (operational)

Set these via `wrangler secret put` (or as a local
`.dev.vars` for `wrangler dev`):

- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_CHAT_ID`   — your personal chat_id
- `MMX_API_KEY`        — MiniMax Messages API key (mmx
                          platform)

## Verification

- `tsc --noEmit` — clean.
- `npm run test:unit` — 123/123 pass in ~0.2s.
- `npm run test:integration` — 41/41 pass in ~0.6s.
- `npm test` — 164/164 pass in ~0.6s.
- `wrangler deploy --dry-run` — bindings + DO + cron
  triggers registered; no validation errors.

## Tests

- 13 new telegram tests (URL/payload, parse_mode, error
  paths, truncation, mock fetch).
- 11 new LLM tests (stub mode for each prompt type, HTTP
  auth header, default + override model, HTTP error
  paths).
- 9 new API status tests (counts, filters, error path).

## Open follow-ups (forward work)

- ** (dashboard)**: the `public/index.html` reads
  the status endpoints to render the live PnL card,
  the per-vertical breakdown, the recent trades/signals
  lists, and the daily recap from R2.
- **News search API**: the LLM context includes the
  suggested news query as a hint, but we don't actually
  fetch news. A real news search (Anthropic web search
  or a dedicated API) would replace the hint-only path.
- **a secondary IM bridge**: secondary channel for the same
  news + daily summaries.
- ** (real trading toggle)**: the news + daily
  summaries may want to also include "real money" PnL
  when the live trading is enabled.
