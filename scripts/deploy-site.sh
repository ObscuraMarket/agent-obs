#!/bin/bash
# Keep obscura.markets on the fork's main. Vercel cannot connect to the
# fork's git (the Vercel GitHub app is not installed on that account), so
# this pulls the fork's main and deploys it to production from the clone,
# with the operator's Vercel login, only when main has moved since the last
# deploy. Run by hand after a merge, or by launchd every 10 minutes
# (com.obscura.obssite). Quiet when nothing changed.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
CLONE="${OBS_SITE_CLONE:-$HOME/dev/obscura-exchange}"
STAMP="$HOME/.obs-site-deployed"
[ -d "$CLONE/.git" ] || { echo "no clone at $CLONE (gh repo clone JohnDevving/obscura-exchange $CLONE)"; exit 1; }
cd "$CLONE" || exit 1
git fetch -q origin main || { echo "fetch failed"; exit 1; }
HEAD="$(git rev-parse origin/main)"
[ "$1" = "--force" ] || { [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$HEAD" ] && exit 0; }
git checkout -q main && git reset -q --hard origin/main
echo "=== deploying fork main ${HEAD:0:7} to obscura.markets, $(date) ==="
if vercel --prod --yes 2>&1 | grep -E "Production:|Error" | head -3; then
  echo "$HEAD" > "$STAMP"
fi
