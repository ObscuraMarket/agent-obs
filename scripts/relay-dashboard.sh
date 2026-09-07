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
mkdir -p "$APP/pages/agent" "$APP/pages/console" "$APP/service" "$DOCS"
rsync -a --delete "$ROOT/dashboard/angular/src/app/pages/agent/" "$APP/pages/agent/"
rsync -a --delete "$ROOT/dashboard/angular/src/app/pages/console/" "$APP/pages/console/"
# The console page needs one route and one declaration in the site's own files. Added once, only when absent, exactly
# the way the Agent page is registered; a site that already has them is left alone.
ROUTING="$APP/app-routing.module.ts"
MODULE="$APP/app.module.ts"
if ! grep -q "ConsoleComponent" "$ROUTING"; then
  python3 - "$ROUTING" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p).read()
s = s.replace("import { AgentComponent } from './pages/agent/agent.component';", "import { AgentComponent } from './pages/agent/agent.component';\nimport { ConsoleComponent } from './pages/console/console.component';", 1)
s = s.replace("const agentMeta = {", "const consoleMeta = {\n  title: 'Obscura - OBS Console',\n  override: true,\n  description: 'The OBS console: read the desk, quote and swap from your own wallet, and unlock your own agent.'\n};\n\nconst agentMeta = {", 1)
s = re.sub(r"(\{ path: 'agent', component: AgentComponent, data: \{ meta: agentMeta \} \})", r"\1,\n      // The OBS console, the same page's command line.\n      { path: 'console', component: ConsoleComponent, data: { meta: consoleMeta } }", s, count=1)
open(p, "w").write(s)
PY
fi
if ! grep -q "ConsoleComponent" "$MODULE"; then
  python3 - "$MODULE" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("import { AgentComponent } from './pages/agent/agent.component';", "import { AgentComponent } from './pages/agent/agent.component';\nimport { ConsoleComponent } from './pages/console/console.component';", 1)
s = s.replace("    AgentComponent,\n", "    AgentComponent,\n    ConsoleComponent,\n", 1)
open(p, "w").write(s)
PY
fi
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

Files: \`$APP/pages/agent/\`, \`$APP/pages/console/\`, \`$APP/service/obs-desk.service.ts\`, the page's images and video under \`$SITE_ASSETS/\` (added, never removed), \`$DOCS/INTEGRATION.md\` (the API contract), \`$DOCS/reference.html\` (the dependency-free reference page). The console page is registered once in \`$APP/app-routing.module.ts\` (route \`console\`) and \`$APP/app.module.ts\` (its declaration), the way the Agent page is; nothing else in your routing, module or environments is touched. Fields in \`/api/obs/*\` are added and never renamed; the few removed are listed in \`$DOCS/INTEGRATION.md\` with their dates."
OPEN="$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json url --jq '.[0].url // ""')"
if [ -n "$OPEN" ]; then
  echo "pull request updated: $OPEN"
else
  gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" --title "OBS Agent page update from ObscuraMarket/agent-obs" --body "$BODY"
fi
