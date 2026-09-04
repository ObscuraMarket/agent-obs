# Integrating the OBS dashboard into obscura.market

For Obscura's developers. This folder is the whole integration surface: one
read-only JSON API served by the agent, and one dependency-free page that
renders it. Use the page as-is (iframe it, or copy it), or fetch the JSON
into your own Angular components. Nothing here needs our code in your build.

What people see: a **terminal** where OBS's thoughts land the moment he
thinks them (every desk cycle, pushed over a live stream, with the decision
each cycle ends on), his **portfolio** (equity curve, mark-to-market PnL,
realized and unrealized, allocation), his **positions** with the PnL of each
(size, average cost, value, unrealized, realized, share), his **trades**
(swaps through Obscura, with the settlement transaction), plus the X feed
and the live reads he is allowed to cite.

## 1. Run the API

```
cd agent
npm install
cp .env.example .env        # only OBS_DASHBOARD_PORT matters for the dashboard
npm run dashboard           # http://localhost:4671
```

The API reads the agent's local ledgers and a cached set of public chain and
site reads. It holds no key and accepts only GET. Host it anywhere Node 22+
runs, on the same box the agent's timers run on (the ledgers live there).
Put it behind your domain, for example `obs-api.obscura.market`.

CORS: `OBS_DASHBOARD_ORIGINS=*` by default; set it to
`https://obscura.market,https://obscuracex.com` in production.

## 2. Endpoints

All responses are JSON, `Cache-Control: public, max-age=30`, except the
stream (`text/event-stream`, no cache). Timestamps are Unix milliseconds.
Every numeric field can be `null`, which means "not measured this cycle",
never zero.

### `GET /api/obs/health`
```json
{ "status": "ok", "at": 1788260000000 }
```

### `GET /api/obs/status`
```json
{
  "agent": { "operator": "obs", "voice": "obs-copywriter", "handle": "ObscuraCEX", "mode": "draft" },
  "desk": {
    "equityUsd": 2454.4, "pnlUsd": 54.4, "pnlPct": 0.0227, "netCapitalUsd": 2400,
    "trades": { "settled": 3, "pending": 1, "proposed": 0 },
    "lastThoughtAt": 1788259000000, "markedAt": 1788259000000, "canExecute": false
  },
  "posts": { "total": 12, "published": 9, "drafts": 3, "lastAt": 1788259000000 },
  "replies": { "total": 4, "published": 4, "lastAt": 1788258000000 },
  "decisions": { "post": 9, "hold": 5 },
  "token": { "contract": "0xfe242d1da8fd04f6a1f80b6d3d807b02e062ad4e", "site": "https://obscura.market" },
  "limits": { "maxTweetChars": 280 },
  "at": 1788260000000
}
```
The response also carries `rails`: the limits every swap is checked against
and what is used, `{ tradingOn, maxSwapUsd, dailySwapUsd, maxOpenOrders,
gasReserveEth, sentTodayUsd, openOrders, allowedAssets, allowedPartners,
allowedChains }`. `allowedChains` is the chains both legs of a swap must be
on, `["robinhood"]`: the desk trades on Robinhood Chain only.
`sentTodayUsd` is dollars sent into routes in the last 24 hours; `openOrders`
counts pending swaps; `allowedPartners` is `null` when any Obscura route may
be used.

`agent.mode`: `live` (posting to X), `draft` (ledger only), `unconfigured`
(no X keys). `desk.canExecute` is `false` until the execution stage exists;
while it is false every swap decision is a proposal. `desk` is read from the
last stored snapshot, so this call never touches the network. The response
also carries `wallet: { address, explorerUrl }` (or `null`): the desk's own
public address, shown on purpose so balances and settlements can be checked.

`GET /api/obs/reads` includes `wallet` when one is configured:
```json
"wallet": { "address": "0x...", "ethRobinhood": 0.25, "ethMainnet": 0.1, "usdg": 120.5, "obs": 0,
            "rewards": { "swaps": 2, "volumeUsd": 480, "rewardsUsd": 1.2, "paidUsd": 0 } }
```
Balances are read from the chains; `rewards` is Obscura's own
`/rewards/{wallet}` for the address. `wallet.tokens` (additive) carries
every registered token balance keyed `SYMBOL@network`, for example
`"WBTC@erc20": 0.001, "DAI@erc20": 20, "NVDA@robinhood": 0.5`; a `null`
value means that chain did not answer. The named fields above remain.

`token` in `/api/obs/reads` carries, besides name, symbol, decimals, supply
and `holders`, the explorer's own lagging figures `explorerPriceUsd`,
`volume24hUsd` and `marketCapUsd`. `market` (the pool read) adds
`usdgInPool`, `obsInPool` and `tvlUsd`, what the pool holds and its dollar
value at the pool's own price. The page's stats strip prefers the pool price
and computes market cap from it and the supply.

`/api/obs/pnl` also carries `track` (additive): `{ roundTrips, wins, losses,
hitRatePct, avgWinUsd, avgLossUsd, realizedUsd, realized24hUsd,
realized7dUsd, last: [{ at, asset, usd }] }`, every settled sell of a
non-stable asset against its average cost.

### `GET /api/obs/signals`
What the desk is watching and how close each signal is to acting:
```json
{
  "basis": { "poolUsd": 230.06, "perpUsd": 230.66, "printUsd": 228.45, "gapToPerpPct": -0.26, "gapToPrintPct": 0.7,
             "roundTripCostPct": 0.62, "netEdgePct": -0.36, "side": "none", "minEdgePct": 0.25 },
  "reference": { "printStatus": "closed", "printAt": "Sep 3, 2026", "perpTradesDay": 15074, "perpChangeDayPct": 2.05 },
  "ratio": { "ratioNow": 10.92, "avg7d": null, "deviationPct": null },
  "session": { "open": false, "label": "pre-market", "minutesToChange": 491 },
  "candidates": [{ "symbol": "LEGS", "grade": null, "capUsd": 0, "why": "below the bar: 45% off its peak", "depthUsd": 871, "trend": "rolling over" }],
  "market": { "priceUsd": 0.00066, "depthUsd2pct": 197 },
  "at": 1788500000000
}
```
`basis.side` is `buy` when NVDA's pool is cheap against the 24-hour
reference by more than the round trip plus the bar, `sell` when rich, else
`none`. Nulls mean a source did not answer; nothing is guessed.

### `GET /api/obs/market?hours=168`
The $OBS price over time, sampled from the pool once a minute at most
whenever a read succeeds (the desk cycle, the dashboard's own reads):
```json
{ "series": [{ "at": 1788173000000, "priceUsd": 0.00048, "depthUsd2pct": 202 }], "change24hPct": 0.031, "samples": 1440, "at": 1788260000000 }
```
`series` is oldest first and thinned to about 400 points; `change24hPct` is
the move against the oldest sample inside the last day, `null` until there
are two.

### `GET /api/obs/thoughts?limit=20`
```json
{
  "items": [
    {
      "at": 1788259000000,
      "observation": ["Book: 0.8 ETH, $490.00 in flight.", "Equity $2,454.40 against $2,400.00 net capital; PnL $54.40 (2.27%).", "BTC $78,000.00.", "..."],
      "thoughts": ["The book is up a little on ETH and nothing else moved.", "The in-flight swap should land within the hour; until it does I am not adding."],
      "decision": { "kind": "hold", "reason": "one leg still in flight" }
    }
  ],
  "at": 1788260000000
}
```
Newest first. `observation` is the measured input the agent was handed, so a
reader can check the thinking against it. `decision.kind` is `hold` or
`propose-swap` (with `from`, `to`, `amount`). Private notes never appear.

### `GET /api/obs/trades?limit=50`
```json
{
  "items": [
    {
      "at": 1788258000000, "id": "49e966f8-...", "status": "settled",
      "from": { "asset": "ETH", "network": "eth", "amount": 0.1, "usd": 245.5 },
      "to": { "asset": "USDC", "network": "erc20", "amount": 242.85, "usd": 242.85 },
      "partner": "stealthex",
      "settlementTx": "0x...", "explorerUrl": "https://etherscan.io/tx/0x...",
      "note": "taking a little off the top",
      "updatedAt": 1788258600000
    }
  ],
  "at": 1788260000000
}
```
One row per trade, latest status. `status` is one of `proposed`, `pending`,
`settled`, `failed`, `cancelled`. `venue` (additive) says where the swap
ran: `pool` for the Uniswap v4 pools on Robinhood Chain from the desk's own
wallet (`partner` is `"pool"`, `settlementTx` and `explorerUrl` are the swap
transaction, `note` carries the route, the expected and received amounts
and the all-in cost), or `obscura` for a swap routed through Obscura. Executed swaps also carry `depositTx` and
`depositTxUrl` (the desk's transfer into the route), `trackUrl` (Obscura's
public order page, `https://obscura.market/exchange/{id}`), and once settled
`settlementTx` / `explorerUrl` (the payout). The ledger never holds a deposit
or payout address, so nothing is redacted here.

### `GET /api/obs/pnl?hours=168`
```json
{
  "snapshot": {
    "at": 1788260000000,
    "holdings": { "ETH": 0.8, "USDC": 242.85 },
    "equityUsd": 2454.4, "inFlightUsd": 0, "netCapitalUsd": 2400,
    "pnlUsd": 54.4, "pnlPct": 0.0227, "unpriced": []
  },
  "prices": { "ETH": 2455.5, "USDC": null },
  "positions": [
    { "asset": "ETH", "qty": 0.8, "priceUsd": 2455.5, "valueUsd": 1964.4, "avgCostUsd": 2400, "costUsd": 1920,
      "unrealizedUsd": 44.4, "unrealizedPct": 0.0231, "realizedUsd": 5.5, "share": 0.89 },
    { "asset": "USDC", "qty": 242.85, "priceUsd": 1, "valueUsd": 242.85, "avgCostUsd": 1.011, "costUsd": 245.5,
      "unrealizedUsd": -2.65, "unrealizedPct": -0.0108, "realizedUsd": 0, "share": 0.11 }
  ],
  "realizedUsd": 5.5,
  "inFlight": [],
  "series": [{ "at": 1788173000000, "equityUsd": 2400, "pnlUsd": 0 }, { "at": 1788259000000, "equityUsd": 2454.4, "pnlUsd": 54.4 }],
  "capital": { "netUsd": 2400, "deposits": 1, "withdrawals": 0 },
  "trades": { "settled": 3, "pending": 0, "proposed": 0, "failed": 0 },
  "canExecute": false,
  "at": 1788260000000
}
```
PnL is mark-to-market: equity (priced holdings plus swaps in flight) minus
net capital deposited. `unpriced` lists held assets with no price this
cycle; their value is missing from equity and the response says so.
`series` is the stored snapshot curve, oldest first. Prices cache 60 s.

`positions` is every holding as a position, largest value first. The cost
basis is average cost from the ledgers in time order: a deposit adds units at
the dollars recorded for it, a settled swap sells the from leg at average
cost (the difference to what it fetched is that asset's `realizedUsd`) and
buys the to leg at what was spent. `avgCostUsd`, `costUsd`, `unrealizedUsd`
and `unrealizedPct` are `null` when no cost was ever recorded for the asset
(the page shows "no cost recorded" rather than a fake gain). `share` is the
position's part of priced equity. `inFlight` lists pending swaps with the
from leg's dollar value and the cost that left with it. `realizedUsd` at the
top level is the sum over all assets.

### `GET /api/obs/stream?limit=12`
Server-sent events (`text/event-stream`), for the terminal. On connect one
`hello` event carries the last `limit` thoughts (oldest first, so they can
be typed out in order), the latest trades and `canExecute`; then a `thought`
event arrives the moment a desk cycle writes one, and a `trade` event when a
trade row is written or changes status. A comment line keeps the socket warm
every 25 s.
```
event: hello
data: { "at": 1788260000000, "thoughts": [ ...thought objects as in /api/obs/thoughts... ], "trades": [ ...trade rows... ], "canExecute": false }

event: thought
data: { "at": 1788261800000, "observation": [...], "thoughts": [...], "decision": { "kind": "hold", "reason": "..." } }

event: trade
data: { "at": ..., "id": "...", "status": "pending", "from": {...}, "to": {...}, "partner": "..." }
```
`EventSource` in the browser handles reconnects. The page falls back to
polling `/api/obs/thoughts` every 15 s if the stream cannot be opened, so a
proxy that does not pass event streams still gives a working terminal.

### `GET /api/obs/feed?limit=30`
The X feed: `{ items: [{ at, kind: "post"|"reply", text, posted, mode, id?, url?, inReplyToId? }], at }`.
Drafts appear with `posted: false` so the team can watch him write before the
account goes live; filter on `posted` in production if you prefer.

### `GET /api/obs/reads`
The live reads he may cite: the $OBS token as read from chain (name, symbol,
supply, holders), BTC and ETH spot, `market` ($OBS priced by its own on-chain
pool: `priceUsd`, `depthUsd2pct` in dollars that move it 2%, `venue`,
`feePct`; null when the chain did not answer), whether the app and its
`/health` answer, and `block`, the same text the agent sees. Cached 60 s.

## 3. Embed options

**Iframe the page** (fastest):
```html
<iframe src="https://obs-api.obscura.market/" style="width:100%;height:1400px;border:0;background:#161816"></iframe>
```

**Host the page yourself and point it at the API**: copy `index.html` into
your static assets and set the API before its script runs, or pass `?api=`:
```html
<script>window.OBS_API = "https://obs-api.obscura.market";</script>
```

**Native Angular components**: fetch the endpoints with `HttpClient` and
render them in your own design. The page's markup is the reference for what
each field means.

**The real Obscura front end**: `dashboard/angular/` is the Agent page from
obscuracex.com as a standalone Angular app, wired to this API. Run it next to
`npm run dashboard` to test the two together; its README covers `?api=`
overrides and a same-origin proxy. See [angular/README.md](angular/README.md).

## 3b. Design contract

The page is a dark terminal: near-black canvas, hairline borders, square
corners, monospace figures, one accent for direction.

| Piece | Value |
|---|---|
| canvas | `#0a0a0a`; panels `#0c0c0c` |
| hairline | `1px solid #262626`; inner rules `#1c1c1c` |
| corners | square everywhere; the only rounded shape is the current-value pill on the chart |
| type | JetBrains Mono for everything that is data or UI; Inter only for the hero headline and paragraph and for post bodies |
| labels | 10.5px, uppercase, letter-spacing .18em, `#8a8a8a` |
| figures | 21px in the strips, 32px on the chart, tabular numerals, `#f2f2f2` |
| direction | up and BUY `#4ade80`, down and SELL `#f87171`, pending `#fbbf24`; used only for direction, state and the live dot |
| button | white on black (`#f2f2f2` on `#0a0a0a`), uppercase, letter-spacing .14em |
| segmented control | bordered group; the active segment inverts to white on black |
| light theme | `data-theme="light"` on `<html>`, same tokens flipped; the sun button toggles it and remembers the choice |

Sections, top to bottom: header ($OBS, by Obscura, live and execution
pills, the desk's address with copy, theme), hero line, the six-cell stats
strip (price with 24h move, market cap, 24h volume, liquidity, holders,
cashback earned), the chart (Equity, PnL or $OBS; 24H, 7D, 30D, ALL) beside
the wallet and rails cards, the live trades ticker, the terminal, the
six-cell portfolio strip (equity, net capital, PnL, unrealized, realized, in
flight), the positions table, the X feed, the footer. The hero illustration
is a placeholder wireframe; replace it with the app's own art or drop it.

## 4. What never crosses this boundary

- The agent's private notes (his journal). Thoughts are public by design;
  notes are not.
- Keys, tokens, deposit addresses, payout addresses, anyone's wallet. The
  only address in any response is the $OBS contract.
- Failed writes and diagnostics. A post X rejected is not content.

## 5. Versioning

Fields are only ever added, never renamed or removed, within `/api/obs/*`.
A breaking change gets a new prefix.
