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

## Start here: the Agent page in five steps

1. **Pull `dashboard/`.** `index.html` is the reference page (no
   dependencies, renders every endpoint), `angular/` is the Agent page from
   obscuracex.com as a standalone Angular app already wired to this API, and
   this file is the contract. Nothing here needs our code in your build.
2. **Point it at an API.** The page does this itself: on obscura.market and
   on obscura.markets it uses `https://obs-api.obscura.markets`, the API
   name with a certificate today (since September 5; the name in the
   obscura.market zone still waits on its ownership TXT record, and probing
   it first cost every visitor four seconds). If the name does not answer
   within four seconds, the page falls back to the desk's
   direct address, `https://desk-production-18ad.up.railway.app`, for that
   page load. `?api=https://...` still overrides everything and is
   remembered (`?api=reset` forgets it). The only thing obscura.market's
   zone needs is one DNS record, no proxy:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | `obs-api` | `1ja8d5cy.up.railway.app` |
   | TXT | `_railway-verify.obs-api` | `railway-verify=5084619bffdfa604e5487bb6399b0e08b387e01e0dca7f494d73b078a27fb41b` |

   The CNAME routes the name to the desk; the TXT proves ownership to
   Railway, which issues the certificate once both resolve.
3. **Wire each component to its endpoint.** The reference page does exactly
   this; its markup says what each field means.

   | Component on the page | Endpoint | Use |
   |---|---|---|
   | The whole page, one poll every 15 s while the tab is shown | `/api/obs/dashboard` | `status`, `agentToken`, `reads`, `pnl`, `agents`, `market`, `trades`, `feed`: each exactly as its own endpoint below answers it, or `null` when that read failed |
   | Terminal (thoughts as they land) | `/api/obs/stream`, fallback `/api/obs/thoughts` | `thoughts[]`, `decision`, `analysis` as the case under each decision, `paper: true` labelled PAPER or filtered |
   | Live dot and "watching now" | `/api/obs/live` | `live`, `watching[]` with `entryState` and `entryOk`, `lastTrigger` |
   | Signals strip (launches, board, entries) | `/api/obs/signals` | `early[]`, `candidates[]` (grade, `stable`), `tapes[]` with `entry.ok` as the green light, `launch.line` |
   | Portfolio strip and equity chart | `/api/obs/pnl` | `snapshot`, `series`, `track` (the public track record) |
   | Positions table with PnL each | `/api/obs/pnl` | `positions[]` |
   | Trades ticker | `/api/obs/trades`, plus `trade` stream events | `status`, `from`, `to`, `settlementTx`, `explorerUrl`, `venue` (the real book only) |
   | Header: live and execution pills, the desk's address | `/api/obs/status` | `desk.canExecute`, `agent.mode`, `wallet` |
   | Stats strip (the token's own market) | `/api/obs/reads`, `/api/obs/market` | `token`, `market`, `block` |
   | X feed | `/api/obs/feed` | `items[]`, `posted` |

4. **Launch.** Deploy `main`. No tunnel, no token, no key: the API is public
   and read-only, and CORS already allows `https://obscura.market`,
   `https://www.obscura.market`, `https://obscura.markets` and
   `https://www.obscura.markets`. `https://obs-api.obscura.market/api/obs/health`
   answers once the CNAME above resolves and its certificate is issued.
5. **Updates arrive by relay.** Every push to `main` here that touches
   `dashboard/` opens a pull request on the site repo
   (`JohnDevving/obscura-exchange`) that puts our copy of the Agent page
   onto the site's own paths: `src/app/pages/agent/`,
   `src/app/service/obs-desk.service.ts`, and this contract plus the
   reference page under `docs/obs/`. Environments, routing and the app
   module are the site's and are never touched. You review and merge on
   your side (`.github/workflows/relay-dashboard.yml`, or `npm run relay`
   from the operator's machine, which does the same by hand). Fields in `/api/obs/*` are
   only ever added, never renamed or removed, so a component that ignores a
   new field keeps working.

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
`https://obscura.market,https://obscuracex.com` in production. An entry may
carry one wildcard host label, `https://*.vercel.app`, to admit preview
deployments. A page on an origin not on the list sees "could not reach the
desk API"; the API logs every origin it refuses.

## 2. Endpoints

All responses are JSON, `Cache-Control: public, max-age=30`, except the
stream (`text/event-stream`, no cache). Timestamps are Unix milliseconds.
Every numeric field can be `null`, which means "not measured this cycle",
never zero.

### `GET /api/obs/health`
```json
{ "status": "ok", "at": 1788260000000 }
```

### `GET /api/obs/dashboard?hours=168&trades=50&feed=30`
The Agent page's one read (since September 8): every payload the page
polls, in one object, assembled once and shared by every viewer for five
seconds (`Cache-Control: public, max-age=5`).
```json
{ "status": {}, "agentToken": {}, "reads": {}, "pnl": {}, "agents": {}, "market": {}, "trades": {}, "feed": {}, "at": 1788260000000 }
```
Each part is exactly what its own endpoint answers: `status` is
`/api/obs/status`, `agentToken` is `/api/obs/agent-token`, `reads` is
`/api/obs/reads`, `pnl` is `/api/obs/pnl?hours=`, `agents` is
`/api/obs/agents`, `market` is `/api/obs/market?hours=`, `trades` is
`/api/obs/trades?limit=` (the `trades` query) and `feed` is
`/api/obs/feed?limit=` (the `feed` query). A part whose read failed is
`null`, never a failed response: the page keeps that panel's last value and
names the part in its footer. The single endpoints stay as they are for any
other consumer. Poll this once every fifteen seconds while the tab is shown,
nothing while it is hidden, and on a 429 double the wait until a read
succeeds; the reference Angular page does exactly that.

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
  "console": { "gate": "on", "apps": false, "credits": false, "freeCredits": 100 },
  "at": 1788260000000
}
```
`console` says what the console offers right now: `gate` (`on`: holders of
OBS or AOBS and the operator's allowlist; `allowlist`: the list only, for the
first users; `off`: everyone), `apps` (Composio switched on), `credits`
(buying credits is on, a treasury is set) and `freeCredits` (the grant a new
wallet gets). The console page reads it once: it hides the Apps button and
the `/apps` menu entry while apps are off, and words its door from `gate`.
The response also carries `rails`: the limits every swap is checked against
and what is used, `{ tradingOn, maxSwapUsd, maxOpenOrders, gasReserveEth,
openOrders, allowedAssets, allowedPartners, allowedChains }`. `allowedChains`
is the chains both legs of a swap must be on, `["robinhood"]`: the desk
trades on Robinhood Chain only. `openOrders` counts pending swaps against
`maxOpenOrders`, the one gauge worth drawing; `allowedPartners` is `null`
when any Obscura route may be used. Nothing is counted by the day: the
daily fields (`dailySwapUsd`, `sentTodayUsd`, `entriesToday`,
`maxEntriesPerDay`) were removed on September 7 and a client must not
expect them.

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
`none`. Nulls mean a source did not answer; nothing is guessed. `basis`,
`reference`, `ratio` and `session` are `null` while the tokenized-stock
side trade is switched off (the default); the token lanes below are always
present.

Additive fields, the token lanes (since September 3 and 4):

- `candidates[]` also carry `stable`: `null` when the token's hourly trail
  was not read, else `{ stable, activeHours, hoursKnown, why }`. A stable
  token (`stable: true`) is a survivor: it traded in most of its hours for
  six hours or more inside a held range, and it grades `B` with `why`
  beginning `stable:`. Show it as a swing candidate, not a launch.
- `early[]`: launches inside the early window, newest first, each
  `{ symbol, source, ageMin, gateOk, creatorTaxBps, ignitedAfterMin,
  sidePoolTierPct, tradable, via }`. `tradable: true` means the desk can
  reach the token right now, through `via` (`curve` or `side pool`); whether
  it may buy is the entry read in `tapes[].entry`.
- `tapes[]`: one per token in play (held, probeable, or graded), read from
  the pool's own swap events: `{ symbol, trend, swaps, buyPressurePct,
  movePct, offPeakPct, entry }`. `trend` is `rising`, `holding`, `rolling
  over`, `thin`, or `unknown` when the pool could not be read yet. `entry`
  is the entry read, the desk's timing rule: `{ state, ok, why, pickup,
  offPeakPct, recentBuyPressurePct }` where `state` is one of `quiet`,
  `spike`, `pullback`, `base`, `breakdown`, `waiting` and `ok: true` means a
  buy is allowed on this read. Render `ok` as the green light and `state`
  as the label; `why` is the sentence to show on hover. `entry` is `null`
  when the tape is not readable yet.
- `launch`: the launch record, every closed launch trade: `{ trades, wins,
  losses, realizedUsd, avgHoldH, byExit, byGrade, paperTrades }`, plus
  `line`, the same as one sentence.
- `live`: the live watch's heartbeat, see `/api/obs/live` below.

### `GET /api/obs/live`
The live watch: the desk in real time. A long-running process follows the
pool of every token in play a few seconds apart and runs a desk cycle the
moment a held token's tape breaks or an entry appears.
```json
{
  "live": true, "at": 1788540000000, "block": 54435542, "paper": false, "pollMs": 3000, "lookMs": 340,
  "watching": [
    { "symbol": "BOLD", "role": "launch", "entryState": "quiet", "entryOk": false, "trend": "holding",
      "offPeakPct": 12.4, "swaps": 210, "lastSwapAgoMin": 0.3, "why": "no volume pickup (the last 10 min ran 0.4x the earlier tape, 2x needed)" }
  ],
  "lastTrigger": "14:02:11Z BOLD gave an entry: pullback holding, entry allowed",
  "cycles": 3, "cycleRunning": false
}
```
`live` is `true` when the heartbeat is under 30 seconds old; show a live
dot from it. `role` is `held`, `launch` or `stable`. `entryOk` is the same
green light as `tapes[].entry.ok` in `/api/obs/signals`, refreshed every
look rather than every cycle. `lastTrigger` is the last reason the watch
ran the desk, with its UTC time. `paper: true` means the watch is following
the paper book. Polling every 5 s is fine; the file behind it is rewritten
every look.

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

Additive fields (since September 3):

- `paper: true` marks a thought from a paper session: the agent decided at
  real size and nothing was sent. Label these plainly (the reference page
  prints them as PAPER) or filter them out of the public terminal; never
  present a paper decision as a trade. Paper trades themselves never appear
  in `/api/obs/trades`; that endpoint is the real book only.
- `analysis`: the argument behind the decision, `{ thesis, evidence,
  invalidation, conviction }`, with `evidence` an array of sentences that
  each quote a figure from `observation` and `conviction` 1 to 5 (or
  `null`). A swap is only executed when this argument cleared the evidence
  rule; a hold's `decision.reason` states the shortfall when it did not.
  This is the block to render as the "case" under each decision.
- `digest` (since September 5): the cycle reduced for a reader, computed
  by the desk from the fields above and nothing else. `verdict` is one of
  `hold`, `probe` (a launch token bought from ETH), `sell`, `swap`,
  `refused` (the agent wanted a swap and a rail said no); `headline` is one
  sentence; `wanted` is the swap in question as `0.002 ETH to COFF` when
  there was one; `tokens[]` is one entry per token in play with `symbol`,
  `role` (`held` or `launch`), a ready `line` such as
  `entry: pullback, allowed · holders: ok · launch: FAIL, the dev buy is 27.3% of supply (8% allowed)`
  and a `tone` (`good`, `bad`, `quiet`) to colour it; `board` counts the
  early launches (`early`, `probeAllowed`, `gateFailed`) and the graded
  candidates (`graded`, `belowBar`); `argument` repeats `analysis` only
  when a trade was wanted. The reference page draws the terminal from this
  block and keeps `observation` folded behind one click. The stream's
  `thought` events carry the same field.
- The stream's `watch` event (since September 5): the live watch between
  cycles, so the terminal moves while the agent is looking rather than
  only when it thinks. `{ at, block, lookMs, line, trigger, triggerKind, cycleRunning }`
  with `line` such as `watching JOHN breakdown, BOW ENTRY (pullback); looks 0.8 s`,
  sent about once a minute while the watch is live, and immediately when
  `trigger` changes (a tape gave an entry, whether or not a cycle followed).
  `triggerKind` (since September 6) is `entry`, or `held` / `exit` when the
  trigger is a token the desk holds: a review on its cadence, or a break in
  its tape. Tag those as the holding they are, not as an entry.
- Every clock the page shows is UTC (since September 6), the desk's own
  clock: its log lines, its trigger text, the API's timestamps and the
  explorer all speak it. A viewer's local zone beside it reads as an offset.
- The stream's `ping` event (since September 6): `{ at }` every 25 seconds, so a
  listener can tell a quiet desk from a dead connection; treat 75 seconds of
  silence as dead and reconnect. The `hello` on reconnect carries what was
  missed, so replay it in order and drop what is already shown.
- The stream's `pnl` event (since September 6): the `/api/obs/pnl` answer
  without `series`, pushed whenever a position moved, opened or closed, or
  equity changed, checked every four seconds. Held launch tokens are priced
  from the live watch's tape, which reads every pool in play every three
  seconds, so the positions move in real time between wallet reads. Apply it
  in place and keep the curve you have until the next full fetch.
  The `hello` frame carries the current one as `watch` when the watch is
  live. Draw it dim; it is context, not a decision.

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
`thought` events carry the same `paper` and `analysis` fields as
`/api/obs/thoughts`; `trade` events are the real book only.

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

### `GET /api/obs/agent-token`

The agent's own token (AOBS, `0x47366e0f257ac009e82bd46fb74e2fb50826ce98`
on Robinhood Chain), for the Market card: `{ contract, name, symbol,
decimals, totalSupply, phase, pair, poolId, priceUsd, depthUsd2pct,
marketCapUsd, volume24hUsd, swaps24h, holders, change24hPct, launchedAt, explorerUrl, at }`.
`tvlUsd` is what the pool holds (one full-range locked position, from its
liquidity and price). `change24hPct` is the price against the oldest sample
inside the last day, a fraction, null until there are two samples;
`change24h` gives the same for `price`, `liquidity`, `volume` and `holders`.
`/api/obs/reads` carries the same for OBS as `token.change24h`
(`volume`, `holders`, `liquidity`). The reference page draws both cards from
these, the same for every viewer, never from the browser's own history.
Price and depth come from its pool, volume from the pool's own swaps over
the last 24 hours, holders from its Transfer events; each is `null` until
it can be measured. Cached a minute. The desk never trades this token; the
rails refuse it by contract, and the launch feed never puts it on the board.

### `GET /api/obs/research?limit=50`

The research log: what the desk learned about tokens between cycles, one
line each, newest first. `{ items: [{ at, kind, symbol, ok, note, line }], at }`.
`kind` is `launch` (a new launch and its gate), `ignited`, `watch` (a pool
taken onto the block-by-block watch), `dropped`, `entry` (the tape's entry
state changed), `holders`, `launch-read`, `trigger`, `holding` (a token the
desk holds: its review, or with `ok` false the break in its tape), `decision`. `ok` is
`true` when a gate passed, `false` when it refused, `null` when it is not a
verdict. `line` is the sentence to show, written for a newcomer
("COFF's launch: FAIL, dev buy 27.3%. Not buying."). The stream sends each
new one as a `research` event and the `hello` frame carries the last forty
as `research`; the reference page merges them into the terminal's timeline
between the cycles.

### The swap console: `GET /api/obs/console/quote`, `GET /api/obs/console/swaps`, `POST /api/obs/console/swap`

A person swaps from their own wallet on the page. The desk quotes, builds,
verifies and keeps the record, and shows that record back; nothing is gated
on it (the three-swap bar for a personal agent was removed on September 7).
It never holds a key of theirs and never sends for them; the swap pays its
output to their address inside the same transaction.

- `GET /api/obs/console/quote?from=ETH&to=USDG&amount=0.05&user=0x...`:
  `{ from, to, amountIn, pool: { amountOut, minOut, costPct, feePct, route[],
  priceInUsd, priceOutUsd }, relay: { amountOut, feeUsd, error } | null,
  steps: [{ id, to, data, value, chainId, note }], deadline }`.
  `pool` is the desk's own router through the pools on Robinhood Chain;
  `relay` is the app's Private route for the same pair, for comparison, only
  for ETH and USDG. `steps` are the transactions the wallet signs in order:
  `approve-token` and `approve-permit2` once for a token input, then `swap`
  (`value` is wei as a decimal string; `chainId` is 4663). A pair the desk
  cannot route answers 400 with `error`. Never cached.
- `GET /api/obs/console/swaps?address=0x...`: `{ address, swaps, recent: [{ at,
  txHash, from, to, amountIn, amountOut }] }`, the wallet's swaps through the
  console, newest first. `/api/obs/console/eligible` answers the same for
  pages not yet redeployed.
- `POST /api/obs/console/swap` with `{ address, txHash, from, to, amountIn }`:
  the page reports the swap it sent. The desk waits for the receipt, checks
  that the transaction came from `address`, went to the swap router and
  succeeded (and for ETH in, carried the ETH reported), reads what arrived
  from the receipt, and records it once. `200 { ok: true, already, swap,
  standing }` or `409 { ok: false, reason }`. This is the one write on the
  API, and it writes only what the chain confirms.

### The console: `POST /api/obs/account/challenge`, `POST /api/obs/account/link`, `POST /api/obs/console/cli`, `/api/obs/my-agent/*`

The console page (`src/app/pages/console/`, route `console`) is one surface
for talking to your own agent and for training it, beside the desk's read-only
commands and your wallet's swaps. A line is a message to the agent; a slash
line is a command. The wallet is the account, and the agent belongs to the
wallet that connected: that wallet is the one that controls it. The agent is
a basic assistant, like any capable model, trained through `/name`, `/style`,
`/voice` and `/goal` and remembering its conversation. It is not a trading
agent and there is nothing to switch on; trading from the console is not
available yet.

- `POST /api/obs/account/challenge` `{ address }` answers `{ message, nonce }`;
  the wallet signs the message (`personal_sign`), and
  `POST /api/obs/account/link` `{ address, nonce, signature }` answers
  `{ session: { token, address, expiresAt }, standing }`, or
  `403 { code: "not_holder", error, obs, aobs, minObs, minAobs }` when the
  wallet holds neither enough OBS nor enough AOBS: the console is for holders
  (`OBS_CONSOLE_MIN_OBS`, `OBS_CONSOLE_MIN_AOBS`; `OBS_CONSOLE_GATE=off`
  opens it), and `my-agent/ensure` and `my-agent/stream` answer the same 403
  for a wallet that stopped holding. The bearer is good for a week and proves
  control only; it authorizes no transaction. The page keeps it in
  localStorage for that week and drops it on `/logout` (or `/disconnect`),
  when the wallet disconnects or switches, and on any 401 from a signed
  route, which it reports as an expired session with a `/connect` chip
  (2026-09-08).
- `POST /api/obs/console/cli` `{ line }` (bearer optional): the desk routes
  the line and answers `{ ok, lines[], effect, suggest[] }`. `effect` is
  `none`, `clear`, `desk` (lines from the same payloads the page reads),
  `read`, `settings` (with the merged `settings`), `chat` (with `text`: the
  page streams it), `wallet` (with `action` and the pair: the page's wallet
  does it), or `view` (with `view`: `trade`, `rewards`, `cards`, `yield`, or
  null for `/close`; the page opens that page of the site beside
  the console, from the components the site's module provides under
  `CONSOLE_VIEWS` in `obs-desk.service.ts`, which the relay wires up). The
  header is the relay's choice: with `CONSOLE_LIVE=yes` those five leave it
  and it lists Console, Agent, Docs and Roadmap; by default the site keeps
  its own links (Referral gone) and Console sits first, greyed out with the
  site's Soon badge, until the console is opened. The route is registered
  either way, and the pages keep their routes for deep links. Signing in uses the
  wallet the site's own picker connected: the module hands its `WalletService`
  to the console under `CONSOLE_WALLET` (the relay adds it), `/connect <name>`
  picks one when several are installed, and no chain switch is asked for until
  a swap needs one.
  A guest may read the desk, take the tour, open the app's pages and quote;
  shaping the agent, `/swaps` and chat need the bearer. `suggest` entries are
  literal lines to submit, rendered as one-tap chips.
- Apps (Composio; on when the desk has `COMPOSIO_API_KEY`): the `apps` effect
  answers `/apps` with `lines` (what is connected, what can be) and
  `/apps connect <app>` with `links: [{ label, url }]`, a sign-in the page
  opens in a new tab; `/apps disconnect <app>` removes one. The wallet's agent
  gets the connected apps' tools through the gateway, and any action inside an
  app waits for the person: the stream sends `{ type: "approval", toolCallId,
  tool, args }`, the page shows Allow and Deny, and
  `POST /api/obs/my-agent/approve` `{ toolCallId, approved }` (bearer) answers
  it; `{ type: "tool", phase: "call" | "result", tool, ok }` reports tool
  activity and `{ type: "approval_resolved", toolCallId, decision }` closes an
  approval.
- Models and credits: the `model` effect answers `/model` (the current model
  and a featured list), `/models <search>` (any of OpenRouter's catalog, with
  prices per million tokens) and `/model <name>` (picks one for the wallet's
  agent); the `credits` effect answers `/credits` with `lines` and `balance`,
  and `/credits buy <amount> <token>` with a `pay` effect: `pay: { to, data,
  value, chainId, note, token, amount, creditsUsd, bonusPct, treasury }`, the
  one transaction the wallet signs (ETH, USDG, AOBS or a tokenized stock to
  the treasury; `treasury` is where it must land). The page signs nothing it
  has not judged first (`send-guard.ts`, since 2026-09-08): the chain must be
  Robinhood Chain and the destination the treasury the reply names (ETH
  straight to it, or a token's transfer to it), the agent's own wallet for
  `/fund` (learned from `ensure` or `/wallet`, never from the fund reply
  alone), or, for a swap's steps, the Universal Router, Permit2 naming the
  router as spender, or the token being approved for Permit2; where it goes
  and what ETH rides along are printed before the wallet opens. The page then
  calls `POST /api/obs/credits/verify` `{ txHash }`
  (bearer), which reads the payment off the chain, prices it at the pools
  (or the stock's print) and credits it once; when the treasury is the desk's
  own wallet, the same payment is written to the desk's capital ledger, so the
  book's PnL stays trading only. A credit is a cent (a thousand
  credits are $10 of USDG); every figure named credits below is in credits.
  `GET /api/obs/credits` (bearer) is `{ balance, granted, deposited, spent,
  turns, creditsPerUsd, model, canBuy }`. Every
  chat turn is metered at the model's price plus the desk's margin, from an
  estimate of the text in and out; the stream's `done` frame carries
  `charged` and `balance`, and a turn is refused with 402 when credits can be
  bought and the balance is gone. Free models cost nothing.
- `POST /api/obs/my-agent/ensure` (bearer): provisions the wallet's own agent
  on first sign-in (with a small credit on the house) and keeps it configured
  after (and attaches its apps when apps are on); there is no bar to clear.
  The reply carries `name`, `settings` and `wallet` (the agent's own wallet,
  null while agent wallets are off), which the page keeps for `/fund`.
  `GET /api/obs/my-agent/history` returns prior turns;
  `GET|POST /api/obs/my-agent/settings` reads and sets `name`, `style`,
  `voice`, `goal`; `POST /api/obs/my-agent/stream` `{ text }` streams the
  reply as server-sent events (`delta`, `final`, `error`, `done`).
- `GET /api/obs/my-agent/book` (bearer, since September 8): the wallet's own
  agent in full, for the Agent page's "Your agent" card. `{ ok, name, on,
  mode, sizeUsd, since, wallet, walletUrl, walletEth, ethUsd, positions,
  realizedUsd, unrealizedUsd, equityUsd, trades, tradeCount, wins, losses,
  at }`: the full wallet address (the owner is asking), the wallet's ETH
  (read once per thirty seconds, null when the read failed), every position
  with its cost and result, and the last twenty trades newest last (`kind`
  entry or exit, `usd`, an exit's `pnlUsd`, `status`, `txUrl`). `equityUsd`
  is the wallet's ETH in dollars plus the positions (a paper agent: the
  positions alone), null when the wallet could not be read. Cached ten
  seconds per wallet. A wallet whose door has closed still reads its own
  book, as it keeps `/agent` and `/wallet` in the console; the other signed
  routes answer 403 as before. Never another wallet's data.

## 2b. The skill, for other agents

The same contract packaged for a model to load: `GET /skill` returns
`SKILL.md` (how to read the desk and interpret it), with
`/skill/references/api.md` (every field), `/skill/references/method.md`
(the reads, the thresholds, what was measured) and
`/skill/scripts/obs-read.sh` (the latest cycle as plain text). Link it from
the page as "for agents".

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
