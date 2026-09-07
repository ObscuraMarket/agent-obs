# Working agreement: agents and engineers, one repo

Two kinds of contributor push to this repo: the agent's own jobs and the
engineers. These rules keep them from overwriting each other.

## Who owns what

| Domain | Owner | Source of truth |
| --- | --- | --- |
| Product direction, posture, what OBS works on next | **OBS** (the operator persona) | the operator's `.env` and the journals |
| Code, guards, docs, tests | **Engineering** (Claude Code, in the editor) | git `main` |
| The X account's keys and the decision to go live | **The operator** (a person) | `agent/.env` on the machine that runs the timers |

### The personas on the gateway

Two personas are provisioned by `agent/scripts/ohsetup.mjs`, and they are not
interchangeable. The split exists so the agent that will one day decide about
money is not also the agent reading untrusted text off a public timeline.

| Agent id | Job | Driven by |
| --- | --- | --- |
| `obs` | The operation: reads the app and the chain, sets posture, directs the copywriter | conversation |
| `obs-copywriter` | Owns @ObscuraCEX: posts, mention replies. **Not** OBS. | `autopilot.ts` / `engage.ts`, via `OBS_X_AGENT_ID` |

Journals are per agent (`<agent>-journal.jsonl`). An agent's journal IS its
memory and its continuity; they must not be shared or swapped.

## Rules

1. **`git pull --rebase` before every push.** Every time. Do not chain it
   through `tail`, because a pipeline reports the last command's status and
   the push will run even when the rebase failed.
2. **Real values live in `.env` on the operator's machine, never in the
   repo.** Gateway tokens, X keys, memory repo paths. `.env.example` is
   documentation: names, comments, placeholders. Never commit a real value.
3. **Stay in your lane.** Engineering edits code and docs; it does not flip
   `X_LIVE`, does not create wallets, does not decide what OBS says. The
   operator decides those. When something needs both (a new env var),
   engineering adds the documented placeholder and the operator sets it.
4. **Draft-first is the safety model, not a phase.** Nothing reaches X while
   `X_LIVE` is anything but `true`. A new guard, a new prompt, a new form:
   read its drafts in the ledger before it posts for real.
5. **Small, frequent commits**, pushed promptly.
6. **No em dashes, anywhere.** Chat, code comments, docs, commit messages,
   persona files, prompts. The setup script and the tests enforce it.

## Deploy notes

- There is no server. The X jobs run on the operator's Mac under launchd
  (`com.obscura.obsx` / `com.obscura.obsengage`), executing `tsx` against
  the working tree, so a code change is live on the next tick with no deploy
  step, and a broken edit is live just as fast. Run the tests first.
- `agent/scripts/install-launchd.sh` writes the per-machine plists; they are
  gitignored because they carry absolute paths.
- Persona edits (`agent/personality/`) take effect on `npm run setup`, no
  restart.
- The knowledge base (`agent/OBSCURA_KB.md`) is outward-facing through
  everything OBS says. Treat edits to it as publishing: verify against the
  site and the chain first.

## When money arrives

Nothing in this repo signs anything today. OBS's wallet key lives in
`~/.obs/wallet/obs-wallet.json` on the operator's machine (mode 600), created
by `npm run wallet -- create`; it is never committed, never placed in `.env`,
never pasted into a chat or an issue, and only `scripts/wallet.mjs export
--reveal` prints it, for an offline backup. The loops read the public address
and nothing else. The desk's capital ledger (`agent/data/obs-capital.jsonl`)
is written by `npm run capital`, never by the model and never by engineering
on the operator's behalf; a deposit that is not in the ledger is not on the
book. The one row the desk writes itself is a credits payment it has verified
on chain when the credits treasury is its own wallet: the asset and amount
that arrived, at their value then, so console revenue is capital handed to
the desk and never trading profit.

**Arming is the operator's act alone.** `OBS_TRADING=on` is set by the
operator in their `.env`, never by engineering and never by the model. The
rails (`OBS_MAX_SWAP_USD`, `OBS_MAX_OPEN_ORDERS`,
`OBS_GAS_RESERVE_ETH`, `OBS_TRADE_ASSETS`) are lowered freely and raised
only after settled swaps have appeared on the board with their transactions.
An asset enters `OBS_TRADE_ASSETS` only if it is already in the registry
(`agent/src/desk/assets.ts`) with a verified contract and decimals; adding
one there is an engineering change with a test, not an env edit.

If Obscura hands OBS a treasury, it gets a treasury doctrine before a single
key is created: an agent-custodied receive-only treasury, a separate
operator-held signer with spend caps and a daily op ceiling, exactly one host
holding the signer key, one open order at a time, and a breaker underneath.
That is a design step with its own document, not a `.env` change.
