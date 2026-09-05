#!/bin/bash
# Stage the Agent page: relay this repo's dashboard to the site repo as a pull
# request, then deploy that pull request's branch to obscura.markets so it
# can be looked at before anything reaches obscura.market. Ship it afterwards
# with `scripts/ship-site.sh` (merges the pull request; obscura.market follows
# the site repo's main).
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/agent" && npm run relay --silent 2>&1 | tail -1
bash "$ROOT/scripts/deploy-site.sh" --branch obs-dashboard-relay 2>&1 | grep -vE "^\[" | tail -2
echo "look at https://obscura.markets/agent; when it is right: scripts/ship-site.sh"
