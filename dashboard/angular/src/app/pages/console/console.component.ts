import { AfterViewInit, Component, ElementRef, Inject, NgZone, OnDestroy, Type, ViewChild, ViewContainerRef } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ObsDeskService, ObsConsoleQuote, ObsStanding, ObsCliReply, ObsSession, ObsUserSettings, ObsPayment, ObsCredits, CONSOLE_VIEWS, CONSOLE_WALLET, ConsoleWallet } from '../../service/obs-desk.service';

type LineKind = 'input' | 'command' | 'output' | 'error' | 'agent' | 'system';
interface Approval { toolCallId: string; tool: string; args?: unknown; decision: 'pending' | 'allowed' | 'denied'; }
interface CliLine { kind: LineKind; text: string; streaming?: boolean; suggest?: string[]; links?: Array<{ label: string; url: string }>; approval?: Approval; }
interface Group { kind: LineKind; lines: CliLine[]; }
type Status = 'guest' | 'connected' | 'signing' | 'signed-in';
type AgentState = 'idle' | 'provisioning' | 'ready' | 'thinking' | 'error';

/** Every command the page knows, in plain words, for the menu that opens on "/": kept in step with the desk's router. */
interface CommandHelp { cmd: string; what: string; usage?: string; args?: boolean; }
const COMMAND_HELP: CommandHelp[] = [
  { cmd: 'status', what: 'Your own agent\'s status once you\'re signed in; the desk\'s until then' },
  { cmd: 'desk', what: 'What Agent OBS, the house desk, is doing right now' },
  { cmd: 'agents', what: 'Every agent following the desk: who is on, what they hold, what they made' },
  { cmd: 'trade', what: 'Open Trade beside the console' },
  { cmd: 'rewards', what: 'Open Rewards: your cashback in tokenized stocks' },
  { cmd: 'cards', what: 'Open Cards' },
  { cmd: 'yield', what: 'Open Yield (coming soon)' },
  { cmd: 'connect', what: 'Connect your wallet and get your own agent' },
  { cmd: 'start', what: 'Turn your trading agent on: it follows Agent OBS\'s trades at your size, paper for now', usage: '/start 100' },
  { cmd: 'stop', what: 'Turn your trading agent off' },
  { cmd: 'size', what: 'What your agent puts into each entry', usage: '/size 150', args: true },
  { cmd: 'agent', what: 'Your trading agent\'s book: on or off, what it holds, what it made' },
  { cmd: 'wallet', what: 'Your agent\'s own wallet: where it is and what it holds' },
  { cmd: 'fund', what: 'Put ETH into your agent\'s wallet from yours; you sign it', usage: '/fund 0.05 ETH', args: true },
  { cmd: 'withdraw', what: 'Send ETH from your agent\'s wallet back to yours', usage: '/withdraw all', args: true },
  { cmd: 'apps', what: 'Connect Slack, Linear, X, Gmail, Google Docs and more to your agent', usage: '/apps connect Slack' },
  { cmd: 'model', what: 'Pick the model your agent runs on, any of them', usage: '/model claude' },
  { cmd: 'models', what: 'Find a model by name', usage: '/models gemini', args: true },
  { cmd: 'credits', what: 'Your credits, and how to add some', usage: '/credits buy 10 USDG' },
  { cmd: 'buy', what: 'Add credits with ETH, USDG, AOBS or a tokenized stock', usage: '/buy 10 USDG', args: true },
  { cmd: 'help', what: 'Every command, explained' },
  { cmd: 'explore', what: 'A short tour, one step at a time' },
  { cmd: 'positions', what: 'What the desk holds' },
  { cmd: 'thoughts', what: 'The desk\'s latest thinking', usage: '/thoughts 3', args: true },
  { cmd: 'research', what: 'What the desk read between cycles', usage: '/research 5', args: true },
  { cmd: 'watch', what: 'The live watch: what it follows right now' },
  { cmd: 'reads', what: 'Prices and the token' },
  { cmd: 'quote', what: 'What the pools pay for a swap', usage: '/quote 0.05 ETH USDG', args: true },
  { cmd: 'swap', what: 'Swap from your own wallet', usage: '/swap 0.05 ETH USDG', args: true },
  { cmd: 'balance', what: 'The ETH in your wallet' },
  { cmd: 'swaps', what: 'Your swaps through the console' },
  { cmd: 'whoami', what: 'How your agent is set up' },
  { cmd: 'name', what: 'Give your agent a name', usage: '/name Ledger', args: true },
  { cmd: 'style', what: 'How much it says: concise, balanced or deep', usage: '/style concise', args: true },
  { cmd: 'voice', what: 'How it should sound', usage: '/voice dry and skeptical', args: true },
  { cmd: 'goal', what: 'What you want from your agent', usage: '/goal help me learn the desk', args: true },
  { cmd: 'reset', what: 'Put a setting back to the default; /reset chat gives your agent a fresh memory', usage: '/reset chat', args: true },
  { cmd: 'close', what: 'Put the open page away' },
  { cmd: 'clear', what: 'Clear the screen' },
];
const COMMANDS = COMMAND_HELP.map((c) => c.cmd);
const ARG_VALUES: Record<string, string[]> = { style: ['concise', 'balanced', 'deep'], reset: ['chat', 'name', 'goal', 'voice', 'style', 'model'], help: ['all'] };
const SESSION_KEY = 'obs-console-session';

/**
 * The OBS console: one surface for talking to your agent and for shaping it, beside the desk's read-only commands,
 * the app's pages and your own wallet's swaps. A line is a message to your agent; a slash line is a command the
 * desk routes (src/cli/router.ts there). Signing in with the wallet is the whole account: it gets its own agent
 * straight away, with nothing to earn first. The page signs a challenge to prove the wallet, signs swaps with it,
 * streams the agent's reply token by token, and never holds a key.
 */
@Component({ selector: 'app-console', templateUrl: './console.component.html', styleUrls: ['./console.component.css'] })
export class ConsoleComponent implements AfterViewInit, OnDestroy {
  @ViewChild('screen') screen?: ElementRef<HTMLDivElement>;
  @ViewChild('cmd') cmd?: ElementRef<HTMLInputElement>;
  /** Where a view command renders one of the site's own pages, beside the console. */
  @ViewChild('viewHost', { read: ViewContainerRef }) viewHost?: ViewContainerRef;

  lines: CliLine[] = [];
  hint: string[] = [];
  wallet: string | null = null;
  chainId: number | null = null;
  token: string | null = null;
  status: Status = 'guest';
  agentState: AgentState = 'idle';
  agentName = 'OBS console';
  agentError: string | null = null;
  standing: ObsStanding | null = null;
  settings: ObsUserSettings = {};
  busy = false;
  /** The site page open beside the console (trade, rewards, cards, yield), or none. */
  view: string | null = null;
  /** The wallet's credits in dollars, once signed in; null until known. */
  credits: number | null = null;
  /** False until the first line runs: the welcome card shows in its place. */
  started = false;
  /** The command menu that opens as soon as a line starts with "/". */
  menu: CommandHelp[] = [];
  menuAt = 0;
  /** What the desk offers right now, read once from its status: Apps stay hidden until Composio is switched on there, and the door's wording follows its gate. */
  appsOn = true;
  gate: 'on' | 'allowlist' | 'off' = 'on';
  /** The welcome card's third line: who gets an agent by connecting, as the door stands today. */
  get inviteLine(): string {
    const who = this.gate === 'allowlist' ? 'For invited wallets' : this.gate === 'off' ? 'For everyone' : 'For OBS and AOBS holders';
    return who + ': connect your wallet and get a basic agent you can talk to and train here. The wallet you connect is the one that controls it.';
  }

  private history: string[] = [];
  private histAt = -1;
  private listening = false;
  private greeted = false;
  private static readonly CHAIN_ID = 4663;
  private static readonly CHAIN_HEX = '0x1237';
  private static readonly EXPLORER = 'https://robinhoodchain.blockscout.com';

  constructor(private obs: ObsDeskService, private zone: NgZone, @Inject(CONSOLE_VIEWS) private views: Record<string, Type<unknown>>, @Inject(CONSOLE_WALLET) private siteWallet: ConsoleWallet | null, title: Title, meta: Meta) {
    title.setTitle('Obscura - OBS Console');
    meta.updateTag({ name: 'description', content: 'The OBS console: talk to your own agent, read the desk, quote and swap from your own wallet.' });
  }

  ngAfterViewInit(): void {
    if (this.siteWallet) { this.watchSiteWallet(); } else { void this.silentReconnect(); }
    // What the desk offers today, so the page does not show a door or a button that is not there yet.
    this.obs.status().subscribe({ next: (s) => { const c = s.console; if (c) { this.appsOn = c.apps !== false; this.gate = c.gate ?? 'on'; } }, error: () => undefined });
    // The trading agent speaks for itself: every trade it makes or sits out arrives in the transcript as it happens.
    this.eventsTimer = setInterval(() => void this.pollEvents(), 20_000);
    setTimeout(() => this.focusInput(), 0);
  }

  ngOnDestroy(): void {
    if (this.eventsTimer) { clearInterval(this.eventsTimer); }
  }

  private eventsTimer?: ReturnType<typeof setInterval>;
  /** Only what happens from now on is news: nothing older than the page is replayed. */
  private eventsSince = Date.now();
  private eventsBusy = false;

  /** The trading agent's own account of what it did since the last look, printed as the agent speaking. */
  private async pollEvents(): Promise<void> {
    if (!this.token || this.status !== 'signed-in' || this.eventsBusy || this.agentState === 'thinking') { return; }
    this.eventsBusy = true;
    try {
      const r = await this.get<{ ok: boolean; events: Array<{ at: number; kind: string; text: string }>; at: number }>(this.obs.myAgentEvents(this.token, this.eventsSince));
      if (!r?.ok) { return; }
      const fresh = (r.events || []).filter((e) => e.at > this.eventsSince);
      if (fresh.length) {
        this.started = true;
        this.print(fresh.map((e) => ({ kind: 'agent' as LineKind, text: e.text })));
        this.eventsSince = Math.max(...fresh.map((e) => e.at));
      }
    } catch { /* the next look will tell */ } finally { this.eventsBusy = false; }
  }

  // ---- view helpers --------------------------------------------------------

  get groups(): Group[] {
    const out: Group[] = [];
    for (const l of this.lines) {
      const kind: LineKind = l.kind === 'input' && l.text.startsWith('/') ? 'command' : l.kind;
      const prev = out[out.length - 1];
      const mergeable = kind === 'output' || kind === 'error' || kind === 'system';
      if (prev && prev.kind === kind && mergeable) { prev.lines.push(l); } else { out.push({ kind, lines: [l] }); }
    }
    return out;
  }

  get placeholder(): string {
    if (this.agentState === 'thinking') { return this.agentName + ' is thinking…'; }
    if (this.agentState === 'ready') { return 'Ask ' + this.agentName + ' anything, or type / for commands'; }
    if (this.agentState === 'provisioning') { return 'Setting up your agent…'; }
    return 'Ask a question, or type / for commands';
  }

  joined(g: Group): string { return g.lines.map((l) => l.text).join(' '); }
  joinedLines(g: Group): string { return g.lines.map((l) => l.text).join('\n'); }
  suggestOf(g: Group): string[] { return g.lines[g.lines.length - 1]?.suggest ?? []; }
  /** A one-tap chip reads as words, not a command: "/trade" is "Trade", "/quote 0.05 ETH USDG" stays as it is. */
  chipLabel(one: string): string {
    const m = /^\/([a-z]+)$/.exec(one);
    const h = m ? COMMAND_HELP.find((c) => c.cmd === m[1]) : null;
    return h ? h.cmd.charAt(0).toUpperCase() + h.cmd.slice(1) : one;
  }
  linksOf(g: Group): Array<{ label: string; url: string }> { return g.lines[g.lines.length - 1]?.links ?? []; }
  approvalOf(g: Group): Approval | null { return g.lines[g.lines.length - 1]?.approval ?? null; }
  /** A message split so that its links open: plain text and http(s) URLs, in order. */
  parts(text: string): Array<{ t: string; url?: string }> {
    const out: Array<{ t: string; url?: string }> = [];
    const re = /https?:\/\/[^\s<>"')\]]+/g;
    let at = 0;
    for (const m of text.matchAll(re)) {
      const i = m.index ?? 0;
      if (i > at) { out.push({ t: text.slice(at, i) }); }
      out.push({ t: m[0], url: m[0] });
      at = i + m[0].length;
    }
    if (at < text.length) { out.push({ t: text.slice(at) }); }
    return out;
  }
  /** A tool's name as a person would say it: the app tool's own name, or what the meta tool does. */
  toolLabel(tool: string): string {
    const bare = (tool || '').replace(/^mcp__[^_]+(?:_[^_]+)*__/, '').replace(/^mcp__apps-[0-9a-f]+__/, '').replace(/^COMPOSIO_/, '');
    const meta: Record<string, string> = { MULTI_EXECUTE_TOOL: 'run something in your apps', SEARCH_TOOLS: 'look up the right tools', GET_TOOL_SCHEMAS: 'read what a tool needs', MANAGE_CONNECTIONS: 'manage your app connections', WAIT_FOR_CONNECTIONS: 'wait for your connection' };
    return meta[bare] ?? bare.toLowerCase().replace(/_/g, ' ');
  }
  argsText(a: unknown): string {
    try { const s = typeof a === 'string' ? a : JSON.stringify(a); return s && s !== '{}' ? s.slice(0, 400) : ''; } catch { return ''; }
  }

  /** Allow or deny what the agent asked to do in an app. One tap; the turn was waiting for it. */
  async approve(a: Approval, ok: boolean): Promise<void> {
    if (a.decision !== 'pending' || !this.token) { return; }
    a.decision = ok ? 'allowed' : 'denied';
    try { await this.get(this.obs.myAgentApprove(this.token, a.toolCallId, ok)); }
    catch (e: any) { this.print([{ kind: 'error', text: 'Couldn\'t send your answer: ' + this.reason(e) }]); }
  }

  get viewLabel(): string { return this.view ? this.view.charAt(0).toUpperCase() + this.view.slice(1) : ''; }
  get statusLine(): string {
    if (this.agentState === 'ready' || this.agentState === 'thinking') { return this.agentName + ' is ready'; }
    if (this.agentState === 'provisioning') { return 'Setting up your agent…'; }
    if (this.agentState === 'error') { return 'Your agent is not reachable'; }
    if (this.status === 'signed-in') { return 'Signed in'; }
    if (this.wallet) { return 'Wallet connected, not signed in'; }
    return 'Not signed in';
  }
  short(address: string): string { return address.slice(0, 6) + '…' + address.slice(-4); }

  focusInput(): void {
    const el = this.cmd?.nativeElement;
    if (el && !el.disabled && (typeof window === 'undefined' || !window.getSelection()?.toString())) { el.focus(); }
  }

  onSignInClick(ev: Event): void {
    ev.stopPropagation();
    if (this.status !== 'signed-in') { void this.runLine('/connect'); } else { void this.runLine('/whoami'); }
  }

  pickHint(h: string): void {
    const el = this.cmd?.nativeElement;
    if (!el) { return; }
    const parts = el.value.slice(1).split(/\s+/);
    el.value = parts.length <= 1 ? '/' + h + ' ' : '/' + [...parts.slice(0, -1), h].join(' ') + ' ';
    this.hint = [];
    el.focus();
  }

  submit(ev: Event): void {
    ev.preventDefault();
    const el = this.cmd?.nativeElement;
    if (!el) { return; }
    const line = el.value;
    el.value = '';
    this.hint = [];
    void this.runLine(line);
  }

  /** As a line is typed: a "/" opens the menu of commands, each explained, so nothing has to be remembered. */
  onInput(): void {
    const el = this.cmd?.nativeElement;
    this.hint = [];
    const v = el?.value ?? '';
    if (!v.startsWith('/') || /\s/.test(v)) { this.menu = []; return; }
    const stem = v.slice(1).toLowerCase();
    this.menu = COMMAND_HELP.filter((c) => c.cmd.startsWith(stem) && (this.appsOn || c.cmd !== 'apps')).slice(0, 8);
    this.menuAt = 0;
  }

  /** A menu item chosen: a command that needs no words runs at once; one that does is filled in, ready for them. */
  pickMenu(item: CommandHelp): void {
    const el = this.cmd?.nativeElement;
    this.menu = [];
    if (item.args) { if (el) { el.value = '/' + item.cmd + ' '; el.focus(); } return; }
    if (el) { el.value = ''; }
    void this.runLine('/' + item.cmd);
  }

  onKey(ev: KeyboardEvent): void {
    const el = this.cmd?.nativeElement;
    if (!el) { return; }
    if (this.menu.length) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); this.menuAt = (this.menuAt + 1) % this.menu.length; return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); this.menuAt = (this.menuAt - 1 + this.menu.length) % this.menu.length; return; }
      if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); this.pickMenu(this.menu[this.menuAt]); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); this.menu = []; return; }
    }
    if (ev.key === 'Tab') { ev.preventDefault(); const c = this.complete(el.value); el.value = c.value; this.hint = c.options; return; }
    if (ev.key === 'l' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); this.lines = []; return; }
    if (ev.key === 'Escape' && this.view) { ev.preventDefault(); void this.runLine('/close'); return; }
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      const r = this.recall(ev.key === 'ArrowUp' ? -1 : 1);
      if (r !== null) { ev.preventDefault(); el.value = r; }
    }
  }

  private recall(direction: -1 | 1): string | null {
    const h = this.history;
    if (!h.length) { return null; }
    if (this.histAt === -1) { if (direction === 1) { return null; } this.histAt = h.length - 1; return h[this.histAt]; }
    const next = this.histAt + direction;
    if (next < 0) { return h[0]; }
    if (next >= h.length) { this.histAt = -1; return ''; }
    this.histAt = next;
    return h[next];
  }

  /** Tab completes the command, and once a command is typed, that command's own values. */
  private complete(input: string): { value: string; options: string[] } {
    if (!input.startsWith('/')) { return { value: input, options: [] }; }
    const parts = input.slice(1).split(/\s+/);
    if (parts.length <= 1) {
      const stem = (parts[0] ?? '').toLowerCase();
      const hits = COMMANDS.filter((c) => c.startsWith(stem));
      return hits.length === 1 ? { value: '/' + hits[0] + ' ', options: [] } : { value: input, options: hits };
    }
    const vals = ARG_VALUES[parts[0].toLowerCase()];
    if (!vals) { return { value: input, options: [] }; }
    const stem = (parts[parts.length - 1] ?? '').toLowerCase();
    const hits = vals.filter((v) => v.startsWith(stem));
    if (hits.length === 1) { parts[parts.length - 1] = hits[0]; return { value: '/' + parts.join(' '), options: [] }; }
    return { value: input, options: hits };
  }

  // ---- printing --------------------------------------------------------------

  private print(incoming: CliLine[]): void {
    for (const l of this.lines) { if (l.streaming) { l.streaming = false; } }
    this.lines.push(...incoming);
    if (this.lines.length > 600) { this.lines.splice(0, this.lines.length - 600); }
    setTimeout(() => { const el = this.screen?.nativeElement; if (el) { el.scrollTop = el.scrollHeight; } }, 0);
  }

  private updateLast(patch: Partial<CliLine>): void {
    const last = this.lines[this.lines.length - 1];
    if (last) { this.patch(last, patch); }
  }

  private patch(line: CliLine, patch: Partial<CliLine>): void {
    Object.assign(line, patch);
    setTimeout(() => { const el = this.screen?.nativeElement; if (el) { el.scrollTop = el.scrollHeight; } }, 0);
  }

  private reason(e: any): string {
    const m = e?.error?.error || e?.error?.reason || (e?.error?.lines && e.error.lines[0]) || e?.data?.message || e?.message || String(e);
    return String(m).replace(/\s+/g, ' ').slice(0, 220);
  }

  private get<T>(o: { subscribe: (h: { next: (v: T) => void; error: (e: any) => void }) => unknown }): Promise<T> {
    return new Promise<T>((res, rej) => o.subscribe({ next: res, error: rej }));
  }

  // ---- running a line ----------------------------------------------------------

  /** One line, from the input or a tapped chip: same routing, same transcript. */
  async runLine(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line || this.busy) { return; }
    this.started = true;
    this.menu = [];
    if (this.history[this.history.length - 1] !== line) { this.history.push(line); }
    this.histAt = -1;
    this.print([{ kind: 'input', text: line }]);
    this.busy = true;
    try {
      if (!line.startsWith('/')) { await this.chat(line); return; }
      const head = line.slice(1).split(/\s+/)[0].toLowerCase();
      if (head === 'connect') { await this.signIn(line.slice(1).split(/\s+/).slice(1).join(' ')); return; }
      if (head === 'clear' || head === 'cls') { this.lines = []; return; }
      const data = await this.get<ObsCliReply>(this.obs.cli(this.token ?? '', line)).catch((e) => (e?.error && typeof e.error === 'object' ? e.error : { ok: false, lines: ['Couldn\'t reach the desk. Try again in a moment.'] }) as ObsCliReply);
      if (data.effect === 'clear') { this.lines = []; return; }
      if (data.effect === 'chat' && typeof data.text === 'string') { await this.chat(data.text, true); return; }
      if (data.effect === 'wallet' && data.ok) { await this.walletEffect(data); return; }
      if (data.effect === 'view') { this.applyView(data); return; }
      if (data.effect === 'pay' && data.ok && data.pay) { await this.pay(data.pay, Array.isArray(data.lines) ? data.lines : []); return; }
      if (typeof data.balance === 'number') { this.credits = data.balance; }
      if (data.effect === 'settings' && data.ok && data.settings) { this.settings = data.settings; this.agentName = this.settings.name || (this.agentState === 'ready' ? 'OBS' : this.agentName); }
      if (data.standing) { this.standing = data.standing; }
      const kind: LineKind = data.ok === false ? 'error' : 'output';
      const out = Array.isArray(data.lines) ? data.lines : [];
      const printed: CliLine[] = out.length ? out.map((t) => ({ kind, text: t })) : [{ kind, text: data.ok === false ? 'That didn\'t work.' : 'Done.' }];
      if (data.suggest?.length) { printed[printed.length - 1].suggest = data.suggest.map(String); }
      if (data.links?.length) { printed[printed.length - 1].links = data.links; }
      this.print(printed);
    } catch (e: any) {
      this.print([{ kind: 'error', text: 'Something went wrong: ' + this.reason(e) }]);
    } finally {
      this.busy = false;
      setTimeout(() => this.focusInput(), 0);
    }
  }

  // ---- credits: one transaction to sign, read off the chain, credited ----------------------------------

  /** Credits as a person reads them: whole when whole, two decimals otherwise. A credit is a cent. */
  creditsText(c: number): string {
    const n = Number.isInteger(c) ? c.toLocaleString('en-US') : c.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n + ' credit' + (c === 1 ? '' : 's');
  }

  private async refreshCredits(): Promise<void> {
    if (!this.token) { return; }
    try { const c = await this.get<ObsCredits>(this.obs.credits(this.token)); this.credits = c.balance; } catch { /* the bar keeps what it had */ }
  }

  /** Add credits: sign the transfer to the treasury, wait for it to land, then have the desk read it and credit it. */
  private async pay(p: ObsPayment, lines: string[]): Promise<void> {
    const prov = this.provider();
    if (!prov || !this.wallet || !this.token) { this.print([{ kind: 'system', text: 'Connect your wallet first: it signs the payment.', suggest: ['/connect'] }]); return; }
    if (this.chainId !== ConsoleComponent.CHAIN_ID) {
      await this.ensureChain(prov);
      if (this.chainId !== ConsoleComponent.CHAIN_ID) {
        // A wallet that cannot add Robinhood Chain (Phantom, for one) can still fund the agent: the ETH just has to come from a wallet that is on the chain.
        const text = p.purpose === 'fund'
          ? 'Your wallet couldn\'t switch to Robinhood Chain, and some wallets can\'t add it. Send ' + p.amount + ' ETH on Robinhood Chain to your agent\'s wallet ' + p.to + ' from any wallet that is on the chain, then type /wallet.'
          : 'Switch your wallet to Robinhood Chain first.';
        this.print([{ kind: 'error', text, suggest: p.purpose === 'fund' ? ['/wallet'] : [] }]);
        return;
      }
    }
    this.print(lines.map((t) => ({ kind: 'output' as LineKind, text: t })));
    let hash: string;
    try { hash = await prov.request({ method: 'eth_sendTransaction', params: [{ from: this.wallet, to: p.to, data: p.data, value: this.hex(p.value) }] }); }
    catch (e: any) { this.print([{ kind: 'error', text: 'Not sent: ' + this.reason(e), suggest: ['/credits'] }]); return; }
    this.print([{ kind: 'system', text: 'Sent ' + hash.slice(0, 12) + '…, waiting for the chain.' }]);
    const r = await this.waitReceipt(prov, hash);
    if (!r.ok) { this.print([{ kind: 'error', text: 'The payment didn\'t land (' + r.status + '). Nothing was credited.', suggest: ['/credits'] }]); return; }
    if (p.purpose === 'fund') {
      // A funding of the agent's own wallet: the desk reads it off the chain and records it; the balance comes back with it.
      const f: any = await this.get<any>(this.obs.fundVerify(this.token, hash)).catch((e) => e?.error ?? e);
      if (f?.ok) { this.print([{ kind: 'output', text: (f.already ? 'Already recorded. ' : '') + 'Your agent\'s wallet received ' + Number(f.amount ?? p.amount).toFixed(5) + ' ETH' + (typeof f.balance === 'number' ? ', and holds ' + f.balance.toFixed(5) + ' ETH now.' : '.'), suggest: ['/wallet', '/start', '/agent'] }]); }
      else { this.print([{ kind: 'error', text: 'The desk couldn\'t record it yet: ' + (f?.reason || f?.error || 'no answer') + '. It landed at ' + ConsoleComponent.EXPLORER + '/tx/' + hash + '; type /wallet in a minute.', suggest: ['/wallet'] }]); }
      return;
    }
    const v: any = await this.get<any>(this.obs.creditsVerify(this.token, hash)).catch((e) => e?.error ?? e);
    if (v?.ok) {
      if (typeof v.balance === 'number') { this.credits = v.balance; }
      this.print([{ kind: 'output', text: (v.already ? 'Already credited. ' : '') + this.creditsText(Number(v.credits ?? 0)) + ' added from ' + v.amount + ' ' + v.token + '. Balance: ' + this.creditsText(Number(v.balance ?? 0)) + '.', suggest: ['/model', '/credits'] }]);
    } else {
      this.print([{ kind: 'error', text: 'The desk couldn\'t credit it yet: ' + (v?.reason || v?.error || 'no answer') + '. It landed at ' + ConsoleComponent.EXPLORER + '/tx/' + hash + '; type /credits in a minute.', suggest: ['/credits'] }]);
    }
  }

  // ---- the app, beside the console ---------------------------------------------------

  /**
   * A view command: open one of the site's own pages beside the console, or close it. The desk names the view;
   * the site's module supplies the component (CONSOLE_VIEWS), so this page never imports a page it does not own.
   */
  private applyView(data: ObsCliReply): void {
    const name = data.view ?? null;
    const lines: CliLine[] = (Array.isArray(data.lines) ? data.lines : []).map((t) => ({ kind: 'output' as LineKind, text: t }));
    if (name === null) { this.closeView(); this.print(lines); return; }
    const cls = this.views[name];
    if (!cls) { this.print([{ kind: 'error', text: 'The ' + name + ' page isn\'t part of this build.' }]); return; }
    const host = this.viewHost;
    if (!host) { this.print([{ kind: 'error', text: 'There\'s nowhere to open it here.' }]); return; }
    host.clear();
    host.createComponent(cls);
    this.view = name;
    const printed = lines.length ? lines : [{ kind: 'output' as LineKind, text: name.charAt(0).toUpperCase() + name.slice(1) + ' is open beside the console.' }];
    if (data.suggest?.length) { printed[printed.length - 1].suggest = data.suggest.map(String); }
    this.print(printed);
  }

  closeView(): void {
    this.viewHost?.clear();
    this.view = null;
  }

  // ---- the wallet is the account ---------------------------------------------------

  /** The wallet the site connected when it has one, else whatever the browser injected. */
  /**
   * No wallet in this browser. On a phone that is the normal case: the page has to be opened inside the wallet
   * app's own browser, so the line carries one-tap links that do exactly that for Phantom and MetaMask.
   */
  private noWalletLine(): CliLine {
    const mobile = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    if (!mobile || typeof location === 'undefined') {
      return { kind: 'error', text: 'No wallet found in this browser. Install MetaMask, Rabby or Phantom, or on a phone open this page inside your wallet app\'s own browser.' };
    }
    const here = location.href;
    return {
      kind: 'error',
      text: 'No wallet in this browser. On a phone the console has to open inside your wallet app: tap your wallet below and it opens this page there, then sign in.',
      links: [
        { label: 'Open in Phantom', url: 'https://phantom.app/ul/browse/' + encodeURIComponent(here) + '?ref=' + encodeURIComponent(location.origin) },
        { label: 'Open in MetaMask', url: 'https://metamask.app.link/dapp/' + location.host + location.pathname + location.search },
      ],
    };
  }

  private provider(): any {
    if (this.siteWallet?.provider) { return this.siteWallet.provider; }
    if (typeof window === 'undefined') { return null; }
    // Phantom keeps its Ethereum provider at window.phantom.ethereum and does not always set window.ethereum.
    const w = window as any;
    return w.ethereum ?? w.phantom?.ethereum ?? null;
  }

  /** With the site's own wallet connection: follow the address it holds, so the header's wallet is the console's. */
  private watchSiteWallet(): void {
    const w = this.siteWallet;
    if (!w) { return; }
    let last: string | null = null;
    w.address$.subscribe((addr) => this.zone.run(() => {
      const next = addr || null;
      if (next === last) { return; }
      const had = last;
      last = next;
      if (!next) {
        if (had) { this.forgetWallet(); this.print([{ kind: 'system', text: 'Wallet disconnected.' }]); }
        return;
      }
      if (had && had.toLowerCase() !== next.toLowerCase()) { this.forgetWallet(); this.print([{ kind: 'system', text: 'Switched to wallet ' + this.short(next) + '.' }]); }
      this.wallet = next;
      this.status = 'connected';
      void this.readChain(w.provider);
      const s = this.readSession(next);
      if (s) { this.token = s.token; this.status = 'signed-in'; void this.afterSignIn(true); }
      else { this.print([{ kind: 'system', text: 'Wallet ' + this.short(next) + ' is connected. Sign in to meet your agent.', suggest: ['/connect', '/status'] }]); }
    }));
  }

  private forgetWallet(): void {
    this.wallet = null; this.token = null; this.standing = null; this.credits = null; this.status = 'guest'; this.agentState = 'idle'; this.agentName = 'OBS console';
  }

  private async readChain(p: any): Promise<void> {
    try { const c: string = await p.request({ method: 'eth_chainId' }); this.chainId = parseInt(c, 16); } catch { /* the swap reads it again */ }
  }

  private readSession(address: string): ObsSession | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) { return null; }
      const s = JSON.parse(raw) as ObsSession;
      return s.address?.toLowerCase() === address.toLowerCase() && s.token && Date.now() < s.expiresAt ? s : null;
    } catch { return null; }
  }

  private storeSession(s: ObsSession | null): void {
    try { if (s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } else { localStorage.removeItem(SESSION_KEY); } } catch { /* private window */ }
  }

  private listen(p: any): void {
    if (this.listening) { return; }
    this.listening = true;
    p.on?.('accountsChanged', (a: string[]) => this.zone.run(() => {
      this.wallet = a?.[0] ?? null; this.token = null; this.standing = null; this.status = this.wallet ? 'connected' : 'guest'; this.agentState = 'idle'; this.agentName = 'OBS console';
      this.print([{ kind: 'system', text: this.wallet ? 'Switched to wallet ' + this.short(this.wallet) + '. Sign in again to reach its agent.' : 'Wallet disconnected.', suggest: this.wallet ? ['/connect'] : [] }]);
    }));
    p.on?.('chainChanged', (c: string) => this.zone.run(() => { this.chainId = parseInt(c, 16); }));
  }

  private async silentReconnect(): Promise<void> {
    const p = this.provider();
    if (!p) { return; }
    try {
      const accs: string[] = await p.request({ method: 'eth_accounts' });
      if (!accs?.length) { return; }
      this.wallet = accs[0];
      this.status = 'connected';
      const c: string = await p.request({ method: 'eth_chainId' });
      this.chainId = parseInt(c, 16);
      this.listen(p);
      const s = this.readSession(this.wallet);
      if (s) { this.token = s.token; this.status = 'signed-in'; await this.afterSignIn(true); }
      else { this.print([{ kind: 'system', text: 'Wallet ' + this.short(this.wallet) + ' is connected. Sign in to meet your agent.', suggest: ['/connect', '/status'] }]); }
    } catch { /* not connected: fine */ }
  }

  private async ensureChain(p: any): Promise<void> {
    const c: string = await p.request({ method: 'eth_chainId' });
    this.chainId = parseInt(c, 16);
    if (this.chainId === ConsoleComponent.CHAIN_ID) { return; }
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ConsoleComponent.CHAIN_HEX }] });
    } catch (e: any) {
      if (e?.code === 4902 || /unrecognized|not added|4902/i.test(String(e?.message))) {
        await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: ConsoleComponent.CHAIN_HEX, chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: [ConsoleComponent.EXPLORER] }] });
      } else { throw e; }
    }
    const after: string = await p.request({ method: 'eth_chainId' });
    this.chainId = parseInt(after, 16);
  }

  /**
   * Connect, sign the challenge, keep the bearer. The signature proves control; it moves nothing, and it needs no
   * particular chain, so nothing is switched here (a swap switches when it must). With the site's own picker,
   * the wallet the header connected is used; when several are installed, /connect <name> picks one.
   */
  private async signIn(which = ''): Promise<void> {
    const noWallet = this.noWalletLine();
    let p: any;
    let wallet: string | null;
    if (this.siteWallet) {
      const w = this.siteWallet;
      if (!w.address) {
        const opts = w.list();
        if (!opts.length) { this.print([noWallet]); return; }
        const want = which.trim().toLowerCase();
        const pick = want ? opts.find((o) => o.name.toLowerCase().startsWith(want) || o.rdns.toLowerCase().includes(want)) : opts.length === 1 ? opts[0] : null;
        if (!pick) {
          this.print([{ kind: 'system', text: want ? 'No wallet called "' + which.trim() + '" here. Pick one:' : 'Which wallet? Pick one:', suggest: opts.map((o) => '/connect ' + o.name) }]);
          return;
        }
        this.print([{ kind: 'system', text: 'Connecting ' + pick.name + '. Approve it in the wallet.' }]);
        try { await w.connect(pick); } catch (e: any) { this.print([{ kind: 'error', text: 'Not connected: ' + this.reason(e), suggest: ['/connect'] }]); return; }
        if (!w.address) { this.print([{ kind: 'error', text: pick.name + ' didn\'t give an account.' }]); return; }
      }
      wallet = w.address;
      p = w.provider;
    } else {
      p = this.provider();
      if (!p) { this.print([noWallet]); return; }
      const accs: string[] = await p.request({ method: 'eth_requestAccounts' });
      wallet = accs?.[0] ?? null;
      if (!wallet) { this.print([{ kind: 'error', text: 'The wallet didn\'t give an account.' }]); return; }
      this.listen(p);
    }
    this.wallet = wallet;
    this.status = 'connected';
    void this.readChain(p);
    const stored = this.readSession(wallet);
    if (stored) { this.token = stored.token; this.status = 'signed-in'; await this.afterSignIn(false); return; }
    this.status = 'signing';
    try {
      const c = await this.get<{ ok: boolean; message: string; nonce: string }>(this.obs.accountChallenge(this.wallet));
      this.print([{ kind: 'system', text: 'Sign the message in your wallet. It proves the wallet is yours and authorizes nothing. This wallet is the one that will control your agent.' }]);
      const signature: string = await p.request({ method: 'personal_sign', params: [c.message, this.wallet] });
      const l = await this.get<{ ok: boolean; error?: string; code?: string; session?: ObsSession; standing?: ObsStanding }>(this.obs.accountLink(this.wallet, c.nonce, signature)).catch((e) => (e?.error && typeof e.error === 'object' ? e.error : { ok: false, error: this.reason(e) }));
      if (l.code === 'not_holder') { this.status = 'connected'; this.print([{ kind: 'system', text: l.error || 'The console is for OBS and AOBS holders.', suggest: ['/trade', '/status'] }]); return; }
      if (!l.ok || !l.session) { throw new Error(l.error || 'sign-in refused'); }
      this.token = l.session.token;
      this.storeSession(l.session);
      this.status = 'signed-in';
      if (l.standing) { this.standing = l.standing; }
      await this.afterSignIn(false);
    } catch (e: any) {
      this.status = 'connected';
      this.print([{ kind: 'error', text: 'Not signed in: ' + this.reason(e), suggest: ['/connect'] }]);
    }
  }

  /** What happens once the bearer is in hand: the wallet's agent, straight away. Nothing to earn first. */
  private async afterSignIn(quiet: boolean): Promise<void> {
    if (!this.token || !this.wallet) { return; }
    this.get<ObsStanding>(this.obs.consoleSwaps(this.wallet)).then((s) => { this.standing = s; }).catch(() => { /* the count stays as it was */ });
    void this.refreshCredits();
    if (!quiet) { this.print([{ kind: 'system', text: 'Signed in as ' + this.short(this.wallet) + '. Setting up your agent…' }]); }
    this.agentState = 'provisioning';
    this.agentError = null;
    try {
      const ensured = await this.get<any>(this.obs.myAgentEnsure(this.token)).catch((e) => (e?.error && typeof e.error === 'object' ? e.error : { ok: false, error: this.reason(e) }));
      if (ensured?.code === 'not_holder') { this.agentState = 'idle'; this.print([{ kind: 'system', text: ensured.error || 'The console is for OBS and AOBS holders.', suggest: ['/trade', '/status'] }]); return; }
      if (!ensured?.ok) { throw new Error(ensured?.error || 'could not reach your agent'); }
      this.settings = ensured.settings ?? {};
      this.agentName = ensured.name || 'OBS';
      const hist = await this.get<{ ok: boolean; turns: Array<{ role: string; content: string }> }>(this.obs.myAgentHistory(this.token)).catch(() => ({ ok: true, turns: [] }));
      const prior = (hist.turns ?? []).filter((t) => t.role === 'user' || t.role === 'assistant');
      if (!this.greeted) {
        this.greeted = true;
        this.print([
          ...prior.map((m) => ({ kind: (m.role === 'user' ? 'input' : 'agent') as LineKind, text: m.content })),
          prior.length
            ? { kind: 'system' as LineKind, text: this.agentName + ' is back, and remembers where you left off.', suggest: ['/help'] }
            : { kind: 'system' as LineKind, text: 'Meet ' + this.agentName + ', your own agent, tied to wallet ' + this.short(this.wallet) + ': that wallet controls it. Talk to it about anything, and train it here with /name, /style, /voice and /goal. It doesn\'t trade for you.', suggest: ['What can you help me with?', '/name', '/explore'] },
        ]);
      } else if (!quiet) {
        this.print([{ kind: 'system', text: this.agentName + ' is ready.', suggest: ['/help'] }]);
      }
      this.agentState = 'ready';
    } catch (e: any) {
      this.agentState = 'error';
      this.agentError = this.reason(e);
    }
  }

  // ---- chat, streamed ---------------------------------------------------------------

  private async chat(text: string, alreadyPrinted = false): Promise<void> {
    if (!this.token) { this.print([{ kind: 'system', text: 'Connect your wallet to talk to your agent. One signature, no transaction, and that wallet is the one that controls your agent.', suggest: ['/connect'] }]); return; }
    if (this.agentState !== 'ready') {
      this.print([{ kind: 'system', text: this.agentState === 'provisioning' ? 'Your agent is still being set up. Give it a moment.' : 'Your agent isn\'t reachable right now.', suggest: this.agentState === 'provisioning' ? [] : ['/connect'] }]);
      return;
    }
    void alreadyPrinted;
    this.agentState = 'thinking';
    this.agentError = null;
    let me: CliLine | null = { kind: 'agent', text: '', streaming: true };
    this.print([me]);
    const { url, headers } = this.obs.myAgentStream(this.token);
    let acc = '';
    // Something happened between the agent's words (a tool ran, an approval was asked): its next words start a new bubble.
    const aside = (line: CliLine) => {
      if (me && !me.text) { const i = this.lines.indexOf(me); if (i >= 0) { this.lines.splice(i, 1); } }
      if (me) { me.streaming = false; }
      me = null; acc = '';
      this.print([line]);
    };
    const say = (text: string) => {
      if (!me) { me = { kind: 'agent', text: '', streaming: true }; this.print([me]); }
      this.patch(me, { text, streaming: true });
    };
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text }) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        if (res.status === 402) { aside({ kind: 'system', text: j?.error || 'You\'re out of credits.', suggest: ['/credits', '/models free'] }); this.credits = 0; return; }
        if (res.status === 403 && j?.code === 'not_holder') { aside({ kind: 'system', text: j.error || 'The console is for OBS and AOBS holders.', suggest: ['/trade', '/status'] }); this.agentState = 'idle'; return; }
        throw new Error(j?.error || 'your agent could not respond');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith('data:')) { continue; }
          let ev: { type: string; text?: string; message?: string; phase?: string; tool?: string; ok?: boolean; toolCallId?: string; args?: unknown; decision?: string; balance?: number; charged?: number };
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === 'delta') { acc += ev.text ?? ''; this.zone.run(() => say(acc)); }
          else if (ev.type === 'final') { acc = ev.text || acc; this.zone.run(() => say(acc)); }
          else if (ev.type === 'error') { acc = acc || (ev.message || 'your agent could not respond just now'); }
          else if (ev.type === 'tool' && ev.phase === 'call') { this.zone.run(() => aside({ kind: 'system', text: 'Working in your apps: ' + this.toolLabel(ev.tool ?? '') + '.' })); }
          else if (ev.type === 'tool' && ev.phase === 'result' && ev.ok === false) { this.zone.run(() => aside({ kind: 'system', text: 'That didn\'t work in the app (' + this.toolLabel(ev.tool ?? '') + ').' })); }
          else if (ev.type === 'approval') { this.zone.run(() => aside({ kind: 'system', text: this.agentName + ' wants to ' + this.toolLabel(ev.tool ?? '') + '. Allow it?', approval: { toolCallId: ev.toolCallId ?? '', tool: ev.tool ?? '', args: ev.args, decision: 'pending' } })); }
          else if (ev.type === 'done' && typeof ev.balance === 'number') { this.zone.run(() => { this.credits = ev.balance as number; }); }
          else if (ev.type === 'approval_resolved') { this.zone.run(() => { for (const l of this.lines) { if (l.approval && l.approval.toolCallId === ev.toolCallId && l.approval.decision === 'pending') { l.approval.decision = ev.decision === 'approved' ? 'allowed' : 'denied'; } } }); }
        }
      }
      if (me || !acc) { say(acc || 'No reply came back. Try again.'); if (me) { (me as CliLine).streaming = false; } }
    } catch (e: any) {
      say(acc || this.reason(e)); if (me) { (me as CliLine).streaming = false; }
      this.agentError = null;
    } finally {
      this.agentState = 'ready';
    }
  }

  // ---- the wallet's own effects: quote, swap, balance ------------------------------------

  private async walletEffect(data: ObsCliReply): Promise<void> {
    if (data.action === 'balance') { await this.balance(); return; }
    if (data.action === 'quote') { this.showQuote(await this.fetchQuote(data.amount as number, data.from as string, data.to as string)); return; }
    if (data.action === 'swap') { await this.swap(data.amount as number, data.from as string, data.to as string); return; }
    if (data.action === 'connect') { await this.signIn(); }
  }

  private async balance(): Promise<void> {
    const p = this.provider();
    if (!p || !this.wallet) { this.print([{ kind: 'system', text: 'Connect your wallet first.', suggest: ['/connect'] }]); return; }
    const hex: string = await p.request({ method: 'eth_getBalance', params: [this.wallet, 'latest'] });
    this.print([{ kind: 'output', text: this.short(this.wallet) + ' holds ' + (Number(BigInt(hex)) / 1e18).toFixed(5) + ' ETH' + (this.chainId === ConsoleComponent.CHAIN_ID ? ' on Robinhood Chain' : ' on chain ' + this.chainId) + '.' }]);
  }

  private fetchQuote(amount: number, from: string, to: string): Promise<ObsConsoleQuote> {
    return this.get<ObsConsoleQuote>(this.obs.consoleQuote(from, to, amount, this.wallet || '0x000000000000000000000000000000000000dEaD'));
  }

  private showQuote(q: ObsConsoleQuote): void {
    const cost = q.pool.costPct != null ? ', all in ' + q.pool.costPct.toFixed(2) + '% against the mark' : '';
    const lines: CliLine[] = [{ kind: 'output', text: q.amountIn + ' ' + q.from + ' -> ' + q.pool.amountOut + ' ' + q.to + ' through the pools (' + q.pool.route.join(' then ') + cost + '); floor ' + q.pool.minOut }];
    if (q.relay) { lines.push({ kind: 'output', text: q.relay.amountOut != null ? 'The app\'s Relay route pays ' + q.relay.amountOut + ' ' + q.to + (q.relay.feeUsd != null ? ' with $' + q.relay.feeUsd.toFixed(2) + ' of fees' : '') + '.' : 'Relay: ' + (q.relay.error || 'no quote') }); }
    const approvals = q.steps.filter((st) => st.id !== 'swap');
    lines.push({ kind: 'output', text: approvals.length ? 'Your wallet signs ' + (approvals.length + 1) + ' transactions: ' + q.steps.map((st) => st.note).join('; ') : 'One transaction to sign: ' + q.steps[q.steps.length - 1].note, suggest: ['/swap ' + q.amountIn + ' ' + q.from + ' ' + q.to] });
    this.print(lines);
  }

  private hex(v: string): string { return '0x' + BigInt(v).toString(16); }

  private async waitReceipt(p: any, hash: string): Promise<{ ok: boolean; status: string }> {
    for (let i = 0; i < 60; i++) {
      const r = await p.request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (r && r.status != null) { return { ok: r.status === '0x1' || r.status === 1, status: String(r.status) }; }
      await new Promise((res) => setTimeout(res, 2000));
    }
    return { ok: false, status: 'not landed in two minutes' };
  }

  private async swap(amount: number, from: string, to: string): Promise<void> {
    const p = this.provider();
    if (!p || !this.wallet) { this.print([{ kind: 'system', text: 'Connect your wallet first: it signs the swap.', suggest: ['/connect'] }]); return; }
    if (this.chainId !== ConsoleComponent.CHAIN_ID) { await this.ensureChain(p); if (this.chainId !== ConsoleComponent.CHAIN_ID) { this.print([{ kind: 'error', text: 'Switch your wallet to Robinhood Chain first.' }]); return; } }
    const q = await this.fetchQuote(amount, from, to);
    this.showQuote(q);
    let swapHash: string | null = null;
    for (const st of q.steps) {
      this.print([{ kind: 'system', text: 'Sign in your wallet: ' + st.note }]);
      const hash: string = await p.request({ method: 'eth_sendTransaction', params: [{ from: this.wallet, to: st.to, data: st.data, value: this.hex(st.value) }] });
      this.print([{ kind: 'system', text: 'Sent ' + hash.slice(0, 12) + '…, waiting for the chain.' }]);
      const r = await this.waitReceipt(p, hash);
      if (!r.ok) { this.print([{ kind: 'error', text: (st.id === 'swap' ? 'The swap' : 'The approval') + ' didn\'t succeed (' + r.status + '). Nothing else was sent.' }]); return; }
      if (st.id === 'swap') { swapHash = hash; } else { this.print([{ kind: 'output', text: 'Approval landed.' }]); }
    }
    if (!swapHash) { return; }
    this.print([{ kind: 'output', text: 'Swap landed: ' + ConsoleComponent.EXPLORER + '/tx/' + swapHash }]);
    const reply: any = await this.get<any>(this.obs.consoleSwap({ address: this.wallet, txHash: swapHash, from: q.from, to: q.to, amountIn: q.amountIn })).catch((e) => e?.error ?? e);
    if (reply?.ok) {
      this.standing = reply.standing ?? this.standing;
      const got = reply.swap?.amountOut != null ? ', and ' + reply.swap.amountOut + ' ' + q.to + ' arrived' : '';
      const n = reply.standing?.swaps;
      this.print([{ kind: 'output', text: 'Verified on the chain' + got + '.' + (n ? ' That\'s ' + n + ' swap' + (n === 1 ? '' : 's') + ' from this wallet through the console.' : ''), suggest: ['/swaps'] }]);
    } else {
      this.print([{ kind: 'error', text: 'The desk couldn\'t verify it yet: ' + (reply?.reason || reply?.error || 'no answer') + '. Type /swaps in a minute.', suggest: ['/swaps'] }]);
    }
  }
}
