#!/bin/bash
# Keep the desk on Railway on this repo's main. Railway cannot pull the repo
# without its GitHub app, so this deploys from the local checkout with the
# operator's Railway login, only when main moved since the last deploy:
# agent/ changes redeploy the desk, ops/railway-gateway changes redeploy the
# gateway. Run by hand after a push, or by launchd every 10 minutes
# (com.obscura.obsdeploy). Quiet when nothing changed.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$HOME/.obs-desk-deployed"
cd "$ROOT" || exit 1
git fetch -q origin main || { echo "fetch failed"; exit 1; }
HEAD="$(git rev-parse origin/main)"
LAST="$(cat "$STAMP" 2>/dev/null)"
[ "$1" = "--force" ] || { [ "$LAST" = "$HEAD" ] && exit 0; }
[ "$(git rev-parse HEAD)" = "$HEAD" ] || git pull -q --ff-only origin main || { echo "local main is not on origin/main; not deploying"; exit 1; }
# The diff runs against the repo root whatever the working directory is: from ops/railway a bare "agent" pathspec
# matched nothing, so until 2026-09-05 every run reported "unchanged" and nothing this script ran ever deployed.
changed() { [ -z "$LAST" ] || [ -n "$(git -C "$ROOT" diff --name-only "$LAST" "$HEAD" -- "$1" 2>/dev/null)" ]; }
cd "$ROOT/ops/railway" || exit 1
echo "=== main ${HEAD:0:7}, $(date) ==="
ok=1
if changed agent; then echo "desk: deploying"; railway up -s desk --path-as-root ../../agent --ci 2>&1 | grep -E "Deploy complete|Error|error" | head -2 || ok=0; else echo "desk: unchanged"; fi
if changed ops/railway-gateway; then echo "gateway: deploying"; railway up -s gateway --path-as-root ../railway-gateway --ci 2>&1 | grep -E "Deploy complete|Error|error" | head -2 || ok=0; else echo "gateway: unchanged"; fi
[ "$ok" = 1 ] && echo "$HEAD" > "$STAMP"
