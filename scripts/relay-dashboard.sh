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
mkdir -p "$APP/pages/agent" "$APP/service" "$DOCS"
rsync -a --delete "$ROOT/dashboard/angular/src/app/pages/agent/" "$APP/pages/agent/"
cp "$ROOT/dashboard/angular/src/app/service/obs-desk.service.ts" "$APP/service/obs-desk.service.ts"
cp "$ROOT/dashboard/INTEGRATION.md" "$DOCS/INTEGRATION.md"
cp "$ROOT/dashboard/index.html" "$DOCS/reference.html"
# The assets the Agent page references, added beside the site's own (never deleted).
ASSETS="$ROOT/dashboard/angular/src/assets"
mkdir -p "$SITE_ASSETS/images/tokenized-stocks" "$SITE_ASSETS/video"
for f in bnb-icon.png btc-icon.png sol-icon.png obs-icon.png agent-obs.png usdg.png maskspin-poster.jpg; do cp "$ASSETS/images/$f" "$SITE_ASSETS/images/$f"; done
rsync -a "$ASSETS/images/tokenized-stocks/" "$SITE_ASSETS/images/tokenized-stocks/"
cp "$ASSETS/video/maskspin.mp4" "$SITE_ASSETS/video/maskspin.mp4"
echo "relayed from ObscuraMarket/agent-obs@$SHA on $(date -u +%FT%TZ)" > "$DOCS/RELAY.txt"
git add -A
if git diff --cached --quiet; then
  echo "nothing to relay: the site already matches $SHA"
  exit 0
fi
git commit -q -m "chore(obs): Agent page relay from ObscuraMarket/agent-obs@$SHA"
git push -q -f origin "$BRANCH"
BODY="Relayed from ObscuraMarket/agent-obs at $SHA.

Files: \`$APP/pages/agent/\`, \`$APP/service/obs-desk.service.ts\`, the page's images and video under \`$SITE_ASSETS/\` (added, never removed), \`$DOCS/INTEGRATION.md\` (the API contract), \`$DOCS/reference.html\` (the dependency-free reference page). Environments, routing and the app module are yours and are not touched. Fields in \`/api/obs/*\` are only ever added, never renamed or removed."
OPEN="$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json url --jq '.[0].url // ""')"
if [ -n "$OPEN" ]; then
  echo "pull request updated: $OPEN"
else
  gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" --title "OBS Agent page update from ObscuraMarket/agent-obs" --body "$BODY"
fi
