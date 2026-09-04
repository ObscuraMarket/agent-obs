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
echo "relayed from louz514/agent-obs@$SHA on $(date -u +%FT%TZ)" > "$DOCS/RELAY.txt"
git add -A
if git diff --cached --quiet; then
  echo "nothing to relay: the site already matches $SHA"
  exit 0
fi
git commit -q -m "chore(obs): Agent page relay from louz514/agent-obs@$SHA"
git push -q -f origin "$BRANCH"
BODY="Relayed from louz514/agent-obs at $SHA.

Files: \`$APP/pages/agent/\`, \`$APP/service/obs-desk.service.ts\`, \`$DOCS/INTEGRATION.md\` (the API contract), \`$DOCS/reference.html\` (the dependency-free reference page). Environments, routing and the app module are yours and are not touched. Fields in \`/api/obs/*\` are only ever added, never renamed or removed."
if gh pr view "$BRANCH" --repo "$REPO" --json url >/dev/null 2>&1; then
  echo "pull request updated: $(gh pr view "$BRANCH" --repo "$REPO" --json url --jq .url)"
else
  gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" --title "OBS Agent page update from louz514/agent-obs" --body "$BODY"
fi
