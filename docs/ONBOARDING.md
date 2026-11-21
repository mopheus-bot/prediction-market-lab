# prediction-market-lab operator onboarding (.9d)

Welcome to prediction-market-lab — Cloudflare Workers + D1 + DO + R2 + a
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
cd prediction-market-lab
npm install
```

---

## 2. Kalshi API key (~3 min)

1. Log in to https://kalshi.com → Account → API
2. **Demo:** Settings → "Generate demo API key" — gives you a
   `Key ID` + downloads a `.pem` file
3. **Production (when ready for real money):** same flow on
   the prod account
4. Save the.pem to `~/keys/`:
   ```bash
   mkdir -p ~/keys
   cp ~/Downloads/kalshi-*.pem ~/keys/kalshi-demo.pem
   chmod 600 ~/keys/kalshi-demo.pem
   ```

> **Never commit the.pem.** `prediction-market-lab/.gitignore` already
> excludes it. The Key ID is fine to commit.

---

## 3. Telegram bot (~2 min)

Telegram's @BotFather is the **only** way to create a bot —
no API for that. Below is the literal conversation you'll
have. Replace `<your-pm>` with your initials or handle (e.g.
`mo`, `acme`, `morgan`); the username must be **globally unique**
and end in `bot`.

### 3a. Suggested bot names

| Name (display) | Username (handle) | Vibe |
|---|---|---|
| `prediction-market-lab-alerts` | `mo_pm_alerts_bot` | short, project-tied (this is what we used) |
| `trader-bot-alerts` | `mo_trader_alerts_bot` | generic — fits any trading bot |
| `kalshi-prediction-market-lab` | `mo_kalshi_pm_bot` | ties to the platform |
| `paper-money-bot` | `mo_paper_money_bot` | funny, what it actually does |
| `<your-pm>-alerts` | `<your-pm>_alerts_bot` | blank-slate — pick your own |

Pick one and walk through the chat below.

### 3b. The full chat (what you'll see, copy-paste this)

```
═══════════════════════════════════════════════════════════════
INBOX: BotFather                              [today, 22:46]
═══════════════════════════════════════════════════════════════

YOU  →  /newbot
                                              22:46:01 ↓

BF   ←  Alright, a new bot. How are we going to call it?
        Please choose a name for your bot.
                                              22:46:05 ↓

YOU  →  trader-bot-alerts
                                              22:46:08 ↓

BF   ←  Good. Now let's choose a username for your bot.
        It must end in `bot`. Like this, for example:
        TetrisBot or tetris_bot.
                                              22:46:12 ↓

YOU  →  @mo_trader_alerts_bot
                                              22:46:15 ↓

BF   ←  Done! Congratulations on your new bot. You will
        find it at t.me/mo_trader_alerts_bot. You can now
        add a description, about section and profile picture
        for your bot, see /help for a list of commands. By
        the way, when you've finished creating your cool bot,
        ping our Bot Support if you want a better username
        for it. Just make sure the bot is fully operational
        before you do this.

        Use this token to access the HTTP API:
        1234567890:REPLACE_WITH_THE_TOKEN_BOTFATHER_GIVES_YOU
        Keep your token secure and store it safely, it can
        be used by anyone to control your bot.

        For a description of the Bot API, see this page:
        https://core.telegram.org/bots/api
                                              22:46:20 ↓

═══════════════════════════════════════════════════════════════
```

**Save that token** (the long `1234567890:...` string)
— you'll paste it into `wrangler secret put` .

The token format is always: `<bot_id>:<base64-yaml-secret>`. Don't
commit it. Don't share it. Anyone with the token can fully
control your bot.

### 3c. Start the conversation (required for messages to deliver)

Open **t.me/your_username_bot** in Telegram and tap
**Start** (or send `/start`). Until you do this, your bot
has no chat to send to — every `sendMessage` call will return
`Bad Request: chat not found`.

```
═══════════════════════════════════════════════════════════════
INBOX: your_username_bot                      [today, 22:47]
═══════════════════════════════════════════════════════════════

YOU  →  /start
                                              22:47:01 ↓
═══════════════════════════════════════════════════════════════
```

(No auto-reply — your bot only speaks when prediction-market-lab pings it.
The `/start` is just opening the chat for delivery.)

### 3d. Get your chat ID (the number prediction-market-lab sends messages to)

The chat ID is the **first thing you'll need **.
Run this once you've sent `/start` to the new bot:

```bash
TELEGRAM_BOT_TOKEN="<paste your token >"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
for u in d.get('result', []):
    chat = u.get('message', {}).get('chat', {})
    print(f'chat_id = {chat.get(\"id\")}  (name: {chat.get(\"first_name\")})')
"
```

You'll see:

```
chat_id = 8032433619  (name: Morgan)
```

**Save that number** — it goes into `TELEGRAM_CHAT_ID` .

> If `result` is `[]`, you forgot to send `/start` in 3c.
> Re-open the bot in Telegram and send `/start`, then retry.

---

## 4. Cloudflare + D1 (~1 min)

```bash
# Already authenticated if you ran `wrangler login` in prereqs.
# Create the D1 database (idempotent; ignore "already exists"):
npx wrangler d1 create prediction-market-lab

# Apply the migrations (rebuilds the schema in your D1):
npx wrangler d1 migrations apply prediction-market-lab --remote

# R2 bucket for model artifacts:
npx wrangler r2 bucket create prediction-market-lab
```

Copy the `database_id` from the D1 create output into
`wrangler.jsonc` → `d1_databases[0].database_id`.

---

## 5. Set your secrets (~1 min)

```bash
cd prediction-market-lab

# Kalshi demo
echo "<KALSHI_DEMO_KEY_ID>" | npx wrangler secret put KALSHI_DEMO_KEY_ID
cat ~/keys/kalshi-demo.pem        | npx wrangler secret put KALSHI_DEMO_PRIVATE_KEY

# Kalshi production (skip until you want real money)
# echo "<KALSHI_PROD_KEY_ID>" | npx wrangler secret put KALSHI_PROD_KEY_ID
# cat ~/keys/kalshi-prod.pem   | npx wrangler secret put KALSHI_PROD_PRIVATE_KEY

# Telegram
echo "<TELEGRAM_BOT_TOKEN>" | npx wrangler secret put TELEGRAM_BOT_TOKEN

# Get your chat ID (after /starting the bot ):
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
cd prediction-market-lab/relay
./deploy.sh   # auto-detects OAuth from ~/.fly/config.yml
              # OR set FLY_API_TOKEN=... first
```

Takes ~1 min to build + deploy. Smoke-test:

```bash
curl -i https://prediction-market-lab-relay.fly.dev/
# → HTTP/1.1 426 Upgrade Required (this is correct — it's WS-only)
```

---

## 7. Deploy the Worker (~30 sec)

```bash
cd prediction-market-lab
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
| `KALSHI_DEMO_PRIVATE_KEY not set` (503 on `/api/pm/bot/balance`) | re-run `wrangler secret put KALSHI_DEMO_PRIVATE_KEY`  |
| Dashboard shows "Loading cadence..." forever | CF API token missing. Re-run . |
| Telegram messages not arriving | (a) bot not `/start`ed in Telegram; (b) `TELEGRAM_BOT_TOKEN` wrong; (c) `TELEGRAM_CHAT_ID` wrong |
| `cf_graphql_query_error: unknown field "cpuTime"` | known stale schema, see [issues tracker](https://github.com//issues) |
| Bot shows "Connecting..." forever on dashboard | inline JS parse error — check wrangler tail for `pageerror` |
| Auto-pilot doesn't flip to real | `AUTO_PILOT_ENABLED=true` must be set on the Worker (env var, not secret) |

---

## Multi-tenant notes (future work)

prediction-market-lab today is **single-tenant per Worker deployment**. To
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
the supported configuration as of.

If you want to deploy for a client, the simplest path is:
clone the repo → `wrangler deploy --name their-prediction-market-lab` →
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
