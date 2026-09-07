#!/bin/bash
# The relay's mapping, applied to one checkout of the site: our Agent and console pages onto the site's own paths,
# the console route and declaration registered once, the site's header rewired so Trade, Rewards, Cards, Referral
# and Yield are console views, the five components handed to the console, the docs and the assets. Called by
# relay-dashboard.sh on a fresh clone, and runnable on any checkout to look at the result or build it:
#   scripts/relay-apply.sh <site checkout> [source sha]
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE="${1:?usage: relay-apply.sh <site checkout> [sha]}"
SHA="${2:-$(git -C "$ROOT" rev-parse --short HEAD)}"
APP="${RELAY_PATH:-src/app}"
DOCS="${RELAY_DOCS:-docs/obs}"
SITE_ASSETS="${RELAY_ASSETS:-src/assets}"
cd "$SITE"
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
# The console opens the site's own pages beside itself (/trade, /rewards, /cards, /referral, /yield): the module
# hands those five components to the console under CONSOLE_VIEWS. Added once, only when absent.
if ! grep -q "CONSOLE_VIEWS" "$MODULE"; then
  python3 - "$MODULE" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("import { ConsoleComponent } from './pages/console/console.component';", "import { ConsoleComponent } from './pages/console/console.component';\nimport { CONSOLE_VIEWS } from './service/obs-desk.service';", 1)
s = s.replace("  providers: [", "  providers: [\n    // The pages the console opens beside itself, by command: /trade, /rewards, /cards, /referral, /yield.\n    { provide: CONSOLE_VIEWS, useValue: { trade: SwapComponent, rewards: RewardsComponent, cards: CardsComponent, referral: ReferralComponent, yield: YieldComponent } },\n    ", 1)
open(p, "w").write(s)
PY
fi
# The header: Trade, Rewards, Cards, Referral and Yield are console views now, so it lists Console, Agent, Docs and
# Roadmap; the five pages keep their routes for deep links. Applied while the old links are there; the header's
# active-link map learns the console route; its spec is replaced by one that describes the header this makes.
HEADER="$APP/dapp-layout/header/header.component.html"
HEADER_TS="$APP/dapp-layout/header/header.component.ts"
HEADER_SPEC="$APP/dapp-layout/header/header.component.spec.ts"
if [ -f "$HEADER" ] && grep -q 'routerLink="/rewards"' "$HEADER"; then
  python3 - "$HEADER" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p).read()
for path in ["app", "rewards", "cards", "referral", "yield"]:
    s = re.sub(r'\n[ \t]*<li><a routerLink="/%s"[^>]*>.*?</a></li>' % path, "", s, count=1, flags=re.S)
    s = re.sub(r'\n[ \t]*<a routerLink="/%s"[^>]*>.*?</a>' % path, "", s, count=1, flags=re.S)
s = s.replace("\n      <!-- Referral routes to the live waitlist page. -->", "", 1)
s = s.replace('      <a routerLink="/agent" class="nav-link"', '      <a routerLink="/console" class="nav-link" data-testid="nav-console" [class.active]="activeLink === \'console\'" (click)="setActiveLink(\'console\')">Console</a>\n      <a routerLink="/agent" class="nav-link"', 1)
s = s.replace('          <li><a routerLink="/agent" class="nav-menu-link"', '          <li><a routerLink="/console" class="nav-menu-link" data-testid="mobile-console" (click)="setActiveLink(\'console\'); toggleMenu()">Console</a></li>\n          <li><a routerLink="/agent" class="nav-menu-link"', 1)
open(p, "w").write(s)
PY
fi
if [ -f "$HEADER_TS" ] && ! grep -q "'/console'" "$HEADER_TS"; then
  python3 - "$HEADER_TS" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("    if (url.startsWith('/cards')) {\n      this.activeLink = 'cards';", "    if (url.startsWith('/console')) {\n      this.activeLink = 'console';\n    } else if (url.startsWith('/cards')) {\n      this.activeLink = 'cards';", 1)
open(p, "w").write(s)
PY
fi
if [ -f "$HEADER_SPEC" ] && grep -q 'nav-rewards' "$HEADER_SPEC"; then
  cp "$ROOT/dashboard/relay/header.component.spec.ts" "$HEADER_SPEC"
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
