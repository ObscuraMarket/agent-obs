# OBS, Design

Status: v0.2, 2026-09-01. Built and tested. Personas provisioned on the
gateway. The desk runs in observation mode: live quotes, an empty book, public
thoughts every cycle, decisions recorded as proposals; the execution stage is
not built. X account in draft mode until the operator supplies @ObscuraCEX
keys and flips `X_LIVE`. Dashboard API and page ready for Obscura's team to
integrate ([dashboard/INTEGRATION.md](dashboard/INTEGRATION.md)): thoughts,
trades, overall PnL, the feed, the reads.

OBS is **Obscura's own agent**: an operator mind and a public voice for
private, non-custodial routing across centralized and decentralized venues,
with cashback paid in tokenized stocks on Robinhood Chain. He runs on an
OpenHermit gateway, keeps his own memory, and speaks only inside boundaries
enforced in code.

---

## 0. The rule everything hangs on

**Narration is separate from authority.**

| The model decides | The model never decides |
|---|---|
| What to post, tone, timing, who to reply to | Whether any money moves (there is no money yet, and no key) |
| How to explain a mechanic | Any address: deposit, contract, wallet. It points at the site |
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
decision must name an asset the desk holds in a size it holds; anything
else is recorded as a hold with the reason. A valid one becomes a `proposed`
trade row. Nothing executes.

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

The execution stage, when it is built, needs: the signer above sending
exactly the quoted deposit from the from-chain, the same address as the
receiving address on the to-chain, a status poller that turns `pending` into
`settled` with the transaction, and rails (per-swap cap, daily cap, one open
order at a time, a kill switch). That is a design document of its own.

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

---

## 5. The dashboard, for Obscura's team

The handoff surface is deliberately small: three JSON endpoints and one
dependency-free HTML page in the app's own palette. Their Angular app can
iframe the page, host a copy pointed at the API with `window.OBS_API`, or
fetch the JSON into native components. The feed shows drafts as drafts, so
the team can watch OBS think for a day before the account goes live, and hide
drafts with a filter once it has. Fields are only added, never renamed.

---

## 6. What v0.2 deliberately does not do

- No capital and no signing. The wallet exists and is read; its key is loaded
  by nothing. The capital ledger is empty and only the operator's tooling
  writes to it. Funding the wallet and recording the deposit are two
  deliberate operator steps, and execution is a third.
- No execution through Obscura. The read paths are used every cycle; order
  creation is gated in code and nothing calls it. A decision is a proposal.
- No X posting until the operator flips `X_LIVE`.

---

## 7. Staged next steps, each an operator decision

- **O2, the desk timers and the dashboard in production.** Load
  `com.obscura.obsdesk`, host `server.ts` behind an Obscura subdomain,
  restrict `OBS_DASHBOARD_ORIGINS`, embed the page. People see thoughts and
  an empty book from day one, honestly labelled.
- **O3, capital and the execution stage.** The wallet doctrine, the first
  deposit recorded in `obs-capital.jsonl`, then the execution stage from
  section 3b with a probe-sized first swap and the status poller writing
  `settled` rows with transactions. `OBS_TRADING=on` is the last step, not
  the first.
- **O4, the account goes live.** Supply the OAuth 1.0a keys for @ObscuraCEX,
  read a day of drafts on the dashboard, set `X_LIVE=true`.
- **O5, the memory repo.** Create a private `obscura-memory` repo, set
  `OBS_MEMORY_REPO_DIR`, and the self-commit loop starts.
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
