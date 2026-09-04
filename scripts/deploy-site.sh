#!/bin/bash
# Deploy the site (the fork, JohnDevving/obscura-exchange) to obscura.markets
# from its local clone, with the operator's Vercel login. The Vercel project
# is not connected to the fork's git, so a merge does not deploy by itself:
# after merging a relay pull request, run this.
#   scripts/deploy-site.sh            pull the fork's main, build and deploy to production
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
CLONE="${OBS_SITE_CLONE:-$HOME/dev/obscura-exchange}"
[ -d "$CLONE/.git" ] || { echo "no clone at $CLONE (gh repo clone JohnDevving/obscura-exchange $CLONE)"; exit 1; }
cd "$CLONE" && git pull -q origin main && echo "fork at $(git log --oneline -1)" && vercel --prod --yes 2>&1 | grep -E "Production:|Error|Ready" | head -3
