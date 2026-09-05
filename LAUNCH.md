# Launch checklist

What has to be true for Agent OBS to trade in public, who owns each item,
and the exact command for each. Three owners: the repo (done in code), the
operator (keys and switches), and the site team (their page and their zone).

## Where everything runs (from 2026-09-05)

- **The desk** runs on Railway (project `obs`, service `desk`, linked from
  `ops/railway`): the API, the live watch (a look at every tape every three
  seconds, a desk cycle the moment a held token's tape breaks or a token
  gives an entry), the feed puller, and the full board read every 30
  minutes. Public name: `https://obs-api.obscura.markets`.
- **The launch watcher** runs on the Mac. Its feed reaches Railway through
  `https://feed.obscura.markets` (the Vercel proxy in `ops/vercel-obs-api`,
  kept pointed at the Mac's bridge by `com.obscura.obsvercel`); the desk
  pulls it every 30 seconds.
- **The site** at `obscura.markets` is the fork's `main`, deployed by
  `scripts/deploy-site.sh` (`com.obscura.obssite`, every 10 minutes when
  main moved). The site team's `obscura.market` carries the same page.
- **The Mac runs no desk.** `obsdesk` and `obslive` stay booted out: two
  desks must never share one wallet. The Mac's jobs are the watcher's feed
  (`obsapi`, `obstunnel`, `obsvercel`, `obsawake`), the site deploy
  (`obssite`) and the desk deploy (`obsdeploy`, `scripts/deploy-desk.sh`,
  every 10 minutes when main moved).

## Already true, in code

- The agent reads the tape for every token in play, the entry read (volume
  puts a token on watch, the price action gives the entry), the stability
  read (tokens with active hours behind them), the holders (concentration,
  bundles, fresh wallets), the wallets' own records across tokens, and the
  launch itself (the dev buy, the wallets exempted from the opening tax,
  the creator tax and its recipient, the deployer's record, the phase). All
  of it reaches the model every cycle, and every gate is public.
- The replay: `scripts/railway-pull-data.sh` copies the desk's tapes and
  ledgers from Railway, and `npm run replay:entries` in `agent/` shows what
  every entry the tape allowed did afterwards. Run it before arming.
- ETH is the book's base: every buy is paid from ETH and every sell comes
  back to ETH. USDG is a hop, never a place to park; the rails refuse a
  swap that would park there.
- Rails, in code, that the model cannot override: Robinhood Chain only,
  $25 a swap, $100 a day, one open order, the gas reserve, the cost floor
  against the pool mark, the whole-book daily loss brake (entries halt after
  a $50 or 5% drawdown from the day's opening mark; exits never halt).
- Launch tokens: a $5 probe, a proven sell before size, one at a time;
  exits on the tape (buyers thinning, the roll-over, the give-back off the
  peak), a floor and a time stop. The ERC-20 approvals a sell needs (token
  to Permit2, Permit2 to the router) are sent once, only when missing.
- The API is a kept-alive service with a per-client request budget, a cap
  on open streams and CORS restricted to the site's origins. The ledgers
  are backed up to the private memory repo daily and restored on a fresh
  boot.

## The operator's switches, launch day

1. **Preflight, read-only.** Nothing changes; it prints what a launch needs:
   ```
   scripts/railway-preflight.sh
   ```
   It must say: health ok, live watch fresh, `OBS_TRADING=off` (until step
   4), the feed within a minute of the Mac's, the gateway answering, no
   desk on the Mac.
2. **The model sees the launches.** The last cycle's observation on Railway
   must carry the launch lines, not just the book:
   ```
   cd ops/railway && railway logs -s desk | grep -E "Launch candidates|Early launches|Entry |HOLDERS" | tail -5
   ```
   (Until 2026-09-05 those lines hung off the reference quotes and vanished
   whenever the quote watchlist failed to parse; the model then held every
   allowed entry "for lack of measured data". Fixed in code and in the
   Railway variable.)
3. **Capital.** The desk's wallet is `0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38`
   on Robinhood Chain. Every deposit is recorded on the capital ledger or
   it is not on the book (the equity and PnL are marked against it):
   ```
   cd agent && npm run capital -- deposit ETH <amount>
   ```
   then push the ledger to Railway with the memory backup, or record it
   inside the container (`railway ssh -s desk`, same command from `/app`).
   The key file `~/.obs/wallet/obs-wallet.json` on the Mac is the only
   copy outside Railway: back it up before arming
   (`npm run wallet -- export --reveal`).
4. **Arm.** Deliberate and reversible; each change redeploys the desk and
   the API is back within a minute:
   ```
   scripts/railway-arm.sh on      # key into OBS_WALLET_JSON, OBS_TRADING=on
   scripts/railway-arm.sh off     # OBS_TRADING=off; the key variable stays
   railway variables -s desk --unset OBS_WALLET_JSON    # remove the key too
   ```
   `ROBINHOOD_RPC_URL` is set to the public Robinhood Chain RPC; a provider
   key removes "not measured" reads on a busy day. Alchemy serves the chain
   (`https://robinhood-mainnet.g.alchemy.com/v2/<key>`, an app on Robinhood
   Chain Mainnet in the Alchemy dashboard). Install it with
   `scripts/railway-rpc.sh <url>`: it proves the endpoint is chain 4663 with
   a fresh head and working `eth_getLogs`, then sets the variable on Railway
   (a redeploy) and in `agent/.env` on the Mac. `--check <url>` tests only.
5. **What the first trade looks like.** The wallet has never sent a
   transaction. The first live action is a $5 probe from ETH into a launch
   token's pool (one swap), then, when the exit comes, two approvals and
   the sell. Watch it on `https://obscura.markets` (the Agent page), on
   `/api/obs/trades`, and in `railway logs -s desk`. A refusal by the rails
   is public on the same page.
6. **Stop.** `scripts/railway-arm.sh off` halts entries within a minute;
   the daily loss brake halts them on its own at $50 or 5% down on the day.
   Exits never halt in either case.

## The site team's side

- **The API by name.** `obs-api.obscura.market` has its CNAME
  (`obs-api` to `1ja8d5cy.up.railway.app`). Railway still needs the
  ownership record beside it: TXT `_railway-verify.obs-api` with the value
  `railway-verify=5084619bffdfa604e5487bb6399b0e08b387e01e0dca7f494d73b078a27fb41b`.
  Until it is in, the page on `obscura.market` reaches the desk through
  its fallback (a four-second health probe on first load, then the desk's
  Railway address). Nothing on the agent's side changes when it lands.
- **Updates.** A dashboard change on this repo's `main` is relayed by hand
  (`npm run relay` in `agent/`) as a pull request on the fork; merging it
  puts it on `obscura.markets` within ten minutes, and the site team pulls
  the same change into `obscura.market`. `dashboard/INTEGRATION.md` is the
  contract: fields in `/api/obs/*` are only ever added, never renamed or
  removed.

## The last look before going live

```
cd agent && npm test
scripts/railway-preflight.sh
curl -s https://obs-api.obscura.markets/api/obs/status | head -c 400
```
