# Run Agent OBS yourself

For an operator who is not on the Mac this was built on. Everything the desk
needs is in this repo except two things: the secrets (yours to create, the
names are in `agent/.env.example`) and the launch feed (see step 6). Nothing
in the repo can arm execution; that is the switch in step 8, yours alone.

## 1. What you need

- A Linux box you control (Ubuntu 24.04, 2 vCPU, 4 GB) with a public IP, and
  a hostname pointing at it. `obs-api.<ip>.sslip.io` works with no domain.
- Access to this repo, and to the private memory repo (or your own: any
  private git repo the box can push to).
- A model. The desk thinks through whichever `agent/.env` names: an
  Anthropic key (`ANTHROPIC_API_KEY`), an OpenAI-shape endpoint
  (`OBS_MODEL_URL`, `OBS_MODEL`), or the OpenHermit gateway, an open-source
  project ([github.com/HCF-STUDIOS/openhermit](https://github.com/HCF-STUDIOS/openhermit))
  that calls the provider named in its own `.env` (`OPENROUTER_API_KEY`).
  This runbook installs the gateway, which the voice needs; the desk alone
  needs only a key.
- A Robinhood Chain RPC endpoint from a provider. The public RPC works but
  throttles; `ROBINHOOD_RPC_URL` in `agent/.env`.
- For the voice only: the X account's OAuth 1.0a credentials.

## 2. Put the code on the box

```
mkdir -p /srv/obs && cd /srv/obs
git clone <this repo> agent-obs
git clone https://github.com/HCF-STUDIOS/openhermit.git openhermit
git clone <the memory repo> memory
```

## 3. The gateway's environment

`/srv/obs/openhermit/.env` needs: `DATABASE_URL` (a local Postgres URL, the
bootstrap creates the role and database from it), `GATEWAY_PORT=4000`,
`GATEWAY_ADMIN_TOKEN` (any long random string; the desk uses the same one),
`GATEWAY_JWT_SECRET` and `OPENHERMIT_SECRETS_KEY` (long random strings),
`OPENROUTER_API_KEY` (the provider key). The gateway runs its own database
migrations at start.

## 4. The desk's environment

```
cp /srv/obs/agent-obs/agent/.env.example /srv/obs/agent-obs/agent/.env
```
Fill in, at minimum: `GATEWAY_ADMIN_TOKEN` (same as the gateway's),
`OPENHERMIT_GATEWAY_URL=http://127.0.0.1:4000`, `ROBINHOOD_RPC_URL`,
`OBS_MEMORY_REPO_DIR=/srv/obs/memory`, `OBS_CANDIDATE_FEED` (step 6),
`OBS_DASHBOARD_ORIGINS` (the site's origins), `OBS_PUBLIC_HOSTNAME` (the
API's hostname). Leave `OBS_TRADING=off`. Every other setting has a default
that is documented beside it.

## 5. The wallet and the capital

The desk trades from its own wallet. Whoever runs the desk holds the key.
```
cd /srv/obs/agent-obs/agent && npm ci
npm run wallet -- create            # writes the key file under OBS_WALLET_DIR (default ~/.obs/wallet)
npm run wallet -- address           # the public address; put it in agent/.env as OBS_WALLET_ADDRESS
npm run wallet -- export --reveal   # back the key up, once, somewhere safe
```
Fund the address with ETH on Robinhood Chain, then record the deposit so the
book knows its capital:
```
npm run capital -- deposit ETH 0.5
```

## 6. The launch feed

The token lanes (launches from minute one, the bar, the stability hunt)
read a launch watcher's feed: an append-only JSONL file of `launch`,
`ignition`, `side-pool`, `hourly` and `candidate` rows (the shapes are in
`agent/src/desk/candidates.ts`, `parseFeed`). That watcher is a separate
program and is not in this repo. Two ways to have the feed on the box:

- **Mirror it** from the machine that runs the watcher: `agent/scripts/_obs-feedsync.sh`
  sends the file's new tail every minute over ssh to `/srv/obs/feed/launch-watch.jsonl`
  (`OBS_SERVER` on that machine names the box). This is how the Mac feeds a server.
- **Run your own watcher** that writes the same rows. Without any feed the
  desk still runs, marks its book, and trades only what is on its base
  allowlist (ETH and USDG); it has no launches to look at.

`OBS_CANDIDATE_FEED` points at the file either way.

## 7. Start it

As root, with `OBS_PUBLIC_HOSTNAME` set to the API's hostname:
```
OBS_PUBLIC_HOSTNAME=obs-api.yourdomain bash /srv/obs/agent-obs/scripts/server/bootstrap.sh
```
This installs Node 22, Postgres and Caddy, creates the `obs` user, the
gateway's database, a deploy key for the memory repo (add its public key,
printed at the end, to that repo with write access), provisions the two
personas, and enables the services:

| Service | What |
|---|---|
| `obs-gateway` | the model gateway, port 4000, local only |
| `obs-api` | the read-only dashboard API, port 4671, local only; Caddy fronts it with TLS |
| `obs-live` | the live watch: the desk in real time |
| `obs-desk.timer` | the full desk cycle every 30 minutes, the memory backup behind it |
| `obs-x.timer`, `obs-engage.timer` | the voice, enabled only when `OBS_VOICE=on` |

Check: `https://obs-api.yourdomain/api/obs/health` answers `{"status":"ok"}`
within a minute of the certificate being issued. Point the site at that
hostname (`environment.prod.ts` in the site repo, `obsApiUrl`).

## 8. Arming, if and when

1. The key file exists on the box and is backed up.
2. Capital is recorded (step 5).
3. `OBS_TRADING=on` in `agent/.env`, then `systemctl restart obs-live obs-api`.

The rails hold either way: Robinhood Chain only, ETH base, one open
position, $25 a swap and $100 a day by default, a $5 probe with a proven
sell before size, entries spaced and counted, a daily loss brake, exits the
model cannot override. The first live trade is a probe.

## 9. Day to day

```
systemctl status 'obs-*'
journalctl -u obs-live -f            # the live watch, one line a minute plus every trigger
journalctl -u obs-desk -n 100        # the last desk cycle
curl -s localhost:4671/api/obs/status
```
Update: `git -C /srv/obs/agent-obs pull && bash /srv/obs/agent-obs/scripts/server/bootstrap.sh`
(idempotent; it reinstalls dependencies and restarts the services). The
ledgers live in `agent/data` and are pushed to the memory repo about once a
day by the backup; `FORCE=1 bash agent/scripts/_obs-backup.sh` pushes now.

## 10. What never leaves the box

The private journal, the key file, the tokens in either `.env`. The API
serves only what `dashboard/INTEGRATION.md` lists. The Mac this was built
on keeps its own copy of everything until you tell it to stop; two desks
must never run against one wallet, so when the box is the desk, the Mac's
timers come down.
