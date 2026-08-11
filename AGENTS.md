# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

---

# pm-bot — project context

## Doc index

| Doc | What it covers |
|---|---|
| [`docs/PLAN.md`](./docs/PLAN.md) | Architecture, chunk plan, decisions, cost-at-scale |
| [`docs/ONBOARDING.md`](./docs/ONBOARDING.md) | New-dev setup, env vars, deploy |
| [`docs/STRATEGY-PARLAYS.md`](./docs/STRATEGY-PARLAYS.md) | Parlay strategy rationale (note: 2026-08-11 LLM hallucinates on parlays — see `docs/LLM-PIPELINE.md`) |
| [`docs/EVENT-DRIVEN-UI.md`](./docs/EVENT-DRIVEN-UI.md) | SSE event vocabulary + render contract for the live dashboard |
| [`docs/operations.md`](./docs/operations.md) | Day-to-day runbook (kill switch, restart, cron triggers) |
| [`docs/LLM-PIPELINE.md`](./docs/LLM-PIPELINE.md) | **Read this before debugging the bot.** The three real bugs in the LLM-driven pipeline as of 2026-08-11: (A) research worker feeds the LLM ticker+title+price only, no parlay component data → LLM hallucinates; (B) LLM cron caps at 50/run, doesn't cover the full 2,184-market catalog in any reasonable window; (C) the 6h flip-filter hold blocks re-examination of open positions, so the "more allowance" (per-trade cap bump) is inert for positions the bot already has. Plus the cost / safety math, the action items, and the lesson that the "judge" was a sizing function downstream of the LLM, not the layer that decided whether to trade. |
| [`docs/changelog/2026-08-11-phase-4-17-vertical-expansion.md`](./docs/changelog/2026-08-11-phase-4-17-vertical-expansion.md) | Phase 4 push (chunks 15–15.4): 4→17 verticals, research-cron scope fix, LLM cron parallelize + drop no_price, auto-retrain pipeline, LLM-PIPELINE Bug A fix. |
| [`docs/changelog/2026-08-11-dashboard-live-pnl-fixes.md`](./docs/changelog/2026-08-11-dashboard-live-pnl-fixes.md) | Later same-day fix: dashboard cache headers, research-cron universe-priority cap, summary endpoint rolling-24h. **The "PnL stuck at $1.35 all day" bug is in here — root cause was the R2 daily-recap being read as the live source.** |

Serverless port of the Kalshi trading bot. Source of truth for strategy: `~/Documents/GitHub/the Python reference engine/` (Python). **Full architecture, chunk plan, decisions, and cost-at-scale analysis: see [`docs/PLAN.md`](./docs/PLAN.md).**

## Infrastructure

- **CF account ID:** `8c995c329fee2ee6ab33d9d3d6a30e55`
- **CF zone ID ():** `9f300065a436e6f73d9d86a13f49607c`
- **CF API tokens:** `/Users/mo/Documents/clients/dev/tokens/cloudflare-tokens.md`
  - OAuth (`cfoat_*`) — for wrangler deploys. **No DNS scope.**
  - User API (`cfut_*`) — for DNS / zone-level ops.
- **D1 database:** `pm-bot-prod` — ID `cd54a509-f2e2-4f6f-97a5-a53afa6c0a36`
- **R2 bucket:** `pm-bot` — model artifacts + market data archive
- **Workers Paid plan enabled** — $5/mo base
- **Custom domain:** `` (A record → 192.0.2.1, proxied)
  - `/pm/*` → dashboard (CF Access protected)
  - `/api/pm/*` → API (CF Access protected, service token for programmatic access)
- **CF Access app:** name `bot`, path-based, 24h session, IDP and policy IDs in user's CF dashboard
- **Repo:** `https://github.com/` (private)

## Deploy workflow

```bash
cd ~/Documents/GitHub/pm-bot
npm run deploy          # = wrangler deploy
```

CHANGELOG / commit history lives in git. Each chunk lands as a commit on main.

## Heads-up: the `bot.` prefix is in flux

The user flagged on 2026-08-08 that "the bot prefix and some other things going in for the Prediction Market Lab pm project" are changing. **Before any DNS or routing change for pm-bot, ask the user "is `` still the right prefix?"** before writing any rules or records.

## Multi-tenant from day 1

Even for a single user, all tables get a `user_id` column (default `'default'`). DO addressed by `idFromName(`user:${userId}`)`. Adding a second user = config change, not refactor.

## Decisions to honor

See `docs/PLAN.md` for the full list. Top three:
- **CF stack over Fly.io** — chose Option C for the analysis + upgrade loop.
- **MiniMax-M2.7-highspeed** for LLM (don't compromise quality for cost).
- **WebSocket hibernation is mandatory** on the DO — without it, $50-140/mo. With it, $0.01-0.50/mo.

## Keys (verified)

- `KALSHI_PROD_KEY_ID` — at `~/keys/kalshi-prod-keyid.txt`
- `KALSHI_PROD_PRIVATE_KEY` (PEM) — at `~/keys/kalshi-prod.pem`
- (Real money: one small test trade placed in past. Currently paper-only. Will go to CF Worker secrets via `wrangler secret put` in Chunk 9.)

## Telegram bridge setup (when ready, Chunk 6)

1. `@BotFather` in Telegram → `/newbot` → get bot token
2. Send `/start` to your new bot from your Telegram
3. Get your chat_id via `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. `wrangler secret put TELEGRAM_BOT_TOKEN` and `wrangler secret put TELEGRAM_CHAT_ID`
