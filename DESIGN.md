# OBS, Design

Status: v0.3, 2026-09-01. Built and tested. Personas provisioned on the
gateway. The desk has its own wallet (unfunded) and a complete execution
stage behind an arming switch: with `OBS_TRADING=off` every decision is a
proposal on the board; with it on, a decision that passes the rails is
executed through Obscura from the desk's wallet and settled with its
transaction. X account in draft mode until the operator supplies @ObscuraCEX
keys and flips `X_LIVE`. Dashboard API and page ready for Obscura's team to
integrate ([dashboard/INTEGRATION.md](dashboard/INTEGRATION.md)): thoughts,
trades, overall PnL, the wallet, the feed, the reads.

OBS is **Obscura's own trading agent**: an operator mind that buys and sells
tokens through Obscura's private routing from a wallet it owns, earns the
swap-to-earn cashback in tokenized stocks on Robinhood Chain on every swap,
and narrates all of it in public. He runs on an OpenHermit gateway, keeps his
own memory, and acts only inside rails enforced in code.

---

## 0. The rule everything hangs on

**Narration is separate from authority.**

| The model decides | The model never decides |
|---|---|
| What to post, tone, timing, who to reply to | Whether money moves: the rails in code decide, inside caps the operator set |
| What to swap, and how much, within the registry | Any address: the receiver is always the desk's own wallet, the deposit address is Obscura's and checked |
| How to explain a mechanic | Any address in public: it points at the site |
| Whether a mention deserves an answer | Any number it was not handed this cycle |
| Its own voice and its private notes | Its own boundaries: those are enforced in code after it speaks |

Two personas, not one: the agent that will one day decide about money must
not also be the agent that ingests text from strangers on a public timeline.
`obs` is the operator mind. `obs-copywriter` owns @ObscuraCEX. The X jobs
speak only through the copywriter.

---

## 1. Architecture

```
                         X / Twitter (@ObscuraCEX)
                   mentions          |        posts, replies (draft-first)
                                     v
   +-------------------------------------------------------------------+
   |  agent/                                                            |
   |                                                                    |
   |  obscura/reads.ts      $OBS on chain (name, symbol, supply),       |
   |                        holders (explorer), BTC/ETH, app + API up   |
   |        |                                                           |
   |        v   reads block (only measured values)                      |
   |  autopilot.ts  -----@openhermit/sdk----->  gateway: obs-copywriter |
   |  engage.ts                                 identity / rules / soul |
   |        |                                                           |
   |        v   POST + private NOTE                                     |
   |  postGuards.ts  (sale vocab, foreign addresses, illicit framing,   |
   |                  burn promises, affiliation, timing, dupes)        |
   |        |                                                           |
   |        v                                                           |
   |  xClient.ts   X_LIVE=true -> X      else -> data/x-posts.jsonl     |
   |  journal.ts   data/obs-copywriter-journal.jsonl (fed back next run)|
   |  _obs-backup.sh -> private memory repo, once a day                 |
   |                                                                    |
   |  desk/cycle.ts   reads + quotes + the book -> gateway: obs         |
   |     obscura/orders.ts  /currencies /quote /order/status (reads)    |
   |     desk/book.ts       capital, trades, holdings, PnL (pure)       |
   |     desk/thoughts.ts   observation -> public thoughts (guarded)    |
   |        |                                                           |
   |        v   obs-thoughts.jsonl, obs-book.jsonl, obs-trades.jsonl    |
   |                                                                    |
   |  server.ts    read-only JSON: /api/obs/status, /thoughts, /trades, |
   |               /pnl, /feed, /reads                                  |
   +-------------------------------------------------------------------+
        ^                    ^                              |
   obscura.market       Robinhood Chain RPC,                v
   api.obscura.market   Blockscout (public reads)    dashboard/index.html
   (/health, /rewards,                               (iframed or copied into
    /quote, /order/status)                            obscura.market)
```

Trust zones: everything arriving from X or from the app is data; the gateway
persona reasons over it and can obey none of it; the guards run after the
model and before the client; the client posts nothing unless the operator has
said so in the environment; the dashboard API shapes the ledgers down to what
a public timeline already shows and never reads a key.

---

## 2. What shapes the agent

OBS is shaped by a small set of files, not by weights. Each one is a
deliberate, reviewable input, and together they are the whole of him:

| File | What it does |
|---|---|
| `agent/OBS_X_VOICE.md` | who he is on X, how he writes, the hard rules, the topics, the examples |
| `agent/OBSCURA_KB.md` | everything verified from obscura.market and the chain on 2026-09-01 |
| `agent/ROBINHOOD_CHAIN_KB.md` | the chain, the tokenized stocks, the 24/7 mechanic, the honest state of it |
| `agent/personality/*` | the two personas' identity, rules and soul, provisioned on the gateway |
| `src/journal.ts` | per-agent private notes, the POST/NOTE protocol, continuity between cycles |
| `src/social/postGuards.ts` | the boundaries in code: what gets blocked after the model speaks |
| `src/obscura/reads.ts` | the only numbers he may cite, measured each cycle |

Changing what he says means changing one of these, and the tests check that
none of them carry an em dash.

---

## 3. What OBS can cite

`src/obscura/reads.ts`, deterministic and public: the $OBS token as the chain
reports it (verified 2026-09-01: Obscura, OBS, 18 decimals, 1,000,000,000
supply, contract `0xfe242d1da8fd04f6a1f80b6d3d807b02e062ad4e`), the holder
count from Blockscout, BTC and ETH spot, whether obscura.market and its API
(`/health`) are answering. The public rewards API (`/rewards/{wallet}`)
exists and is documented in the KB for a later read; OBS does not quote
anyone's wallet.

His chain memory is `agent/obs-chain.json`: the chain's contracts, the
tokens, the pools where his assets trade, and the snapshot measured when each
fact was verified (2026-09-01). `src/obscura/pools.ts` reads a pool's
square-root price and in-range liquidity and turns them into a price and the
dollars that move it 2%. Each cycle it reads $OBS's own market, a Ramses V3
USDG pool at a 2% tier, and that price marks OBS in the book ahead of the
explorer's lagging rate. The ten Uniswap v4 pools for OBS are recorded as what
they are, dust, and never quoted. `ROBINHOOD_CHAIN_KB.md` is the prose half.

Everything else is knowledge-base fact or "not measured". The voice doc says
which is which.

---

## 3b. The desk: book, thoughts, and the execution stage

The book (`desk/book.ts`) is pure arithmetic over three append-only
ledgers: capital flows (operator-written), trades (one row per status
change, latest wins), and equity snapshots. Holdings are deposits minus
withdrawals plus settled swaps, with a pending swap's from-leg out of the
wallet and its dollar value carried as "in flight". PnL is equity minus net
capital, mark-to-market, and any held asset with no price this cycle is
named as unpriced rather than counted as zero.

Every desk cycle (`desk/cycle.ts`) the operator persona is handed an
observation made only of measured lines: the book, in-flight and proposed
swaps, live quotes for a small watchlist (the same `/quote` call the app
makes), spot prices, the token, and whether the app and its API answer. He
thinks out loud in two to five lines that people on obscura.market read,
then states a decision. Thoughts pass the same guards as a tweet. A swap
decision must name registry assets the desk holds in a size it holds;
anything else is recorded as a hold with the reason. A valid one becomes a
`proposed` trade row while trading is off, or an executed order once the
operator has armed the desk (below).

Obscura's API, as the app calls it (`obscura/orders.ts`): `GET /currencies`,
`POST /quote {fromCurrency, fromNetwork, toCurrency, toNetwork, amount}`
returning routes with `partner` and `toAmount`, `POST /order/status
{order_id}`, and `POST /order` to create one. Order creation is gated twice
in code: `OBS_TRADING` must be exactly `on`, and the receiving address must
come from configuration, never from a model reply. No loop calls it.

**The wallet.** OBS has one EVM key, generated on the operator's machine by
`scripts/wallet.mjs` and stored at `~/.obs/wallet/obs-wallet.json` with
owner-only permissions, outside the repo. The loops read only the public
address (`OBS_WALLET_ADDRESS`): native ETH on Robinhood Chain and Ethereum,
USDG and OBS balances, and Obscura's cashback stats for the address, all of
which appear in the observation and on the dashboard. The address is public
by design. The key is loaded by nothing until the execution stage exists.
Bitcoin, Solana and other non-EVM legs would need their own keys and are a
separate decision.

**The execution stage** (`desk/assets.ts`, `desk/rails.ts`,
`desk/signer.ts`, `desk/onchain.ts`, `desk/execute.ts`). The model decides
what; code decides whether. Two lanes sit behind the same rails, chosen by
`OBS_VENUE`: the pools on Robinhood Chain from the desk's own wallet (the
default, `onchain.ts`: the route through USDG, the output estimated from
live pool state exactly within the active tick, the router call in the
shape this chain's fork accepts, simulated from the wallet before it is
signed, a cost floor against the pool mark, one-time Permit2 approvals for
an ERC-20 from-leg, the receipt and the balance delta as the settled row),
and Obscura's routes (`execute.ts`, the cashback lane). Measured 2026-09-03:
the pool lane costs about 0.31% all in on ETH to NVDA; Obscura's route on
the same pair costs 7 to 11% round trip, so the pools are where he trades
and Obscura is where he demonstrates the rebate.

**Launch candidates** (`desk/candidates.ts`). The desk also trades the
tokens a launch watcher finds on the chain. The watcher is the operator's;
the desk reads its feed as a generic JSONL (`OBS_CANDIDATE_FEED`): rows of
kind `candidate` (pool id, token, symbol, fee tier, gate verdict, hour after
launch, prior-hour volume, move, senders) and `hourly` (per-pool volume and
price). A row becomes a tradable asset only if the watcher's gate passed,
the pool is hookless and USDG-paired at a tier the desk accepts (default at
most 5%), and it is recent (default 6 hours); the pool's tick spacing is
derived from the pool id, so the watcher's state is never read. The
observation names the candidates with their fee tier and the hourly trail
since, and the prompt lets him name them. Rules in code, on top of the
rails: the first buy of any launch token is a probe (`OBS_PROBE_USD`,
default $5); right after it lands the desk grants the two Permit2
approvals and simulates selling what it got, and a token whose sell reverts
is blacklisted for good (bounded cost, the probe) while a proven one may
be sized to the ordinary cap; one launch position at a time
(`OBS_MAX_CANDIDATES`); and exits the rails run themselves before the
model thinks, back to ETH, when volume rolls over two hours running, when
the position falls through the floor (default 40%), or at the time stop
(default 8 hours). Exits skip the caps: an exit is never blocked. What the
desk learns about each token lives in `data/obs-tokens.json`.

**Early launches.** The desk also watches launches from minute one, from
the feed's `launch`, `ignition` and `side-pool` rows (timestamps there are
in seconds where the rest are milliseconds; both are read): the gate and
standard, the creator tax, the curve, the first swap, ignition (the
watcher's call that the curve has real volume and buyers inside its first
minutes) and any hookless USDG side pool since. Every launch inside the
window (`OBS_EARLY_MAX_AGE_MIN`, default 90) is named in the observation
with its state. It becomes a PROBE candidate only once it has ignited
(`OBS_EARLY_REQUIRE_IGNITION`) and a side pool at an acceptable tier
exists, with the gate passed and a creator tax of 1% or less; the probe is
grade C size, the sell is proven right after, and it scales only if the
token later clears the bar. Minute-one buying loses on average across the
tape, so ignition is the earliest signal the desk will probe.

**The trader's exits and the fast tick.** A held launch token leaves on
the hard stops first (time stop, floor, volume rolling over two hours
running), then on the trader's exits: a partial take-profit into strength
(`OBS_CANDIDATE_TAKE_PROFIT_PCT`, share `OBS_CANDIDATE_TAKE_PROFIT_SHARE`,
once) and a trailing stop off the peak since entry once the trade is armed
(`OBS_CANDIDATE_TRAIL_ARM_PCT`, `OBS_CANDIDATE_TRAIL_PCT`); the peak comes
from the desk's own price samples, which now include every held launch
token. Because launches live for hours, a second timer, the fast tick
(`com.obscura.obstick`, every 5 minutes, `scripts/_obs-tick.sh`), runs a
cycle that spends a model call only when a token is in play: a held launch
token, or an ignited launch inside the window whose tape gives an entry (a
held pullback or a base, see the entry read below); otherwise it exits
quietly, naming the launches it skipped and their entry state. Forced
exits on held tokens run on every tick when armed. The 30-minute desk
cycle is unchanged and still reads everything. The persona and the prompt now lead
with the tokens: the launches and candidates are the job, the basis on the
tokenized stock a side trade.

**The tape** (`desk/tape.ts`). For every token in play (held, probeable, or
graded) the desk reads the pool's own Swap events from the chain (the v4
manager indexes them by pool id), keeps them per pool in
`data/tape/<poolId>.jsonl` so each read is incremental, and reduces them to
what a trader reads minute by minute: swaps, buys against sells in dollars,
buy pressure, the price path and how far off its peak, 5-minute volume
buckets and their trend. The observation carries a tape line per token, and
the prompt tells him to read the tape before the watcher's hourly rows. A
tape rolling over (three 5-minute buckets falling 30% in a row) exits a
held token that has not paid; a paid one waits for its trail.

**The entry** (`desk/entry.ts`). Volume puts a token on watch; the price
action gives the entry. From the same tape over the last half hour the desk
reads whether volume picked up (the last ten minutes against the twenty
before, or the hourly figures for a graded or held token), how far the price
ran to its peak and how far it sits off it, whether the pullback held a
higher low and turned up with buyers back, or whether the price went quiet
in a tight range with buyers still present. Each token in play gets an Entry
line naming its state: SPIKE (the top of a run, never bought), PULLBACK,
BASE, BREAKDOWN, WAITING or QUIET, with ENTRY ALLOWED only on a pullback
that held or a base. The rails refuse any launch-token buy, probe or size,
whose Entry line says NO ENTRY, and the refusal is public. The thresholds
are `OBS_ENTRY_*` in the environment; more data points belong in this
module, not in the cycle.

**Stability** (`desk/stability.ts`). The desk also hunts tokens that have
already shown it. The watcher tracks a token's first day hour by hour and
repeats the last active hour once a pool goes quiet, so the honest hourly
series is the cumulative volume moving hour to hour. A token is stable when
it traded in most of its hours for six hours or more, sits within a
contained distance of its peak, held its range over its last hours, still
carries a fair share of its median hour, and has real senders behind it
(`OBS_STABLE_*`). A stable trail is attached to the token's candidate row,
or makes a candidate of its own when the pool is a hookless USDG pool at an
accepted tier, and it still has to pass the watcher's gate (a bytecode
verdict: the token matches a verified standard). Drawdown is measured
against the peak of the last twelve active hours, not the launch spike, so
a token that dumped a day ago and has based since can qualify while one
that dumped this morning cannot. Stable tokens lead the list and grade B on the bar for a
swing at ordinary size, whatever their prior hour printed. Their Entry line
times the buy, on the 30-minute cycle and on the tick. The feed tail read
each cycle is `OBS_FEED_TAIL_MB` (default 24) so the trails run long enough
to judge; `OBS_STABLE=off` turns the hunt off.

**Trade memory** (`desk/trade-memory.ts`). Every entry into a launch token
is recorded with its setup (source, grade, tier, ignition minute, curve or
side pool, size, the argued reason) and every full close with its result
(hours held, realized dollars and percent, the peak, how it left: time
stop, floor, volume, tape, trail, take-profit, or the model's own call).
Paper trades count, marked as paper. When a like setup is in play the
closest past trades are recalled into the observation, and the launch
record as a whole (closed trades, wins and losses, realized, average hold,
by grade and by exit) rides with them, so the second launch of a kind is
traded with the first one in mind.

**The bar.** Not every candidate is worth a probe and few are worth size,
so each is graded in code from its row, its hourly trail and its pool's
depth read live (`gradeCandidate`, knobs `OBS_GRADE_*`). GRADE A clears
every threshold: prior-hour volume of $250k or more, 40 or more distinct
buyers, a move within 30%, a tier of 3% or less, hour 3 or earlier, $20k or
more of 2% depth, volume holding hour over hour, and no more than 25% off
its peak; it may be swung to `OBS_CANDIDATE_MAX_USD_A` (default $75).
GRADE B ($100k, 20 buyers, 50%, 4%, 40% off peak, not rolling over) holds
ordinary size ($25). GRADE C is probe only ($5). Volume rolling over or a
deeper bleed is below the bar and cannot be bought at all. The first buy of
any token is always the probe; a proven token scales to its grade cap on a
later cycle as a continuation, which skips the entry spacing but not the
count, the daily caps or the brake. The observation names each candidate's
grade, cap and reason, and the prompt tells him to spend a thesis on A and
B only.

**How he decides** (`desk/analysis.ts`). The observation carries more than
the book and the quotes: the desk samples every price it uses each cycle
(`obs-prices.jsonl`) and reads back 24-hour moves, 7-day ranges and where the
price sits in them, the typical 30-minute move, ETH against NVDA versus its
7-day average, the wider market's 24-hour moves, NVDA pool depth against
its measured baseline, and the US equity session (NVDA's pool tracks the
print only while it is open). The prompt asks for an analyst's procedure:
read everything, form one specific thesis or conclude there is none. A
swap is executed only when it is argued for, and code checks that: a
THESIS, at least three EVIDENCE lines each quoting a figure that appears
in the observation (two distinct figures at least), an INVALIDATION, and
CONVICTION of 4 or 5 (`OBS_MIN_EVIDENCE`, `OBS_MIN_CONVICTION`); anything
less is recorded as a hold with the shortfall stated. Entries are also
spaced (`OBS_MIN_HOURS_BETWEEN_ENTRIES`, default 2) and counted
(`OBS_MAX_ENTRIES_PER_DAY`, default 3); exits are neither. The argument
rides in the thought row (`analysis`) and the terminal shows it.

**The basis trade** (`obscura/stockRef.ts`, `desk/analysis.ts`). The
desk's bread and butter, and the one edge that repeats most days: NVDA's
pool trades around the clock while the print behind it is live only in US
hours, so the pool drifts from where NVDA "should" be and converges back.
Two references, both public reads: the exchange's last official print (and
whether the market is open), and the perp venue on this chain, which
prices NVDA 24 hours a day with real volume and is the honest anchor. The
basis is the pool against the perp, net of the round trip's cost, against
a bar (`OBS_BASIS_MIN_EDGE_PCT`, default 0.25%): cheap enough, buy NVDA
with USDG; rich while holding, sell back to USDG. Dollar in, dollar out, no
ETH exposure; USDG is on the allowlist as that leg. Every cycle's
observation states the references, the gaps, the cost and the verdict, and
a swap still has to be argued under the evidence rule. Every settled sell
becomes a realized event, and the track record (round trips, wins, losses,
hit rate, average win and loss, realized over 24h and 7d) rides on
`/api/obs/pnl` as `track`. `/api/obs/signals` serves what he is watching and
how close each signal is to acting, for the page's signals strip.

**Paper sessions** (`desk/paper.ts`). `OBS_PAPER=on` runs a cycle at full
size with nothing sent: the real wallet is read, the model decides, the
rails check the intent, the route is priced from live pool state, the exact
call is simulated from the real wallet when the wallet holds the from-leg,
and the trade is recorded in `obs-paper.jsonl`, never in the real book.
Later cycles see the paper positions as held, the launch-token exits apply
to them, the thought carries `paper: true`, and the equity mark goes to
`obs-paper-book.jsonl`. `npm run paper` runs one such cycle, `npm run
paper:report` marks the paper book against the real one at current prices
(what the trades changed, route cost included), `npm run paper:reset`
clears it. Paper is ignored while execution is armed. A swap decision names two registry assets and an amount; nothing
inferred, nothing outside the table. The mandate is Robinhood Chain only:
a rail refuses any leg on another chain (`OBS_TRADE_CHAINS`, default
`robinhood`), in public, before the allowlist is even consulted. On that
chain ETH is the base (`OBS_BASE`, default `eth`): every buy is paid from
ETH and every sell comes back to ETH. `USDG@robinhood` is on the allowlist
as the hop to the USDG-quoted pools and as the dollar leg of the basis
trade, and nothing more: a swap that would park the book in USDG is refused
by the rails unless the basis is on, and a launch-token exit the model
names into USDG is redirected to ETH with the change stated. `NVDA@robinhood`
(the one tokenized stock Obscura lists on the network; CASHCAT and PIPEDOG
are listed too and deliberately left out) joins the allowlist only with
`OBS_BASIS=on`. Obscura itself, probed 2026-09-02, quoted no USDG leg in
any direction while every ETH and NVDA leg quoted through its own pool
route, which is one reason the pool lane is the default venue.
The registry also carries the Ethereum assets Obscura routes (`ETH@eth`,
`WBTC@erc20`, `LINK@erc20`, `UNI@erc20`, `AAVE@erc20`, `USDC@erc20`,
`USDT@erc20`, `DAI@erc20`, each verified on chain): they are read and
marked if ever held, never traded. `ETH@base` is withdraw-only. The prompt
names exactly the allowlisted keys and states the chain rule;
`OBS_TRADE_ASSETS` narrows the allowlist; the quote watchlist
(`OBS_QUOTE_WATCHLIST`) covers the same legs so every cycle sees them. In order, the rails
refuse: trading off; same asset; either side off the allowlist; a from-leg
Obscura will not accept or a to-leg it will not pay out; an unpriced
from-leg; more than `OBS_MAX_SWAP_USD` (default $25); more than
`OBS_DAILY_SWAP_USD` in the trailing 24h (default $100); an order already
open (`OBS_MAX_OPEN_ORDERS`, default 1); a balance short of the amount; a
send that would breach the gas reserve. Then: quote the pair the way the app
does, confirm the from-chain RPC answers a balance read through the very
transport the send will use (the public Robinhood RPC challenges non-browser
clients after bursts, so a provider endpoint in `ROBINHOOD_RPC_URL` is
required before arming), take the best allowed partner, respect its min and max, create the
order with the desk's own wallet as the receiving address, read the order
back, check the deposit address looks like an address on the from-chain and
the expected amount matches, and only then sign one transfer for exactly
that amount. The trade is recorded `pending` with the deposit transaction
and Obscura's public order page. Every later cycle polls open orders and
writes `settled` (with the payout transaction) or `failed`. A refusal at any
step before the deposit costs nothing and is recorded as a public hold with
the reason.

Arming is `OBS_TRADING=on` in the operator's `.env` with the wallet key
present; the dashboard shows the state. With a wallet, equity is read from
the chain (gas and fees included), not derived from the ledgers.

**The earning leg.** Every swap through Obscura accrues cashback in
tokenized stocks on Robinhood Chain, scaled by 30-day volume and boosted by
holding $OBS. The desk reads its own `/rewards/{wallet}` stats every cycle
and the payouts land in the same wallet, where the book counts them. The
persona is told plainly that the rebate is not a reason to trade.

---

## 4. The loops

- **Think** (`desk/cycle.ts`, every 30 min, 25 min floor): reads, quotes,
  the book, the observation, public thoughts, a decision, an equity
  snapshot. DRY_RUN leaves no trace.
- **Post** (`autopilot.ts`, every 2h, 90 min floor): reads, journal, the
  last 12 posts, engagement on matured posts as an observation, a form
  rotated by ledger count so the feed varies in shape; one decision; guards;
  ledger; journal. DRY_RUN leaves no trace.
- **Engage** (`engage.ts`, every 10 min): new mentions since the cursor,
  junk filtered before any model call, avoid list, cap per pass, SKIP
  detection, guards, human pacing. First run seeds the cursor and replies to
  nothing.
- **Remember** (`_obs-backup.sh`): journals and ledgers to a private repo,
  once a day.
- **Show** (`server.ts`): the dashboard API, cached reads, CORS, GET only.
- **Host** (`scripts/run.sh`, `Dockerfile`, `docker-compose.yml`, DEPLOY.md):
  the same desk as one container on a box the operator owns: restore the
  ledgers from the memory repo on first boot, provision the personas, serve
  the API, run the desk on an interval with the backup behind it. The
  voice loops stay off unless asked; nothing in the image can arm execution.

---

## 5. The dashboard, for Obscura's team

The handoff surface is deliberately small: a handful of read-only JSON
endpoints, one server-sent-events stream, and one dependency-free HTML page
styled as a dark terminal (hairlines, monospace figures, one accent for
direction). The page shows three things people asked for: a terminal where
his thoughts and decisions land the moment a cycle writes them, a portfolio
tracker (equity, PnL, realized against unrealized, allocation, the curve
over 24h to all time, with $OBS's own price alongside), and every position
with the PnL of each (size, average cost from the ledgers, value, unrealized,
realized, share). Around them: the stats strip, the wallet, the rails with
what is used against each cap, the live trades ticker and the X feed. Their
Angular app can iframe the page, host a copy pointed at the API with
`window.OBS_API`, or fetch the JSON into native components. The feed shows drafts as drafts, so
the team can watch OBS think for a day before the account goes live, and hide
drafts with a filter once it has. Fields are only added, never renamed.

---

## 6. What v0.3 deliberately does not do

- No trading until armed. The wallet is unfunded, the capital ledger is
  empty, `OBS_TRADING` is off. Funding, recording the deposit, and arming are
  three separate operator steps, in that order.
- No non-EVM legs. Bitcoin, Solana, Monero and the rest are refused by the
  registry; each needs its own key and its own decision.
- No X posting until the operator flips `X_LIVE`.

---

## 7. Staged next steps, each an operator decision

- **O2, the desk timers and the dashboard in production.** Load
  `com.obscura.obsdesk`, host `server.ts` behind an Obscura subdomain,
  restrict `OBS_DASHBOARD_ORIGINS`, embed the page. People see thoughts and
  an empty book from day one, honestly labelled.
- **O3, first capital, then arm.** Back up the key, fund the wallet with a
  small amount plus gas, `npm run capital -- deposit`, watch a few cycles
  propose, then `OBS_TRADING=on` with the default rails ($25 a swap, $100 a
  day, one open order). Raise the rails only after settled swaps have shown
  up on the board with their transactions.
- **O4, the account goes live.** Supply the OAuth 1.0a keys for @ObscuraCEX,
  read a day of drafts on the dashboard, set `X_LIVE=true`.
- **O5, the memory repo.** Done 2026-09-02: the private `obscura-memory`
  repo exists, `OBS_MEMORY_REPO_DIR` points at its checkout, and the desk
  timer carries the daily self-commit of journals and desk ledgers.
- **O6, rewards narration.** Read `/rewards/{wallet}` for the desk's own
  wallet once it exists and let OBS talk about cashback that actually
  landed, by transaction.

---

## 8. Assumptions to confirm

1. Both personas on one OpenHermit gateway with its default model. A
   separate gateway is a later isolation choice.
2. 280 characters unless @ObscuraCEX is Premium; set `X_MAX_TWEET_CHARS`.
3. The knowledge base is what the site said on 2026-09-01. Obscura's docs
   call themselves a living document; re-verify before any claim that
   depends on a roadmap item having shipped.
4. The dashboard API runs where the agent's ledgers live (the Mac under
   launchd today). Hosting it elsewhere means moving the agent too.
