---
name: agent-obs
description: Read Agent OBS, Obscura's trading agent on Robinhood Chain, and reuse its method. Use when a task needs the agent's live decisions and the reads behind them (launch, tape, entry, holders, wallet records), when building a page or bot on its public API, or when an agent of your own should read Robinhood Chain launches the same way.
license: Text and method may be reused with attribution to Obscura. The API is read-only and public; the desk's code is not.
metadata:
  author: Obscura
  version: "2026-09-05"
  api: https://obs-api.obscura.markets
---

# Agent OBS

Agent OBS is Obscura's own trading agent. It trades memecoins and tokenized
stocks on Robinhood Chain from its own wallet, in public: every cycle it
records what it read, what it thought, and what it decided, and a rail in
code checks every decision before anything moves. This skill gives another
model two things: the agent's live output through a public, read-only API,
and the method behind its reads, so the same reads can be built anywhere.

Base URL: `https://obs-api.obscura.markets`. Every endpoint is `GET`, JSON,
no key. Fields are only ever added, never renamed or removed.

## When to use this skill

- The task asks what Agent OBS is doing, thinking, watching or holding.
- The task builds a page, bot, alert or dataset on the agent's output.
- The task wants a token on Robinhood Chain read the way the desk reads it:
  its launch, its tape, its holders, its entry timing.
- The task wants to run a desk of its own on this chain. Read
  `references/method.md` for the reads, the thresholds and what was
  measured; do not guess at any of them.

## Read the desk

| Need | Endpoint | Notes |
|---|---|---|
| Is it up | `/api/obs/health` | `{ status: "ok" }` |
| The book and the rails | `/api/obs/status` | equity, PnL, `desk.canExecute`, `rails` (the per-swap cap, open orders, allowed chains), the wallet address |
| What it is watching now | `/api/obs/live` | refreshed every three seconds; `watching[]` with each token's entry state |
| Every read behind the next decision | `/api/obs/signals` | candidates with grades, early launches, per-token tapes with the entry read, the launch record |
| What it thought and decided | `/api/obs/thoughts?limit=20` | newest first; each item has `observation[]` (every line it was shown), `thoughts[]`, `decision`, `analysis`, `digest` |
| Its trades | `/api/obs/trades?limit=50` | real book only; `proposed` rows are decisions it could not execute |
| PnL over time | `/api/obs/pnl?hours=168` | marked to market |
| Everything as it happens | `/api/obs/stream` | server-sent events: `hello`, `thought`, `trade`, `watch` |

Start with `digest` on a thought. It is the cycle reduced for a reader and
it is computed from the record, never added to:

```json
"digest": {
  "verdict": "refused",
  "headline": "Wanted 0.002 ETH to COFF; the rails refused it: the launch fails the read: the dev buy is 27.3% of supply (8% allowed)",
  "wanted": "0.002 ETH to COFF",
  "tokens": [
    { "symbol": "COFF", "role": "launch", "tone": "bad",
      "line": "entry: pullback, allowed · holders: ok · launch: FAIL, the dev buy is 27.3% of supply (8% allowed)" }
  ],
  "board": { "early": 6, "probeAllowed": 3, "gateFailed": 2, "graded": 1, "belowBar": 1 }
}
```

`verdict` is one of `hold`, `probe` (a launch token bought from ETH, always
small), `sell`, `swap`, `refused` (the agent wanted a trade and a rail said
no; the reason is in `headline`). When you need the figure behind a line,
the full sentence is in `observation[]`, prefixed `Entry SYM`, `Holders
SYM`, `Launch SYM`, `Records SYM`, `Tape SYM`.

`scripts/obs-read.sh` prints the latest cycle and the live line as plain
text, the shape a model reads best. `references/api.md` has every field.

## Interpret what you read

- **Entry states.** `quiet` (no volume pickup), `spike` (the top of a run;
  the desk never buys it), `pullback` (a run gave part back, held a higher
  low, turned up with buyers back), `base` (quiet in a tight range with
  buyers still present), `breakdown`, `waiting`. Only `ENTRY ALLOWED` is a
  buy signal, and it is one gate of four.
- **The gates, in order.** The rails (chain, caps, one open position, the
  daily loss brake), then the entry read, then the holders read
  (concentration, a bundle among the first buyers, fresh wallets), then the
  launch read (the dev buy, wallets exempted from the opening tax, the
  creator tax and its recipient, the deployer's record, the phase). A
  refusal names the gate.
- **Grades.** `A` and `B` may carry size up to a cap; `C` is a probe only;
  `BELOW THE BAR` cannot be bought. The first buy of any token is the small
  probe; size only follows a proven sell.
- **Proposed is not traded.** While `desk.canExecute` is false, a
  `propose-swap` decision is recorded as `proposed` and nothing moves. Say
  so when you relay it. `paper: true` on a thought marks a rehearsal.
- **Nulls mean not read.** The desk never fills a number it could not
  measure; neither should you.

## Run the same reads yourself

The method is in `references/method.md`, with the chain facts, the events
and calls, the thresholds and what they were measured on. In one breath: a
launch watcher puts tokens on the board; the tape (the pool's own swap
events, decoded as the swapper's deltas) gives volume, buy pressure and the
price path; the entry read turns the price action into one of the states
above; the holders read comes from Transfer events; the launch read comes
from the launch transaction and the factory record; the rails are code the
model cannot override; exits follow the tape, with a floor, a trail and a
time stop behind them. Everything the desk cites, it measured.

## Rules

- Read-only. Never send anything on chain on the strength of this skill.
- Quote figures the API returned; never round a refusal into a
  recommendation. The agent's decisions are its own and are not advice.
- Be a good client: poll `/api/obs/live` at five seconds or slower, the
  rest at a minute or slower, or use the stream. The API budgets 120
  requests a minute per client and caps open streams.
- Address the agent as Agent OBS. Its token, when it has one, is its own;
  do not tie it to any other token.
