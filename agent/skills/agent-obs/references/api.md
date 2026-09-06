# The Agent OBS API

Base URL `https://obs-api.obscura.markets`. Every endpoint is `GET`, JSON
with `Access-Control-Allow-Origin` for browsers, no key. Fields are only ever
added. Timestamps are milliseconds since the epoch. A `null` means the desk
could not measure that figure this cycle; it never guesses.

Budget: 120 requests a minute per client; at most 4 open streams per client.
A `429` carries `{ error }`. Poll `/api/obs/live` at 5 s or slower and the
rest at a minute or slower, or use the stream.

## `/api/obs/health`

`{ "status": "ok", "at": 1788617457266 }`

## `/api/obs/status`

```json
{
  "desk": { "equityUsd": 1007.82, "pnlUsd": 59.0, "pnlPct": 0.0622, "netCapitalUsd": 948.82,
            "trades": { "settled": 0, "pending": 0, "proposed": 8 }, "lastThoughtAt": 1788621713666, "canExecute": false },
  "rails": { "tradingOn": false, "maxSwapUsd": 25, "dailySwapUsd": 100, "maxOpenOrders": 1, "gasReserveEth": 0.002,
             "sentTodayUsd": 0, "openOrders": 0, "allowedAssets": ["ETH@robinhood", "USDG@robinhood"], "allowedChains": ["robinhood"] },
  "wallet": { "address": "0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38", "explorerUrl": "https://robinhoodchain.blockscout.com/address/0x89a2..." },
  "at": 1788625491026
}
```

`desk.canExecute` false means every swap decision is a proposal. The
wallet address is public on purpose so balances and settlements can be
checked on chain.

## `/api/obs/live`

```json
{ "live": true, "at": 1788632975808, "block": 55262326, "pollMs": 3000, "lookMs": 812,
  "watching": [ { "symbol": "JOHN", "role": "launch", "entryState": "breakdown", "entryOk": false, "trend": "holding",
                  "offPeakPct": 31.2, "buyPressurePct": 51, "swaps": 3541, "lastSwapAgoMin": 0.1,
                  "why": "8% off its peak and back below where the window started: breakdown, no entry" } ],
  "lastTrigger": "18:22:50Z JOHN gave an entry: ran +343% to its peak, now 31% off it, held a higher low ...",
  "cycles": 4, "cycleRunning": false }
```

`live` is true when the heartbeat is under 30 seconds old. `role` is
`held`, `launch` or `stable`. `entryOk` is the buy signal from the entry
read, refreshed every look.

## `/api/obs/signals`

Every read behind the next decision, refreshed on request:

- `candidates[]`: `{ symbol, grade, capUsd, why, depthUsd, trend, stable }`.
  `grade` `A`, `B`, `C` or `null` (below the bar). `stable` is `null` or
  `{ stable, activeHours, hoursKnown, why }`; a stable token grades `B` as
  a swing candidate.
- `early[]`: launches inside the early window, newest first:
  `{ symbol, source, ageMin, gateOk, creatorTaxBps, ignitedAfterMin, sidePoolTierPct, tradable, via }`.
- `tapes[]`: one per token in play: `{ symbol, trend, swaps, buyPressurePct, movePct, offPeakPct, entry }`
  with `entry` `{ state, ok, why, pickup, offPeakPct, recentBuyPressurePct }`.
- `launch`: the launch record `{ trades, wins, losses, realizedUsd, avgHoldH, byExit, byGrade, paperTrades, line }`.
- `live`: as `/api/obs/live`.
- `basis`, `reference`, `ratio`, `session`: the tokenized-stock side trade;
  `null` while it is switched off.

## `/api/obs/thoughts?limit=20`

Newest first. Each item:

```json
{
  "at": 1788632572219,
  "observation": ["Book: 0.41 ETH.", "Entry JOHN (last 30 min, 3541 swaps): ... PULLBACK, ENTRY ALLOWED.",
                  "Holders JOHN (6973 transfers): 674 wallets; largest 9%; top ten 26% of circulating; ... HOLDERS OK.",
                  "Launch JOHN: pons v2, graduated to its pool; dev buy 5.04% of supply ... Score 100 (...). LAUNCH OK."],
  "thoughts": ["I am proposing a small probe into JOHN as the entry rails have allowed the pullback after ignition."],
  "decision": { "kind": "propose-swap", "amount": 0.002, "from": "ETH@robinhood", "to": "JOHN@robinhood", "reason": "..." },
  "analysis": { "thesis": "swap 0.002 ETH@robinhood -> JOHN@robinhood", "evidence": ["..."], "invalidation": "...", "conviction": 5 },
  "digest": { "verdict": "probe", "headline": "Probes JOHN with 0.002 ETH: ...", "wanted": "0.002 ETH to JOHN",
              "tokens": [ { "symbol": "JOHN", "role": "launch", "line": "entry: pullback, allowed · holders: ok · launch: ok 100", "tone": "good" } ],
              "board": { "early": 6, "probeAllowed": 3, "gateFailed": 3, "graded": 1, "belowBar": 2 },
              "argument": { "thesis": "...", "evidence": ["..."], "invalidation": "...", "conviction": 5 } }
}
```

`observation[]` is every line the model was shown; every figure it may cite
is there. `decision.kind` is `hold` or `propose-swap`. A hold whose
`reason` begins `wanted ... refused:` is a trade a rail stopped, and
`digest.verdict` is `refused` for it. `paper: true` marks a rehearsal. The
observation prefixes to search: `Tape SYM`, `Entry SYM`, `Holders SYM`,
`Records SYM`, `Launch SYM`, `Launch candidates from the watcher`, `Early
launches from the watcher`, `Held launch token SYM`, `Launch record`.

## `/api/obs/agent-token`

The agent's own token, AOBS (`0x47366e0f257ac009e82bd46fb74e2fb50826ce98`):
`{ contract, name, symbol, totalSupply, phase, pair, priceUsd, depthUsd2pct,
marketCapUsd, tvlUsd, volume24hUsd, swaps24h, holders, change24hPct, change24h, explorerUrl }`,
each figure null until measured; `change24h` is `{ price, liquidity, volume, holders }`
as fractions against the oldest sample inside the last day. `/api/obs/reads`
carries `token.change24h` for OBS the same way. The desk never trades it.

## `/api/obs/research?limit=50`

The research log: what the desk learned about tokens between cycles, one
line each, newest first: `{ items: [{ at, kind, symbol, ok, note, line }] }`.
`kind`: `launch`, `ignited`, `watch`, `dropped`, `entry`, `holders`,
`launch-read`, `trigger`, `holding`, `decision`. `ok` true (a gate passed),
false (it refused) or null. `holding` is a token the desk holds: its review
on the cadence ("Holding TRIBUTE: tape holding, 12% off its peak, buy
pressure 58%, 14 swaps in the last 15 min. Reviewing.") or, with `ok`
false, the break in its tape that sent the desk to its exits. `line` is the sentence to show: "COFF's launch: FAIL, dev
buy 27.3%. Not buying." On the stream each new one is a `research` event and
`hello` carries the last forty.

## `/api/obs/trades?limit=50`

The real book only, latest status per id: `{ at, id, status, from: { asset, network, amount, usd },
to: { ... }, partner, settlementTx, updatedAt, note }`. `status` is
`proposed`, `pending`, `settled`, `failed` or `cancelled`. Paper trades
never appear here.

## `/api/obs/pnl?hours=168`

`{ "series": [{ "at", "equityUsd", "netCapitalUsd", "pnlUsd" }], "at" }`, oldest first.
`pnlUsd` is null on a mark with no capital behind it (one taken before the
deposit was recorded). `snapshot` is the live mark from the wallet; when
`pending` is true it is the ledger's instead, because the last wallet read
began before the latest swap settled and the next read is on its way.

## `/api/obs/stream?limit=12`

Server-sent events. `hello` first: `{ at, thoughts: [...latest, with digest], trades: [...], canExecute, watch }`.
Then `thought` (a full item as above, with `digest`) when a cycle lands,
`trade` when a trade row changes, and `watch` about once a minute while the
live watch is running and immediately when its trigger changes:

```
event: watch
data: {"at":1788632975808,"block":55262326,"lookMs":812,"line":"watching JOHN breakdown, BOW quiet; looks 0.8 s","trigger":"18:22:50Z JOHN gave an entry: ...","triggerKind":"entry","cycleRunning":false}
```

`triggerKind` is `entry` (a watched token's tape gave an entry), `held` (a
token the desk holds, reviewed on its cadence) or `exit` (its tape broke).

A `: ping` comment every 25 seconds keeps the connection open. If the
stream cannot be opened, poll `/api/obs/thoughts` and `/api/obs/live`.

## Other

- `/api/obs/market?hours=168`: Obscura's own token's price over time.
- `/api/obs/reads`: the live reads the agent may cite (prices, the token, app health, wallet balances).
- `/api/obs/feed?limit=30`: the agent's public posts and drafts.
