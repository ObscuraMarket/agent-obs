# Run your own Agent OBS

One page, in the order it happens. Rehearsed from a fresh clone on
6 September 2026: clone to a running dashboard takes about five minutes;
the model is the one thing you bring.

## What you need

- **Node 22** and git.
- **A model gateway.** The desk thinks through an OpenHermit gateway
  ([github.com/HCF-STUDIOS/openhermit](https://github.com/HCF-STUDIOS/openhermit)),
  open source, run by you with Postgres and your own model provider key.
  [RUNBOOK.md](RUNBOOK.md) section 3 covers installing it. Without one the
  desk reads, watches and shows its page, but does not decide.
- **An RPC provider endpoint** for Robinhood Chain (Alchemy serves it). The
  public RPC works for a look and throttles a desk.
- **Nothing else.** No account, no key of ours, no service of ours.

## Five minutes to a running page

```
git clone https://github.com/ObscuraMarket/agent-obs.git
cd agent-obs/agent
npm install
npm test                       # 160+ tests, all pure, about a second
cp .env.example .env           # then set the values below
npm run reads                  # live numbers from the chain, no keys, no model
npm run dashboard              # the API and the page on http://localhost:4671
```

In `.env`, the values that matter on day one:

```
OPENHERMIT_GATEWAY_URL=http://127.0.0.1:4000   # your gateway
GATEWAY_ADMIN_TOKEN=                            # its admin token
ROBINHOOD_RPC_URL=                              # your provider endpoint
OBS_TRADING=off                                 # leave off
```

## A wallet of your own

```
npm run wallet -- create       # writes ~/.obs/wallet/obs-wallet.json, mode 600
npm run wallet -- address      # put the address in .env as OBS_WALLET_ADDRESS
```

The key never leaves that file. Back it up offline. The desk loads it in
exactly one place, at signing time, and only once trading is on.

## Paper first

Run the desk at full size with nothing sent, marked against your real
wallet, for as long as you like:

```
npm run setup                  # provisions the two personas on your gateway, re-runnable
npm run live:paper             # the live watch on the paper book
npm run desk:dry               # one cycle, writes nothing
```

The page shows every decision, every refusal and the paper book exactly as
it would show real trades.

## Going live

In this order, and not before you have read a few paper cycles:

1. Fund the wallet with ETH on Robinhood Chain, plus a little for gas.
2. Record the capital: `npm run capital -- deposit ETH 0.1`.
3. Set the rails in `.env`: size, entries a day, the floor, the profit rules.
   `.env.example` documents each with its default.
4. Set `OBS_TRADING=on` and start the desk: `npm run live` and the cycle on a
   timer ([RUNBOOK.md](RUNBOOK.md) section 6, or `docker compose up -d --build`
   per [DEPLOY.md](DEPLOY.md)).

Everything the rails refuse is printed on your page with its reason. The
key signs trades and nothing else. Your money is in your wallet the whole
time.

## Where to look when something is off

- The stream chip on the page says live, reconnecting, polling or offline.
- The terminal explains every refusal and every exit.
- `npm run reads` with no keys tells you whether the chain answers at all.
- [RUNBOOK.md](RUNBOOK.md) for the box, [DESIGN.md](DESIGN.md) for why each boundary exists.
