#!/bin/bash
# Ship the staged Agent page: merge the relay pull request on the site repo.
# obscura.markets is put on main by the launchd job within ten minutes (or
# now, with --now); obscura.market follows the site repo's main on its own
# deploy, once the site team's Vercel setting accepts merges from this account.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${RELAY_REPO:-JohnDevving/obscura-exchange}"
PR="$(gh pr list --repo "$REPO" --head obs-dashboard-relay --state open --json number --jq '.[0].number')"
[ -n "$PR" ] || { echo "no open relay pull request on $REPO; stage first (scripts/stage-site.sh)"; exit 1; }
gh pr merge "$PR" --repo "$REPO" --merge --delete-branch=false 2>&1 | tail -1
echo "merged #$PR into $REPO main"
[ "${1:-}" = "--now" ] && bash "$ROOT/scripts/deploy-site.sh" --force 2>&1 | grep -vE "^\[" | tail -1
exit 0
