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
# Changed since the last deploy. A git error (a stamp that names a commit this checkout no longer has) reads as
# changed, never as unchanged: silenced errors once made a real change look like nothing to deploy (2026-09-08).
changed() {
  [ -z "$LAST" ] && return 0
  git -C "$ROOT" rev-parse -q --verify "$LAST^{commit}" >/dev/null 2>&1 || return 0
  local d; d="$(git -C "$ROOT" diff --name-only "$LAST" "$HEAD" -- "$1" 2>/dev/null)" || return 0
  [ -n "$d" ]
}
# A head that failed to deploy is not retried every ten minutes by the timer; --force retries it.
[ "$1" = "--force" ] || { [ -f "$STAMP.failed" ] && [ "$(cat "$STAMP.failed")" = "$HEAD" ] && { echo "main ${HEAD:0:7} failed to deploy last time; run with --force to retry"; exit 1; }; }
cd "$ROOT/ops/railway" || exit 1
echo "=== main ${HEAD:0:7}, $(date) ==="
ok=1
# Success is railway's own exit code, never grep's: a deploy that printed "Error" matched the grep and advanced the
# stamp, so the job then reported "unchanged" while the old image kept running (2026-09-08).
up() {
  local out rc; out="$(railway up -s "$1" --path-as-root "$2" --ci 2>&1)"; rc=$?
  if [ "$rc" = 0 ] && grep -q "Deploy complete" <<<"$out"; then echo "$1: Deploy complete"; return 0; fi
  echo "$1: railway exited $rc"; tail -n 8 <<<"$out"; return 1
}
if changed agent; then echo "desk: deploying"; up desk ../../agent || ok=0; else echo "desk: unchanged"; fi
if changed ops/railway-gateway; then echo "gateway: deploying"; up gateway ../railway-gateway || ok=0; else echo "gateway: unchanged"; fi
if [ "$ok" = 1 ]; then echo "$HEAD" > "$STAMP"; rm -f "$STAMP.failed"; else echo "$HEAD" > "$STAMP.failed"; echo "deploy failed; the stamp was not advanced"; exit 1; fi
