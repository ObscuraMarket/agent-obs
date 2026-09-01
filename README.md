# AGENT OBS

OBS is Obscura's own agent: OpenHermit personas, a private journal that
feeds a public voice, a draft-first X account, hard boundaries enforced in
code, a memory that commits itself to a private repo, and a read-only
dashboard API that Obscura's app can render.

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
  ROBINHOOD_CHAIN_KB.md    the chain and the tokenized stocks
  OBS_X_VOICE.md           who OBS is on X and exactly how he posts
  OBS-MEMORY.md            how he keeps his own memory
  personality/             obs (operator) and copywriter (the voice), provisioned on the gateway
  src/
    autopilot.ts           the posting cycle: reads + journal + recent posts -> one decision
    engage.ts              mention replies, cursor-driven, capped, paced like a person
    server.ts              the dashboard API: read-only JSON, CORS, serves the page
    obscura/reads.ts       the live numbers he may cite: $OBS on chain, holders, prices, app health
    social/postGuards.ts   the hard boundaries, one place, shared by every job
    social/xClient.ts      draft-first X client: nothing posts until X_LIVE=true
    journal.ts             per-agent private notes, fed back next cycle
  scripts/
    ohsetup.mjs            provision both personas on the gateway
    _obs-post.sh           launchd wrapper for the post cycle (+ memory backup)
    _obs-engage.sh         launchd wrapper for replies
    _obs-backup.sh         self-commit of his memory to a private repo
    install-launchd.sh     generates the per-machine timers from templates
  test/                    node:test, all pure
dashboard/
  index.html               the standalone dashboard page (iframe it, or copy it)
  INTEGRATION.md           endpoints, JSON shapes, embed options, what never leaks
```

## Run

```
cd agent
npm install
cp .env.example .env     # gateway values, X keys when ready
npm test
npm run reads            # the live reads block, no model, no keys
npm run setup            # provision obs + obs-copywriter on the gateway (re-runnable)
npm run dashboard        # the dashboard API and page on http://localhost:4671
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
```

Post cycle every 2h (90 min floor inside the job), replies every 10 min.
Logs in `~/Library/Logs/obs-autopilot.log` and `obs-engage.log`.

## His memory

Set `OBS_MEMORY_REPO_DIR` to a private git checkout and the post wrapper
snapshots his journals and ledgers there about once a day, committing as
`obs memory <date>`. Until it is set, the step skips quietly. See
[agent/OBS-MEMORY.md](agent/OBS-MEMORY.md).

No em dashes anywhere in this project. The provisioning script refuses a
persona file that contains one, and the tests check every doc.
