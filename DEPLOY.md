# Running OBS on a box you own

The Mac setup uses launchd timers and a local gateway. This is the same
desk as one container: the desk cycle on an interval, the daily memory
backup behind it, the read-only API on port 4671. Same ledgers, same rails,
same boundaries. Nothing in the image can arm execution.

## What you need

1. **A model.** An Anthropic key (`ANTHROPIC_API_KEY`) or an OpenAI-shape
   endpoint (`OBS_MODEL_URL`, `OBS_MODEL`) in `agent/.env` is enough for the
   desk. The voice needs an OpenHermit gateway the container can reach, with
   its admin token: on the same host the default
   `http://host.docker.internal:4000` works; anywhere else, set
   `OPENHERMIT_GATEWAY_URL` in the shell before `docker compose up`. The
   runner provisions the two personas on it at boot (`scripts/ohsetup.mjs`,
   idempotent) when the token is set.
2. **`agent/.env`**, from `agent/.env.example`. The values that matter here:
   `GATEWAY_ADMIN_TOKEN`, `OBS_WALLET_ADDRESS` (the public address only),
   `ROBINHOOD_RPC_URL` (a provider endpoint; the public RPC throttles),
   `OBS_MEMORY_REPO_URL` (see below), and `OBS_DASHBOARD_ORIGINS` set to
   the site's origin. Leave `OBS_TRADING=off`.
3. **The private memory repo.** `OBS_MEMORY_REPO_URL` is an HTTPS URL that
   can push, for example
   `https://x-access-token:<token>@github.com/<owner>/obscura-memory.git`
   with a fine-grained token scoped to that one repo, contents read and
   write. On first boot the runner clones it and, if the data volume is
   empty, seeds the ledgers from it: the book, the thoughts, the journal
   and the track record continue where the Mac left off. After every desk
   cycle the backup script commits and pushes, throttled to about once a
   day.

## Run

```
docker compose up -d --build
docker compose logs -f obs        # "[run] ..." lines, then desk cycles
curl http://localhost:4671/api/obs/health
```

Open `http://localhost:4671/` for the page, or point the site at the API
(see `dashboard/INTEGRATION.md`). Put the API behind your domain, for
example `obs-api.obscura.market`, with TLS. The stream is server-sent
events, so the proxy must not buffer it (the API already sends
`X-Accel-Buffering: no`; on nginx also set `proxy_buffering off` for
`/api/obs/stream`).

## Cadence and the voice

`OBS_DESK_INTERVAL_SEC` (default 1800) is the desk cadence; the cycle's
own 25-minute floor still applies. The X voice is off by default; set
`OBS_VOICE=on` to run posting (`OBS_POST_INTERVAL_SEC`, default 7200) and
replies (`OBS_ENGAGE_INTERVAL_SEC`, default 600) in the same process.
Posting stays draft-first until `X_LIVE=true`, exactly as on the Mac.

## Arming, if and when

Execution is a separate, deliberate step and it is the operator's:

1. Back up the key. Mount the wallet directory read-only at `/wallet`
   (uncomment the volume line in `docker-compose.yml`).
2. Set `ROBINHOOD_RPC_URL` to a provider endpoint and record capital with
   `docker compose exec obs npm run capital -- deposit ETH <amount>`.
3. Set `OBS_TRADING=on` in `agent/.env` and restart. Watch the proposals
   become orders on the page.

The rails hold either way: Robinhood Chain only, the allowlist, $25 a swap,
one open order, the gas reserve, and the deposit address check. Nothing is
counted by the day.

## Updating

`git pull && docker compose up -d --build`. The data and memory volumes
persist across rebuilds. Fields in `/api/obs/*` are only ever added, so an
older page keeps working against a newer API.

## What never leaves the box

The journal (`obs-journal.jsonl`) is in the data volume and in the memory
repo, never in any API response. The key, when mounted, is read only at
signing time inside the desk cycle and never by the API process. The
memory repo token lives in `agent/.env`, which the image never contains
(`.dockerignore`) and compose passes as environment.

## The server, as plain services (the launch path)

The container above is one way. The launch path is a small server running
the same pieces as plain systemd services, with nothing in front of the API
but Caddy and a hostname you control, and no tunnel anywhere.

**What you need:** a fresh Ubuntu 24.04 box (2 vCPU and 4 GB is plenty) with
root ssh using this Mac's key, and a hostname whose A record points at it
(`obs-api.yourdomain` on any DNS you control; `obs-api.<ip>.sslip.io` works
with no domain at all). The launch watcher stays on this Mac and its feed
mirrors to the server every minute.

**Move it, from this Mac:**
```
scripts/server/sync-to-server.sh root@<ip> obs-api.yourdomain --seed-data
```
That copies this repo, the model gateway's source and state, the
environment with the server's overrides (feed path, memory path, gateway
URL, trading off), the memory repo checkout and, with `--seed-data`, the
ledgers; then runs `scripts/server/bootstrap.sh` on the box, which installs
Node 22, Postgres, Caddy, creates the `obs` user, the gateway's database and
a deploy key for the memory repo (added to the repo with your gh login),
provisions the personas, and enables the services: `obs-gateway`,
`obs-api`, `obs-live`, `obs-desk.timer` (every 30 minutes, backup behind
it), and the voice timers only when `OBS_VOICE=on`. It also points this
Mac's feed mirror (`com.obscura.obsfeedsync`) at the server.

**Then:** `https://obs-api.yourdomain/api/obs/health` answers within a minute
of the certificate being issued. Put that hostname in the site's
`environment.prod.ts` (one line in the fork) and the page has live data
with no tunnel. Run the sync again after any change here; it restarts the
services. Arming on the server is the same deliberate step as anywhere:
`--with-wallet` once, `OBS_TRADING=on` in `/srv/obs/agent-obs/agent/.env`,
`systemctl restart obs-live obs-api`. Stop the Mac's timers when the server
is the desk, so there is one desk, not two:
`launchctl bootout gui/$(id -u)/com.obscura.obslive` and the same for
`obsdesk`, `obsapi`, `obstunnel`.

## Railway (where the desk runs from 2026-09-04)

Project `obs` in the operator's Railway workspace (linked from
`ops/railway`; `railway status` there). Three services:

- **Postgres**: the gateway's store, Railway's own, volume at its default path.
- **gateway**: the model gateway built from its public source
  (`ops/railway-gateway/Dockerfile`), listening on `::` port 4000 so the
  private network reaches it as `http://gateway.railway.internal:4000`.
  Variables: `DATABASE_URL` (a reference to Postgres), `GATEWAY_PORT`,
  `GATEWAY_HOST=::`, `GATEWAY_ADMIN_TOKEN`, `GATEWAY_JWT_SECRET`,
  `OPENHERMIT_SECRETS_KEY`, `OPENROUTER_API_KEY`. It runs its migrations at
  start. Deploy: `railway up -s gateway --path-as-root ../railway-gateway --ci`
  from `ops/railway`.
- **desk**: this repo's `agent/Dockerfile` (the hosted runner: API, live
  watch, feed puller, the 30-minute desk loop with the memory backup), a
  volume at `/app/data` (ledgers, tapes, the pulled feed, the wallet dir),
  public on port 4671. Variables: the Mac's `agent/.env` minus the Mac-only
  keys, plus `OBS_CANDIDATE_FEED=/app/data/feed/launch-watch.jsonl`,
  `OPENHERMIT_GATEWAY_URL=http://gateway.railway.internal:4000`,
  `OBS_FEED_SOURCE=https://feed.obscura.markets` with `OBS_FEED_TOKEN`,
  `OBS_MEMORY_REPO_URL` (an HTTPS URL that can push; the ledgers are
  restored from the memory repo on first boot), `OBS_WALLET_DIR=/app/data/wallet`,
  `OBS_TRADING=off`. Deploy: `railway up -s desk --path-as-root ../../agent --ci`.
  Logs: `railway logs -s desk`.

The desk needs no machine but the box. It reads launches from the
launchpad's contract and judges their ignition from their curve pool's
first minutes itself (`launchpull.ts`, `OBS_IGNITION_*`), so the launch
lane runs with no watcher anywhere. The Mac's launch watcher is optional:
when `OBS_FEED_SOURCE` and `OBS_FEED_TOKEN` are set, the desk also pulls
its feed (the hourly trails and side pools) from
`https://feed.obscura.markets` every few seconds, and when the Mac is
asleep the desk simply goes without them. `obs-api.obscura.markets` points at the
desk on Railway (a CNAME in Vercel DNS to the Railway domain). Arming on
Railway: `scripts/railway-preflight.sh` (read-only readiness checks), then
`scripts/railway-arm.sh on` (puts the key from `~/.obs/wallet/obs-wallet.json`
into `OBS_WALLET_JSON`, written to the wallet dir at boot, and sets
`OBS_TRADING=on`; `off` disarms). Set `ROBINHOOD_RPC_URL` to a provider
endpoint first; the public RPC throttles. Two desks must never run against one wallet:
when Railway is the desk, the Mac's desk timers come down.

