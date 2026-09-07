# Go-live checklist: the tokenized agent

The list the team walks through when Agent OBS goes live with its own
token. Two events land together: the token launches, and the desk starts
trading real money in public. Each item names its owner. Commands are the
exact ones; nothing here is approximate. The ticker is TBD until the team
decides it; the token is the agent's own and is never tied to any other.

Owners: **Team** (a decision), **Operator** (keys, switches, Railway),
**Site** (John, Max: the page and their zone), **Community** (announcements).

## 0. Decisions still open (Team)

- [ ] **Name and ticker.** Everything below says "the token" until this is set.
- [ ] **What the token does.** The desk never trades it and profits stay in ETH, so its utility is a product decision, not a trading one.
- [ ] **Launch parameters, chosen to pass the desk's own launch read.** The agent will read its own launch the way it reads every other one, in public. Choose so it scores well:
  - dev buy between 1% and 6% of supply (the read rewards this band, punishes over 10%);
  - creator tax at most 2% (1% earns the creator on volume and scores +10; 0% scores +5);
  - no wallets exempted from the opening tax (an exemption list is a declared bundle and fails the read at 3 or more);
  - the X link, the website (obscura.markets) and a telegram set in the token's metadata, with a description of 40 characters or more;
  - the fee recipient decided (a treasury wallet reads as the builder pattern; the deployer wallet reads as first party);
  - the deployer wallet chosen: fresh, or one with graduated launches behind it.
- [ ] **Launch time.** A window when the team is all present for the first two hours.

## 1. The day before (T-1)

**Operator, the desk**
- [ ] Pull the data and rerun the replay; decide the entry rule to arm on (today's evidence favours launches under 15 minutes old; the rule is one variable, `OBS_EARLY_MAX_AGE_MIN`):
  ```
  scripts/railway-pull-data.sh && cd agent && npm run replay:entries -- ../data-railway/tape ../data-railway/poolmap.json
  ```
- [ ] Preflight clean: `scripts/railway-preflight.sh` (health ok, live watch fresh, feed within a minute of the Mac, gateway answering, no desk on the Mac).
- [ ] Key backed up outside the Mac: `cd agent && npm run wallet -- export --reveal`, stored where two people can reach it.
- [ ] Capital recorded on the ledger matches the wallet on chain (`/api/obs/status`, `netCapitalUsd` against the address's balance).
- [ ] Alchemy on pay as you go with a monthly spending cap and the usage alert on.
- [ ] Railway: the desk's logs open in a tab; the volume under 1 GB.
- [ ] Snapshot the tapes and ledgers (they prune after three days): the pull script above into a dated folder.

**Operator, two small builds**
- [ ] A never-trade rail for the agent's own token (its contract in one variable, refused by the rails in public), so the desk can never be accused of trading its own coin.
- [ ] The post guard's address allowlist widened to the new contract, so the agent's own posts may carry it and nothing else.

**Site**
- [ ] obscura.market deploying from the site repo again (the Vercel setting for commit authors outside the team, or a manual redeploy after each merge; see pull request #9 on the site repo).
- [ ] `obs-api.obscura.market` carrying its ownership TXT record, or the team accepting the page's fallback to the Railway address.
- [ ] The Agent page shows the digested terminal and the live watch line on both domains.

**Community**
- [ ] Announcement drafts written with a placeholder for the contract address; the address is published only after launch, only from official accounts.
- [ ] A short "how to read the terminal" post: HOLD, PROBE, REFUSED, the four gates, and that a proposal is not a trade.
- [ ] The rules of engagement agreed: the agent gives no advice; every figure it cites is measured; nothing is promised.
- [ ] The skill link ready to share for other agents: `https://obs-api.obscura.markets/skill`.

## 2. Launch hour (T-0)

**The token (Team, Community)**
- [ ] Deploy through the launchpad with the parameters above. Do not race the first block: the opening tax hands the first seconds to the creator's bucket by design.
- [ ] Within a minute, read the launch with the desk's own read and confirm it scores as intended (dev buy share, zero exempt wallets, tax, links). The agent will say the same in public on its next cycle.
- [ ] Publish the contract from official accounts. Add it to the post guard.
- [ ] Watch the curve fill and the graduation. Between the sweep and the pool, nothing trades; say so if asked.

**The desk (Operator)**
- [ ] Withdraw the proposals the unarmed desk stacked up: `scripts/railway-withdraw.sh --dry` to see them, then `scripts/railway-withdraw.sh`. An armed desk decides and executes in the same cycle and never returns to an old proposal, so anything left as "proposed" is a dead row the model keeps reading as "awaiting the operator" and holds against.
- [ ] Arm: `scripts/railway-arm.sh on`. Rerun the preflight; `armed (canExecute)` must read true.
- [ ] Know the first trade: a $5 probe from ETH into a launch token's pool, one swap; on its exit, two approvals then the sell. Watch it on the Agent page, on `/api/obs/trades`, and in `railway logs -s desk`.
- [ ] Know the stop: `scripts/railway-arm.sh off` halts entries within a minute; the daily loss brake halts them alone at $50 or 5% down on the day; exits never halt.
- [ ] Rails at launch, said out loud once: $25 a swap, one open position, $5 probe, a proven sell before size.

## 3. The first 24 hours

**Monitoring (Operator), every hour**
- [ ] `/api/obs/health` ok; `/api/obs/live` fresh with looks under two seconds.
- [ ] Feed lag zero: the Railway copy matches the Mac's file size.
- [ ] Alchemy usage inside the cap; no throttling lines in the desk logs.
- [ ] Every settled trade has a settlement transaction on the explorer; every proposal that was refused names its gate.
- [ ] PnL marked on the page matches the wallet on chain.

**If something goes wrong**
- [ ] RPC throttling or "not measured" reads: the public RPC is the fallback (`scripts/railway-rpc.sh <url>`), slower but working.
- [ ] A sell fails on a held token: the desk blacklists it and stops adding; the position is sold by hand from the wallet if it can be.
- [ ] The key is exposed: `scripts/railway-arm.sh off`, move the ETH to a fresh wallet, generate a new desk wallet, record the deposit, re-arm.
- [ ] obscura.markets down: the API is separate; the page on obscura.market (if deploying) or the reference page from the repo carries the terminal.
- [ ] The token's pool stuck in the swept phase: wait; it is the launchpad's gap, not ours.

## 4. The first week

- [ ] The replay every morning, on the previous day's tapes; rails changed only with a number behind the change.
- [ ] A daily readout to the team: cycles, probes, refusals by gate, realized PnL, the best and worst trade with the reason.
- [ ] The launch ledger kept (every launch the desk read, with its score) for the week's review of which facts predicted the winners.
- [ ] The voice: posts stay draft-first for the first week of clean cycles; the team reviews the drafts before `X_LIVE` is turned on.
- [ ] The team writeup republished with the ticker filled in and the first week's numbers.
