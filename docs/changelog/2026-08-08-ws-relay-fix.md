# WebSocket relay fix (2026-08-08)

**Problem:** Bot was configured to connect to
`wss://prediction-market-lab-relay.fly.dev/` but `connected: false`,
`n_frames: 0`, `last_ws_error: null`. The `open` event never
fired. The Stage panel stuck on "Connecting…".

**Root cause:** `openKalshiWs` always called
`new WebSocket(url, { headers } as unknown as string[])` —
passing `{ headers }` as the second arg. CF Workers treats that
second arg as a protocols string (it should be `string[] |
string`), so the `{ headers }` was silently dropped. Result: the
WS upgrade went out without auth headers, the relay accepted
the connection, but the protocol negotiation was wrong and
`open` never fired.

**Fix:** Detect the relay (or any non-Kalshi host) by checking
`!url.includes("kalshi")` and use the plain `new WebSocket(url)`
form — no second arg. The relay handles Kalshi auth server-side;
the Worker just needs a clean WS upgrade.

**Also added:**
- 10-second `open` event timeout. If `open` doesn't fire within
  10s, the bot logs `_lastWsError = { code: "open_timeout",... }`,
  closes the WS, and schedules a reconnect. Catches the
  silent-CLOSING case so the dashboard never sits on
  "Connecting…" forever.
- Cadence endpoint was using wrong DO path
  (`/api/pm/bot/status` instead of `/status`), so the WS row
  always showed "not connected" even when /stage said "streaming".
- Fly.io cost endpoint was returning
  `status: "not_deployed"` when the `fm2_*` machine token
  couldn't see the app via the org-level API. Now falls through
  to `status: "assumed_running"` and assumes 1 machine × 24/7.
- `wrangler.jsonc DEFAULT_URL` now points at the deployed relay
  so future /start calls don't need a URL.
- `relay/deploy.sh` auto-detects OAuth creds in
  `~/.fly/config.yml` (no more `FLY_API_TOKEN required` error
  when `fly auth login` was used).

**Files:**
- `src/durable-objects/LiveBot.ts` — `openKalshiWs` rewrite (relay
  detection + 10s open-event timeout)
- `src/api/cadence.ts` — fix `stub.fetch` path
- `src/api/cost.ts` — assume 24/7 when API returns 404
- `test/ws-relay.test.ts` — 5 new tests pinning the URL
  classification
- `test/cost-monthly.test.ts` — 1 new test for `assumed_running`
  math
- `vitest.config.mts` — wire new tests into the unit project
- `wrangler.jsonc` — `DEFAULT_URL` → relay
- `relay/fly.toml` — `fly launch` rewrote (quotes + new `[vm]`
  schema)
- `relay/deploy.sh` — OAuth auto-detect
- `docs/operations.md` — relay section: "why a relay exists" +
  RSA-PSS spec + token scope limitation

**Test count:** 229 → 235 (+6).

**Live state after deploy:**
- Stage: `streaming` (color=ok)
- Cadence WS row: `ok` — connected, 25 frames received
- Cadence summary: 4/7 ok, 3/7 starting (daily/train/model_registry
  — those run on weekly cron schedules, not the WS path)
- `fly_relay`: `assumed_running`, $0.49/mo estimated,
  $0.34 free credit remaining
- `cf_monthly`: all bars <1% (Paid plan, way under limits)

**Deploys (4 total in this step):**
- `58fd41b3` — openKalshiWs relay detection + 10s open timeout
- `27484cc7` — cadence stub.fetch path fix
- `97cc2ada` — cost.ts fly_relay assumed_running fallback
- `2d0d6cab` — wrangler DEFAULT_URL + deploy.sh OAuth + ops runbook

**Commits:**
- `cf921e1` —  main
- `88f8eca` —.7b cadence path fix
- `955739c` —.7c fly_relay status
- `ee3b99f` —.7d polish
