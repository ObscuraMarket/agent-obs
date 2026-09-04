# Launch checklist

What has to be true for OBS to be live in public, who owns each item, and
the exact command for each. Three owners: the repo (done in code), the
operator (keys, switches, this Mac), and the site team (the page and the
domain).

## Already true, in code

- The live watch runs continuously and runs a desk cycle the moment a held
  token's tape breaks or an entry appears; the full board is read every 30
  minutes on a launchd timer. The desk thinks with the full persona
  (identity, rules, soul, knowledge).
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
   The clean bridge is a named tunnel on the site's own domain: the site
   team creates a tunnel in their Cloudflare zone (Zero Trust, Networks,
   Tunnels), routes a hostname such as `obs-api.obscura.market` to
   `http://127.0.0.1:4671`, and hands over the token; put it in `agent/.env`
   as `OBS_TUNNEL_TOKEN` and restart the service
   (`launchctl kickstart -k gui/$(id -u)/com.obscura.obstunnel`). Without a
   token the service opens a quick tunnel with a random hostname, printed
   to `~/Library/Logs/obs-tunnel.log`; it changes on restart, so it is for a
   test, not for the page. Either way, the hosted runner (DEPLOY.md) is the
   destination once the site team has a box.
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

**Tonight's test URL (2026-09-04, changes if the bridge restarts):**
`https://stripes-estimates-parent-save.trycloudflare.com`
Open the Agent page as `http://127.0.0.1:4200/?api=https://stripes-estimates-parent-save.trycloudflare.com`
(or the deployed page with the same `?api=`). If it stops answering, ask the
operator for a fresh one.

**In general.** `npm run bridge:url` in `agent/` prints the current
public URL of the API and a ready page link. Open the Agent page with
`?api=<that url>`; it is remembered in the browser, `?api=reset` forgets
it. The URL changes when the tunnel restarts, so it is for testing only.

**For launch, a stable name.** The page's production build already points
at `https://obs-api.obscura.market` (`environment.prod.ts`). Make that name
exist with a named Cloudflare tunnel in the site's own zone; nothing on
the agent's side changes but one line of `.env`.

In the Cloudflare dashboard (Zero Trust, Networks, Tunnels):
1. Create a tunnel, connector type Cloudflared, name it `obs-api`.
2. Copy the token it shows (the long string after `--token` in the install
   command). Send that token to the operator, privately.
3. Public hostname: subdomain `obs-api`, domain `obscura.market`, service
   type HTTP, URL `127.0.0.1:4671`. Save. (The origin is the operator's
   machine; the tunnel reaches it from inside, no port is opened.)

Or with the CLI, logged into the zone:
```
cloudflared tunnel create obs-api
cloudflared tunnel route dns obs-api obs-api.obscura.market
cloudflared tunnel token obs-api        # send this to the operator
```

The operator then puts the token in `agent/.env` as `OBS_TUNNEL_TOKEN` and
restarts the bridge (`launchctl kickstart -k gui/$(id -u)/com.obscura.obstunnel`).
Within a minute `https://obs-api.obscura.market/api/obs/health` answers and
the production page needs no `?api=`.

Also true already: the API's CORS list names `https://obscuracex.com`,
`https://www.obscuracex.com`, `https://obscura.market` and
`https://www.obscura.market` (add any other origin to
`OBS_DASHBOARD_ORIGINS` in `agent/.env` and `launchctl kickstart -k
gui/$(id -u)/com.obscura.obsapi`). The stream is server-sent events, and
Cloudflare tunnels pass it as is. `dashboard/INTEGRATION.md` is the
contract; fields are only ever added. For the day after launch, run the
desk on a box you own (`DEPLOY.md`), seeded from the memory repo, so
nothing depends on a laptop.

## The last look before going live

```
cd agent
npm test                      # every rail, guard and parser, offline
npm run desk:dry              # one cycle, nothing recorded
npm run post:dry              # one draft, nothing posted
curl -s http://127.0.0.1:4671/api/obs/status | head -c 400
```
