import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ObsDeskService, ObsConsoleQuote, ObsEligibility } from '../../service/obs-desk.service';

/**
 * The OBS console: the desk's command line for a person with their own wallet, at /console. The same commands as
 * the obs CLI in the agent-obs repo. Reads come from the public API; a quote comes from the desk's router on the
 * pools; a swap is signed by the visitor's own wallet (EIP-1193, the provider the browser exposes) and paid to
 * their address in the same transaction, then verified by the desk on the chain and counted toward running their
 * own agent. Nothing here holds a key or sends for anyone.
 */
@Component({
  selector: 'app-console',
  templateUrl: './console.component.html',
  styleUrls: ['./console.component.css']
})
export class ConsoleComponent implements AfterViewInit, OnDestroy {
  @ViewChild('screen') screen?: ElementRef<HTMLDivElement>;
  @ViewChild('cmd') cmd?: ElementRef<HTMLInputElement>;

  lines: Array<{ cls: string; text: string }> = [];
  wallet: string | null = null;
  chainId: number | null = null;
  elig: ObsEligibility | null = null;
  busy = false;

  private history: string[] = [];
  private histAt = -1;
  private listening = false;
  private static readonly CHAIN_ID = 4663;
  private static readonly CHAIN_HEX = '0x1237';
  private static readonly EXPLORER = 'https://robinhoodchain.blockscout.com';

  constructor(private obs: ObsDeskService, private zone: NgZone, title: Title, meta: Meta) {
    title.setTitle('Obscura - OBS Console');
    meta.updateTag({ name: 'description', content: 'The OBS console: read the desk, quote and swap from your own wallet, and unlock your own agent.' });
  }

  ngAfterViewInit(): void {
    this.print('OBS console. The desk\'s command line: read what it is doing, quote a pair through its router, swap from your own wallet.', 'dim');
    this.print('Three verified swaps make your wallet eligible to run your own agent. Type help.', 'dim');
    void this.silentReconnect();
    setTimeout(() => this.focusInput(), 0);
  }

  ngOnDestroy(): void { /* the provider listeners are harmless after the page is gone */ }

  focusInput(): void {
    const el = this.cmd?.nativeElement;
    if (el && !this.busy && (typeof window === 'undefined' || !window.getSelection()?.toString())) { el.focus(); }
  }

  short(address: string): string {
    return address.slice(0, 6) + '…' + address.slice(-4);
  }

  onWalletPill(ev: Event): void {
    ev.stopPropagation();
    void this.run(this.wallet ? 'status' : 'connect');
  }

  submit(ev: Event): void {
    ev.preventDefault();
    const el = this.cmd?.nativeElement;
    if (!el) { return; }
    const line = el.value;
    el.value = '';
    void this.run(line);
  }

  onKey(ev: KeyboardEvent): void {
    const el = this.cmd?.nativeElement;
    if (!el || !this.history.length) { return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); this.histAt = Math.max(0, this.histAt < 0 ? this.history.length - 1 : this.histAt - 1); el.value = this.history[this.histAt]; }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); if (this.histAt < 0) { return; } this.histAt = this.histAt + 1; if (this.histAt >= this.history.length) { this.histAt = -1; el.value = ''; } else { el.value = this.history[this.histAt]; } }
  }

  // ---- printing ----------------------------------------------------------

  private print(text: string, cls = ''): void {
    this.lines.push({ cls, text });
    if (this.lines.length > 500) { this.lines.splice(0, this.lines.length - 500); }
    setTimeout(() => { const el = this.screen?.nativeElement; if (el) { el.scrollTop = el.scrollHeight; } }, 0);
  }

  private clock(ts: number): string {
    const d = new Date(ts);
    return d.toISOString().slice(11, 16) + 'Z';
  }

  private usd(v: number | null | undefined, digits = 0): string {
    return v == null || !isFinite(v) ? 'n/a' : (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  private pct(v: number | null | undefined): string {
    return v == null || !isFinite(v) ? 'n/a' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  }

  private reason(e: any): string {
    const m = e?.error?.error || e?.error?.reason || e?.data?.message || e?.message || String(e);
    return String(m).replace(/\s+/g, ' ').slice(0, 220);
  }

  private get<T>(o: { subscribe: (h: { next: (v: T) => void; error: (e: any) => void }) => unknown }): Promise<T> {
    return new Promise<T>((res, rej) => o.subscribe({ next: res, error: rej }));
  }

  // ---- the grammar, the same as the obs CLI --------------------------------

  private parse(line: string): { kind: string; n?: number; amount?: number; from?: string; to?: string; text?: string } {
    const t = (line || '').trim().replace(/^obs\s+/i, '');
    if (!t) { return { kind: 'empty' }; }
    const [head, ...rest] = t.split(/\s+/);
    const w = head.toLowerCase();
    const n = rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : undefined;
    switch (w) {
      case 'help': case '?': return { kind: 'help' };
      case 'connect': return { kind: 'connect' };
      case 'disconnect': return { kind: 'disconnect' };
      case 'status': return { kind: 'status' };
      case 'positions': case 'book': return { kind: 'positions' };
      case 'thoughts': case 'thought': return { kind: 'thoughts', n };
      case 'research': case 'log': return { kind: 'research', n };
      case 'watch': case 'live': return { kind: 'watch' };
      case 'reads': case 'read': return { kind: 'reads' };
      case 'eligible': case 'progress': return { kind: 'eligible' };
      case 'balance': case 'balances': case 'bal': return { kind: 'balance' };
      case 'clear': case 'cls': return { kind: 'clear' };
      case 'quote': case 'swap': {
        const m = rest.join(' ').match(/^([\d,]*\d(?:\.\d+)?)\s+([A-Za-z0-9]+)\s*(?:->|to|for)?\s+([A-Za-z0-9]+)$/i);
        const amount = m ? Number(m[1].replace(/,/g, '')) : NaN;
        if (m && amount > 0) { return { kind: w, amount, from: m[2].toUpperCase(), to: m[3].toUpperCase() }; }
        return { kind: 'unknown', text: t };
      }
      default: return { kind: 'unknown', text: t };
    }
  }

  async run(line: string): Promise<void> {
    const c = this.parse(line);
    if (c.kind === 'empty') { return; }
    this.print('obs> ' + line.trim(), 'you');
    if (this.history[this.history.length - 1] !== line.trim()) { this.history.push(line.trim()); }
    this.histAt = -1;
    if (this.busy) { this.print('still working on the last command', 'warn'); return; }
    this.busy = true;
    try {
      switch (c.kind) {
        case 'help': this.help(); break;
        case 'clear': this.lines = []; break;
        case 'connect': await this.connect(); break;
        case 'disconnect': this.wallet = null; this.elig = null; this.print('disconnected on this page; your wallet keeps its own connection', 'dim'); break;
        case 'status': await this.status(); break;
        case 'positions': await this.positions(); break;
        case 'thoughts': await this.thoughts(c.n ?? 3); break;
        case 'research': await this.research(c.n ?? 12); break;
        case 'watch': await this.watch(); break;
        case 'reads': await this.reads(); break;
        case 'eligible': await this.eligible(false); break;
        case 'balance': await this.balance(); break;
        case 'quote': this.showQuote(await this.fetchQuote(c.amount as number, c.from as string, c.to as string)); break;
        case 'swap': await this.swap(c.amount as number, c.from as string, c.to as string); break;
        default: this.print('not a command: ' + c.text + '. Type help.', 'bad');
      }
    } catch (e: any) {
      this.print('failed: ' + this.reason(e), 'bad');
    } finally {
      this.busy = false;
      setTimeout(() => this.focusInput(), 0);
    }
  }

  private help(): void {
    const rows: Array<[string, string]> = [
      ['status', 'the desk: equity, PnL, entries today, what it holds'],
      ['positions', 'open positions and the last day\'s closed trades'],
      ['thoughts [n]', 'the desk\'s last decisions, in its own words'],
      ['research [n]', 'what it read between cycles: launches, tapes, holders'],
      ['watch', 'the live watch: every pool in play right now'],
      ['reads', 'the chain as the desk reads it: prices, the OBS market'],
      ['connect', 'your wallet, on Robinhood Chain'],
      ['balance', 'ETH in your wallet'],
      ['quote 0.05 ETH USDG', 'what the pools pay, with the app\'s Relay route beside it'],
      ['swap 0.05 ETH USDG', 'the same, signed by your wallet, paid to your address'],
      ['eligible', 'your verified swaps against the bar that unlocks your own agent'],
      ['clear', 'wipe the screen'],
    ];
    for (const [k, v] of rows) { this.print(k.padEnd(22) + v, 'dim'); }
    this.print('Tokens: ETH, USDG, NVDA and any token the desk is watching, by symbol. The same commands run in the repo as the obs CLI.', 'dim');
  }

  // ---- reads through the public API ----------------------------------------

  private async status(): Promise<void> {
    const s = await this.get<any>(this.obs.status());
    const d = s.desk; const r = s.rails;
    this.print('equity ' + this.usd(d.equityUsd) + '  pnl ' + this.usd(d.pnlUsd) + ' (' + this.pct(d.pnlPct) + ')  capital ' + this.usd(d.netCapitalUsd) + '  last cycle ' + (d.lastThoughtAt ? this.clock(d.lastThoughtAt) : 'n/a'), 'ok');
    if (r) { this.print('trading ' + (r.tradingOn ? 'on' : 'off') + '  entries today ' + (r.entriesToday ?? '?') + ' of ' + (r.maxEntriesPerDay ?? '?') + '  size ' + this.usd(r.maxSwapUsd) + ' a trade  open orders ' + r.openOrders, 'dim'); }
    if (s.wallet?.address) { this.print('the desk\'s wallet ' + s.wallet.address + '  ' + s.wallet.explorerUrl, 'dim'); }
    const p = await this.get<any>(this.obs.pnl(24));
    const held = (p.positions || []).filter((x: any) => x.asset !== 'ETH');
    this.print(held.length ? 'holding ' + held.map((x: any) => x.asset + ' ' + this.usd(x.valueUsd) + ' (' + this.pct(x.unrealizedPct) + ')').join(', ') : 'holding nothing but ETH', held.length ? '' : 'dim');
  }

  private async positions(): Promise<void> {
    const p = await this.get<any>(this.obs.pnl(24));
    this.print('positions', 'head');
    for (const x of p.positions || []) { this.print((x.asset as string).padEnd(10) + this.usd(x.valueUsd, 2).padStart(12) + '  ' + this.pct(x.unrealizedPct).padStart(8) + '  share ' + Math.round((x.share || 0) * 100) + '%'); }
    const closed = (p.closed || []).slice(0, 10);
    if (closed.length) {
      this.print('closed, last 24 hours', 'head');
      for (const c of closed) { this.print(this.clock(c.closedAt) + '  ' + (c.asset as string).padEnd(10) + this.usd(c.resultUsd, 2).padStart(10) + '  ' + c.heldMin + ' min  ' + c.how, c.resultUsd >= 0 ? 'ok' : 'bad'); }
    }
  }

  private async thoughts(n: number): Promise<void> {
    const t = await this.get<any>(this.obs.thoughts(Math.max(1, Math.min(20, n))));
    for (const x of (t.items || [])) {
      this.print(this.clock(x.at) + '  ' + (x.decision?.kind === 'propose-swap' ? 'swap ' + x.decision.amount + ' ' + x.decision.from + ' -> ' + x.decision.to : 'hold'), 'head');
      for (const l of (x.thoughts || []).slice(0, 4)) { this.print('  ' + l); }
      if (x.decision?.reason) { this.print('  reason: ' + x.decision.reason, 'dim'); }
    }
  }

  private async research(n: number): Promise<void> {
    const r = await this.get<any>(this.obs.research(Math.max(1, Math.min(50, n))));
    for (const x of (r.items || []).slice().reverse()) { this.print(this.clock(x.at) + '  ' + (x.kind as string).padEnd(11) + x.line, x.ok === false ? 'bad' : x.ok === true ? 'ok' : ''); }
  }

  private async watch(): Promise<void> {
    const l = await this.get<any>(this.obs.live());
    this.print((l.live ? 'live' : 'not live') + ' at block ' + (l.block ?? '?') + (l.lastTrigger ? '  last trigger: ' + l.lastTrigger : ''), l.live ? 'ok' : 'warn');
    for (const w of l.watching || []) { this.print((w.symbol as string).padEnd(10) + (w.role as string).padEnd(7) + (w.trend || '').padEnd(14) + (w.why || ''), w.role === 'held' ? 'ok' : ''); }
    if (!(l.watching || []).length) { this.print('nothing on watch right now', 'dim'); }
  }

  private async reads(): Promise<void> {
    const r = await this.get<any>(this.obs.reads());
    this.print('ETH ' + this.usd(r.prices?.ethUsd, 2) + '  BTC ' + this.usd(r.prices?.btcUsd, 0), 'ok');
    if (r.token) { this.print('$OBS ' + r.token.address + (r.token.explorerPriceUsd != null ? '  price ' + this.usd(r.token.explorerPriceUsd, 6) : '') + (r.token.holders != null ? '  holders ' + r.token.holders : ''), 'dim'); }
    if (r.market) { this.print('OBS market: ' + JSON.stringify(r.market).slice(0, 200), 'dim'); }
  }

  // ---- the wallet ---------------------------------------------------------------

  private provider(): any {
    return typeof window !== 'undefined' ? (window as any).ethereum ?? null : null;
  }

  private async silentReconnect(): Promise<void> {
    const p = this.provider();
    if (!p) { return; }
    try {
      const accs: string[] = await p.request({ method: 'eth_accounts' });
      if (accs && accs.length) {
        this.wallet = accs[0];
        const c: string = await p.request({ method: 'eth_chainId' });
        this.chainId = parseInt(c, 16);
        this.listen(p);
        await this.eligible(true);
        this.print('wallet ' + this.short(this.wallet) + ' is connected' + (this.chainId === ConsoleComponent.CHAIN_ID ? ' on Robinhood Chain' : ' on chain ' + this.chainId), 'dim');
      }
    } catch { /* not connected: fine */ }
  }

  private listen(p: any): void {
    if (this.listening) { return; }
    this.listening = true;
    p.on?.('accountsChanged', (a: string[]) => this.zone.run(() => { this.wallet = a?.[0] ?? null; this.elig = null; this.print(this.wallet ? 'wallet switched to ' + this.short(this.wallet) : 'wallet disconnected', 'dim'); if (this.wallet) { void this.eligible(true); } }));
    p.on?.('chainChanged', (c: string) => this.zone.run(() => { this.chainId = parseInt(c, 16); }));
  }

  private async connect(): Promise<void> {
    const p = this.provider();
    if (!p) { this.print('no wallet found in this browser. Install MetaMask or Rabby, or open this page inside your wallet\'s browser.', 'bad'); return; }
    const accs: string[] = await p.request({ method: 'eth_requestAccounts' });
    this.wallet = accs?.[0] ?? null;
    if (!this.wallet) { this.print('the wallet gave no account', 'bad'); return; }
    await this.ensureChain(p);
    this.listen(p);
    this.print('connected ' + this.short(this.wallet) + (this.chainId === ConsoleComponent.CHAIN_ID ? ' on Robinhood Chain' : ' on chain ' + this.chainId + '; switch to Robinhood Chain to swap'), this.chainId === ConsoleComponent.CHAIN_ID ? 'ok' : 'warn');
    await this.eligible(true);
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

  private async balance(): Promise<void> {
    const p = this.provider();
    if (!p || !this.wallet) { this.print('connect first', 'warn'); return; }
    const hex: string = await p.request({ method: 'eth_getBalance', params: [this.wallet, 'latest'] });
    this.print(this.short(this.wallet) + ': ' + (Number(BigInt(hex)) / 1e18).toFixed(5) + ' ETH on chain ' + this.chainId, 'ok');
  }

  private async eligible(quiet: boolean): Promise<void> {
    if (!this.wallet) { if (!quiet) { this.print('connect first', 'warn'); } return; }
    const e = await this.get<ObsEligibility>(this.obs.consoleEligible(this.wallet));
    this.elig = e;
    if (quiet && !e.swaps) { return; }
    this.print(e.swaps + ' of ' + e.required + ' verified swaps' + (e.eligible ? ': eligible. Your agent is yours to run: github.com/ObscuraMarket/agent-obs, QUICKSTART.md' : ''), e.eligible ? 'ok' : '');
    for (const r of e.recent.slice(0, 5)) { this.print('  ' + this.clock(r.at) + '  ' + r.amountIn + ' ' + r.from + ' -> ' + (r.amountOut != null ? r.amountOut + ' ' : '') + r.to + '  ' + r.txHash.slice(0, 10) + '…', 'dim'); }
  }

  // ---- quote and swap -------------------------------------------------------------

  private fetchQuote(amount: number, from: string, to: string): Promise<ObsConsoleQuote> {
    return this.get<ObsConsoleQuote>(this.obs.consoleQuote(from, to, amount, this.wallet || '0x000000000000000000000000000000000000dEaD'));
  }

  private showQuote(q: ObsConsoleQuote): void {
    const cost = q.pool.costPct != null ? ', all in ' + q.pool.costPct.toFixed(2) + '% against the mark' : '';
    this.print(q.amountIn + ' ' + q.from + ' -> ' + q.pool.amountOut + ' ' + q.to + ' through the pools (' + q.pool.route.join(' then ') + cost + '); floor ' + q.pool.minOut, 'ok');
    if (q.relay) { this.print(q.relay.amountOut != null ? 'the app\'s Relay route pays ' + q.relay.amountOut + ' ' + q.to + (q.relay.feeUsd != null ? ' with $' + q.relay.feeUsd.toFixed(2) + ' of fees' : '') : 'Relay: ' + (q.relay.error || 'no quote'), 'dim'); }
    const approvals = q.steps.filter((st) => st.id !== 'swap');
    this.print(approvals.length ? 'your wallet signs ' + (approvals.length + 1) + ' transactions: ' + q.steps.map((st) => st.note).join('; ') : 'one transaction to sign: ' + q.steps[q.steps.length - 1].note, 'dim');
  }

  private hex(v: string): string {
    return '0x' + BigInt(v).toString(16);
  }

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
    if (!p || !this.wallet) { this.print('connect first: the swap is signed by your wallet', 'warn'); return; }
    if (this.chainId !== ConsoleComponent.CHAIN_ID) { await this.ensureChain(p); if (this.chainId !== ConsoleComponent.CHAIN_ID) { this.print('switch your wallet to Robinhood Chain first', 'bad'); return; } }
    const q = await this.fetchQuote(amount, from, to);
    this.showQuote(q);
    let swapHash: string | null = null;
    for (const st of q.steps) {
      this.print('sign: ' + st.note, 'warn');
      const hash: string = await p.request({ method: 'eth_sendTransaction', params: [{ from: this.wallet, to: st.to, data: st.data, value: this.hex(st.value) }] });
      this.print('sent ' + hash.slice(0, 12) + '…, waiting for the chain', 'dim');
      const r = await this.waitReceipt(p, hash);
      if (!r.ok) { this.print((st.id === 'swap' ? 'the swap' : 'the approval') + ' did not succeed (' + r.status + '). Nothing else was sent.', 'bad'); return; }
      if (st.id === 'swap') { swapHash = hash; } else { this.print('approval landed', 'ok'); }
    }
    if (!swapHash) { return; }
    this.print('swap landed: ' + ConsoleComponent.EXPLORER + '/tx/' + swapHash, 'ok');
    const reply: any = await this.get<any>(this.obs.consoleSwap({ address: this.wallet, txHash: swapHash, from: q.from, to: q.to, amountIn: q.amountIn })).catch((e) => e?.error ?? e);
    if (reply?.ok) {
      this.elig = reply.eligibility ?? this.elig;
      const got = reply.swap?.amountOut != null ? ', ' + reply.swap.amountOut + ' ' + q.to + ' arrived' : '';
      this.print('verified on the chain' + got + '. ' + (reply.eligibility ? reply.eligibility.swaps + ' of ' + reply.eligibility.required + ' swaps' + (reply.eligibility.eligible ? ': eligible. Your agent is yours to run.' : '.') : ''), 'ok');
    } else {
      this.print('the desk could not verify it yet: ' + (reply?.reason || reply?.error || 'no answer') + '. Type eligible in a minute.', 'warn');
    }
  }
}
