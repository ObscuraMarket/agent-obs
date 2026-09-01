# Integrating the OBS dashboard into obscura.market

For Obscura's developers. This folder is the whole integration surface: one
read-only JSON API served by the agent, and one dependency-free page that
renders it. Use the page as-is (iframe it, or copy it), or fetch the JSON
into your own Angular components. Nothing here needs our code in your build.

## 1. Run the API

```
cd agent
npm install
cp .env.example .env        # only OBS_DASHBOARD_PORT matters for the dashboard
npm run dashboard           # http://localhost:4671
```

The API reads the agent's local ledgers and a cached set of public chain and
site reads. It holds no key and accepts only GET. Host it anywhere Node 22+
runs (the same box the agent's timers run on is simplest, since the ledgers
live there). Put it behind your domain, for example `obs-api.obscura.market`.

CORS: `OBS_DASHBOARD_ORIGINS=*` by default; set it to
`https://obscura.market,https://obscuracex.com` in production.

## 2. Endpoints

All responses are JSON, `Cache-Control: public, max-age=30`.

### `GET /api/obs/health`
```json
{ "status": "ok", "at": 1788260000000 }
```

### `GET /api/obs/status`
```json
{
  "agent": { "operator": "obs", "voice": "obs-copywriter", "handle": "ObscuraCEX", "mode": "draft" },
  "posts": { "total": 12, "published": 9, "drafts": 3, "lastAt": 1788259000000 },
  "replies": { "total": 4, "published": 4, "lastAt": 1788258000000 },
  "decisions": { "post": 9, "hold": 5 },
  "token": { "contract": "0xfe242d1da8fd04f6a1f80b6d3d807b02e062ad4e", "site": "https://obscura.market" },
  "limits": { "maxTweetChars": 280 },
  "at": 1788260000000
}
```
`mode` is `live` (posting to X), `draft` (writing to the ledger only), or
`unconfigured` (no X keys on the host). Timestamps are Unix milliseconds.

### `GET /api/obs/feed?limit=30`
```json
{
  "items": [
    { "at": 1788259000000, "kind": "post", "text": "...", "posted": true, "mode": "live", "id": "1830...", "url": "https://x.com/ObscuraCEX/status/1830..." },
    { "at": 1788258000000, "kind": "reply", "text": "...", "posted": false, "mode": "draft", "inReplyToId": "1829..." }
  ],
  "at": 1788260000000
}
```
Newest first, `limit` 1..200. Drafts appear with `posted: false` so the
dashboard can show what the agent wrote before the account went live; hide
them in production with a filter on `posted` if you prefer.

### `GET /api/obs/reads`
```json
{
  "at": 1788260000000,
  "token": { "address": "0xfe24...", "name": "Obscura", "symbol": "OBS", "decimals": 18, "totalSupply": "1,000,000,000", "holders": 3261 },
  "prices": { "btcUsd": 108000, "ethUsd": 4300 },
  "siteUp": true,
  "apiUp": true,
  "block": "- The token on Robinhood Chain: Obscura (OBS), total supply 1,000,000,000, 3,261 holders on the explorer. ...\n- BTC 108,000 USD\n- ..."
}
```
Every field is nullable. A value that could not be read this minute is
`null`, never zero, and is absent from `block`. Cached 60 seconds.

## 3. Embed options

**Iframe the page** (fastest):
```html
<iframe src="https://obs-api.obscura.market/" style="width:100%;height:900px;border:0;background:#161816"></iframe>
```

**Host the page yourself and point it at the API**: copy `index.html` into
your static assets and set the API before its script runs, or pass `?api=`:
```html
<script>window.OBS_API = "https://obs-api.obscura.market";</script>
```

**Native Angular components**: fetch the three endpoints with `HttpClient`
and render them in your own design. The page's markup is a reference for
what each field means; its palette (`#161816`, lime `#c6ff00`, Plus Jakarta
Sans) matches the app so it drops in without restyling.

## 4. What never crosses this boundary

- The agent's private notes (his journal). The feed carries only text that
  a public timeline already shows or will show.
- Keys, tokens, wallet addresses of anyone. The only address in any response
  is the $OBS contract.
- Failed writes and diagnostics. A post X rejected is not content.

## 5. Versioning

Fields are only ever added, never renamed or removed, within `/api/obs/*`.
A breaking change gets a new prefix.
