#!/bin/bash
# The relay, run from this machine: put our copy of the Agent page onto the
# site repo's own paths and open (or update) a pull request there. The same
# mapping as .github/workflows/relay-dashboard.yml, for when Actions cannot
# run. Needs gh logged in with write on the site repo. Idempotent: the relay
# branch is rebuilt from the site's base branch every time.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${RELAY_REPO:-JohnDevving/obscura-exchange}"
BASE="${RELAY_BASE:-main}"
APP="${RELAY_PATH:-src/app}"
DOCS="${RELAY_DOCS:-docs/obs}"
SITE_ASSETS="${RELAY_ASSETS:-src/assets}"
BRANCH="obs-dashboard-relay"
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
gh repo clone "$REPO" "$TMP/site" -- --quiet --depth 1 --branch "$BASE"
cd "$TMP/site"
git checkout -q -B "$BRANCH"
# The mapping and every patch live in relay-apply.sh, so the same steps can be applied to any checkout of the site.
RELAY_PATH="$APP" RELAY_DOCS="$DOCS" RELAY_ASSETS="$SITE_ASSETS" bash "$ROOT/scripts/relay-apply.sh" "$TMP/site" "$SHA"
git add -A
if git diff --cached --quiet; then
  echo "nothing to relay: the site already matches $SHA"
  exit 0
fi
git commit -q -m "chore(obs): Agent page relay from ObscuraMarket/agent-obs@$SHA"
git push -q -f origin "$BRANCH"
BODY="Relayed from ObscuraMarket/agent-obs at $SHA.

Files: \`$APP/pages/agent/\`, \`$APP/pages/console/\`, \`$APP/service/obs-desk.service.ts\`, the page's images and video under \`$SITE_ASSETS/\` (added, never removed), \`$DOCS/INTEGRATION.md\` (the API contract), \`$DOCS/reference.html\` (the dependency-free reference page). The console page is registered once in \`$APP/app-routing.module.ts\` (route \`console\`) and \`$APP/app.module.ts\` (its declaration), the way the Agent page is. The header (\`$APP/dapp-layout/header/\`) lists Console, Agent, Docs and Roadmap: Trade, Rewards, Cards, Referral and Yield are console views now (\`/trade\`, \`/rewards\`, \`/cards\`, \`/referral\`, \`/yield\` on the console page) and keep their routes for deep links; the module hands those five components to the console (\`CONSOLE_VIEWS\`), and the header's spec is replaced by one describing this header. Nothing else in your routing, module or environments is touched. Fields in \`/api/obs/*\` are added and never renamed; the few removed are listed in \`$DOCS/INTEGRATION.md\` with their dates."
OPEN="$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json url --jq '.[0].url // ""')"
if [ -n "$OPEN" ]; then
  echo "pull request updated: $OPEN"
else
  gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" --title "OBS Agent page update from ObscuraMarket/agent-obs" --body "$BODY"
fi
