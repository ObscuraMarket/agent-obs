#!/bin/bash
# The relay's mapping, applied to one checkout of the site: our Agent and console pages onto the site's own paths,
# the console route and declaration registered once, the site's header given the console, the five components
# handed to the console, the docs and the assets. Called by relay-dashboard.sh on a fresh clone, and runnable on
# any checkout to look at the result or build it:
#   scripts/relay-apply.sh <site checkout> [source sha]
# The header becomes Console, Trade, Agent, Docs, Roadmap: Rewards, Cards and Yield live in the console (their
# routes stay for deep links), Referral is gone, and Console follows the connected wallet, a live link when the
# desk's door lets that wallet in and the site's own greyed Soon item otherwise.
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
# The console opens the site's own pages beside itself (/trade, /rewards, /cards, /yield): the module
# hands those five components to the console under CONSOLE_VIEWS. Added once, only when absent.
if ! grep -q "CONSOLE_VIEWS" "$MODULE"; then
  python3 - "$MODULE" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("import { ConsoleComponent } from './pages/console/console.component';", "import { ConsoleComponent } from './pages/console/console.component';\nimport { CONSOLE_VIEWS } from './service/obs-desk.service';", 1)
s = s.replace("  providers: [", "  providers: [\n    // The pages the console opens beside itself, by command: /trade, /rewards, /cards, /yield.\n    { provide: CONSOLE_VIEWS, useValue: { trade: SwapComponent, rewards: RewardsComponent, cards: CardsComponent, yield: YieldComponent } },\n    ", 1)
open(p, "w").write(s)
PY
fi
# The console signs in with the wallet the site's own picker connected: the module hands its WalletService to the
# console under CONSOLE_WALLET. Added once, only when absent.
if ! grep -q "CONSOLE_WALLET" "$MODULE"; then
  python3 - "$MODULE" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("import { CONSOLE_VIEWS } from './service/obs-desk.service';", "import { CONSOLE_VIEWS, CONSOLE_WALLET } from './service/obs-desk.service';", 1)
if "from './service/wallet.service'" not in s:
    s = s.replace("import { CONSOLE_VIEWS, CONSOLE_WALLET } from './service/obs-desk.service';", "import { CONSOLE_VIEWS, CONSOLE_WALLET } from './service/obs-desk.service';\nimport { WalletService } from './service/wallet.service';", 1)
s = s.replace("    { provide: CONSOLE_VIEWS, useValue:", "    // The wallet the header connected is the wallet the console signs in with.\n    { provide: CONSOLE_WALLET, useExisting: WalletService },\n    { provide: CONSOLE_VIEWS, useValue:", 1)
open(p, "w").write(s)
PY
fi
# The header: Trade, Rewards, Cards and Yield are console views now, so it lists Console, Agent, Docs and
# Roadmap; the five pages keep their routes for deep links. Applied while the old links are there; the header's
# active-link map learns the console route; its spec is replaced by one that describes the header this makes.
# The referral section is gone: its page, its route and its declaration leave the site. The ReferralService that
# records a ?ref= visitor for the swap's attribution is not the section and stays. Applied while the page exists.
if [ -d "$APP/pages/referral" ]; then
  rm -rf "$APP/pages/referral"
  python3 - "$ROUTING" "$MODULE" "$APP/app-routing.module.spec.ts" <<'PY'
import sys, os, re
routing, module, spec = sys.argv[1:4]
s = open(routing).read()
s = s.replace("import { ReferralComponent } from './pages/referral/referral.component';\n", "", 1)
s = re.sub(r"const referralMeta = \{.*?\};\n\n", "", s, count=1, flags=re.S)
s = s.replace("      // Live referral dashboard.\n", "", 1)
s = re.sub(r"\n[ \t]*\{ path: 'referral', component: ReferralComponent[^\n]*\},", "", s, count=1)
open(routing, "w").write(s)
m = open(module).read()
m = m.replace("import { ReferralComponent } from './pages/referral/referral.component';\n", "", 1)
m = m.replace("    ReferralComponent,\n", "", 1)
open(module, "w").write(m)
if os.path.exists(spec):
    t = open(spec).read()
    t = t.replace("      'referral', 'rewards', 'reward-page-soon', 'agent'\n", "      'rewards', 'reward-page-soon', 'agent', 'console'\n", 1)
    open(spec, "w").write(t)
# The RWA page's spec borrowed the waitlist key from the referral page; it keeps the value on its own.
rwa = os.path.join(os.path.dirname(routing), "pages", "rwa", "rwa.component.spec.ts")
if os.path.exists(rwa):
    t = open(rwa).read()
    t = t.replace("import { REFERRAL_WAITLIST_KEY } from '../referral/referral.component';", "const REFERRAL_WAITLIST_KEY = 'obscura_referral_waitlist';", 1)
    open(rwa, "w").write(t)
# The docs still describe the referral boost; the words stay, the link to a page that no longer exists goes.
docs = os.path.join(os.path.dirname(routing), "pages", "docs", "docs.component.html")
if os.path.exists(docs):
    t = open(docs).read()
    t = t.replace('<a routerLink="/referral">referral link</a>', "referral link", 1)
    open(docs, "w").write(t)
# The roadmap's button to the referral waitlist goes with the page.
road = os.path.join(os.path.dirname(routing), "pages", "roadmap", "roadmap.component.html")
if os.path.exists(road):
    t = open(road).read()
    t = re.sub(r'\n[ \t]*<a class="outro-button" routerLink="/referral">[^<]*</a>', "", t, count=1)
    open(road, "w").write(t)
PY
fi
HEADER="$APP/dapp-layout/header/header.component.html"
HEADER_TS="$APP/dapp-layout/header/header.component.ts"
HEADER_SPEC="$APP/dapp-layout/header/header.component.spec.ts"
if [ -f "$HEADER" ] && { grep -q 'routerLink="/rewards"' "$HEADER" || ! grep -q 'consoleOpen; else consoleSoon' "$HEADER"; }; then
  python3 - "$HEADER" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p).read()
# Rewards, Cards and Yield are console views and Referral is gone: their links leave the header (desktop and the
# mobile menu); Trade, Agent, Docs and Roadmap stay. Each removal is one match, so a header already folded is left as it is.
for path in ["rewards", "cards", "referral", "yield"]:
    s = re.sub(r'\n[ \t]*<li><a routerLink="/%s"[^>]*>.*?</a></li>' % path, "", s, count=1, flags=re.S)
    s = re.sub(r'\n[ \t]*<a routerLink="/%s"[^>]*>.*?</a>' % path, "", s, count=1, flags=re.S)
s = s.replace("\n      <!-- Referral routes to the live waitlist page. -->", "", 1)
# Console first. It follows the connected wallet: a live link when the desk's door lets that wallet in (the header's
# consoleOpen, from /api/obs/console/door), and otherwise the site's own Soon treatment, dimmed and taking no click.
# Idempotent: every Console item already there (a relay before this one, in either shape, or two of them) is
# stripped first, so the header carries exactly one whatever main holds when the relay runs.
s = re.sub(r'\n[ \t]*<ng-template #mobileConsoleSoon>.*?</ng-template>', "", s, flags=re.S)
s = re.sub(r'\n[ \t]*<ng-template #consoleSoon>.*?</ng-template>', "", s, flags=re.S)
s = re.sub(r'\n[ \t]*<li \*ngIf="consoleOpen; else mobileConsoleSoon">.*?</li>', "", s, flags=re.S)
s = re.sub(r'\n[ \t]*<li><a [^>]*data-testid="mobile-console"[^>]*>.*?</a></li>', "", s, flags=re.S)
s = re.sub(r'\n[ \t]*<a [^>]*data-testid="nav-console"[^>]*>.*?</a>', "", s, flags=re.S)
desktop = ('      <a *ngIf="consoleOpen; else consoleSoon" routerLink="/console" class="nav-link" data-testid="nav-console" [class.active]="activeLink === \'console\'" (click)="setActiveLink(\'console\')">Console</a>\n'
           '      <ng-template #consoleSoon><a class="nav-link coming-soon" data-testid="nav-console" aria-disabled="true" title="The OBS console is open to invited wallets; connect one to use it">\n'
           '        <span class="soon-tag">Soon</span>\n        Console\n      </a></ng-template>\n')
mobile = ('          <li *ngIf="consoleOpen; else mobileConsoleSoon"><a routerLink="/console" class="nav-menu-link" data-testid="mobile-console" (click)="setActiveLink(\'console\'); toggleMenu()">Console</a></li>\n'
          '          <ng-template #mobileConsoleSoon><li><a class="nav-menu-link coming-soon-mobile" data-testid="mobile-console" aria-disabled="true">\n'
          '            <span class="soon-tag-mobile">Soon</span>\n            Console\n          </a></li></ng-template>\n')
s = s.replace('      <a routerLink="/app" class="nav-link"', desktop + '      <a routerLink="/app" class="nav-link"', 1)
s = s.replace('          <li><a routerLink="/app" class="nav-menu-link"', mobile + '          <li><a routerLink="/app" class="nav-menu-link"', 1)
open(p, "w").write(s)
PY
fi
# The wallet picker sees every wallet in the browser, not only the ones that announce themselves: Phantom keeps its
# Ethereum provider at window.phantom.ethereum and does not always announce it, and a browser with several wallets
# lists them under window.ethereum.providers. Applied once, keyed on the Phantom flag it introduces.
WALLET_TS="$APP/service/wallet.service.ts"
if [ -f "$WALLET_TS" ] && ! grep -q "isPhantom" "$WALLET_TS"; then
  python3 - "$WALLET_TS" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = """  list(): WalletOption[] {
    if (this.discovered.length) return [...this.discovered];
    const eth = (window as any).ethereum;
    if (!eth) return [];
    const name = eth.isMetaMask ? 'MetaMask' : eth.isCoinbaseWallet ? 'Coinbase Wallet' : eth.isRabby ? 'Rabby' : 'Browser Wallet';
    return [{ uuid: 'injected', name, icon: '', rdns: 'injected', provider: eth }];
  }"""
new = """  list(): WalletOption[] {
    // Announced wallets first, then every injected provider the page can see that did not announce itself:
    // Phantom's Ethereum provider (window.phantom.ethereum), the providers a multi-wallet browser lists under
    // window.ethereum.providers, and window.ethereum itself. Each provider appears once.
    const out: WalletOption[] = [...this.discovered];
    const seen = new Set<any>(out.map((w) => w.provider));
    const w = window as any;
    const nameOf = (eth: any): string => eth?.isPhantom ? 'Phantom' : eth?.isMetaMask ? 'MetaMask' : eth?.isCoinbaseWallet ? 'Coinbase Wallet' : eth?.isRabby ? 'Rabby' : eth?.isTrust ? 'Trust Wallet' : eth?.isBraveWallet ? 'Brave Wallet' : 'Browser Wallet';
    const add = (eth: any, rdns: string) => {
      if (!eth || typeof eth.request !== 'function' || seen.has(eth)) return;
      if (out.some((x) => x.rdns === rdns && rdns !== 'injected')) return;
      seen.add(eth);
      out.push({ uuid: `${rdns}-${out.length}`, name: nameOf(eth), icon: '', rdns, provider: eth });
    };
    add(w.phantom?.ethereum, 'app.phantom');
    for (const eth of Array.isArray(w.ethereum?.providers) ? w.ethereum.providers : []) add(eth, eth?.isPhantom ? 'app.phantom' : 'injected');
    add(w.ethereum, w.ethereum?.isPhantom ? 'app.phantom' : 'injected');
    return out;
  }"""
if old not in s: raise SystemExit("wallet.service.ts list() is not the shape this patch knows")
s = s.replace(old, new, 1)
open(p, "w").write(s)
PY
fi
# The header asks the desk's door about the connected wallet, once per connection, and lights the link on yes.
if [ -f "$HEADER_TS" ] && ! grep -q "consoleOpen" "$HEADER_TS"; then
  python3 - "$HEADER_TS" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("import { LanguageService } from 'src/app/service/language.service';", "import { LanguageService } from 'src/app/service/language.service';\nimport { WalletService } from 'src/app/service/wallet.service';\nimport { ObsDeskService } from 'src/app/service/obs-desk.service';\nimport { Subscription } from 'rxjs';", 1)
s = s.replace("  activeLink = 'trade';", "  activeLink = 'trade';\n  /** The OBS console is for invited wallets: the link goes live when the connected wallet is one, greyed otherwise. */\n  consoleOpen = false;\n  private consoleSub?: Subscription;", 1)
s = s.replace("    private router: Router\n  ) {", "    private router: Router,\n    private wallet: WalletService,\n    private obs: ObsDeskService\n  ) {", 1)
s = s.replace("    this.syncActiveLink(this.router.url);\n", "    this.syncActiveLink(this.router.url);\n    // The console link follows the connected wallet: live when the desk's door lets it in, greyed otherwise.\n    this.consoleSub = this.wallet.address$.subscribe((address) => {\n      if (!address) { this.consoleOpen = false; this.cdRef.markForCheck(); return; }\n      this.obs.door(address).subscribe({ next: (d) => { this.consoleOpen = !!d?.open; this.cdRef.markForCheck(); }, error: () => { this.consoleOpen = false; this.cdRef.markForCheck(); } });\n    });\n", 1)
s = s.replace("['trade', 'rewards', 'referral', 'cards', 'yield', 'agent', 'docs', 'roadmap']", "['trade', 'rewards', 'referral', 'cards', 'yield', 'agent', 'docs', 'roadmap', 'console']", 1)
s = s.replace("  setActiveLink(link: string) {", "  ngOnDestroy(): void {\n    this.consoleSub?.unsubscribe();\n  }\n\n  setActiveLink(link: string) {", 1)
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
# The header's spec describes the header the relay makes; ours replaces the site's whenever they differ.
if [ -f "$HEADER_SPEC" ] && ! cmp -s "$ROOT/dashboard/relay/header.component.spec.ts" "$HEADER_SPEC"; then
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
