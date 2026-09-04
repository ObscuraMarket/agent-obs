#!/bin/bash
# Keep obs-api.obscura.markets pointed at the desk. The Vercel project in
# ops/vercel-obs-api proxies /api/obs/* to a destination; when the bridge
# hostname changes (a quick tunnel gets a new name on restart) this rewrites
# vercel.json and redeploys. Quiet when nothing changed. launchd, every 2 min.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
set -a; [ -f .env ] && source .env; set +a
PROJ="$PWD/../ops/vercel-obs-api"
UP="${OBS_API_UPSTREAM:-$(npm run -s bridge:url 2>/dev/null | head -1 | awk '{print $1}')}"
[ -n "$UP" ] || { echo "no upstream (bridge not answering); leaving the proxy as is"; exit 0; }
CUR="$(python3 -c "import json;print(json.load(open('$PROJ/vercel.json'))['rewrites'][0]['destination'].split('/api/obs')[0])" 2>/dev/null)"
[ "$CUR" = "$UP" ] && exit 0
echo "=== upstream changed $(date): $CUR -> $UP ==="
python3 - "$UP" "$PROJ/vercel.json" <<'PY'
import json,sys
up=sys.argv[1].rstrip("/"); p=sys.argv[2]; cfg=json.load(open(p))
cfg["rewrites"]=[{"source":"/api/obs/:path*","destination":f"{up}/api/obs/:path*"}]
json.dump(cfg,open(p,"w"),indent=2)
PY
cd "$PROJ" && vercel --prod --yes 2>&1 | grep -E "Production:|Error" | head -2
