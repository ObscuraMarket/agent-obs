import { AfterViewInit, Component, ElementRef, NgZone, ViewChild } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ObsDeskService, ObsConsoleQuote, ObsEligibility, ObsCliReply, ObsSession, ObsUserSettings } from '../../service/obs-desk.service';

type LineKind = 'input' | 'command' | 'output' | 'error' | 'agent' | 'system';
interface CliLine { kind: LineKind; text: string; streaming?: boolean; suggest?: string[]; }
interface Group { kind: LineKind; lines: CliLine[]; }
type Status = 'guest' | 'connected' | 'signing' | 'signed-in';
type AgentState = 'idle' | 'locked' | 'provisioning' | 'ready' | 'thinking' | 'error';

/** Completion vocabulary, kept in step with the desk's router. */
const COMMANDS = ['help', 'explore', 'clear', 'whoami', 'name', 'style', 'voice', 'goal', 'reset', 'eligible', 'connect', 'balance', 'quote', 'swap', 'status', 'positions', 'thoughts', 'research', 'watch', 'reads'];
const ARG_VALUES: Record<string, string[]> = { style: ['concise', 'balanced', 'deep'], reset: ['name', 'goal', 'voice', 'style'], help: ['all'] };
const SESSION_KEY = 'obs-console-session';

/**
 * The OBS console: one surface for talking to your agent and for shaping it, beside the desk's read-only commands
 * and your own wallet's swaps. A line is a message to your agent; a slash line is a command the desk routes
 * (src/cli/router.ts there). The page signs a challenge to prove the wallet, signs swaps with it, streams the
 * agent's reply token by token, and never holds a key.
 */
@Component({ selector: 'app-console', templateUrl: './console.component.html', styleUrls: ['./console.component.css'] })
export class ConsoleComponent implements AfterViewInit {
  @ViewChild('screen') screen?: ElementRef<HTMLDivElement>;
  @ViewChild('cmd') cmd?: ElementRef<HTMLInputElement>;

  lines: CliLine[] = [];
  hint: string[] = [];
  wallet: string | null = null;
  chainId: number | null = null;
  token: string | null = null;
  status: Status = 'guest';
  agentState: AgentState = 'idle';
  agentName = 'OBS console';
  agentError: string | null = null;
  elig: ObsEligibility | null = null;
  settings: ObsUserSettings = {};
  busy = false;

  private history: string[] = [];
  private histAt = -1;
  private listening = false;
  private greeted = false;
  private static readonly CHAIN_ID = 4663;
  private static readonly CHAIN_HEX = '0x1237';
  private static readonly EXPLORER = 'https://robinhoodchain.blockscout.com';

  constructor(private obs: ObsDeskService, private zone: NgZone, title: Title, meta: Meta) {
    title.setTitle('Obscura - OBS Console');
    meta.updateTag({ name: 'description', content: 'The OBS console: talk to your own agent, read the desk, quote and swap from your own wallet.' });
  }

  ngAfterViewInit(): void {
    this.print([{ kind: 'system', text: 'OBS console. the desk\'s command line. read it, quote through its router, swap from your own wallet; three verified swaps unlock an agent of your own.', suggest: ['/explore', '/status', '/connect'] }]);
    void this.silentReconnect();
    setTimeout(() => this.focusInput(), 0);
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
    if (this.agentState === 'ready') { return 'message, or /help'; }
    if (this.status === 'signed-in') { return '/swap 0.05 ETH USDG unlocks your agent, or /help'; }
    return '/help, /status, or /connect to sign in';
  }

  joined(g: Group): string { return g.lines.map((l) => l.text).join(' '); }
  joinedLines(g: Group): string { return g.lines.map((l) => l.text).join('\n'); }
  suggestOf(g: Group): string[] { return g.lines[g.lines.length - 1]?.suggest ?? []; }
  short(address: string): string { return address.slice(0, 6) + '…' + address.slice(-4); }

  focusInput(): void {
    const el = this.cmd?.nativeElement;
    if (el && !el.disabled && (typeof window === 'undefined' || !window.getSelection()?.toString())) { el.focus(); }
  }

  onSignInClick(ev: Event): void {
    ev.stopPropagation();
    if (this.status !== 'signed-in') { void this.runLine('/connect'); } else { void this.runLine('/eligible'); }
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

  onKey(ev: KeyboardEvent): void {
    const el = this.cmd?.nativeElement;
    if (!el) { return; }
    if (ev.key === 'Tab') { ev.preventDefault(); const c = this.complete(el.value); el.value = c.value; this.hint = c.options; return; }
    if (ev.key === 'l' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); this.lines = []; return; }
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
    if (last) { Object.assign(last, patch); }
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
    if (this.history[this.history.length - 1] !== line) { this.history.push(line); }
    this.histAt = -1;
    this.print([{ kind: 'input', text: line }]);
    this.busy = true;
    try {
      if (!line.startsWith('/')) { await this.chat(line); return; }
      const head = line.slice(1).split(/\s+/)[0].toLowerCase();
      if (head === 'connect') { await this.signIn(); return; }
      if (head === 'clear' || head === 'cls') { this.lines = []; return; }
      const data = await this.get<ObsCliReply>(this.obs.cli(this.token ?? '', line)).catch((e) => (e?.error && typeof e.error === 'object' ? e.error : { ok: false, lines: ['could not reach the desk. try again.'] }) as ObsCliReply);
      if (data.effect === 'clear') { this.lines = []; return; }
      if (data.effect === 'chat' && typeof data.text === 'string') { await this.chat(data.text, true); return; }
      if (data.effect === 'wallet' && data.ok) { await this.walletEffect(data); return; }
      if (data.effect === 'settings' && data.ok && data.settings) { this.settings = data.settings; this.agentName = this.settings.name || (this.agentState === 'ready' ? 'OBS' : this.agentName); }
      if (data.eligibility) { this.elig = data.eligibility; }
      const kind: LineKind = data.ok === false ? 'error' : 'output';
      const out = Array.isArray(data.lines) ? data.lines : [];
      const printed: CliLine[] = out.length ? out.map((t) => ({ kind, text: t })) : [{ kind, text: data.ok === false ? 'that did not work.' : 'done.' }];
      if (data.suggest?.length) { printed[printed.length - 1].suggest = data.suggest.map(String); }
      this.print(printed);
    } catch (e: any) {
      this.print([{ kind: 'error', text: 'failed: ' + this.reason(e) }]);
    } finally {
      this.busy = false;
      setTimeout(() => this.focusInput(), 0);
    }
  }

  // ---- the wallet is the account ---------------------------------------------------

  private provider(): any {
    return typeof window !== 'undefined' ? (window as any).ethereum ?? null : null;
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
      this.wallet = a?.[0] ?? null; this.token = null; this.elig = null; this.status = this.wallet ? 'connected' : 'guest'; this.agentState = 'idle'; this.agentName = 'OBS console';
      this.print([{ kind: 'system', text: this.wallet ? 'wallet switched to ' + this.short(this.wallet) + '. sign in again to reach its agent.' : 'wallet disconnected.', suggest: this.wallet ? ['/connect'] : [] }]);
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
      else { this.print([{ kind: 'system', text: 'wallet ' + this.short(this.wallet) + ' is connected. sign in to reach its agent and its standing.', suggest: ['/connect', '/status'] }]); }
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

  /** Connect, sign the challenge, keep the bearer. The signature proves control; it moves nothing. */
  private async signIn(): Promise<void> {
    const p = this.provider();
    if (!p) { this.print([{ kind: 'error', text: 'no wallet found in this browser. install MetaMask or Rabby, or open this page inside your wallet\'s browser.' }]); return; }
    const accs: string[] = await p.request({ method: 'eth_requestAccounts' });
    this.wallet = accs?.[0] ?? null;
    if (!this.wallet) { this.print([{ kind: 'error', text: 'the wallet gave no account.' }]); return; }
    this.status = 'connected';
    this.listen(p);
    await this.ensureChain(p);
    const stored = this.readSession(this.wallet);
    if (stored) { this.token = stored.token; this.status = 'signed-in'; await this.afterSignIn(false); return; }
    this.status = 'signing';
    try {
      const c = await this.get<{ ok: boolean; message: string; nonce: string }>(this.obs.accountChallenge(this.wallet));
      this.print([{ kind: 'system', text: 'sign the message in your wallet. it proves the wallet is yours and authorizes nothing.' }]);
      const signature: string = await p.request({ method: 'personal_sign', params: [c.message, this.wallet] });
      const l = await this.get<{ ok: boolean; error?: string; session?: ObsSession; eligibility?: ObsEligibility }>(this.obs.accountLink(this.wallet, c.nonce, signature));
      if (!l.ok || !l.session) { throw new Error(l.error || 'sign-in refused'); }
      this.token = l.session.token;
      this.storeSession(l.session);
      this.status = 'signed-in';
      if (l.eligibility) { this.elig = l.eligibility; }
      await this.afterSignIn(false);
    } catch (e: any) {
      this.status = 'connected';
      this.print([{ kind: 'error', text: 'not signed in: ' + this.reason(e), suggest: ['/connect'] }]);
    }
  }

  /** What happens once the bearer is in hand: standing, then the agent when the bar is cleared. */
  private async afterSignIn(quiet: boolean): Promise<void> {
    if (!this.token || !this.wallet) { return; }
    try {
      const e = await this.get<ObsEligibility>(this.obs.consoleEligible(this.wallet));
      this.elig = e;
    } catch { /* the pill stays as it was */ }
    if (!this.elig?.eligible) {
      this.agentState = 'locked';
      this.agentName = 'OBS console';
      const left = (this.elig?.required ?? 3) - (this.elig?.swaps ?? 0);
      this.print([{ kind: 'system', text: 'signed in as ' + this.short(this.wallet) + '. ' + (this.elig?.swaps ?? 0) + ' of ' + (this.elig?.required ?? 3) + ' verified swaps; ' + left + ' more unlock' + (left === 1 ? 's' : '') + ' an agent of your own.', suggest: ['/swap 0.05 ETH USDG', '/quote 0.05 ETH USDG', '/explore'] }]);
      return;
    }
    this.agentState = 'provisioning';
    this.agentError = null;
    try {
      const ensured = await this.get<any>(this.obs.myAgentEnsure(this.token));
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
            ? { kind: 'system' as LineKind, text: this.agentName + ' is live.', suggest: ['/help'] }
            : { kind: 'system' as LineKind, text: this.agentName + ' is live and it is yours. it reads the desk and remembers this conversation. talking to it is free.', suggest: ['what is the desk holding right now, and why?', '/explore', '/help'] },
        ]);
      } else if (!quiet) {
        this.print([{ kind: 'system', text: this.agentName + ' is live.', suggest: ['/help'] }]);
      }
      this.agentState = 'ready';
    } catch (e: any) {
      this.agentState = 'error';
      this.agentError = this.reason(e);
    }
  }

  // ---- chat, streamed ---------------------------------------------------------------

  private async chat(text: string, alreadyPrinted = false): Promise<void> {
    if (!this.token) { this.print([{ kind: 'system', text: 'sign in with your wallet first: it is the account here.', suggest: ['/connect'] }]); return; }
    if (this.agentState !== 'ready') {
      const left = (this.elig?.required ?? 3) - (this.elig?.swaps ?? 0);
      this.print([{ kind: 'system', text: this.agentState === 'locked' ? 'your agent unlocks at ' + (this.elig?.required ?? 3) + ' verified swaps from this wallet; ' + Math.max(0, left) + ' to go.' : 'your agent is not reachable right now.', suggest: this.agentState === 'locked' ? ['/swap 0.05 ETH USDG', '/eligible'] : ['/connect'] }]);
      return;
    }
    void alreadyPrinted;
    this.agentState = 'thinking';
    this.agentError = null;
    this.print([{ kind: 'agent', text: '', streaming: true }]);
    const { url, headers } = this.obs.myAgentStream(this.token);
    let acc = '';
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text }) });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
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
          let ev: { type: string; text?: string; message?: string };
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === 'delta') { acc += ev.text ?? ''; this.zone.run(() => this.updateLast({ text: acc, streaming: true })); }
          else if (ev.type === 'final') { acc = ev.text || acc; this.zone.run(() => this.updateLast({ text: acc, streaming: true })); }
          else if (ev.type === 'error') { acc = acc || (ev.message || 'your agent could not respond just now'); }
        }
      }
      this.updateLast({ text: acc || 'no reply came back. try again.', streaming: false });
    } catch (e: any) {
      this.updateLast({ text: acc || this.reason(e), streaming: false });
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
    if (!p || !this.wallet) { this.print([{ kind: 'system', text: 'connect first.', suggest: ['/connect'] }]); return; }
    const hex: string = await p.request({ method: 'eth_getBalance', params: [this.wallet, 'latest'] });
    this.print([{ kind: 'output', text: this.short(this.wallet) + ': ' + (Number(BigInt(hex)) / 1e18).toFixed(5) + ' ETH on chain ' + this.chainId }]);
  }

  private fetchQuote(amount: number, from: string, to: string): Promise<ObsConsoleQuote> {
    return this.get<ObsConsoleQuote>(this.obs.consoleQuote(from, to, amount, this.wallet || '0x000000000000000000000000000000000000dEaD'));
  }

  private showQuote(q: ObsConsoleQuote): void {
    const cost = q.pool.costPct != null ? ', all in ' + q.pool.costPct.toFixed(2) + '% against the mark' : '';
    const lines: CliLine[] = [{ kind: 'output', text: q.amountIn + ' ' + q.from + ' -> ' + q.pool.amountOut + ' ' + q.to + ' through the pools (' + q.pool.route.join(' then ') + cost + '); floor ' + q.pool.minOut }];
    if (q.relay) { lines.push({ kind: 'output', text: q.relay.amountOut != null ? 'the app\'s Relay route pays ' + q.relay.amountOut + ' ' + q.to + (q.relay.feeUsd != null ? ' with $' + q.relay.feeUsd.toFixed(2) + ' of fees' : '') : 'Relay: ' + (q.relay.error || 'no quote') }); }
    const approvals = q.steps.filter((st) => st.id !== 'swap');
    lines.push({ kind: 'output', text: approvals.length ? 'your wallet signs ' + (approvals.length + 1) + ' transactions: ' + q.steps.map((st) => st.note).join('; ') : 'one transaction to sign: ' + q.steps[q.steps.length - 1].note, suggest: ['/swap ' + q.amountIn + ' ' + q.from + ' ' + q.to] });
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
    if (!p || !this.wallet) { this.print([{ kind: 'system', text: 'connect first: the swap is signed by your wallet.', suggest: ['/connect'] }]); return; }
    if (this.chainId !== ConsoleComponent.CHAIN_ID) { await this.ensureChain(p); if (this.chainId !== ConsoleComponent.CHAIN_ID) { this.print([{ kind: 'error', text: 'switch your wallet to Robinhood Chain first.' }]); return; } }
    const q = await this.fetchQuote(amount, from, to);
    this.showQuote(q);
    let swapHash: string | null = null;
    for (const st of q.steps) {
      this.print([{ kind: 'system', text: 'sign in your wallet: ' + st.note }]);
      const hash: string = await p.request({ method: 'eth_sendTransaction', params: [{ from: this.wallet, to: st.to, data: st.data, value: this.hex(st.value) }] });
      this.print([{ kind: 'system', text: 'sent ' + hash.slice(0, 12) + '…, waiting for the chain' }]);
      const r = await this.waitReceipt(p, hash);
      if (!r.ok) { this.print([{ kind: 'error', text: (st.id === 'swap' ? 'the swap' : 'the approval') + ' did not succeed (' + r.status + '). nothing else was sent.' }]); return; }
      if (st.id === 'swap') { swapHash = hash; } else { this.print([{ kind: 'output', text: 'approval landed' }]); }
    }
    if (!swapHash) { return; }
    this.print([{ kind: 'output', text: 'swap landed: ' + ConsoleComponent.EXPLORER + '/tx/' + swapHash }]);
    const reply: any = await this.get<any>(this.obs.consoleSwap({ address: this.wallet, txHash: swapHash, from: q.from, to: q.to, amountIn: q.amountIn })).catch((e) => e?.error ?? e);
    if (reply?.ok) {
      this.elig = reply.eligibility ?? this.elig;
      const got = reply.swap?.amountOut != null ? ', ' + reply.swap.amountOut + ' ' + q.to + ' arrived' : '';
      const e = reply.eligibility;
      this.print([{ kind: 'output', text: 'verified on the chain' + got + '. ' + (e ? e.swaps + ' of ' + e.required + ' swaps' + (e.eligible ? ': eligible.' : '.') : ''), suggest: e?.eligible ? [] : ['/eligible'] }]);
      if (e?.eligible && this.token && this.agentState !== 'ready') { await this.afterSignIn(false); }
    } else {
      this.print([{ kind: 'error', text: 'the desk could not verify it yet: ' + (reply?.reason || reply?.error || 'no answer') + '. type /eligible in a minute.', suggest: ['/eligible'] }]);
    }
  }
}
