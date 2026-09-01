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

Nothing in this repo signs anything today. The desk's capital ledger
(`agent/data/obs-capital.jsonl`) is written by the operator's tooling only,
never by the model and never by engineering on the operator's behalf; a
deposit that is not in the ledger is not on the book. Order creation at
Obscura is gated in code (`OBS_TRADING`) and no loop calls it.

If Obscura hands OBS a treasury, it gets a treasury doctrine before a single
key is created: an agent-custodied receive-only treasury, a separate
operator-held signer with spend caps and a daily op ceiling, exactly one host
holding the signer key, one open order at a time, and a breaker underneath.
That is a design step with its own document, not a `.env` change.
