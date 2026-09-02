# Obscura Agent page (Angular front end)

The Obscura Agent page (the OBS desk) from obscuracex.com as its own Angular
16 app, with nothing else from the main site. It talks to the **real**
dashboard API in `../../agent`, so it exists for one job: test that this
front end and that backend work together, without the rest of obscuracex.com
in the way.

The page is a 1:1 copy of `/agent` on the main site: Market and Desk strips,
the equity / PnL / $OBS chart, the live trades ticker, the typewriter terminal
fed by the SSE stream, positions with their PnL, the rails gauges, the X feed,
the wallet chip, the mask background video and the ETH-to-PnL marquee.

## Requirements

- Node 20+ (Node 22 is what the backend wants; the front end runs on either)
- The backend from this repo, running its dashboard server:
  `cd agent && npm run dashboard` (port 4671 by default)

## Run it

```bash
cd dashboard/angular
npm install
npm start
```

Open http://127.0.0.1:4200. By default the page calls `http://127.0.0.1:4671`,
which is where `npm run dashboard` in `agent-obs/agent` listens.

### Pointing it at another backend

Three ways, pick whichever fits the test:

1. **No rebuild, per browser.** Open the page with `?api=` set:
   `http://127.0.0.1:4200/?api=https://obs-api.example.com`
   The value is remembered in `localStorage`, so the next plain load keeps
   using it. `?api=reset` goes back to the built-in default.
2. **Edit `src/app/environments/environment.ts`** (`obsApiUrl`) for dev, or
   `environment.prod.ts` for `npm run build`.
3. **Same-origin proxy, no CORS at all.** Set `obsApiUrl: ''` in
   `environment.ts`, point `proxy.conf.json` at the backend, and run
   `npm run start:proxy`. The dev server then forwards `/api/*` itself.

### CORS

The backend decides who may call it with `OBS_DASHBOARD_ORIGINS` in
`agent-obs/agent/.env`. The default `*` allows everything, which is fine for
local testing. If it is locked down, add this app's origin
(`http://127.0.0.1:4200` when running locally) or use the proxy option above.

## What the page calls

All GET, all JSON, documented in [../INTEGRATION.md](../INTEGRATION.md):

| Endpoint | Used for |
| --- | --- |
| `/api/obs/status` | agent mode, desk summary, rails, wallet link |
| `/api/obs/reads` | token, prices, pool market, wallet balances, site/API up |
| `/api/obs/pnl?hours=` | equity series, positions, realized PnL, in-flight swaps |
| `/api/obs/market?hours=` | $OBS pool price series and 24h change |
| `/api/obs/trades?limit=` | trades ticker |
| `/api/obs/feed?limit=` | X feed grid |
| `/api/obs/stream?limit=` | SSE hello / thought / trade events for the terminal (polls `/thoughts` if SSE fails) |

Plus one external read, CoinGecko `/coins/markets`, for the non-OBS assets in
the Market strip switcher. No keys anywhere.

Every numeric field may be `null` ("not measured this cycle"), never zero,
and the page renders those as dashes. Fields are only ever added by the
backend, so an older page keeps working against a newer API.

## Where things live

```
src/app/pages/agent/agent.component.{ts,html,css}   the page
src/app/pages/agent/curve.ts                        monotone cubic curve used by the chart
src/app/service/obs-desk.service.ts                 typed API client (+ the ?api= override)
src/app/environments/                               API base URL per build
src/assets/                                         icons, marquee coins, background video
proxy.conf.json                                     optional same-origin proxy for `start:proxy`
```

## Checks

```bash
npm run build     # production build
npm test          # curve unit tests, headless Chrome
```

## Keeping it in sync with the main site

This is a copy, not a package. When the Agent page changes on obscuracex.com,
copy `src/app/pages/agent/*` and `src/app/service/obs-desk.service.ts` over
again (the service here carries the extra `resolveObsApiUrl()` helper at the
bottom, keep that). House rule of this repo: no em dashes anywhere, so check
the copied files.
