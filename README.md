# AGENT OBS

OBS is Obscura's own agent: a desk that thinks in public, keeps a book and
marks its PnL honestly; OpenHermit personas; a private journal that feeds a
public voice; a draft-first X account; hard boundaries enforced in code; a
memory that commits itself to a private repo; and a read-only dashboard API
that obscura.market renders so people can watch his thoughts, his trades and
the overall PnL.

Obscura ([obscura.market](https://obscura.market), [@ObscuraCEX](https://x.com/ObscuraCEX))
is private liquidity infrastructure: one route that compares centralized and
decentralized venues, shields the order intent, and settles non-custodially to
the trader's own wallet, with cashback paid in tokenized stocks on Robinhood
Chain. OBS is its operator mind and its voice.

- Design and every boundary: [DESIGN.md](DESIGN.md)
- Working agreement for agents and engineers sharing this repo: [AGENTS.md](AGENTS.md)
- **For Obscura's developers, the dashboard integration:** [dashboard/INTEGRATION.md](dashboard/INTEGRATION.md)

## What is in the box

```
agent/
  OBSCURA_KB.md            what OBS knows about Obscura, verified from the site and chain
  ROBINHOOD_CHAIN_KB.md    the chain, the tokenized stocks, where things trade, how to read it
  obs-chain.json           his chain memory: contracts, tokens, the pools where his assets trade
  OBS_X_VOICE.md           who OBS is on X and exactly how he posts
  OBS-MEMORY.md            how he keeps his own memory
  personality/             obs (operator) and copywriter (the voice), provisioned on the gateway
  src/
    desk/cycle.ts          the desk cycle: reads, quotes, the book, public thoughts, a decision
    desk/book.ts           capital flows, trades, holdings, mark-to-market PnL (pure arithmetic)
    desk/thoughts.ts       the observation, the prompt, the parser, the guards on public thoughts
    desk/onchain.ts        the pool lane: a swap in the USDG pools on Robinhood Chain from his own wallet
    desk/candidates.ts     launch candidates from a watcher's feed: gate, probe rule, proven sells, forced exits
    desk/paper.ts          paper sessions: the desk at full size with nothing sent, marked against the real book
    obscura/orders.ts      Obscura's swap API: currencies, quotes, order status; order creation gated
    autopilot.ts           the posting cycle: reads + journal + recent posts -> one decision
    engage.ts              mention replies, cursor-driven, capped, paced like a person
    server.ts              the dashboard API: read-only JSON, CORS, serves the page
    obscura/reads.ts       the live numbers he may cite: $OBS on chain, holders, prices, app health
    obscura/pools.ts       a pool's price and depth; $OBS priced by its own market each cycle
    social/postGuards.ts   the hard boundaries, one place, shared by every job
    social/xClient.ts      draft-first X client: nothing posts until X_LIVE=true
    journal.ts             per-agent private notes, fed back next cycle
  scripts/
    ohsetup.mjs            provision both personas on the gateway
    _obs-desk.sh           launchd wrapper for the desk cycle
    _obs-post.sh           launchd wrapper for the post cycle (+ memory backup)
    _obs-engage.sh         launchd wrapper for replies
    _obs-backup.sh         self-commit of his memory to a private repo
    install-launchd.sh     generates the per-machine timers from templates
  test/                    node:test, all pure
dashboard/
  index.html               the standalone dashboard page (iframe it, or copy it)
  INTEGRATION.md           endpoints, JSON shapes, embed options, what never leaks
  angular/                 the obscuracex.com Agent page as its own Angular app,
                           for testing this API against the real front end
```

## Run

On a box you own, the whole desk is one container: see [DEPLOY.md](DEPLOY.md)
(`docker compose up -d --build`; the private memory repo seeds the ledgers).
On a Mac with launchd:

```
cd agent
npm install
cp .env.example .env     # gateway values, X keys when ready
npm test
npm run reads            # the live reads block, no model, no keys
npm run setup            # provision obs + obs-copywriter on the gateway (re-runnable)
npm run dashboard        # the dashboard API and page on http://localhost:4671
npm run desk:dry         # one desk cycle: quotes, the book, public thoughts; writes nothing
npm run desk             # a real desk cycle: records thoughts, a snapshot, any proposal
npm run post:dry         # one full posting cycle, model call included, writes nothing
npm run post             # a real cycle; posts only if X_LIVE=true, otherwise ledgers a draft
npm run engage:dry       # reply pass rehearsal
```

Draft-first is the whole safety model for the account: with `X_LIVE` unset,
every tweet and reply lands in `agent/data/x-posts.jsonl` or
`x-replies.jsonl` and nowhere else. Read the drafts for a day before flipping
it. The dashboard shows drafts too, so the team can watch him think before
he speaks.

## Schedule on a Mac

```
agent/scripts/install-launchd.sh     # writes ~/Library/LaunchAgents/com.obscura.*.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.obscura.obsx.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.obscura.obsengage.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.obscura.obsdesk.plist
```

Desk cycle every 30 min (25 min floor inside the job), post cycle every 2h
(90 min floor), replies every 10 min. Logs in `~/Library/Logs/obs-desk.log`,
`obs-autopilot.log` and `obs-engage.log`.

## The wallet

OBS has one EVM wallet of his own (Ethereum, Base, Arbitrum, BSC and
Robinhood Chain share the address).

```
cd agent
npm run wallet -- create            # generates the key into ~/.obs/wallet/obs-wallet.json (mode 600)
npm run wallet -- address           # the public address; put it in .env as OBS_WALLET_ADDRESS
npm run wallet -- export --reveal   # the private key, once, for an offline backup
npm run wallet:balances             # ETH on both chains, USDG, OBS, and Obscura cashback stats
```

The key never enters the repo, the `.env`, a chat, or a log. Only the
execution path loads it, only when trading is armed, and only to sign one
deposit that passed every rail; everything else reads the public address.
The address is public on the dashboard on purpose, so every balance and
settlement can be checked on the explorer.

Capital handed to the desk is recorded by you, never by the model:

```
npm run capital -- deposit ETH 0.5          # USD from spot at record time
npm run capital -- deposit USDG 500 500     # explicit USD
npm run capital -- list
```

## The desk

Three append-only ledgers in `agent/data/` are the whole book:

- `obs-capital.jsonl`: deposits and withdrawals, written by the operator's
  tooling when capital is handed to the desk. Never by the model.
- `obs-trades.jsonl`: swaps through Obscura, one row per status change
  (`proposed`, `pending`, `settled`, `failed`, `cancelled`), with the
  settlement transaction once there is one. Never a deposit address.
- `obs-book.jsonl`: an equity snapshot per cycle. PnL is equity (priced
  holdings plus swaps in flight) minus net capital, mark-to-market.

`obs-thoughts.jsonl` holds his public reasoning per cycle, alongside the
measured observation he was handed, so anyone can check the thinking.

## Trading

With `OBS_TRADING=off` (the default) a swap decision becomes a `proposed`
row that the dashboard shows as exactly that. With `OBS_TRADING=on` and the
wallet key present, a decision that passes the rails is executed through
Obscura from the desk's own wallet: quote, best allowed partner, order with
the desk's address as the receiver, deposit address checked, one signed
transfer for exactly the quoted amount, then polled until Obscura reports it
settled, with both transactions on the board.

The rails live in `.env` and refuse before anything is sent:

```
OBS_MAX_SWAP_USD=25          dollars per swap
OBS_DAILY_SWAP_USD=100       dollars per trailing 24h
OBS_MAX_OPEN_ORDERS=1        orders in flight at once
OBS_GAS_RESERVE_ETH=0.002    never spent
OBS_ALLOWED_PARTNERS=        blank = any route Obscura quotes
OBS_TRADE_ASSETS=ETH@eth,USDC@erc20,ETH@robinhood,USDG@robinhood,NVDA@robinhood
```

Arming order: back up the key, set `ROBINHOOD_RPC_URL` to a provider endpoint
(the public RPC blocks non-browser clients after bursts and the desk refuses
to create an order it could not fund), fund the wallet (plus gas), record the
deposit with `npm run capital`, read a few cycles of proposals, then flip
`OBS_TRADING=on`. Every swap also accrues Obscura's cashback in tokenized
stocks to the same wallet, which is the desk's earning leg.

## His memory

Set `OBS_MEMORY_REPO_DIR` to a private git checkout and the post wrapper
snapshots his journals and ledgers there about once a day, committing as
`obs memory <date>`. Until it is set, the step skips quietly. See
[agent/OBS-MEMORY.md](agent/OBS-MEMORY.md).

No em dashes anywhere in this project. The provisioning script refuses a
persona file that contains one, and the tests check every doc.
