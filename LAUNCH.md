# Launch checklist

What has to be true for OBS to be live in public, who owns each item, and
the exact command for each. Three owners: the repo (done in code), the
operator (keys, switches, this Mac), and the site team (the page and the
domain).

## Already true, in code

- The desk cycles every 30 minutes on a launchd timer and thinks with the
  full persona (identity, rules, soul, knowledge).
- Every public thought passes the same guards as a tweet; the journal never
  leaves the machine except into the private memory repo.
- Two execution lanes behind one set of rails: the pools on Robinhood Chain
  (default, simulated green from the desk's wallet) and Obscura's routes.
  Robinhood Chain only, $25 a swap, $100 a day, one open order, the gas
  reserve, the cost floor, and the whole-book daily loss brake (entries
  halt after a $50 or 5% drawdown from the day's opening mark; exits never
  halt).
- Launch tokens from the watcher's feed trade under their own rules: a $5
  probe, a proven sell before size, one at a time, exits on volume
  roll-over, floor or time stop.
- The API is a kept-alive service with a per-client request budget and a
  cap on open streams; CORS is restricted to the site's origins and local
  development.
- The memory repo receives a daily self-commit; paper sessions exist for
  rehearsal (`npm run paper`, `npm run paper:report`).

## The operator's switches

1. **Keep this Mac awake and the services up** (all reversible with
   `launchctl bootout gui/$(id -u)/<label>`):
   ```
   cd agent && bash scripts/install-launchd.sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.obscura.obsapi.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.obscura.obsawake.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.obscura.obstunnel.plist
   ```
   The tunnel's public URL is in `~/Library/Logs/obs-tunnel.log` (grep
   `trycloudflare.com`). It changes if the tunnel restarts; the site team
   should replace it with a named tunnel on their domain or the hosted
   runner (DEPLOY.md) as soon as they can.
2. **A provider RPC** in `agent/.env` (`ROBINHOOD_RPC_URL`). The public RPC
   works, paced, but it is Cloudflare's to throttle; a free provider key
   removes "not measured" cycles on a busy day.
3. **Arm execution**, when you decide to:
   ```
   cd agent && npm run wallet -- export --reveal    # back up the key first
   # then in agent/.env: OBS_TRADING=on
   ```
   The first real actions will be a swap of at most $25 in the pools, or a
   $5 probe of a launch token followed by its sell proof.
4. **Turn the voice on**, when you decide to. `X_LIVE=true` in `agent/.env`,
   then load the two timers:
   ```
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.obscura.obsx.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.obscura.obsengage.plist
   ```
   Until then every post is a draft in the ledger and on the feed panel.

## The site team's side

- Point the Agent page at the API: `?api=<tunnel url>` for a test,
  `environment.prod.ts` for the build. The API's CORS list already names
  `https://obscuracex.com`, `https://www.obscuracex.com`,
  `https://obscura.market` and `https://www.obscura.market`; add any other
  origin to `OBS_DASHBOARD_ORIGINS` in `agent/.env` and restart the API
  service (`launchctl kickstart -k gui/$(id -u)/com.obscura.obsapi`).
- The stream is server-sent events; a proxy in front must not buffer it.
- Read `dashboard/INTEGRATION.md` for the contract. Fields are only ever
  added.
- For the day after launch: run the desk on a box you own (`DEPLOY.md`),
  seeded from the memory repo, so nothing depends on a laptop.

## The last look before going live

```
cd agent
npm test                      # every rail, guard and parser, offline
npm run desk:dry              # one cycle, nothing recorded
npm run post:dry              # one draft, nothing posted
curl -s http://127.0.0.1:4671/api/obs/status | head -c 400
```
