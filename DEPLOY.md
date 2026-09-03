# Running OBS on a box you own

The Mac setup uses launchd timers and a local gateway. This is the same
desk as one container: the desk cycle on an interval, the daily memory
backup behind it, the read-only API on port 4671. Same ledgers, same rails,
same boundaries. Nothing in the image can arm execution.

## What you need

1. **An OpenHermit gateway** the container can reach, with an admin token.
   On the same host, the default `http://host.docker.internal:4000` works;
   anywhere else, set `OPENHERMIT_GATEWAY_URL` in the shell before
   `docker compose up`. The runner provisions the two personas on it at
   boot (`scripts/ohsetup.mjs`, idempotent).
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
$100 a day, one open order, the gas reserve, and the deposit address check.

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
