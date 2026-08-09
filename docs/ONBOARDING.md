# pm-bot operator onboarding (chunk 10.9d)

Welcome to pm-bot — Cloudflare Workers + D1 + DO + R2 + a
Fly.io WebSocket relay, paper-trading (or real) on Kalshi.

This doc is the **copy-paste setup flow** for one operator. It
takes ~10 minutes. Each step is a *single Telegram message* or
*single shell command*. Run them in order.

> **Why per-operator?** Kalshi + Telegram are per-account.
> One bot token = one operator. CF / Fly / D1 can be shared
> but the credentials below are YOURS — keep them private.

---

## 0. Prereqs (~2 min)

- A Cloudflare account (free tier is fine)
- A Fly.io account (free tier covers the relay)
- A Kalshi account (https://kalshi.com) — you can start with
  a demo account, no real money needed for paper trading
- A Telegram account
- Node 22+, npm, `git`, `curl`
- `brew install flyctl` (or `curl -L https://fly.io/install.sh | sh`)
- `npm install -g wrangler` then `wrangler login`

---

## 1. Clone + install (~1 min)

```bash
git clone https://github.com/.git
cd pm-bot
npm install
```

---

## 2. Kalshi API key (~3 min)

1. Log in to https://kalshi.com → Account → API
2. **Demo:** Settings → "Generate demo API key" — gives you a
   `Key ID` + downloads a `.pem` file
3. **Production (when ready for real money):** same flow on
   the prod account
4. Save the .pem to `~/keys/`:
   ```bash
   mkdir -p ~/keys
   cp ~/Downloads/kalshi-*.pem ~/keys/kalshi-demo.pem
   chmod 600 ~/keys/kalshi-demo.pem
   ```

> **Never commit the .pem.** `pm-bot/.gitignore` already
> excludes it. The Key ID is fine to commit.

---

## 3. Telegram bot (~2 min)

Telegram's @BotFather is the **only** way to create a bot —
no API for that. Copy-paste this script in Telegram:

```
YOU:    /newbot

FATHER: Alright, a new bot. How are we going to call it?
        Please choose a name for your bot.

YOU:    pm-bot-alerts            ← (or your own: "acme-pm-alerts")

FATHER: Good. Now let's choose a username for your bot. It
        must end in `bot`. Like this, for example: TetrisBot
        or tetris_bot.

YOU:    acme_pm_alerts_bot       ← (must be globally unique)

FATHER: Done! Congratulations on your new bot. You will find
        it at t.me/acme_pm_alerts_bot. You can now add a
        description [...]

        Use this token to access the HTTP API:
        1234567890:REPLACE_WITH_THE_TOKEN_BOTFATHER_GIVES_YOU
        Keep your token secure and store it safely, it can be
        used by anyone to control your bot.
```

**Save that token — you'll paste it into `wrangler secret put`
in step 5.**

Then open **t.me/your_bot_username** in Telegram and tap
**Start** so the bot has a chat to send to.

---

## 4. Cloudflare + D1 (~1 min)

```bash
# Already authenticated if you ran `wrangler login` in prereqs.
# Create the D1 database (idempotent; ignore "already exists"):
npx wrangler d1 create pm-bot-prod

# Apply the migrations (rebuilds the schema in your D1):
npx wrangler d1 migrations apply pm-bot-prod --remote

# R2 bucket for model artifacts:
npx wrangler r2 bucket create pm-bot
```

Copy the `database_id` from the D1 create output into
`wrangler.jsonc` → `d1_databases[0].database_id`.

---

## 5. Set your secrets (~1 min)

```bash
cd pm-bot

# Kalshi demo
echo "<KALSHI_DEMO_KEY_ID>" | npx wrangler secret put KALSHI_DEMO_KEY_ID
cat ~/keys/kalshi-demo.pem        | npx wrangler secret put KALSHI_DEMO_PRIVATE_KEY

# Kalshi production (skip until you want real money)
# echo "<KALSHI_PROD_KEY_ID>" | npx wrangler secret put KALSHI_PROD_KEY_ID
# cat ~/keys/kalshi-prod.pem   | npx wrangler secret put KALSHI_PROD_PRIVATE_KEY

# Telegram
echo "<TELEGRAM_BOT_TOKEN>" | npx wrangler secret put TELEGRAM_BOT_TOKEN

# Get your chat ID (after /starting the bot in step 3):
TELEGRAM_BOT_TOKEN="<token>" curl -sS \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['result'][0]['message']['chat']['id'])"
# → copy the chat id, then:
echo "<CHAT_ID>" | npx wrangler secret put TELEGRAM_CHAT_ID

# Cloudflare API token (Account-level, NOT User-level):
#   dash.cloudflare.com → My Profile → API Tokens
#   → Create Token → Custom → Account.Account Settings:Read
#   + Account.Workers Scripts:Read
#   → Account.Resources:Include → All accounts
echo "<CF_API_TOKEN>" | npx wrangler secret put CF_API_TOKEN

# Fly.io API token (machine-scoped is fine; the cost endpoint
# falls back to "assumed_running" if the token can't see the
# app — see /api/pm/cost).
#   fly.io → Account → Personal Access Tokens → Generate
#   → Use Org-scoped if available
echo "<FLY_API_TOKEN>" | npx wrangler secret put FLY_API_TOKEN
```

---

## 6. Deploy the relay (Fly.io, ~2 min)

```bash
cd pm-bot/relay
./deploy.sh   # auto-detects OAuth from ~/.fly/config.yml
              # OR set FLY_API_TOKEN=... first
```

Takes ~1 min to build + deploy. Smoke-test:

```bash
curl -i https://pm-bot-relay.fly.dev/
# → HTTP/1.1 426 Upgrade Required (this is correct — it's WS-only)
```

---

## 7. Deploy the Worker (~30 sec)

```bash
cd pm-bot
npx wrangler deploy
```

Take note of the deploy version (e.g. `Version ID: abc123...`).

---

## 8. Verify everything (~1 min)

```bash
# Dashboard
open 

# Health endpoints
curl -sS api/pm/bot/stage
curl -sS api/pm/kalshi-sdk-test
curl -sS api/pm/verticals

# Smoke-test the relay → Kalshi auth chain (no real order):
curl -sS -X POST api/pm/bot/trading-mode \
  -H "content-type: application/json" -d '{"trading_mode":"real"}'
# → response.bankroll_refresh.bankrollCents is your actual
#   Kalshi cash balance in cents.
```

---

## 9. Place a test order (~$0.10)

```bash
# 1. Switch to real (this also re-pulls your bankroll).
curl -sS -X POST api/pm/bot/trading-mode \
  -H "content-type: application/json" -d '{"trading_mode":"real"}'

# 2. Place a 10c / 1-share order on KXWARMING-50 (any
# Kalshi ticker works).
curl -sS -X POST api/pm/bot/place-test-order \
  -H "content-type: application/json" \
  -d '{"ticker":"KXWARMING-50","side":"yes","price_cents":10,"size":1}'

# 3. Check your Telegram — you should see:
#    🟢 real fill (manual): KXWARMING-50
#    side=yes size=1 price=10¢
#    notional=10¢
#    rationale=manual_test_order
#    kalshi order: <uuid>
```

---

## 10. Go back to paper (or stay on real)

```bash
curl -sS -X POST api/pm/bot/trading-mode \
  -H "content-type: application/json" -d '{"trading_mode":"paper"}'
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `KALSHI_DEMO_PRIVATE_KEY not set` (503 on `/api/pm/bot/balance`) | re-run `wrangler secret put KALSHI_DEMO_PRIVATE_KEY` from step 5 |
| Dashboard shows "Loading cadence..." forever | CF API token missing. Re-run step 5. |
| Telegram messages not arriving | (a) bot not `/start`ed in Telegram; (b) `TELEGRAM_BOT_TOKEN` wrong; (c) `TELEGRAM_CHAT_ID` wrong |
| `cf_graphql_query_error: unknown field "cpuTime"` | known stale schema, see [issues tracker](https://github.com//issues) |
| Bot shows "Connecting..." forever on dashboard | inline JS parse error — check wrangler tail for `pageerror` |
| Auto-pilot doesn't flip to real | `AUTO_PILOT_ENABLED=true` must be set on the Worker (env var, not secret) |

---

## Multi-tenant notes (future work)

pm-bot today is **single-tenant per Worker deployment**. To
go multi-tenant, each operator would need their own Worker
deployment (different `*.workers.dev` subdomain) with their
own:
- `KALSHI_DEMO_KEY_ID` / `KALSHI_DEMO_PRIVATE_KEY` (or prod)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
- `CF_API_TOKEN` (Account-level, not User-level)

The DO is addressed by `idFromName(\`user:${userId}\`)` so a
single Worker can host multiple DOs but only one set of env
secrets. To go true multi-tenant, the Worker would need a
`user_id → secrets` mapping table in D1 + a per-user auth
layer at the gateway. **Not built yet** — single-tenant is
the supported configuration as of chunk 10.9.

If you want to deploy for a client, the simplest path is:
clone the repo → `wrangler deploy --name their-pm-bot` →
set their secrets → share the dashboard URL. Each
deployment is independent.

---

## What you should end up with

- A dashboard at `pm/` (or your custom
  domain) showing live trading data
- A `trader-bot-alerts` (or your chosen name) Telegram bot
  pinging you on real fills
- The bot placing paper trades via the reversion model
  (weather + economic) + naive baseline (politics + sports)
- Auto-restart on the 90-min cycle (alarm)
- Daily recap at 06:00 UTC
- Backtest retrospective Sunday 01:00 UTC

If anything's broken, the most useful debug tool is:

```bash
npx wrangler tail --format=json | grep -E "live-bot|telegram|cf_"
```

Good luck.
