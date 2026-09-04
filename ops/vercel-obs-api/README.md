# obs-api.obscura.markets

The API's public name, hosted on Vercel: a project with no code, only a
rewrite that proxies `/api/obs/*` to wherever the desk's API is reachable
(`vercel.json`, `destination`). Today that is the bridge from the Mac; when
the desk moves to a server, the destination becomes that server and nothing
else changes. `agent/scripts/_obs-vercel-upstream.sh` keeps the destination
current when the bridge hostname changes (launchd, every two minutes).

Deploy by hand: `cd ops/vercel-obs-api && vercel --prod --yes`.
