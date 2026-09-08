#!/bin/bash
# Keep obscura.markets on the site repo. Vercel cannot connect to the site
# repo's git (the Vercel GitHub app is not installed on that account), so
# this pulls a branch of the site repo and deploys it to production on our
# Vercel project (obscura.markets), with the operator's Vercel login.
#
#   scripts/deploy-site.sh                       main, only when it moved since the last deploy (the launchd job, every 10 min)
#   scripts/deploy-site.sh --force               main, now
#   scripts/deploy-site.sh --branch obs-dashboard-relay
#       the relay branch (an open pull request on the site repo) to obscura.markets, to look at
#       before it is merged. obscura.market follows the site repo's main only, so nothing reaches it
#       until the pull request is merged. The next time main moves, the job puts main back.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
CLONE="${OBS_SITE_CLONE:-$HOME/dev/obscura-exchange}"
STAMP="$HOME/.obs-site-deployed"
BRANCH="main"
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2;;
    --force) FORCE=1; shift;;
    *) echo "usage: $0 [--force] [--branch <name>]"; exit 1;;
  esac
done
[ -d "$CLONE/.git" ] || { echo "no clone at $CLONE (gh repo clone JohnDevving/obscura-exchange $CLONE)"; exit 1; }
cd "$CLONE" || exit 1
git fetch -q origin "$BRANCH" || { echo "fetch of $BRANCH failed"; exit 1; }
HEAD="$(git rev-parse "origin/$BRANCH")"
if [ "$BRANCH" = "main" ] && [ "$FORCE" = 0 ]; then
  [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$HEAD" ] && exit 0
fi
git checkout -q -B "$BRANCH" "origin/$BRANCH" && git reset -q --hard "origin/$BRANCH"
echo "=== deploying site $BRANCH ${HEAD:0:7} to obscura.markets, $(date) ==="
# Success is vercel's own exit code plus a Production line, never grep's: a piped grep advanced the stamp on every
# outcome, so a failed site deploy read as "unchanged" until main moved again (2026-09-08).
out="$(vercel --prod --yes 2>&1)"; rc=$?
grep -E "Production:|Error" <<<"$out" | head -3
if [ "$rc" = 0 ] && grep -q "Production:" <<<"$out"; then
  if [ "$BRANCH" = "main" ]; then echo "$HEAD" > "$STAMP"; else echo "staged: $BRANCH is on obscura.markets until main moves; merge its pull request to ship it to obscura.market"; fi
else
  echo "site deploy failed (vercel exited $rc); the stamp was not advanced"; tail -n 6 <<<"$out"; exit 1
fi
