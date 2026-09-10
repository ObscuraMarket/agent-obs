import { AfterViewInit, Component, ElementRef, HostListener, Inject, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';

import { timeout } from 'rxjs';
import { REFRESH_MS, nextRefreshMs, tickStatus } from './refresh';
import { MONTHS, agentsSummary, shortPct, sinceText, sinceTitle, visibleAgents, wholeUsd } from './agents';
import { SPARK_H, SPARK_W, Spark, sparkline } from './sparkline';
import {
  CgMarket, ObsDashboard, ObsDeskService, ObsInFlight, ObsMarket, ObsPnl, ObsPosition, ObsClosedTrade, ObsPublicAgent,
  ObsAgentToken, ObsLive, ObsReads, ObsResearchEvent, ObsStatus, ObsThought, ObsTokenDigest, ObsTrade, ObsWatchEvent,
  ObsMyAgentBook, ObsMyAgentBookTrade, ObsAgentDetail, ObsSession, CONSOLE_WALLET, ConsoleWallet, readConsoleSession, dropConsoleSession
} from '../../service/obs-desk.service';

type MarketAssetId = 'agent' | 'obs' | 'eth' | 'usdg' | 'btc' | 'bnb' | 'sol';

/** One slot of the marquee: a token mark (ETH, USDG, OBS or a tokenized stock) or a realised PnL figure. */
interface MarqueeItem { kind: 'eth' | 'usdg' | 'obs' | 'stock' | 'pnl'; value?: string; src?: string; }

/** Tokenized-stock coins that can roll through the marquee (see assets/images/tokenized-stocks). */
const MARQUEE_STOCKS = ['aapl', 'amzn', 'googl', 'mcd', 'meta', 'msft', 'nflx', 'nvda', 'pypl', 'tsla'];

/** One cell of a six-cell strip (stats, portfolio). */
interface StatCell { lbl: string; val: string; valCls?: string; sub?: string; subCls?: string; /** Clicking the cell copies this. */ copy?: string; }

/** One chip of the live trades ticker. */
interface TickerChip { side: string; sideCls: string; asset: string; amt: string; status: string; }

/** Items queued for the terminal's typewriter. */
interface TermItem { row: HTMLElement; tx: HTMLElement; text: string; animate: boolean; node?: HTMLElement; }

const STABLE: { [asset: string]: 1 } = { USDG: 1, USDC: 1, USDT: 1, DAI: 1 };
const TERM_LINE_CAP = 700;
/**
 * A thought or a trade on the stream refreshes the panels a moment later, once the ledger write behind it has landed.
 * Six seconds: past the API's five-second cache of the one read, so the refresh is never answered from an assembly
 * older than the event (2026-09-08).
 */
const EVENT_REFRESH_MS = 6_000;
/** CoinGecko's free API refreshes about once a minute; asking it more often only spends the viewer's budget. */
const CG_EVERY_MS = 60_000;
/** How long a book read (the owner's, or the open agent's) waits for an answer before the next tick may try again. */
const MY_BOOK_TIMEOUT_MS = 20_000;
/** The hours of series the one read asks for: a week, what the page has always read. The positions and the closed trades ride on the same read. */
const DASHBOARD_HOURS = 168;

/**
 * The OBS desk: every feature of agent-obs's newest dashboard (the typewriter
 * terminal over SSE, positions with their PnL, the trades ticker) rendered in
 * OUR design language, the house cards, Plus Jakarta Sans, the lime accent,
 * shimmer on every section title, the mask background video and the
 * ETH-to-PnL marquee.
 */
@Component({
  selector: 'app-agent',
  templateUrl: './agent.component.html',
  styleUrls: ['./agent.component.css']
})
export class AgentComponent implements OnInit, AfterViewInit, OnDestroy {
  status: ObsStatus | null = null;
  pnl: ObsPnl | null = null;
  /**
   * The agents following the desk, as anyone may see them: the API's list less the switched-off blanks (off, no
   * trades, nothing held), which the table hid from 2026-09-08 so a "test" agent stopped sitting in it. The summary
   * counts these rows, not the API's totals. A blank that a deep link (?agent=0x...) opened keeps its row while its
   * panel is open, so the panel always has a row marked open above it; closing leaves the row until the next read.
   */
  agents: ObsPublicAgent[] = [];
  /** The Agents card is hidden for now (2026-09-10); true puts it back as it was. "Your agent" stays either way. */
  readonly showAgents = false;
  /** The API's list as it came, so opening a hidden agent can put its row back without another read. */
  private allAgents: ObsPublicAgent[] = [];
  get agentsSummary(): string { return agentsSummary(this.agents); }
  sinceText(ts: number): string { return sinceText(ts); }
  sinceTitle(ts: number): string { return sinceTitle(ts); }
  wholeUsd(v: number): string { return wholeUsd(v); }
  shortPct(v: number): string { return shortPct(v); }
  // ---- Your agent: the wallet that signed in on the console, its own book, from its own signed read ----
  /** The connected wallet: the site's own connection when the module hands one over, else the browser's provider asked once, silently. */
  myWallet: string | null = null;
  /** The console's stored session for that wallet, read from the same key the console writes; null until a sign-in there. */
  mySession: ObsSession | null = null;
  myBook: ObsMyAgentBook | null = null;
  /** The last trades, newest first, for the card's small table. */
  myTrades: ObsMyAgentBookTrade[] = [];
  /** The book read failed with something other than a 401; the card says so once and keeps what it had. */
  myBookErr = false;
  private myWalletSub?: { unsubscribe(): void };
  private myBookBusy = false;
  /** The book met a 429 and has not answered since: the tick's clock doubles until it does, whatever the dashboard says. */
  private myBookLimited = false;
  /** The browser provider the fallback path listens to, so the listener can be removed on destroy. */
  private myProvider: any = null;
  private readonly onMyAccounts = (accs: string[]) => this.zone.run(() => this.setMyWallet(accs?.[0] ?? null));
  /** What the card shows: one sentence for each state before the book, the book itself after. */
  get myState(): 'no-wallet' | 'no-session' | 'loading' | 'not-started' | 'book' {
    if (!this.myWallet) { return 'no-wallet'; }
    if (!this.mySession) { return 'no-session'; }
    if (!this.myBook) { return 'loading'; }
    if (this.myBook.since == null && !this.myBook.tradeCount) { return 'not-started'; }
    return 'book';
  }
  get mySummary(): string {
    const b = this.myBook;
    if (this.myState !== 'book' || !b) { return this.myWallet ? this.short(this.myWallet) : ''; }
    return `${b.on ? 'on' : 'off'}, ${b.mode}, $${b.sizeUsd} a trade`;
  }
  // ---- The Agents table's open row: one agent's book, for anyone, by the agent's own wallet ----
  /** The agent whose book the panel under the table shows, by its own wallet; null while the panel is closed. */
  pickedWallet: string | null = null;
  picked: ObsAgentDetail | null = null;
  /** Its last trades, newest first, for the panel's table. */
  pickedTrades: ObsMyAgentBookTrade[] = [];
  /** Its realized series drawn: the sparkline's path, baseline and colour. */
  pickedSpark: Spark | null = null;
  /** What the panel says while there is no book to show: reading, gone (a 404), or a read that failed and will try again. */
  pickedState: 'reading' | 'book' | 'gone' | 'failed' = 'reading';
  readonly sparkW = SPARK_W;
  readonly sparkH = SPARK_H;
  private pickedBusy = false;
  /** The detail read met a 429 and has not answered since: carried into the tick's clock with the card's. */
  private pickedLimited = false;
  reads: ObsReads | null = null;
  obsMarket: ObsMarket | null = null;
  agentToken: ObsAgentToken | null = null;
  agentCopied = false;
  err = '';
  /** The parts the desk's last answer left out. Not an error: the API answered, and its chain reads warm for about a minute after a restart. */
  warming = '';

  stats: StatCell[] = [];
  portfolio: StatCell[] = [];

  /** The asset the Market strip is showing; OBS reads locally, the rest CoinGecko. */
  marketAsset: MarketAssetId = 'obs';
  assetMenuOpen = false;
  readonly marketAssets: Array<{ id: MarketAssetId; label: string }> = [
    { id: 'agent', label: 'AOBS' },
    { id: 'obs', label: 'OBS' },
    { id: 'eth', label: 'Ethereum' },
    { id: 'usdg', label: 'USDG' },
    { id: 'btc', label: 'Bitcoin' },
    { id: 'bnb', label: 'Binance Coin' },
    { id: 'sol', label: 'Solana' }
  ];
  private cg: { [id: string]: CgMarket } = {};
  positions: ObsPosition[] = [];
  inFlight: ObsInFlight[] = [];
  posSummary = '';
  /** The day at a glance, above the fold: trades, the ETH count against the start, what the desk is doing now. */
  summary: Array<{ k: string; v: string; cls?: string }> = [];
  closed: ObsClosedTrade[] = [];
  /** How many tapes the live watch follows, from its last line. */
  watchingCount = 0;
  ticker: TickerChip[] = [];
  tickerRoll = false;

  /** Terminal stream state, shown in the header pill and the terminal head. */
  streamState: 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline' = 'connecting';
  copied = false;

  // ETH-to-PnL marquee (kept from our earlier build). ETH marks enter from
  // the left; the slot resting behind the opaque Obscura badge is swapped to
  // a PnL figure while hidden, so it emerges transformed.
  marqueeItems: MarqueeItem[] = [];
  marqueeStepping = false;
  private readonly marqueeCenter = 8;
  private marqueeInterval?: ReturnType<typeof setInterval>;
  private marqueeSwapTimer?: ReturnType<typeof setTimeout>;

  @ViewChild('termEl') termEl?: ElementRef<HTMLDivElement>;

  // Terminal internals (direct DOM: a typewriter over hundreds of lines is
  // not a job for change detection).
  private termQueue: TermItem[] = [];
  private termTyping = false;
  private termCursor: HTMLElement | null = null;
  private termSeeded = false;
  private lastThoughtAt = 0;
  private lastTradeAt = 0;
  private es?: EventSource;
  private esFails = 0;
  /** The page reconnects its own stream: the browser gives up for good when a redeploy answers with a bad status. */
  private esBackoffMs = 3000;
  private esReconnectTimer?: ReturnType<typeof setTimeout>;
  private esLastEventAt = 0;
  private esLivenessTimer?: ReturnType<typeof setInterval>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private typeTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private pendingSeed: { thoughts: ObsThought[]; trades: ObsTrade[]; canExecute: boolean; research?: ObsResearchEvent[] } | null = null;
  private lastResearchAt = 0;

  /** The polling clock: one read of the whole page, fifteen seconds after the last answer, doubling on a 429. */
  private refreshEveryMs = REFRESH_MS;
  private refreshClock?: ReturnType<typeof setTimeout>;
  /** Set on destroy: a read that lands after the person has left the page must not set the clock again. */
  private destroyed = false;
  /** When CoinGecko was last asked for the strip's other assets. */
  private cgAt = 0;

  constructor(private obs: ObsDeskService, private zone: NgZone, @Inject(CONSOLE_WALLET) private siteWallet: ConsoleWallet | null, title: Title, meta: Meta) {
    title.setTitle('Obscura - OBS Desk');
    meta.updateTag({
      name: 'description',
      content:
        'OBS is Obscura\'s own trading agent. Watch his public reasoning every desk cycle, '
        + 'his swaps through Obscura, and the desk PnL marked to market.'
    });
  }

  /**
   * A tab in the background can keep a stream connection that is dead without knowing it, and its timers slow to a
   * crawl; the terminal then sits where it was, minutes behind. When the tab comes back, a stale stream is reopened
   * at once (the hello replays every line missed, in order) and the panels refresh, which also restarts the polling
   * clock that stopped while the tab was hidden.
   */
  private readonly onVisible = () => {
    if (document.hidden) { return; }
    if (this.es && Date.now() - this.esLastEventAt > 20_000) {
      this.es.close();
      this.es = undefined;
      this.connect();
    }
    this.refresh();
  };

  ngOnInit(): void {
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onVisible);
    window.addEventListener('pageshow', this.onVisible);
    // ?agent=0x... opens that agent's panel before the first read goes out, so the read includes it.
    this.openAgentFromUrl();
    // The first read sets the clock; every answer sets the next.
    this.refresh();
    this.watchMyWallet();
    this.startMarquee();
    // The stream and the typewriter run outside Angular: a 9ms typing tick
    // must not drive change detection. Bound state re-enters via zone.run.
    this.zone.runOutsideAngular(() => this.connect());
  }

  ngAfterViewInit(): void {
    if (this.pendingSeed) {
      const s = this.pendingSeed;
      this.pendingSeed = null;
      this.seed(s.thoughts, s.trades, s.canExecute, s.research || []);
    }
  }

  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onVisible);
    window.removeEventListener('pageshow', this.onVisible);
    this.destroyed = true;
    this.myWalletSub?.unsubscribe();
    this.myProvider?.removeListener?.('accountsChanged', this.onMyAccounts);
    if (this.refreshClock) { clearTimeout(this.refreshClock); }
    this.es?.close();
    if (this.pollTimer) { clearInterval(this.pollTimer); }
    if (this.esReconnectTimer) { clearTimeout(this.esReconnectTimer); }
    if (this.esLivenessTimer) { clearInterval(this.esLivenessTimer); }
    if (this.typeTimer) { clearTimeout(this.typeTimer); }
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    if (this.marqueeInterval) { clearInterval(this.marqueeInterval); }
    if (this.marqueeSwapTimer) { clearTimeout(this.marqueeSwapTimer); }
  }

  // ---- data ------------------------------------------------------------

  /**
   * One read for the whole page: /api/obs/dashboard carries every payload the page used to poll one route at a time
   * (nine requests every fifteen seconds from an idle tab, hidden or not, until 2026-09-08), fanned out here to the
   * same fields. A hidden tab reads nothing and its clock stops; the tab coming back reads once and the clock
   * restarts (onVisible). A 429 doubles the wait until a read succeeds. The dashboard's answer alone sets the
   * clock, once per tick, and carries the book's 429 with it (tickStatus): the two answers used to race and the
   * book's 429 lost whenever it answered first (2026-09-08).
   */
  refresh(): void {
    if (document.hidden) { return; }
    this.err = '';
    this.warming = '';
    this.obs.dashboard(DASHBOARD_HOURS, 30, 8).subscribe({
      next: (d) => { this.applyDashboard(d); this.scheduleRefresh(tickStatus(null, this.myBookLimited || this.pickedLimited)); },
      error: (e: { status?: number }) => { this.err = 'dashboard'; this.scheduleRefresh(tickStatus(e?.status ?? 0, this.myBookLimited || this.pickedLimited)); }
    });
    this.refreshAssetMarkets();
    this.refreshMyAgent();
    this.refreshPicked();
  }

  // ---- the open agent -------------------------------------------------

  isPicked(a: ObsPublicAgent): boolean {
    return !!a.walletAddress && !!this.pickedWallet && a.walletAddress.toLowerCase() === this.pickedWallet.toLowerCase();
  }

  /**
   * A click anywhere on a row opens its agent; the name button handles its own click (it stops propagation), so the
   * guard keeps a button, or any future link in the row, from toggling twice (the wallet link moved into the panel
   * 2026-09-08; the name is a button too, for the keyboard).
   */
  rowClick(a: ObsPublicAgent, ev: Event): void {
    const t = ev.target as HTMLElement | null;
    if (t?.closest?.('a, button')) { return; }
    this.toggleAgent(a);
  }

  /** The row's name button: opens the agent's book below the table, or closes it when it is the one open. */
  toggleAgent(a: ObsPublicAgent): void {
    if (!a.walletAddress) { return; }
    if (this.isPicked(a)) { this.closeAgent(); return; }
    this.pickAgent(a.walletAddress, true, true);
  }

  closeAgent(): void {
    this.pickedWallet = null;
    this.picked = null;
    this.pickedTrades = [];
    this.pickedSpark = null;
    this.pickedState = 'reading';
    this.pickedLimited = false;
    this.setAgentParam(null);
  }

  /**
   * The panel opens on this agent and reads its book at once; the page's clock re-reads it on every tick after.
   * The address bar carries the choice (?agent=0x...) so the page can be shared open on one agent, and the same
   * parameter on load opens it (writeUrl false: the bar already says so). replaceState rather than the router: the
   * site serves this page at /agent and opening a row is not a navigation to go back from (2026-09-08).
   */
  private pickAgent(wallet: string, writeUrl: boolean, focus = false): void {
    this.pickedWallet = wallet;
    this.agents = visibleAgents(this.allAgents, wallet);
    this.picked = null;
    this.pickedTrades = [];
    this.pickedSpark = null;
    this.pickedState = 'reading';
    this.pickedLimited = false;
    if (writeUrl) { this.setAgentParam(wallet); }
    this.refreshPicked();
    // Focus follows a click into the panel, which also brings it into view under a long table; not on a deep link, where the page is still settling.
    if (focus && typeof requestAnimationFrame === 'function') { requestAnimationFrame(() => document.getElementById('agent-panel')?.focus()); }
  }

  /**
   * The open agent's book, on the page's clock: called from refresh(), so it shares the cadence, the hidden-tab pause
   * and the 429 backoff (its 429 rides into the clock with the card's, through tickStatus), and once when a row
   * opens. A 404 is an agent that no longer follows: the panel says so and the next tick asks again. An answer for
   * a row closed or swapped while the read was out is dropped.
   */
  private refreshPicked(): void {
    const wallet = this.pickedWallet;
    if (!wallet || document.hidden || this.pickedBusy) { return; }
    this.pickedBusy = true;
    this.obs.agentDetail(wallet).pipe(timeout(MY_BOOK_TIMEOUT_MS)).subscribe({
      next: (d) => {
        this.pickedBusy = false;
        if (this.pickedWallet !== wallet) { return; }
        this.pickedLimited = false;
        this.picked = d;
        this.pickedTrades = [...(d.trades || [])].reverse();
        this.pickedSpark = sparkline(d.series || []);
        this.pickedState = 'book';
      },
      error: (e: { status?: number }) => {
        this.pickedBusy = false;
        if (this.pickedWallet !== wallet) { return; }
        if (e?.status === 404) { this.picked = null; this.pickedTrades = []; this.pickedSpark = null; this.pickedState = 'gone'; return; }
        if (e?.status === 429) { this.pickedLimited = true; }
        this.pickedState = 'failed';
      }
    });
  }

  /** The choice in the address bar, every other parameter kept (?api= among them); a bar that cannot be written changes nothing else. */
  private setAgentParam(wallet: string | null): void {
    if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') { return; }
    try {
      const url = new URL(window.location.href);
      if (wallet) { url.searchParams.set('agent', wallet); } else { url.searchParams.delete('agent'); }
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    } catch { /* the panel is open all the same */ }
  }

  /** ?agent=0x... on load opens that agent; anything that is not a wallet address is ignored. */
  private openAgentFromUrl(): void {
    if (typeof window === 'undefined') { return; }
    try {
      const w = new URLSearchParams(window.location.search).get('agent') || '';
      if (/^0x[0-9a-fA-F]{40}$/.test(w)) { this.pickAgent(w, false); }
    } catch { /* no bar to read */ }
  }

  // ---- your agent ------------------------------------------------------

  /**
   * The wallet the card follows: the site's own connection when the module hands one over (the header's wallet,
   * the one the console signs in with), else the browser's provider asked once for the accounts it already
   * exposes, never a prompt. A wallet arriving or changing re-reads the stored session and the book at once; a
   * disconnect empties the card. This repo's own build provides no site wallet, so it takes the second path.
   */
  private watchMyWallet(): void {
    if (this.siteWallet) {
      this.myWalletSub = this.siteWallet.address$.subscribe((addr) => this.zone.run(() => this.setMyWallet(addr || null)));
      return;
    }
    if (typeof window === 'undefined') { return; }
    // Phantom keeps its Ethereum provider at window.phantom.ethereum and does not always set window.ethereum.
    const w = window as any;
    const p = w.ethereum ?? w.phantom?.ethereum ?? null;
    if (!p || typeof p.request !== 'function') { return; }
    // The call sits inside the chain: a shim whose request() throws before it is initialised threw out of
    // ngOnInit and took the page down (2026-09-08). A wallet connected or switched after load is heard the way
    // the console hears it, so the card follows without a reload.
    Promise.resolve().then(() => p.request({ method: 'eth_accounts' }))
      .then((accs: string[]) => this.zone.run(() => this.setMyWallet(accs?.[0] ?? null)))
      .catch(() => { /* not connected, or the wallet said no: the card asks for a connection */ });
    this.myProvider = p;
    try { p.on?.('accountsChanged', this.onMyAccounts); } catch { /* a provider with no events: the next load sees the wallet */ }
  }

  private setMyWallet(addr: string | null): void {
    const same = !!addr && !!this.myWallet && addr.toLowerCase() === this.myWallet.toLowerCase();
    this.myWallet = addr;
    this.mySession = addr ? readConsoleSession(addr) : null;
    if (!same) { this.myBook = null; this.myTrades = []; this.myBookErr = false; }
    this.refreshMyAgent();
  }

  /**
   * The wallet's own book, on the page's clock: called from refresh(), so it shares the fifteen-second cadence,
   * the hidden-tab pause and the 429 backoff (a 429 here is carried into the clock by the dashboard's answer), and
   * once when the wallet arrives. Nothing is asked without a session; a wallet with none is checked for one on
   * every read, so a sign-in on the console in another tab shows up here on the next read. A 401 drops the stored
   * session the way the console does, and the card asks for a sign-in. The read is given twenty seconds: a socket
   * a proxy held open left the busy flag set and the card reading for minutes (2026-09-08).
   */
  private refreshMyAgent(): void {
    if (document.hidden || this.myBookBusy) { return; }
    if (this.myWallet && !this.mySession) { this.mySession = readConsoleSession(this.myWallet); }
    const s = this.mySession;
    if (!s) { return; }
    this.myBookBusy = true;
    this.obs.myAgentBook(s.token).pipe(timeout(MY_BOOK_TIMEOUT_MS)).subscribe({
      next: (b) => { this.myBookBusy = false; this.myBookLimited = false; this.myBook = b; this.myTrades = [...(b.trades || [])].reverse(); this.myBookErr = false; },
      error: (e: { status?: number }) => {
        this.myBookBusy = false;
        if (e?.status === 401) { dropConsoleSession(); this.mySession = null; this.myBook = null; this.myTrades = []; return; }
        this.myBookErr = true;
        if (e?.status === 429) { this.myBookLimited = true; }
      }
    });
  }

  /** The next read, on the clock: fifteen seconds after a success, doubling on a 429. One clock, set once per tick by the dashboard's answer. */
  private scheduleRefresh(failedStatus: number | null): void {
    if (this.destroyed) { return; }
    this.refreshEveryMs = nextRefreshMs(this.refreshEveryMs, failedStatus);
    if (this.refreshClock) { clearTimeout(this.refreshClock); }
    this.refreshClock = setTimeout(() => { this.refreshClock = undefined; this.refresh(); }, this.refreshEveryMs);
  }

  /**
   * The one read fanned out to the fields each route filled before. A part the API could not read is null: that
   * panel keeps its last value and the footer names the part, as it named the route before. The agent's token and
   * the agents list never raise the footer: the card keeps its placeholders, the list stands.
   */
  private applyDashboard(d: ObsDashboard): void {
    const missing = (['status', 'reads', 'pnl', 'market', 'trades'] as const).filter((k) => !d[k]);
    // A part left out of an answer is not a failure to reach the desk: since 2026-09-09 the API answers with a
    // part missing rather than hanging, and the chain reads take about a minute to warm after a restart. The
    // footer says so in those words; the red line is for an answer that never came.
    this.warming = missing.length ? missing.join(', ') : '';
    if (d.status) { this.status = d.status; }
    if (d.agentToken) { this.agentToken = d.agentToken; }
    if (d.reads) { this.reads = d.reads; }
    if (d.pnl) { this.pnl = d.pnl; this.buildPortfolio(d.pnl); this.buildPositions(d.pnl); }
    if (d.agents) { this.allAgents = d.agents.agents ?? []; this.agents = visibleAgents(this.allAgents, this.pickedWallet); }
    if (d.market) { this.obsMarket = d.market; }
    if (d.trades) { this.buildTicker(d.trades.items); }
    this.buildStats();
  }

  /**
   * CoinGecko's rows for the strip's other assets, read from the browser and not through the desk: the desk's own
   * CoinGecko budget marks its book, and CoinGecko counts by address. Asked only while the strip shows one of those
   * assets, once a minute, and at once when the strip switches to one it has no row for; it was asked every fifteen
   * seconds by every viewer whatever the strip showed (2026-09-08).
   */
  private refreshAssetMarkets(now = false): void {
    if (this.marketAsset === 'obs' || this.marketAsset === 'agent') { return; }
    if (!now && Date.now() - this.cgAt < CG_EVERY_MS) { return; }
    this.cgAt = Date.now();
    this.obs.assetMarkets().subscribe({
      next: (rows) => {
        const map: { [id: string]: MarketAssetId } = {
          ethereum: 'eth', bitcoin: 'btc', binancecoin: 'bnb', solana: 'sol', 'global-dollar': 'usdg'
        };
        rows.forEach((row) => { const k = map[row.id]; if (k) { this.cg[k] = row; } });
        if (this.marketAsset !== 'obs') { this.buildStats(); }
      },
      error: () => {} // the strip keeps its last values if CoinGecko is down
    });
  }

  setMarketAsset(id: MarketAssetId): void {
    this.marketAsset = id;
    this.assetMenuOpen = false;
    this.buildStats();
    this.refreshAssetMarkets(!this.cg[id]);
  }

  get marketAssetLabel(): string {
    return this.marketAssets.find((a) => a.id === this.marketAsset)?.label ?? 'OBS';
  }

  @HostListener('document:click', ['$event'])
  onDocClick(e: Event): void {
    if (this.assetMenuOpen && !(e.target as HTMLElement).closest('.asset-dd')) {
      this.assetMenuOpen = false;
    }
  }

  copyAddress(): void {
    const a = this.status?.wallet?.address;
    if (!a || !navigator.clipboard) { return; }
    navigator.clipboard.writeText(a).then(() => {
      this.copied = true;
      setTimeout(() => this.zone.run(() => { this.copied = false; }), 900);
    }).catch(() => {});
  }

  // ---- view models -----------------------------------------------------

  private buildStats(): void {
    if (this.marketAsset === 'obs') { this.buildStatsObs(); } else if (this.marketAsset === 'agent') { this.buildStatsAgent(); } else { this.buildStatsCg(); }
  }

  /** A "+x.xx% 24h" sub line from a fractional change, coloured by direction. */
  private chgSub(pct: number | null): { sub?: string; subCls?: string } {
    if (pct == null || !isFinite(pct)) { return {}; }
    return { sub: this.pct(pct) + ' 24h', subCls: this.dir(pct) };
  }

  private buildStatsObs(): void {
    const r = this.reads;
    if (!r) { return; }
    const pool = r.market;
    const p = pool?.priceUsd ?? r.token?.explorerPriceUsd ?? null;
    const chg = this.obsMarket?.change24hPct ?? null;
    const supply = this.parseSupply(r.token?.totalSupply);
    const cap = p != null && supply != null ? p * supply : r.token?.marketCapUsd ?? null;
    const rw = r.wallet?.rewards;
    const holders = r.token?.holders ?? null;
    const cash = rw ? rw.rewardsUsd : 0;
    this.stats = [
      { lbl: 'Price', val: this.price(p), ...this.chgSub(chg) },
      // Supply is fixed, so the cap moves exactly with the price.
      { lbl: 'Market cap', val: this.compact(cap), ...this.chgSub(chg) },
      // The changes under volume, liquidity and holders are the API's own, from its samples: the same for every viewer.
      { lbl: 'Vol 24h', val: this.compact(r.token?.volume24hUsd), ...this.chgSub(r.token?.change24h?.volume ?? null) },
      { lbl: 'Liquidity', val: this.compact(pool?.tvlUsd ?? pool?.depthUsd2pct), ...this.chgSub(r.token?.change24h?.liquidity ?? null) },
      { lbl: 'Holders', val: holders != null ? holders.toLocaleString('en-US') : 'n/a', ...this.chgSub(r.token?.change24h?.holders ?? null) },
      { lbl: 'Cashback earned', val: this.usd(cash), valCls: cash > 0 ? 'up' : '', ...this.chgSub(this.trackPct('obs:cash', cash)) }
    ];
  }

  /** The agent's own token, going live: the logo and the honest word on every box until the ticker is announced. Filled from the API once it trades. */
  /** The agent's own token, shown exactly like OBS: the same six boxes with the same 24-hour sub-lines, plus the contract in the last box. */
  private buildStatsAgent(): void {
    const t = this.agentToken;
    const addr = t?.contract || '';
    const short = addr ? addr.slice(0, 6) + '\u2026' + addr.slice(-4) : 'TBD';
    const contract: StatCell = { lbl: 'Contract', val: short, sub: this.agentCopied ? 'copied' : (addr ? 'click to copy' : 'announced at launch'), copy: addr || undefined };
    if (!t || t.priceUsd == null) {
      this.stats = [
        { lbl: 'Price', val: 'TBD', sub: t ? 'not priced yet' : 'going live' },
        { lbl: 'Market cap', val: 'TBD', sub: t ? 'not priced yet' : 'going live' },
        { lbl: 'Vol 24h', val: t?.volume24hUsd != null ? this.compact(t.volume24hUsd) : 'TBD' },
        { lbl: 'Liquidity', val: 'TBD', sub: t ? 'not priced yet' : 'going live' },
        { lbl: 'Holders', val: t?.holders != null ? t.holders.toLocaleString('en-US') : 'TBD' },
        contract
      ];
      return;
    }
    // Every change comes from the API's own samples, the same for each viewer, never from this browser's history.
    const c = t.change24h || { price: t.change24hPct ?? null, liquidity: null, volume: null, holders: null };
    this.stats = [
      { lbl: 'Price', val: this.price(t.priceUsd), ...this.chgSub(c.price) },
      // Supply is fixed, so the cap moves exactly with the price.
      { lbl: 'Market cap', val: this.compact(t.marketCapUsd), ...this.chgSub(c.price) },
      { lbl: 'Vol 24h', val: this.compact(t.volume24hUsd), ...this.chgSub(c.volume) },
      { lbl: 'Liquidity', val: this.compact(t.tvlUsd ?? t.depthUsd2pct), ...this.chgSub(c.liquidity) },
      { lbl: 'Holders', val: t.holders != null ? t.holders.toLocaleString('en-US') : 'n/a', ...this.chgSub(c.holders) },
      contract
    ];
  }

  /** A stat cell that carries an address copies it on click. */
  copyCell(c: StatCell): void {
    if (!c.copy || !navigator.clipboard) { return; }
    navigator.clipboard.writeText(c.copy).then(() => {
      this.agentCopied = true;
      this.buildStats();
      setTimeout(() => { this.agentCopied = false; this.buildStats(); }, 1500);
    });
  }

  private buildStatsCg(): void {
    const c = this.cg[this.marketAsset];
    if (!c) { this.stats = []; return; }
    const price = c.current_price;
    this.stats = [
      { lbl: 'Price', val: this.price(price), ...this.chgSub(c.price_change_percentage_24h != null ? c.price_change_percentage_24h / 100 : null) },
      { lbl: 'Market cap', val: this.compact(c.market_cap), ...this.chgSub(c.market_cap_change_percentage_24h != null ? c.market_cap_change_percentage_24h / 100 : null) },
      { lbl: 'Vol 24h', val: this.compact(c.total_volume), ...this.chgSub(this.trackPct(this.marketAsset + ':vol', c.total_volume)) },
      // High and low read against the live price: how far it sits from each.
      { lbl: '24h High', val: this.price(c.high_24h), ...this.chgSub(price != null && c.high_24h ? (price - c.high_24h) / c.high_24h : null) },
      { lbl: '24h Low', val: this.price(c.low_24h), ...this.chgSub(price != null && c.low_24h ? (price - c.low_24h) / c.low_24h : null) },
      { lbl: 'Supply', val: this.compactPlain(c.circulating_supply), ...this.chgSub(this.trackPct(this.marketAsset + ':supply', c.circulating_supply)) }
    ];
  }

  /**
   * A working 24h change for metrics no API provides a delta for: samples are
   * recorded to localStorage (at most one per 5 minutes, pruned at 25h) and
   * the change is read against the oldest sample inside the last day. Returns
   * null until at least 30 minutes of history exists.
   */
  private trackPct(key: string, v: number | null | undefined): number | null {
    if (v == null || !isFinite(v)) { return null; }
    try {
      const now = Date.now();
      const raw = localStorage.getItem('obs-market-hist');
      const all: { [k: string]: Array<[number, number]> } = raw ? JSON.parse(raw) : {};
      const arr = (all[key] || []).filter((sm) => now - sm[0] < 25 * 3600_000);
      if (!arr.length || now - arr[arr.length - 1][0] > 5 * 60_000) { arr.push([now, v]); }
      all[key] = arr;
      localStorage.setItem('obs-market-hist', JSON.stringify(all));
      const base = arr.find((sm) => now - sm[0] <= 24 * 3600_000);
      if (!base || now - base[0] < 30 * 60_000 || !base[1]) { return null; }
      return (v - base[1]) / Math.abs(base[1]);
    } catch {
      return null;
    }
  }

  /** Compact figure without the dollar sign (supply counts). */
  compactPlain(v: number | null | undefined): string {
    if (v == null || isNaN(v)) { return 'n/a'; }
    const a = Math.abs(v);
    if (a >= 1e9) { return (v / 1e9).toFixed(2) + 'B'; }
    if (a >= 1e6) { return (v / 1e6).toFixed(2) + 'M'; }
    if (a >= 1e3) { return (v / 1e3).toFixed(2) + 'K'; }
    return this.num(v, 2);
  }

  /** The day at a glance. Every figure here is one the page already holds; nothing is fetched for it. */
  private buildSummary(): void {
    const p = this.pnl;
    const out: Array<{ k: string; v: string; cls?: string }> = [];
    if (p?.closed) {
      const wins = p.closed.filter((x) => x.resultUsd > 0).length, losses = p.closed.filter((x) => x.resultUsd < 0).length;
      const net = p.closed.reduce((s, x) => s + x.resultUsd, 0);
      out.push({ k: 'Closed, 24h', v: `${p.closed.length} · ${wins} up · ${losses} down · ${this.usd(net, true)}`, cls: this.dir(net) });
    }
    const eth = p?.snapshot?.holdings?.['ETH'];
    const start = p?.capital?.ethIn;
    if (eth != null && start != null && start > 0) {
      const pct = ((eth - start) / start) * 100;
      out.push({ k: 'ETH', v: `${eth.toFixed(4)} vs ${start.toFixed(4)} in · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`, cls: this.dir(pct) });
    }
    const held = this.positions.filter((x) => x.asset !== 'ETH').map((x) => x.asset);
    const now = held.length ? `holding ${held.join(', ')}` : `flat${this.watchingCount ? `, watching ${this.watchingCount} tape${this.watchingCount === 1 ? '' : 's'}` : ''}`;
    out.push({ k: 'Now', v: now });
    this.summary = out;
  }

  /** The positions table's empty row, true to the day: flat is not "nothing yet". */
  get flatLine(): string {
    if (this.closed.length || (this.status?.desk?.trades?.settled ?? 0) > 0) {
      return `Flat${this.watchingCount ? `, watching ${this.watchingCount} tape${this.watchingCount === 1 ? '' : 's'} for a setup` : ''}.`;
    }
    return 'No positions. The desk holds nothing yet.';
  }

  howLabel(h: string): string {
    return ({ 'trail': 'trailing stop', 'floor': 'floor', 'tape-profit': 'buyers thinned', 'take-profit': 'take profit', 'time-stop': 'time stop', 'volume': 'tape rolled over', 'operator': 'operator', 'the model': 'the model sold' } as Record<string, string>)[h] ?? h;
  }

  private buildPortfolio(p: ObsPnl): void {
    const s = p.snapshot;
    let un = 0, known = 0;
    (p.positions || []).forEach((x) => {
      if (x.unrealizedUsd != null) { un += x.unrealizedUsd; known++; }
    });
    this.portfolio = [
      { lbl: 'Equity', val: this.usd(s.equityUsd) },
      { lbl: 'Net capital', val: this.usd(s.netCapitalUsd) },
      { lbl: 'PnL', val: this.usd(s.pnlUsd, true), valCls: this.dir(s.pnlUsd) },
      { lbl: 'Unrealized', val: known ? this.usd(un, true) : 'n/a', valCls: known ? this.dir(un) : '' },
      { lbl: 'Realized', val: this.usd(p.realizedUsd || 0, true), valCls: this.dir(p.realizedUsd) },
      { lbl: 'In flight', val: this.usd(s.inFlightUsd || 0) }
    ];
  }

  private buildPositions(p: ObsPnl): void {
    this.positions = p.positions ?? [];
    this.inFlight = p.inFlight ?? [];
    const n = this.positions.length, f = this.inFlight.length;
    this.posSummary = n ? `${n} position${n > 1 ? 's' : ''}${f ? ` · ${f} in flight` : ''}` : '';
    this.closed = p.closed ?? [];
    this.buildSummary();
  }

  private buildTicker(items: ObsTrade[]): void {
    const shown = (items || []).filter((x) => x.status !== 'proposed');
    this.ticker = shown.map((x) => {
      const buy = STABLE[x.from.asset] && !STABLE[x.to.asset];
      const sell = !STABLE[x.from.asset] && STABLE[x.to.asset];
      const side = buy ? 'BUY' : sell ? 'SELL' : 'SWAP';
      const bad = x.status === 'failed' || x.status === 'cancelled';
      return {
        side,
        sideCls: bad ? 'down' : buy ? 'up' : sell ? 'down' : '',
        asset: side === 'SELL' ? x.from.asset : x.to.asset,
        amt: x.from.usd != null ? this.usd(x.from.usd) : `${this.qty(x.from.amount)} ${x.from.asset}`,
        status: x.status
      };
    });
    this.tickerRoll = this.ticker.length >= 6;
  }

  // ---- the terminal ----------------------------------------------------

  private term(): HTMLDivElement | null {
    return this.termEl?.nativeElement ?? null;
  }

  private setStreamState(v: AgentComponent['streamState']): void {
    this.zone.run(() => { this.streamState = v; });
  }

  private connect(): void {
    if (typeof EventSource === 'undefined') { this.startPollFallback(); return; }
    if (this.esReconnectTimer) { clearTimeout(this.esReconnectTimer); this.esReconnectTimer = undefined; }
    this.es?.close();
    let es: EventSource;
    try { es = new EventSource(this.obs.streamUrl(12)); } catch { this.startPollFallback(); this.scheduleReconnect(); return; }
    this.es = es;
    const alive = () => { this.esLastEventAt = Date.now(); };
    es.addEventListener('hello', (ev) => {
      alive();
      const h = JSON.parse((ev as MessageEvent).data) as { thoughts?: ObsThought[]; trades?: ObsTrade[]; canExecute?: boolean; watch?: ObsWatchEvent; research?: ObsResearchEvent[] };
      this.esFails = 0;
      this.esBackoffMs = 3000;
      this.setStreamState('live');
      this.stopPollFallback();
      if (this.termSeeded) {
        // Back after a drop: what landed while the stream was down joins the terminal in order, and nothing already shown repeats.
        (h.research || []).slice().sort((a, b) => a.at - b.at).forEach((r) => this.onResearch(r));
        (h.thoughts || []).slice().sort((a, b) => a.at - b.at).forEach((t) => this.onThought(t));
        (h.trades || []).forEach((t) => this.onTrade(t));
      } else if (this.term()) { this.seed(h.thoughts || [], h.trades || [], !!h.canExecute, h.research || []); }
      else { this.pendingSeed = { thoughts: h.thoughts || [], trades: h.trades || [], canExecute: !!h.canExecute, research: h.research || [] }; }
      if (h.watch) { setTimeout(() => this.onWatch(h.watch as ObsWatchEvent), 0); }
    });
    es.addEventListener('thought', (ev) => { alive(); this.onThought(JSON.parse((ev as MessageEvent).data) as ObsThought); });
    es.addEventListener('watch', (ev) => { alive(); this.onWatch(JSON.parse((ev as MessageEvent).data) as ObsWatchEvent); });
    es.addEventListener('research', (ev) => { alive(); this.onResearch(JSON.parse((ev as MessageEvent).data) as ObsResearchEvent); });
    es.addEventListener('trade', (ev) => { alive(); this.onTrade(JSON.parse((ev as MessageEvent).data) as ObsTrade); });
    es.addEventListener('ping', () => alive());
    // The positions in real time: the API re-prices the book from the live watch's tape every few seconds and pushes it when it moved.
    es.addEventListener('pnl', (ev) => { alive(); this.zone.run(() => this.onPnl(JSON.parse((ev as MessageEvent).data) as Partial<ObsPnl>)); });
    es.onerror = () => {
      // A redeploy answers 502 for a minute and the browser then stops retrying for good; the page keeps the terminal
      // moving on polls and reopens the stream itself, backing off to half a minute.
      this.esFails++;
      es.close();
      if (this.es === es) { this.es = undefined; }
      this.setStreamState('reconnecting');
      this.startPollFallback();
      this.scheduleReconnect();
    };
    this.startLiveness();
  }

  private scheduleReconnect(): void {
    if (this.esReconnectTimer) { return; }
    const wait = this.esBackoffMs;
    this.esBackoffMs = Math.min(30_000, this.esBackoffMs * 2);
    this.esReconnectTimer = setTimeout(() => { this.esReconnectTimer = undefined; this.connect(); }, wait);
  }

  /** The watch line arrives about once a minute; a stream silent for two and a half minutes is dead, whatever the browser says. */
  private startLiveness(): void {
    this.esLastEventAt = Date.now();
    if (this.esLivenessTimer) { return; }
    this.esLivenessTimer = setInterval(() => {
      // The API pings every 25 s; 75 s of silence is a dead connection, not a quiet desk.
      if (!this.es || Date.now() - this.esLastEventAt < 75_000) { return; }
      this.es.close();
      this.es = undefined;
      this.setStreamState('reconnecting');
      this.startPollFallback();
      this.scheduleReconnect();
    }, 30_000);
  }

  /** While the stream is down the terminal still moves: thoughts, the research log and the watch line, every 15 seconds. */
  private startPollFallback(): void {
    if (this.pollTimer) { return; }
    this.setStreamState('polling');
    const tick = () => {
      this.obs.thoughts(12).subscribe({
        next: (t) => {
          const items = t.items.slice().reverse();
          if (!this.termSeeded && this.term()) { this.seed(items, [], false); return; }
          items.forEach((x) => this.onThought(x));
        },
        error: () => this.setStreamState('offline')
      });
      this.obs.research(40).subscribe({
        next: (r) => r.items.slice().sort((a, b) => a.at - b.at).forEach((x) => this.onResearch(x)),
        error: () => { /* the thoughts poll reports the outage */ }
      });
      this.obs.live().subscribe({
        next: (l) => this.onWatch(this.watchFromLive(l)),
        error: () => { /* same */ }
      });
    };
    tick();
    this.pollTimer = setInterval(tick, 15_000);
  }

  private stopPollFallback(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
  }

  /** The watch line the stream would have sent, built from the heartbeat the page polled instead. */
  private watchFromLive(l: ObsLive): ObsWatchEvent {
    const what = (l.watching || []).map((w) => `${w.symbol} ${w.entryOk ? 'ENTRY' : (w.entryState || 'quiet')}`).join(', ') || 'nothing in play';
    return { at: l.at, block: l.block, lookMs: l.lookMs, line: `watching ${what}; looks ${((l.lookMs || 0) / 1000).toFixed(1)} s`, trigger: l.lastTrigger || null, cycleRunning: !!l.cycleRunning };
  }

  private cursorEl(): HTMLElement {
    if (!this.termCursor) {
      this.termCursor = document.createElement('span');
      this.termCursor.className = 'cur';
    }
    return this.termCursor;
  }

  private line(cls: string, ts: number | null, tag: string, text: string, animate: boolean): TermItem {
    const row = document.createElement('div');
    row.className = 'ln ' + cls;
    // The row carries its time, so a cycle's write-up that lands after the trades it produced can be put back before them.
    if (ts != null) { row.dataset['at'] = String(ts); }
    const a = document.createElement('span');
    a.className = 'ts num';
    a.textContent = ts == null ? '' : this.clock(ts);
    const b = document.createElement('span');
    b.className = 'tag';
    b.textContent = tag;
    const c = document.createElement('span');
    c.className = 'tx';
    row.appendChild(a); row.appendChild(b); row.appendChild(c);
    return { row, tx: c, text: String(text ?? ''), animate };
  }

  private nearBottom(term: HTMLElement): boolean {
    return term.scrollHeight - term.scrollTop - term.clientHeight < 90;
  }

  private push(items: TermItem[]): void {
    this.termQueue.push(...items);
    if (!this.termTyping) { this.drain(); }
  }

  private drain(): void {
    const term = this.term();
    if (!term) { this.termTyping = false; return; }
    const it = this.termQueue.shift();
    if (!it) {
      this.termTyping = false;
      const last = term.lastElementChild;
      if (last?.lastElementChild) { last.lastElementChild.appendChild(this.cursorEl()); }
      return;
    }
    this.termTyping = true;
    const stick = this.nearBottom(term);
    // A cycle's lines are stamped at the cycle's start; the trades it sent settle and print first. Put its lines back
    // before any trade row stamped later, so the terminal reads decision, then trade, in the order they happened.
    const at = Number(it.row.dataset['at'] ?? NaN);
    let before: Element | null = null;
    if (Number.isFinite(at)) {
      for (let el = term.lastElementChild; el; el = el.previousElementSibling) {
        const t = Number((el as HTMLElement).dataset['at'] ?? NaN);
        if (!Number.isFinite(t)) { continue; }
        if (t > at && (el.classList.contains('trade') || el.classList.contains('watch') || el.classList.contains('trigger'))) { before = el; continue; }
        break;
      }
    }
    if (before) { term.insertBefore(it.row, before); } else { term.appendChild(it.row); }
    while (term.children.length > TERM_LINE_CAP) { term.removeChild(term.firstChild as Node); }
    // The typewriter must never fall behind the desk. When lines are waiting behind this one, or this one is already
    // more than a few seconds old, it is drawn at once; only a fresh line with nothing queued behind it is typed.
    // Until 2026-09-06 every line was typed at 9 ms a character and the queue grew all day, so the terminal sat
    // minutes to an hour behind a desk that the stream had delivered within a second.
    const backlog = this.termQueue.length > 2 || (Number.isFinite(at) && Date.now() - at > 8000);
    if (!it.animate || backlog) {
      if (it.node) { it.tx.textContent = ''; it.tx.appendChild(it.node); }
      else
      it.tx.textContent = it.text;
      if (stick) { term.scrollTop = term.scrollHeight; }
      this.drain();
      return;
    }
    let i = 0;
    const n = it.text.length;
    // Any line finishes typing inside about a third of a second, whatever its length.
    const step = Math.max(1, Math.ceil(n / 40));
    const tick = () => {
      i = Math.min(n, i + step);
      it.tx.textContent = it.text.slice(0, i);
      it.tx.appendChild(this.cursorEl());
      if (stick) { term.scrollTop = term.scrollHeight; }
      if (i < n) { this.typeTimer = setTimeout(tick, 9); }
      else { this.typeTimer = setTimeout(() => this.drain(), 120); }
    };
    tick();
  }

  /**
   * One cycle, as a reader sees it: the verdict and one sentence, the agent's own lines, the board in
   * counts, one status line per token in play, the argument when a trade was wanted, and everything it
   * read folded behind one click. A thought without a digest (an older API) falls back to the raw lines.
   */
  private cycleLines(t: ObsThought, animate: boolean, withInputs: boolean): TermItem[] {
    const out: TermItem[] = [];
    const d = t.decision || { kind: 'hold' as const };
    const swap = d.kind === 'propose-swap';
    const g = t.digest;
    if (!g) {
      out.push(this.line('sys cycle', t.at, 'cycle', 'desk cycle, ' + (swap ? 'proposes a swap' : 'holds') + (withInputs ? '' : ' (inputs folded)'), false));
      if (withInputs) { (t.observation || []).forEach((o) => out.push(this.line('obs', null, 'observe', o, false))); }
      (t.thoughts || []).forEach((l) => out.push(this.line('think', null, 'think', l, animate)));
      out.push(this.line('decide' + (swap ? ' swap' : ''), null, 'decide', swap ? `swap ${d.amount} ${d.from} -> ${d.to}` : 'hold', animate));
      if (d.reason) { out.push(this.line('why', null, 'because', d.reason, animate)); }
      return out;
    }
    out.push(this.line('sys cycle v-' + g.verdict, t.at, g.verdict, g.headline, animate));
    (g.lines || t.thoughts || []).forEach((l) => out.push(this.line('think', null, 'think', l, animate)));
    if (g.board) {
      const b = g.board;
      const bits: string[] = [];
      if (b.early) { bits.push(`${b.early} early launch${b.early === 1 ? '' : 'es'}, ${b.probeAllowed} probe-allowed, ${b.gateFailed} failed the gate`); }
      if (b.graded || b.belowBar) { bits.push(`${b.graded} graded candidate${b.graded === 1 ? '' : 's'}, ${b.belowBar} below the bar`); }
      if (bits.length) { out.push(this.line('board', null, 'board', bits.join('; '), false)); }
    }
    g.tokens.forEach((x) => { const it = this.line('tok t-' + x.tone, null, x.symbol, x.line, false); it.node = this.chips(x); out.push(it); });
    if (g.argument) {
      const a = g.argument;
      out.push(this.line('think', null, 'thesis', a.thesis, animate));
      a.evidence.forEach((e) => out.push(this.line('obs', null, 'evidence', e, animate)));
      if (a.invalidation) { out.push(this.line('why', null, 'wrong if', a.invalidation, animate)); }
      if (a.conviction != null) { out.push(this.line('why', null, 'conviction', `${a.conviction} of 5`, false)); }
    }
    const raw = t.observation || [];
    if (raw.length) {
      const fold = this.line('fold', null, 'read', `show everything it read (${raw.length} lines)`, false);
      const box = document.createElement('div');
      box.className = 'raw';
      raw.forEach((o) => { const r = document.createElement('div'); r.className = 'r'; r.textContent = o; box.appendChild(r); });
      fold.row.appendChild(box);
      fold.row.addEventListener('click', () => {
        const open = box.classList.toggle('open');
        fold.tx.textContent = open ? `hide what it read (${raw.length} lines)` : `show everything it read (${raw.length} lines)`;
      });
      out.push(fold);
    }
    return out;
  }

  /** One chip per gate for a token in play; the failing reason in a few words, the whole of it on hover. */
  private chips(x: ObsTokenDigest): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'chips';
    const chip = (cls: string, text: string, title?: string) => {
      const c = document.createElement('span');
      c.className = 'chip ' + cls;
      c.textContent = text;
      if (title) { c.title = title; }
      wrap.appendChild(c);
    };
    if (x.role === 'held') { chip('held', 'held'); }
    if (x.entry) { chip(x.entry.ok ? 'ok' : 'na', 'entry ' + x.entry.state + (x.entry.ok ? ' \u2713' : ''), x.entry.why); }
    if (x.holders) { chip(x.holders.ok ? 'ok' : 'bad', x.holders.ok ? 'holders \u2713' : 'holders \u2717 ' + (x.holders.short || ''), x.holders.why); }
    if (x.launch) { chip(x.launch.ok ? 'ok' : 'bad', x.launch.ok ? 'launch \u2713' + (x.launch.score != null ? ' ' + x.launch.score : '') : 'launch \u2717 ' + (x.launch.short || ''), x.launch.why); }
    if (!x.entry && !x.holders && !x.launch) { chip('na', x.line); }
    return wrap;
  }

  private tradeLine(x: ObsTrade, animate: boolean): TermItem {
    const cls = x.status === 'settled' ? 'settled' : (x.status === 'failed' || x.status === 'cancelled') ? 'bad' : '';
    const txt = `${this.qty(x.from.amount)} ${x.from.asset} -> ${x.to.amount ? this.qty(x.to.amount) + ' ' + x.to.asset : x.to.asset}, ${x.status}`
      + (x.partner ? ` via ${x.partner}` : '') + (x.from.usd != null ? `, ${this.usd(x.from.usd)}` : '');
    return this.line('trade ' + cls, x.updatedAt || x.at, 'trade', txt, animate);
  }

  private seed(thoughts: ObsThought[], trades: ObsTrade[], canExecute: boolean, research: ObsResearchEvent[] = []): void {
    const term = this.term();
    if (!term) { this.pendingSeed = { thoughts, trades, canExecute }; return; }
    term.innerHTML = '';
    this.termQueue = [];
    this.termTyping = false;
    this.termSeeded = true;
    let items: TermItem[] = [];
    if (!thoughts.length) { items.push(this.line('sys', Date.now(), 'obs', 'no desk cycle yet. this fills the moment OBS thinks.', false)); }
    // Cycles and research lines in one timeline, oldest first.
    const timeline: Array<{ at: number; t?: ObsThought; r?: ObsResearchEvent }> = [
      ...thoughts.map((t) => ({ at: t.at, t })),
      ...research.map((r) => ({ at: r.at, r }))
    ].sort((a, b) => a.at - b.at);
    timeline.forEach((x, i) => {
      if (x.t) {
        items = items.concat(this.cycleLines(x.t, false, i === timeline.length - 1));
        if (x.t.at > this.lastThoughtAt) { this.lastThoughtAt = x.t.at; }
      } else if (x.r) {
        items.push(this.researchLine(x.r, false));
        if (x.r.at > this.lastResearchAt) { this.lastResearchAt = x.r.at; }
      }
    });
    trades.forEach((x) => {
      const at = x.updatedAt || x.at;
      if (at > this.lastTradeAt) { this.lastTradeAt = at; }
    });
    items.push(this.line('sys', Date.now(), 'obs',
      'listening' + (canExecute ? '. execution is armed.' : '. observation mode: a swap decision is a proposal until the operator arms execution.'), false));
    this.push(items);
  }

  private onThought(t: ObsThought): void {
    if (t.at <= this.lastThoughtAt) { return; }
    this.lastThoughtAt = t.at;
    this.push(this.cycleLines(t, true, true));
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => this.zone.run(() => this.refresh()), EVENT_REFRESH_MS);
  }

  /** One line of research: what the desk learned about a token, as it learned it. */
  private researchLine(r: ObsResearchEvent, animate: boolean): TermItem {
    const tag = r.kind === 'launch-read' ? 'launch' : r.kind === 'entry' ? 'tape' : r.kind === 'decision' ? 'decided' : r.kind;
    const tone = r.ok === true ? ' ok' : r.ok === false ? ' bad' : '';
    return this.line('research r-' + r.kind + tone, r.at, tag, r.line, animate);
  }

  private onResearch(r: ObsResearchEvent): void {
    if (!this.termSeeded || r.at <= this.lastResearchAt) { return; }
    this.lastResearchAt = r.at;
    this.push([this.researchLine(r, true)]);
  }

  /** The live watch between cycles: a dim line a minute, and a trigger line the moment a tape gives an entry or a held token is looked at. */
  private lastWatchTrigger: string | null = null;
  private onWatch(w: ObsWatchEvent): void {
    // "watching A x, B y; looks 0.8 s": the count of tapes in play, for the summary and the flat line.
    const m = /^watching (.+?)(?:;|$)/.exec(w.line || '');
    const n = m && m[1] !== 'nothing in play' ? m[1].split(', ').length : 0;
    if (n !== this.watchingCount) { this.watchingCount = n; this.zone.run(() => this.buildSummary()); }
    if (!this.termSeeded) { return; }
    const items: TermItem[] = [];
    if (w.trigger && w.trigger !== this.lastWatchTrigger) {
      this.lastWatchTrigger = w.trigger;
      // A held token's review or break is tagged as the holding it is; only a watched token's entry is a "trigger".
      const holding = w.triggerKind === 'held' || w.triggerKind === 'exit';
      // The trigger text opens with the desk's UTC clock; the row already carries the viewer's, so one clock per line.
      items.push(this.line(holding ? 'trigger holding' : 'trigger', w.at, holding ? 'holding' : 'trigger', w.trigger.replace(/^\d\d:\d\d:\d\dZ\s+/, '') + (w.cycleRunning ? ' (thinking)' : ''), true));
    }
    const term = this.term();
    const last = term?.lastElementChild as HTMLElement | null;
    if (!items.length && last && last.classList.contains('watch')) {
      const tx = last.querySelector('.tx'); const ts = last.querySelector('.ts');
      if (tx) { tx.textContent = w.line; }
      if (ts) { ts.textContent = this.clock(w.at); }
      return;
    }
    items.push(this.line('watch', w.at, 'watch', w.line, false));
    this.push(items);
  }

  /** A `pnl` event carries everything but the curve; the curve it has stays until the next full refresh. */
  private onPnl(p: Partial<ObsPnl>): void {
    const merged = { ...(this.pnl ?? {}), ...p, series: this.pnl?.series ?? [] } as ObsPnl;
    this.pnl = merged;
    this.buildPortfolio(merged);
    this.buildPositions(merged);
  }

  private onTrade(x: ObsTrade): void {
    const at = x.updatedAt || x.at;
    if (at <= this.lastTradeAt) { return; }
    this.lastTradeAt = at;
    this.push([this.tradeLine(x, true)]);
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => this.zone.run(() => this.refresh()), EVENT_REFRESH_MS);
  }

  // ---- formatting ------------------------------------------------------

  usd(v: number | null | undefined, signed = false): string {
    if (v == null || isNaN(v)) { return 'n/a'; }
    const sign = signed && v > 0 ? '+' : v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  compact(v: number | null | undefined): string {
    if (v == null || isNaN(v)) { return 'n/a'; }
    const a = Math.abs(v);
    if (a >= 1e9) { return '$' + (v / 1e9).toFixed(2) + 'B'; }
    if (a >= 1e6) { return '$' + (v / 1e6).toFixed(2) + 'M'; }
    if (a >= 1e4) { return '$' + (v / 1e3).toFixed(2) + 'K'; }
    return this.usd(v);
  }

  price(v: number | null | undefined): string {
    if (v == null || isNaN(v)) { return 'n/a'; }
    return v >= 1 ? this.usd(v) : '$' + v.toLocaleString('en-US', { maximumSignificantDigits: 3 });
  }

  pct(v: number | null | undefined): string {
    return v == null || isNaN(v) ? '' : (v > 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
  }

  dir(v: number | null | undefined): string {
    return v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '';
  }

  qty(v: number | null | undefined): string {
    return v == null ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 });
  }

  num(v: number | null | undefined, digits = 2): string {
    return v == null ? 'n/a' : Number(v).toLocaleString('en-US', { maximumFractionDigits: digits });
  }

  /**
   * Every clock on the page is UTC: the desk's own clock, the clock in its log lines and trigger text, the API's
   * timestamps and the explorer's. One clock for a global audience; a viewer's local zone next to the desk's read
   * as "off by" whatever the offset was.
   */
  when(ts: number): string {
    const d = new Date(ts), now = new Date();
    const pad = (n: number) => (n < 10 ? '0' : '') + n;
    const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    const sameDay = d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate();
    return sameDay ? t : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${t}`;
  }

  clock(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => (n < 10 ? '0' : '') + n;
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  ago(ts: number | null | undefined): string {
    if (!ts) { return ''; }
    const m = Math.round((Date.now() - ts) / 60_000);
    if (m < 1) { return 'just now'; }
    if (m < 60) { return `${m}m ago`; }
    const h = Math.round(m / 60);
    if (h < 48) { return `${h}h ago`; }
    return `${Math.round(h / 24)}d ago`;
  }

  short(address: string): string {
    return address.slice(0, 6) + '…' + address.slice(-4);
  }

  get handle(): string {
    return this.status?.agent?.handle || 'ObscuraCEX';
  }

  get streamPillCls(): string {
    return this.streamState === 'live' ? 'on' : this.streamState === 'offline' ? '' : 'warn';
  }

  posUnrealDim(p: ObsPosition): string {
    return p.valueUsd == null ? 'unpriced' : 'no cost recorded';
  }

  shareWidth(share: number): number {
    return Math.max(1, Math.round(share * 100));
  }

  private parseSupply(s: string | null | undefined): number | null {
    if (!s) { return null; }
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  flightPl(f: ObsInFlight): number | null {
    return f.usd != null && f.costUsd != null ? f.usd - f.costUsd : null;
  }

  // ---- ETH-to-PnL marquee (kept from our earlier build) ----------------

  private startMarquee(): void {
    // The centre slot starts as a PnL too: the first step slides it out from
    // behind the badge, and it must already be transformed when it appears.
    this.marqueeItems = Array.from({ length: 14 }, (_, i): MarqueeItem =>
      i < this.marqueeCenter ? this.randomMark() : { kind: 'pnl', value: this.randomPnl() });
    if (typeof window !== 'undefined'
      && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return; // static strip, no stepping
    }
    this.marqueeInterval = setInterval(() => this.stepMarquee(), 2400);
  }

  private stepMarquee(): void {
    this.marqueeStepping = true;
    // After the slide, shift one slot right: a new token mark enters on the
    // left, and whatever now rests behind the badge becomes a PnL figure.
    this.marqueeSwapTimer = setTimeout(() => {
      const shifted: MarqueeItem[] = [this.randomMark(), ...this.marqueeItems.slice(0, -1)];
      shifted[this.marqueeCenter] = { kind: 'pnl', value: this.randomPnl() };
      this.marqueeItems = shifted;
      this.marqueeStepping = false;
    }, 950);
  }

  /** A random token mark for the left side of the marquee. ETH stays the most common. */
  private randomMark(): MarqueeItem {
    const r = Math.random();
    if (r < 0.35) { return { kind: 'eth' }; }
    if (r < 0.55) { return { kind: 'usdg' }; }
    if (r < 0.75) { return { kind: 'obs' }; }
    const t = MARQUEE_STOCKS[Math.floor(Math.random() * MARQUEE_STOCKS.length)];
    return { kind: 'stock', src: `/assets/images/tokenized-stocks/marquee/${t}.png` };
  }

  private randomPnl(): string {
    const big = Math.random() < 0.3;
    const v = big ? 100 + Math.random() * 550 : 8 + Math.random() * 92;
    return '+$' + v.toFixed(2);
  }
}
