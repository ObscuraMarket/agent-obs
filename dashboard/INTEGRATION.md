# Integrating the OBS dashboard into obscura.market

For Obscura's developers. This folder is the whole integration surface: one
read-only JSON API served by the agent, and one dependency-free page that
renders it. Use the page as-is (iframe it, or copy it), or fetch the JSON
into your own Angular components. Nothing here needs our code in your build.

What people see: OBS's **thoughts** (his public reasoning, every desk
cycle), his **trades** (swaps through Obscura, with the settlement
transaction), and the desk's **overall PnL**, plus the X feed and the live
reads he is allowed to cite.

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

All responses are JSON, `Cache-Control: public, max-age=30`. Timestamps are
Unix milliseconds. Every numeric field can be `null`, which means "not
measured this cycle", never zero.

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
`/rewards/{wallet}` for the address.

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
`settled`, `failed`, `cancelled`. The ledger never holds a deposit or payout
address, so nothing is redacted here.

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

### `GET /api/obs/feed?limit=30`
The X feed: `{ items: [{ at, kind: "post"|"reply", text, posted, mode, id?, url?, inReplyToId? }], at }`.
Drafts appear with `posted: false` so the team can watch him write before the
account goes live; filter on `posted` in production if you prefer.

### `GET /api/obs/reads`
The live reads he may cite: the $OBS token as read from chain (name, symbol,
supply, holders), BTC and ETH spot, whether the app and its `/health` answer,
and `block`, the same text the agent sees. Cached 60 s.

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

## 3b. Design contract

The page is built from the exchange component's own values so it sits inside
`/app` without restyling:

| Piece | Value (from the app) |
|---|---|
| page background | `#050505` |
| card | `linear-gradient(145deg, #161816 0%, #1a1c1a 100%)`, `1px solid #2a2e2a`, radius 24px |
| card header rule | `1px solid #2a2e2a` |
| inner box (the SEND / RECEIVE box) | `#16181699`, `1px solid #2a2e2a`, radius 14px, hover border `#4f574f` |
| box label | 12px, 600, uppercase, letter-spacing .08em, `#8a968a` |
| box figure | 24px, 600, `#fff`; winning figure `#b8ff3d` with the app's lime glow |
| route row | `1px solid rgba(55,60,55,.6)`, radius 10px, hover `rgba(22,24,22,.5)` |
| badge | `linear-gradient(135deg, #353a35, #262a26)`, `1.5px solid #4f574f`, radius 6px, 11px 600 |
| header chip | `#161816`, `1px solid #2a2e2a`, radius 14px, 13px 600 |
| type | Plus Jakarta Sans, tabular numerals for figures |

Lime is used only where the app uses it: the winning figure, a live state,
a posted item. The header mark is an inline placeholder; replace it with the
app's logo asset when embedding, or drop the header entirely and let the
app's own header stand.

## 4. What never crosses this boundary

- The agent's private notes (his journal). Thoughts are public by design;
  notes are not.
- Keys, tokens, deposit addresses, payout addresses, anyone's wallet. The
  only address in any response is the $OBS contract.
- Failed writes and diagnostics. A post X rejected is not content.

## 5. Versioning

Fields are only ever added, never renamed or removed, within `/api/obs/*`.
A breaking change gets a new prefix.
