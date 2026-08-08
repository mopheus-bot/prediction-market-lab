#!/usr/bin/env bash
#
# pm-bot-relay deploy script (chunk 10.6).
#
# One-time setup: `fly launch` (creates the app), `fly secrets set`,
# `fly deploy`. After that, every `fly deploy` is a single command
# that updates the running relay.
#
# Prerequisites: `brew install flyctl` (or `curl -L https://fly.io/install.sh | sh`).
# Auth: either `fly auth login` (OAuth credentials at ~/.fly/config.yml)
# OR `export FLY_API_TOKEN=<your-fly-account-token>` (an `Fo1_...` org
# token, not the `fm2_...` machine token). The deploy script
# auto-detects which auth you have.
#
# Usage:
#   fly auth login                  # one-time OAuth
#   ./deploy.sh                     # first-time deploy
#   ./deploy.sh --update            # update an existing deploy
#
set -euo pipefail

APP_NAME="pm-bot-relay"
DEMO_KEY="/Users/mo/keys/kalshi-demo-keyid.txt"
DEMO_PEM="/Users/mo/keys/kalshi-demo.pem"

# Auth detection: FLY_API_TOKEN env var > ~/.fly/config.yml OAuth.
# A machine-scoped `fm2_*` token is NOT enough for `fly launch` —
# it can manage its own machine but can't create new apps.
if [[ -z "${FLY_API_TOKEN:-}" ]]; then
	if [[ -f "${HOME}/.fly/config.yml" ]] && grep -q "access_token:" "${HOME}/.fly/config.yml"; then
		echo "==> using OAuth credentials from ~/.fly/config.yml"
	else
		echo "error: no Fly.io auth found. Either:"
		echo "  1. Run 'fly auth login' (OAuth, recommended for first-time deploy)"
		echo "  2. Or: export FLY_API_TOKEN=\"<your-Fo1-_-org-token>\""
		exit 1
	fi
fi

if [[ ! -f "$DEMO_KEY" ]]; then
	echo "error: $DEMO_KEY not found"
	exit 1
fi
if [[ ! -f "$DEMO_PEM" ]]; then
	echo "error: $DEMO_PEM not found"
	exit 1
fi

if [[ "${1:-}" == "--update" ]]; then
	echo "==> deploying update to $APP_NAME"
	fly deploy --remote-only
	exit 0
fi

echo "==> first-time deploy of $APP_NAME"
echo "    this creates the app, sets secrets, and deploys the relay"

# 1. Create the app (no deploy yet).
echo "==> fly launch (creating app)"
fly launch --no-deploy --copy-config

# 2. Set the secrets.
echo "==> setting secrets"
DEMO_KEY_ID="$(cat "$DEMO_KEY")"
DEMO_PRIVATE_KEY="$(cat "$DEMO_PEM")"
fly secrets set \
	--stage \
	KALSHI_KEY_ID="$DEMO_KEY_ID" \
	KALSHI_PRIVATE_KEY="$DEMO_PRIVATE_KEY"

# 3. Deploy.
echo "==> fly deploy"
fly deploy --remote-only

# 4. Smoke test.
echo "==> smoke test"
sleep 5
fly status
echo ""
echo "relay should now be at: wss://${APP_NAME}.fly.dev/"
echo "in the bot: POST /api/pm/bot/start with body: {\"url\": \"wss://${APP_NAME}.fly.dev/\"}"
