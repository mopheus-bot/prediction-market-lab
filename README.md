# pm-bot

Serverless Kalshi trading bot. Cloudflare Workers + Durable Objects + D1 + R2.

- **Dashboard:** `pm` (CF Access protected)
- **API:** `api/pm/*` (CF Access protected, service token for programmatic access)
- **Source of truth:** the Prediction Market Lab `tools/predictive-markets/` Python codebase. This TS port mirrors it.

## Architecture

- **D1** (`DB`) — trades, signals, market_snapshots, model registry.
- **R2** (`BUCKET`) — model artifacts (ONNX), market data archive, reports.
- **Durable Objects** — live bot (one per user), shadow bot, scheduled via `ctx.storage` + hibernation.
- **Cron Triggers** — scan, news, daily recap, weekly train.
- **Telegram bridge** — IM notifications (primary), a secondary IM channel.

## Local dev

```bash
npm install
npm run dev                 # local Worker on http://localhost:8787
npm run d1:migrate:local    # apply migrations to local D1
npm run typecheck
```

## Deploy

```bash
npm run deploy
```

## Secrets (set once, then `wrangler secret put <NAME>`)

- `KALSHI_PROD_KEY_ID` — Kalshi prod API key ID
- `KALSHI_PROD_PRIVATE_KEY` — Kalshi prod RSA private key (PEM contents)
- `KALSHI_DEMO_KEY_ID` — for safe local testing
- `KALSHI_DEMO_PRIVATE_KEY`
- `TELEGRAM_BOT_TOKEN` — Telegram bot for IM notifications
- `TELEGRAM_CHAT_ID` — your personal chat ID
- `MMX_API_KEY` — for `mmx` CLI inside Workers (if used; otherwise call external)

## Docs

See `docs/PLAN.md` (TBD) for the full chunk-by-chunk plan.
