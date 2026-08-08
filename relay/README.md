# pm-bot Kalshi WebSocket relay

This is the bridge that lets the pm-bot CF Worker talk to
Kalshi's WebSocket feed. CF Workers can't add custom
headers to outbound WebSocket connections, so the bot
can't auth directly with Kalshi. The relay accepts an
unauthenticated WebSocket from the bot, signs the Kalshi
WS path with the demo creds, and forwards messages both
ways.

## What's inside

- **`server.py`** — the relay. ~30 lines of `websockets` +
  `cryptography`. Signs the path with RSA-SHA256, opens
  an authed WS to Kalshi, forwards messages bidirectionally.
- **`requirements.txt`** — `websockets>=12.0,<14.0` and
  `cryptography>=42.0,<46.0`.
- **`Dockerfile`** — `python:3.12-slim` + the deps + the
  server. Runs as a non-root user.
- **`fly.toml`** — Fly.io app config. `shared-cpu-1x`,
  1GB RAM, $1.94/mo. Exposes port 8080 over TCP+TLS
  (Fly's edge handles the TLS).
- **`deploy.sh`** — one-time setup + deploy. Run from
  this directory.

## Why a relay, not the bot itself

CF Workers' `new WebSocket(url)` constructor does NOT
support custom headers on the outbound upgrade — the
`{ headers }` second arg is treated as a protocols string
and rejected. The `fetch(url, { Upgrade: "websocket" })`
pattern returns 101 + a WebSocket object, but the WS
immediately goes to `readyState: 2` (CLOSING) without
firing `open`. The `nodejs_compat` flag does NOT change
this. So there's no way to do this entirely in CF
Workers. A separate runtime (Python, Node.js, etc.) is
required to add the auth headers to the WS upgrade.

The Python `websockets` library supports `extra_headers`
on the upgrade (the same way `kalshi_ws.py` does it in
`live/kalshi_ws.py`).
So the relay is a thin shim that wraps the same logic.

## Deploy to Fly.io

```bash
# 1. Install the fly CLI (one-time).
brew install flyctl        # macOS
# or: curl -L https://fly.io/install.sh | sh

# 2. Log in with your Fly.io account token.
#    The machine token in
#    ~/Documents/GitHub/Prediction Market Lab/docs/modes/prediction-markets-env.txt
#    is scoped to one app — for `fly launch` you need an account token.
#    Get one at: https://fly.io/user/personal_access_tokens
export FLY_API_TOKEN="<your-fly-account-token>"

# 3. From this directory, run the one-command deploy.
./deploy.sh
```

That's it. The script:
1. Runs `fly launch --no-deploy` (creates the `pm-bot-relay` app).
2. Sets the `KALSHI_KEY_ID` + `KALSHI_PRIVATE_KEY` secrets.
3. Runs `fly deploy` (builds + ships the image).
4. Prints the smoke test + the URL.

To update after a code change: `./deploy.sh --update`.

## Point the bot at the relay

Once deployed, switch the bot to use the relay URL via the
existing `/start` endpoint:

```bash
curl -X POST 'api/pm/bot/start' \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"url": "wss://pm-bot-relay.fly.dev/"}'
```

The bot will reconnect through the relay. The
`fetch(url, { headers: { Upgrade: "websocket" } })` pattern
the bot already uses will work with the relay because the
relay is at a `wss://` URL with no auth required (it
optionally accepts a shared secret via `X-Relay-Token`
header; see "Security" below).

To switch back to direct Kalshi (won't work for auth, but
useful for testing): `POST /start` with
`{"url": "wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2"}`.

## Security

The relay is a public endpoint. Anyone with the URL can
connect and proxy through to Kalshi. The risk is bandwidth
+ a small amount of auth-quota usage. For a personal
trading bot, that's acceptable. To lock it down:

1. Set `RELAY_TOKEN=<random>` as a Fly.io secret.
2. Set the same value in the CF Worker as a `RELAY_TOKEN` env var.
3. The Worker adds an `X-Relay-Token: <random>` header on the
   WS upgrade. The relay checks the header; rejects if it
   doesn't match.

## Cost

- **Fly.io**: `shared-cpu-1x` (1GB RAM) = $1.94/mo. The user
  currently has $0.83 of free Fly.io credit, so the first
  ~12 days of relay operation are free.
- **Bandwidth**: minimal. The relay is just a thin shim
  that forwards bytes.
- **CF**: zero (the relay is on a different host).

## Local development

To run the relay locally + expose it via cloudflared:

```bash
# 1. Install deps.
pip install -r requirements.txt

# 2. Set the env vars + run.
KALSHI_KEY_ID="$(cat /Users/mo/keys/kalshi-demo-keyid.txt)" \
  KALSHI_PRIVATE_KEY="$(cat /Users/mo/keys/kalshi-demo.pem)" \
  KALSHI_WS_URL="wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2" \
  PORT=8080 \
  python server.py

# 3. In another terminal, expose via cloudflared.
cloudflared tunnel --url http://localhost:8080

# 4. Point the bot at the cloudflared URL.
curl -X POST 'api/pm/bot/start' \
  -H "Content-Type: application/json" \
  -d '{"url": "wss://<your-tunnel>.trycloudflare.com/"}'
```

This is the free dev option. The Mac must be on for the
bot to work; when the Mac sleeps, the WS drops (the bot
auto-reconnects when the Mac wakes).
