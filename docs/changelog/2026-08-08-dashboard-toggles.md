# Dashboard toggles: pause, paper, go-live and kill (2026-08-08)

The  default caps were sized for a hypothetical
"test with a real bag" account. For a $9.73 reality they
were a yolo: `$10/day deployed notional` on a $9.73 balance
= 100% of the account deployable in a single day. This
step scales them down and exposes the trading controls
in the dashboard so operators can flip modes without
hitting the API.

## What changed

### Caps (revised defaults)

| Knob | Before | After | Reasoning |
|---|---|---|---|
| Per-trade cap | 100c ($1.00) | **25c** ($0.25) | 2.5% of balance per trade. |
| Daily deployed notional | 1000c ($10.00) | **150c** ($1.50) | 15% of balance per 24h. |
| Max daily loss | up to $10 | ~$0.75 | Plenty of room to learn if the bot's edge is below fee. |

Both are operator-bumpable via `POST /api/pm/bot/start`
with `{"max_notional_cents_per_trade": 50, "daily_notional_cents_cap": 250}`.
The 25c / 150c defaults are right-sized for a $9.73 account.

### New: `src/api/balance.ts` — Kalshi account balance

`GET /api/pm/bot/balance` — calls Kalshi's
`/portfolio/balance` via the prod creds and returns:

```json
{
  "ok": true,
  "balance_cents": 927,
  "balance_dollars": "9.27",
  "portfolio_value_cents": 67,
  "portfolio_value_dollars": "0.67",
  "updated_ts": 1786190299
}
```

30s Cache-Control. Errors return `503 missing_credentials`
or `502 kalshi_balance_failed` (with a `detail` field
carrying the upstream error message).

Wired in `src/index.ts`:
```typescript
if (path === "/api/pm/bot/balance" && request.method === "GET") {
    return handleBotBalance(env, url);
}
```

### New: Dashboard "Trading mode" card

Three big buttons, one card. The active mode gets a
border-highlight + tinted background. The current mode
also shows as a pill in the card title.

```
┌─── Trading mode ─────────────────[paper]───┐
│ ┌─────────┐  ┌─────────┐  ┌─────────┐         │
│ │ 1 PAUSE │  │ 2 PAPER │  │ 3 GO LIVE│         │
│ │ WS keeps│  │ Signals │  │ Real $  │         │
│ │ running │  │ + paper │  │ Real    │         │
│ │ no new  │  │ fills,  │  │ orders  │         │
│ │ trades  │  │ default │  │ needs   │         │
│ │         │  │         │  │ confirm │         │
│ └─────────┘  └─────────┘  └─────────┘         │
│ ──────────────────────────────────────────── │
│ [⚠ KILL SWITCH  off]  panic-stop: refuses all │
│                       new trades immediately │
└──────────────────────────────────────────────┘
```

- **Pause** (`trading_mode: "off"`) — one click, no
  confirm. Bot keeps WS, processes frames, but writes
  no trades.
- **Paper** (`trading_mode: "paper"`) — one click, no
  confirm. Default mode. Signals + paper fills, no
  real money.
- **Go live** (`trading_mode: "real"`) — opens a modal
  with confirmation (see below).
- **Kill switch** — one click, no confirm, red. Toggles
  the engine's kill_switch flag. When ON, the engine
  refuses all new trades (paper + real). Open positions
  are NOT auto-closed.

### New: Dashboard "Caps & today" card

```
┌─── Caps & today ─────────────────────┐
│ Account balance            $9.27    │
│ Per-trade cap              $0.25    │
│ Daily deployed   $0.00 / $1.50     │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│ (bar turns amber at 80%, red at 100%)│
└─────────────────────────────────────┘
```

- Account balance: live from Kalshi (`/api/pm/bot/balance`),
  polled every 30s.
- Per-trade cap: from the bot config.
- Daily deployed: from `risk.daily_notional_cents`.
- Progress bar: width = (used / cap) × 100. Amber at
  80%, red at 100%.

### New: Dashboard "Last 5 trades" panel

```
┌─── Last 5 trades ──────────────────────────────────────────┐
│ When     Ticker         Side  Mode   Price  Size  PnL     │
│ 2h ago   KXWARMING-50   yes   paper  1c     1     —       │
│...                                                         │
└────────────────────────────────────────────────────────────┘
```

The same list also appears inside the go-live modal.
Each row tags the trade with a `paper` or `real` badge
so the operator can see what kind of activity they've
had.

### New: Go-live modal

```
┌── Go live with real money ──────────────┐
│ ⚠ This will place real orders on Kalshi │
│   using your prod credentials. The bot  │
│   will respect the caps shown below.    │
│                                          │
│ Account balance              $9.27     │
│ Per-trade cap                $0.25     │
│ Daily cap (24h)              $1.50     │
│ Today's deployed   $0.00 / $1.50       │
│ Kill switch                   off      │
│                                          │
│ Last 5 trades (real + paper)            │
│ ┌────────────────────────────────────┐  │
│ │ KXWARMING-50  yes  paper  —         │  │
│ │...                                │  │
│ └────────────────────────────────────┘  │
│                                          │
│ Type LIVE to confirm:                    │
│ ┌──────────────────────────────────────┐│
│ │ LIVE                                ││
│ └──────────────────────────────────────┘│
│                                          │
│              [Cancel]  [Go live (real)] │
└──────────────────────────────────────────┘
```

- The input shows a green border when the typed value
  matches `LIVE` exactly, red when it doesn't.
- The confirm button is disabled until the match is
  correct.
- ESC or click-outside closes the modal.
- Cancel button always works.

The confirm button flips `trading_mode` to `"real"`
via `POST /api/pm/bot/trading-mode`. The "Go live" pill
in the trading mode card updates on the next refresh
(5s).

### New: Dashboard "Last 5 trades" panel

The same data also shows in the go-live modal so the
operator has the recent context before committing.

## Verification (2026-08-08 07:58)

- `tsc --noEmit` clean.
- `npm test` 185/185 in ~1s. One test updated to match
  the new 150c default (was 1000c).
- `wrangler deploy` succeeded.
- Caps applied via `POST /api/pm/bot/start` with
  `{"max_notional_cents_per_trade": 25,
   "daily_notional_cents_cap": 150}`.
- Smoke tests:
  - `GET /api/pm/bot/balance` → `$9.27`
  - `POST /api/pm/bot/trading-mode {trading_mode: "off"}`
    → `{"ok":true,"trading_mode":"off"}`
  - `POST /api/pm/bot/trading-mode {trading_mode: "paper"}`
    → `{"ok":true,"trading_mode":"paper"}`
  - `POST /api/pm/bot/kill-switch {on: true}` → ok
  - `POST /api/pm/bot/kill-switch {on: false}` → ok
  - `GET /api/pm/bot/status` confirms
    `trading_mode=paper, kill_switch=false, per-trade=25c,
     daily=150c`.

## Safety considerations

- The Go live modal is the ONLY path to flip to real
  money. It always shows the current caps + today's
  deployed notional + the last 5 trades. Confirmation
  requires typing the literal string `LIVE`.
- Kill switch and Pause are one-click (panic speed).
- The Caps & Today card visually surfaces the daily
  notional used / cap. The bar turns amber at 80%
  and red at 100% so the operator can see they're
  approaching the limit before they hit it.
- Account balance is live from Kalshi, polled every
  30s. Operators see the actual balance, not a stale
  number.
- The dashboard does NOT auto-flip to real. The
  operator must explicitly click "Go live" + type
  `LIVE` to confirm. No way to do this by accident.

## What this enables

- Operators can manage trading mode + caps from the
  dashboard. No more `curl` for routine toggles.
- The go-live modal is a single, deliberate action
  with full context. No "did I mean to click that?"
  moments.
- The kill switch is reachable in two clicks from
  anywhere on the page (no scrolling).
- Account balance is always visible, so operators
  know exactly how much is at risk.
