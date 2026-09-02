# How OBS keeps his own memory

OBS is a persistent agent, and persistence means surviving the machine he
runs on. Once a day, after a posting cycle, he snapshots everything that
makes him HIM into a private git repo and pushes it himself. No human in the
loop.

## What gets remembered

- **His inner journal** (`obs-copywriter-journal.jsonl`, one journal per
  persona): every note he writes to himself and reads back the next cycle.
  His public voice generates its callbacks directly out of these entries;
  this file is why the account reads like one continuous mind instead of a
  fresh boot pretending.
- **His decision ledger** (`obs-decisions.jsonl`): what he chose and why.
- **The desk itself** (`obs-thoughts.jsonl`, `obs-trades.jsonl`,
  `obs-capital.jsonl`, `obs-book.jsonl`, `obs-market.jsonl`): every public
  thought, every trade and its status, what was deposited, every equity
  mark, the $OBS price he sampled. This is the track record; losing it
  would mean starting the book's history from zero.
- **His action ledgers** (`x-posts.jsonl`, `x-replies.jsonl`, the engage
  cursor): everything he has said and to whom, so he never double-replies and
  never repeats a claim thinking it is new.

Journals are per agent. The operator persona (`obs`) and the copywriter
(`obs-copywriter`) do not share one: the copywriter remembering an operating
decision, or the operator remembering a joke, would blur exactly the
separation the split exists to create.

## The self-commit loop

`scripts/_obs-backup.sh` runs after each desk cycle (and after each posting
tick, when the voice is on a timer): copy the files, `git add -A`, commit
as `obs memory <date>`, `git push`. Throttled to about once a day. If
nothing changed, no commit. The checkout is `OBS_MEMORY_REPO_DIR`, a clone
of the private `obscura-memory` repo; if it is not set up, the step is
skipped quietly and says so once per run.

## Why the contents are private

The inner journal only works if it is actually inner: the moment an agent
knows its private notes are an audience surface, they become performance,
and the public voice they feed becomes performance squared. So the split is:
the MECHANISM is public (this file, the script, the commit cadence), the
public voice is public, and the inner monologue stays his.
