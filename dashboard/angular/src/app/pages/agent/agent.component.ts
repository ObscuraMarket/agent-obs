import { AfterViewInit, Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { Subscription, interval } from 'rxjs';

import { Curve, buildCurve, curveYAt, traceCurve } from './curve';
import {
  CgMarket, ObsDeskService, ObsFeedItem, ObsInFlight, ObsMarket, ObsPnl, ObsPosition,
  ObsAgentToken, ObsLive, ObsRails, ObsReads, ObsResearchEvent, ObsStatus, ObsThought, ObsTokenDigest, ObsTrade, ObsWatchEvent
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

/** One block gauge of the rails panel (daily budget, open orders). */
interface RailGauge { label: string; used: string; blocks: string[]; }

interface KvRow { k: string; v: string; icon?: 'eth' | 'usdg' | 'obs'; }

/** Items queued for the terminal's typewriter. */
interface TermItem { row: HTMLElement; tx: HTMLElement; text: string; animate: boolean; node?: HTMLElement; }

const STABLE: { [asset: string]: 1 } = { USDG: 1, USDC: 1, USDT: 1, DAI: 1 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TERM_LINE_CAP = 700;

/**
 * The OBS desk: every feature of agent-obs's newest dashboard (the typewriter
 * terminal over SSE, the chart with series and ranges, positions with their
 * PnL, the rails gauges, the trades ticker) rendered in OUR design language,
 * the house cards, Plus Jakarta Sans, the lime accent, shimmer on every
 * section title, the mask background video and the ETH-to-PnL marquee.
 */
@Component({
  selector: 'app-agent',
  templateUrl: './agent.component.html',
  styleUrls: ['./agent.component.css']
})
export class AgentComponent implements OnInit, AfterViewInit, OnDestroy {
  status: ObsStatus | null = null;
  pnl: ObsPnl | null = null;
  reads: ObsReads | null = null;
  obsMarket: ObsMarket | null = null;
  agentToken: ObsAgentToken | null = null;
  agentCopied = false;
  feed: ObsFeedItem[] = [];
  err = '';

  stats: StatCell[] = [];
  portfolio: StatCell[] = [];

  /** The asset the Market strip is showing; OBS reads locally, the rest CoinGecko. */
  marketAsset: MarketAssetId = 'obs';
  assetMenuOpen = false;
  readonly marketAssets: Array<{ id: MarketAssetId; label: string }> = [
    { id: 'obs', label: 'OBS' },
    { id: 'agent', label: 'AOBS' },
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
  walletRows: KvRow[] = [];
  railGauges: RailGauge[] = [];
  railKv: KvRow[] = [];
  ticker: TickerChip[] = [];
  tickerRoll = false;

  chartHours = 168;
  chartSeries: 'equity' | 'pnl' | 'obs' = 'equity';
  chartVal = '$0.00';
  chartValCls = '';
  chartChg = '';
  chartChgCls = '';
  chartCap = 'OBS Desk Equity / USD · Live';
  chartHigh = ''; chartLow = ''; chartRangeChg = ''; chartRangeCls = '';

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

  @ViewChild('chartCanvas') chartCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('termEl') termEl?: ElementRef<HTMLDivElement>;

  // The chart engine: a canvas drawn on a requestAnimationFrame loop outside
  // Angular. Every motion goes through a frame-time-normalised exponential
  // ease, the way the reference site's chart does: the y-range, the grid
  // alphas, the live value, the reveal and the crosshair all glide.
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId = 0;
  private cw = 0;
  private readonly chH = 330;
  private chartData: Array<{ at: number; v: number }> = [];
  private chartFmtF: (v: number | null) => string = (v) => this.usd(v);
  private chartKey = '';
  private reveal = 1;
  private dispMin = 0;
  private dispSpan = 1;
  private rangeInit = false;
  private liveV = 0;
  private liveInit = false;
  private gridAlphas = new Map<number, number>();
  private cross = { x: 0, alpha: 0, active: false };
  /** The curve as last stroked, so the crosshair dot rides the same line. */
  private curve: Curve | null = null;
  private lastFrame = 0;
  private reduceMotion = false;
  private dotPattern: CanvasPattern | null = null;
  private emptyMsg = '';

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
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private ro?: ResizeObserver;
  private pendingSeed: { thoughts: ObsThought[]; trades: ObsTrade[]; canExecute: boolean; research?: ObsResearchEvent[] } | null = null;
  private lastResearchAt = 0;

  private readonly onResize = () => {
    if (this.resizeTimer) { clearTimeout(this.resizeTimer); }
    this.resizeTimer = setTimeout(() => this.resizeCanvas(), 150);
  };

  private poll?: Subscription;

  constructor(private obs: ObsDeskService, private zone: NgZone, title: Title, meta: Meta) {
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
   * at once (the hello replays every line missed, in order) and the panels refresh.
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
    this.refresh();
    this.poll = interval(15_000).subscribe(() => this.refresh());
    this.startMarquee();
    // The stream and the typewriter run outside Angular: a 9ms typing tick
    // must not drive change detection. Bound state re-enters via zone.run.
    this.zone.runOutsideAngular(() => this.connect());
    window.addEventListener('resize', this.onResize);
  }

  ngAfterViewInit(): void {
    if (this.pendingSeed) {
      const s = this.pendingSeed;
      this.pendingSeed = null;
      this.seed(s.thoughts, s.trades, s.canExecute, s.research || []);
    }
    // Deferred: updateChart() writes bound headline values, which must not
    // happen inside the change-detection pass that just checked them (NG0100).
    setTimeout(() => this.updateChart());
    // The whole chart engine lives outside the zone: the render loop, the
    // crosshair and the resize handling must never drive change detection.
    this.zone.runOutsideAngular(() => {
      const cv = this.chartCanvas?.nativeElement;
      if (!cv) { return; }
      this.ctx = cv.getContext('2d');
      this.reduceMotion = typeof window !== 'undefined' && !!window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.resizeCanvas();
      cv.addEventListener('mousemove', this.onChartMove);
      cv.addEventListener('mouseleave', this.onChartLeave);
      if (typeof ResizeObserver !== 'undefined') {
        this.ro = new ResizeObserver(() => this.resizeCanvas());
        this.ro.observe(cv);
      }
      this.rafId = requestAnimationFrame(this.frame);
    });
  }

  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onVisible);
    window.removeEventListener('pageshow', this.onVisible);
    this.poll?.unsubscribe();
    this.es?.close();
    this.ro?.disconnect();
    if (this.rafId) { cancelAnimationFrame(this.rafId); }
    window.removeEventListener('resize', this.onResize);
    if (this.pollTimer) { clearInterval(this.pollTimer); }
    if (this.esReconnectTimer) { clearTimeout(this.esReconnectTimer); }
    if (this.esLivenessTimer) { clearInterval(this.esLivenessTimer); }
    if (this.typeTimer) { clearTimeout(this.typeTimer); }
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    if (this.resizeTimer) { clearTimeout(this.resizeTimer); }
    if (this.marqueeInterval) { clearInterval(this.marqueeInterval); }
    if (this.marqueeSwapTimer) { clearTimeout(this.marqueeSwapTimer); }
  }

  // ---- data ------------------------------------------------------------

  refresh(): void {
    this.err = '';
    const fail = (path: string) => () => { this.err = path; };
    this.obs.status().subscribe({ next: (s) => { this.status = s; this.buildRails(s); this.buildStats(); }, error: fail('status') });
    this.obs.agentToken().subscribe({ next: (t) => { this.agentToken = t; if (this.marketAsset === 'agent') { this.buildStats(); } }, error: () => { /* the card keeps its placeholders */ } });
    this.obs.reads().subscribe({ next: (r) => { this.reads = r; this.buildWallet(r); this.buildStats(); if (this.chartSeries === 'obs') { this.updateChart(); } }, error: fail('reads') });
    this.obs.pnl(this.chartHours).subscribe({ next: (p) => { this.pnl = p; this.buildPortfolio(p); this.buildPositions(p); this.updateChart(); }, error: fail('pnl') });
    this.obs.market(this.chartHours).subscribe({ next: (m) => { this.obsMarket = m; this.buildStats(); if (this.chartSeries === 'obs') { this.updateChart(); } }, error: fail('market') });
    this.obs.trades(30).subscribe({ next: (t) => { this.buildTicker(t.items); }, error: fail('trades') });
    this.obs.feed(8).subscribe({ next: (f) => { this.feed = f.items.slice(0, 6); }, error: fail('feed') });
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

  setSeries(s: 'equity' | 'pnl' | 'obs'): void {
    this.chartSeries = s;
    this.buildStats();
    this.updateChart();
  }

  setRange(h: number): void {
    this.chartHours = h;
    this.obs.pnl(h).subscribe({ next: (p) => { this.pnl = p; this.buildPortfolio(p); this.buildPositions(p); this.updateChart(); } });
    this.obs.market(h).subscribe({ next: (m) => { this.obsMarket = m; this.buildStats(); this.updateChart(); } });
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
    const last = this.status?.desk?.lastThoughtAt;
    const name = this.chartSeries === 'obs' ? 'OBS / USD' : this.chartSeries === 'pnl' ? 'OBS Desk PnL / USD' : 'OBS Desk Equity / USD';
    this.chartCap = name + (last ? ' · Last Cycle ' + this.capWords(this.ago(last)) : ' · Live');
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

  private buildWallet(r: ObsReads): void {
    const w = r.wallet;
    if (!w) { this.walletRows = []; return; }
    const rows: KvRow[] = [
      { k: 'ETH · Robinhood Chain', v: this.num(w.ethRobinhood, 5), icon: 'eth' },
      { k: 'ETH · Ethereum', v: this.num(w.ethMainnet, 5), icon: 'eth' },
      { k: 'USDG', v: this.num(w.usdg, 2), icon: 'usdg' },
      { k: 'OBS', v: this.num(w.obs, 0), icon: 'obs' }
    ];
    this.walletRows = rows;
  }

  private blocks(used: number, cap: number, cls: string): string[] {
    const n = 10;
    const f = cap > 0 ? Math.min(n, Math.round((used / cap) * n)) : 0;
    return Array.from({ length: n }, (_, i) => (i < f ? cls : ''));
  }

  private buildRails(s: ObsStatus): void {
    const r: ObsRails | undefined = s.rails;
    if (!r) { this.railGauges = []; this.railKv = []; return; }

    this.railGauges = [
      {
        label: 'Daily budget', used: `${this.usd(r.sentTodayUsd)} / ${this.usd(r.dailySwapUsd)}`,
        blocks: this.blocks(r.sentTodayUsd, r.dailySwapUsd, r.sentTodayUsd >= r.dailySwapUsd ? 'a' : 'g')
      },
      { label: 'Open orders', used: `${r.openOrders} / ${r.maxOpenOrders}`, blocks: this.blocks(r.openOrders, r.maxOpenOrders, 'f') }
    ];
    const assets = r.allowedAssets.map((a) => a.split('@')[0]).filter((a, i, arr) => arr.indexOf(a) === i).join(' ');
    this.railKv = [
      { k: 'Per-swap cap', v: this.usd(r.maxSwapUsd) },
      { k: 'Gas reserve', v: `${r.gasReserveEth} ETH` },
      { k: 'Assets', v: assets },
      { k: 'Partners', v: r.allowedPartners ? r.allowedPartners.join(' ') : 'Any Obscura Route' }
    ];
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

  // ---- the chart -------------------------------------------------------

  private seriesData(): Array<{ at: number; v: number }> {
    if (this.chartSeries === 'obs') {
      return (this.obsMarket?.series || [])
        .filter((x): x is { at: number; priceUsd: number; depthUsd2pct: number | null } => x.priceUsd != null)
        .map((x) => ({ at: x.at, v: x.priceUsd }));
    }
    const key = this.chartSeries === 'pnl' ? 'pnlUsd' : 'equityUsd';
    const pts = (this.pnl?.series || [])
      .filter((x) => x[key] != null)
      .map((x) => ({ at: x.at, v: x[key] as number }));
    // The curve ends at the live mark, not at the last stored snapshot.
    const live = this.pnl?.snapshot;
    if (live && live[key] != null && (!pts.length || live.at > pts[pts.length - 1].at)) {
      pts.push({ at: live.at, v: live[key] as number });
    }
    return pts;
  }

  /**
   * Chart data and headline update, called when data, the series or the range
   * changes. The render loop picks the new targets up and glides there; this
   * writes bound values, so it must run in zone contexts only.
   */
  private updateChart(): void {
    const pts = this.seriesData();
    const fmt = this.chartSeries === 'obs' ? (v: number | null) => this.price(v) : (v: number | null) => this.usd(v);
    this.chartFmtF = fmt;
    const s = this.pnl?.snapshot;
    const headline = this.chartSeries === 'obs'
      ? (this.reads?.market?.priceUsd ?? (pts.length ? pts[pts.length - 1].v : null))
      : this.chartSeries === 'pnl' ? (s ? s.pnlUsd : null) : (s ? s.equityUsd : null);
    this.chartVal = this.chartSeries === 'pnl' ? this.usd(headline, true) : fmt(headline);
    this.chartValCls = this.chartSeries === 'pnl' ? this.dir(headline) : '';
    let chg: number | null = null;
    if (this.chartSeries === 'pnl') { chg = s?.pnlPct ?? null; }
    else if (pts.length >= 2 && pts[0].v) { chg = (pts[pts.length - 1].v - pts[0].v) / Math.abs(pts[0].v); }
    this.chartChg = chg == null ? '' : this.pct(chg);
    this.chartChgCls = this.dir(chg);
    if (pts.length < 2) {
      this.emptyMsg = pts.length
        ? 'one point so far. the curve starts with the next cycle.'
        : this.chartSeries === 'obs'
          ? 'no price samples yet. they accrue once a minute while the desk reads.'
          : 'no snapshots yet. the desk writes one every cycle.';
      this.chartHigh = ''; this.chartLow = ''; this.chartRangeChg = ''; this.chartRangeCls = '';
      this.chartData = [];
      return;
    }
    this.emptyMsg = '';
    const vals = pts.map((p) => p.v);
    const hi = Math.max(...vals), lo = Math.min(...vals);
    this.chartHigh = this.chartSeries === 'pnl' ? this.usd(hi, true) : fmt(hi);
    this.chartLow = this.chartSeries === 'pnl' ? this.usd(lo, true) : fmt(lo);
    const delta = pts[pts.length - 1].v - pts[0].v;
    this.chartRangeChg = this.chartSeries === 'pnl'
      ? this.usd(delta, true)
      : pts[0].v ? this.pct(delta / Math.abs(pts[0].v)) : 'n/a';
    this.chartRangeCls = this.dir(delta);
    const key = this.chartSeries + '|' + this.chartHours;
    if (key !== this.chartKey) {
      // A new series or range unfurls through the wave and rescales fresh.
      this.chartKey = key;
      this.reveal = this.reduceMotion ? 1 : 0;
      this.rangeInit = false;
      this.liveInit = false;
      this.gridAlphas.clear();
      this.cross.active = false;
    }
    this.chartData = pts;
  }

  /** Frame-time-normalised exponential ease, the reference chart's lerp. */
  private ease(cur: number, target: number, rate: number, dt: number): number {
    if (this.reduceMotion) { return target; }
    const k = 1 - Math.pow(1 - rate, dt / 16.67);
    return cur + (target - cur) * k;
  }

  /** Value at an exact time, interpolated between samples (binary search). */
  private valueAt(pts: Array<{ at: number; v: number }>, t: number): number {
    if (t <= pts[0].at) { return pts[0].v; }
    if (t >= pts[pts.length - 1].at) { return pts[pts.length - 1].v; }
    let a = 0, b = pts.length - 1;
    while (b - a > 1) {
      const m = (a + b) >> 1;
      if (pts[m].at <= t) { a = m; } else { b = m; }
    }
    const span = pts[b].at - pts[a].at;
    if (!span) { return pts[a].v; }
    return pts[a].v + ((t - pts[a].at) / span) * (pts[b].v - pts[a].v);
  }

  private resizeCanvas(): void {
    const cv = this.chartCanvas?.nativeElement;
    if (!cv || !this.ctx) { return; }
    const w = cv.clientWidth || 800;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (w === this.cw && cv.width === Math.round(w * dpr)) { return; }
    this.cw = w;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(this.chH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The dot-grid backdrop from the line-charts-9 spec, as a pattern tile.
    const tile = document.createElement('canvas');
    tile.width = 20;
    tile.height = 20;
    const tc = tile.getContext('2d');
    if (tc) {
      tc.fillStyle = 'rgba(138, 150, 138, 0.16)';
      tc.beginPath();
      tc.arc(10, 10, 1, 0, Math.PI * 2);
      tc.fill();
    }
    this.dotPattern = this.ctx.createPattern(tile, 'repeat');
  }

  private readonly onChartMove = (e: MouseEvent) => {
    const cv = this.chartCanvas?.nativeElement;
    if (!cv) { return; }
    this.cross.x = e.clientX - cv.getBoundingClientRect().left;
    this.cross.active = true;
  };

  private readonly onChartLeave = () => { this.cross.active = false; };

  /** One frame of the chart. Everything eases; nothing jumps. */
  private readonly frame = (now: number) => {
    this.rafId = requestAnimationFrame(this.frame);
    const ctx = this.ctx, cv = this.chartCanvas?.nativeElement;
    if (!ctx || !cv) { return; }
    if (document.hidden) { this.lastFrame = now; return; }
    const dt = Math.min(50, now - (this.lastFrame || now)) || 16.67;
    this.lastFrame = now;
    const W = this.cw || cv.clientWidth || 800, H = this.chH;
    const T = 24, B = 30, L = 64, R = 18;
    const chW = W - L - R, chH = H - T - B;
    const LIME = '#b8ff3d', CARD = '#161816';
    const pts = this.chartData;
    ctx.clearRect(0, 0, W, H);
    if (pts.length < 2) {
      if (this.emptyMsg) {
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.font = '500 12px "Plus Jakarta Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(this.emptyMsg, W / 2, H / 2);
        ctx.restore();
      }
      return;
    }
    // Eased targets: the y-range, the live value and the reveal.
    const vals = pts.map((p) => p.v);
    const hiV = Math.max(...vals), loV = Math.min(...vals);
    let lo = loV, span0 = hiV - loV;
    if (span0 === 0) { span0 = Math.abs(hiV) * 0.02 || 1; lo -= span0 / 2; }
    const pad = span0 * 0.08;
    const tMin = lo - pad, tSpan = span0 + pad * 2;
    if (!this.rangeInit) { this.dispMin = tMin; this.dispSpan = tSpan; this.rangeInit = true; }
    this.dispMin = this.ease(this.dispMin, tMin, 0.12, dt);
    this.dispSpan = this.ease(this.dispSpan, tSpan, 0.12, dt);
    const lastPt = pts[pts.length - 1];
    if (!this.liveInit) { this.liveV = lastPt.v; this.liveInit = true; }
    this.liveV = this.ease(this.liveV, lastPt.v, 0.15, dt);
    this.reveal = Math.min(1, this.ease(this.reveal, 1, 0.055, dt) + (this.reduceMotion ? 1 : 0.002));
    const rv = this.reveal;
    const t0 = pts[0].at, dtx = (lastPt.at - t0) || 1;
    const x = (t: number) => L + ((t - t0) / dtx) * chW;
    const y = (v: number) => T + (1 - (v - this.dispMin) / this.dispSpan) * chH;
    if (this.dotPattern) {
      ctx.fillStyle = this.dotPattern;
      ctx.fillRect(0, 0, W, H);
    }
    this.drawGrid(ctx, dt, W, T, L, R, chH);
    // A change unfurls through a wandering wave, the reference chart's reveal.
    const midY = T + chH / 2, amp = chH * 0.07, ph = now * 0.001;
    const wave = (fx: number) => midY + amp * (Math.sin(fx * 9.4 + ph) * 0.55 + Math.sin(fx * 15.7 + ph * 1.3) * 0.3 + Math.sin(fx * 4.2 + ph * 0.7) * 0.15);
    const blend = (yy: number, xx: number) => {
      if (rv >= 1) { return yy; }
      const fx = Math.max(0, Math.min(1, (xx - L) / chW));
      const edge = Math.abs(fx - 0.5) * 2;
      const w = Math.max(0, Math.min(1, (rv - edge * 0.4) / 0.6));
      return wave(fx) + (yy - wave(fx)) * w;
    };
    const px: number[] = [], py: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const xx = x(pts[i].at);
      const vy = i === pts.length - 1 ? this.liveV : pts[i].v;
      px.push(xx);
      py.push(blend(Math.max(T, Math.min(H - B, y(vy))), xx));
    }
    const curve = buildCurve(px, py);
    this.curve = curve;
    const alpha = Math.max(0.15, rv);
    const grad = ctx.createLinearGradient(0, T, 0, H - B);
    grad.addColorStop(0, 'rgba(184, 255, 61, 0.10)');
    grad.addColorStop(1, 'rgba(184, 255, 61, 0)');
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(px[0], H - B);
    ctx.lineTo(px[0], py[0]);
    traceCurve(ctx, curve);
    ctx.lineTo(px[px.length - 1], H - B);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px[0], py[0]);
    traceCurve(ctx, curve);
    ctx.strokeStyle = LIME;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(184, 255, 61, 0.45)';
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.restore();
    if (rv > 0.95) {
      // High and low marked; the live end gets the dashed line and the pulse.
      const hiI = vals.indexOf(hiV), loI = vals.indexOf(loV);
      ctx.save();
      for (const i of Array.from(new Set([hiI, loI]))) {
        if (i === pts.length - 1) { continue; }
        ctx.beginPath();
        ctx.arc(x(pts[i].at), Math.max(T, Math.min(H - B, y(pts[i].v))), 5, 0, Math.PI * 2);
        ctx.fillStyle = LIME;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        ctx.shadowBlur = 3;
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
      const ly = Math.max(T, Math.min(H - B, y(this.liveV)));
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(184, 255, 61, 0.35)';
      ctx.beginPath();
      ctx.moveTo(L, ly);
      ctx.lineTo(W - R, ly);
      ctx.stroke();
      ctx.restore();
      const ex = px[px.length - 1], ey = py[py.length - 1];
      if (!this.reduceMotion) {
        const u = (now % 1500) / 900;
        if (u < 1) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(ex, ey, 8 + u * 12, 0, Math.PI * 2);
          ctx.strokeStyle = LIME;
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.35 * (1 - u);
          ctx.stroke();
          ctx.restore();
        }
      }
      ctx.beginPath();
      ctx.arc(ex, ey, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = CARD;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = LIME;
      ctx.fill();
    }
    this.drawTimeLabels(ctx, pts, W, H, L, R);
    this.drawCrosshair(ctx, dt, pts, x, y, W, H, T, B, L, R);
  };

  /** Nice-stepped grid whose lines and labels crossfade as the range moves. */
  private drawGrid(ctx: CanvasRenderingContext2D, dt: number, W: number, T: number, L: number, R: number, chH: number): void {
    const pxPerVal = chH / this.dispSpan;
    const seq = [2, 2.5, 2];
    let step = Math.pow(10, Math.ceil(Math.log10(this.dispSpan || 1)));
    let si = 0;
    while ((step / seq[si % 3]) * pxPerVal >= 36 && si < 40) { step /= seq[si % 3]; si++; }
    const yOf = (v: number) => T + (1 - (v - this.dispMin) / this.dispSpan) * chH;
    const targets = new Map<number, number>();
    const first = Math.ceil(this.dispMin / step) * step;
    for (let v = first; v <= this.dispMin + this.dispSpan; v += step) {
      const yy = yOf(v);
      const edge = Math.min(yy - T, T + chH - yy);
      const a = edge >= 28 ? 1 : edge <= 0 ? 0 : edge / 28;
      if (a > 0) { targets.set(Math.round(v * 1e6), a); }
    }
    for (const key of Array.from(this.gridAlphas.keys())) {
      if (!targets.has(key)) { targets.set(key, 0); }
    }
    ctx.save();
    ctx.setLineDash([4, 8]);
    ctx.lineWidth = 1;
    ctx.font = '500 11.5px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'right';
    for (const [key, target] of Array.from(targets)) {
      const cur = this.gridAlphas.get(key) ?? 0;
      let a = this.ease(cur, target, target > cur ? 0.18 : 0.12, dt);
      if (Math.abs(a - target) < 0.02) { a = target; }
      if (a < 0.01 && target === 0) { this.gridAlphas.delete(key); continue; }
      this.gridAlphas.set(key, a);
      if (a < 0.02) { continue; }
      const yy = yOf(key / 1e6);
      ctx.globalAlpha = a;
      ctx.strokeStyle = 'rgba(55, 60, 55, 0.6)';
      ctx.beginPath();
      ctx.moveTo(L, yy);
      ctx.lineTo(W - R, yy);
      ctx.stroke();
      ctx.fillStyle = '#b8ff3d';
      ctx.fillText(this.chartFmtF(key / 1e6), L - 10, yy + 4);
    }
    ctx.restore();
  }

  private drawTimeLabels(ctx: CanvasRenderingContext2D, pts: Array<{ at: number; v: number }>, W: number, H: number, L: number, R: number): void {
    const mid = pts[Math.floor(pts.length / 2)];
    ctx.save();
    ctx.fillStyle = '#b8ff3d';
    ctx.globalAlpha = 0.85;
    ctx.font = '500 11.5px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(this.when(pts[0].at), L, H - 8);
    ctx.textAlign = 'center';
    ctx.fillText(this.when(mid.at), (L + (W - R)) / 2, H - 8);
    ctx.textAlign = 'right';
    ctx.fillText(this.when(pts[pts.length - 1].at), W - R, H - 8);
    ctx.restore();
  }

  /** Crosshair: eased in and out, the dot riding the curve between samples. */
  private drawCrosshair(ctx: CanvasRenderingContext2D, dt: number, pts: Array<{ at: number; v: number }>, x: (t: number) => number, y: (v: number) => number, W: number, H: number, T: number, B: number, L: number, R: number): void {
    const target = this.cross.active && this.reveal > 0.9 ? 1 : 0;
    this.cross.alpha = this.ease(this.cross.alpha, target, target ? 0.25 : 0.15, dt);
    const a = this.cross.alpha;
    if (a < 0.01) { return; }
    const t0 = pts[0].at, t1 = pts[pts.length - 1].at;
    const cx = Math.max(L, Math.min(W - R, this.cross.x));
    const t = t0 + ((cx - L) / (W - L - R)) * (t1 - t0);
    const v = this.valueAt(pts, t);
    const cy = this.curve ? curveYAt(this.curve, cx) : Math.max(T, Math.min(H - B, y(v)));
    ctx.save();
    ctx.globalAlpha = a * 0.55;
    ctx.strokeStyle = 'rgba(184, 255, 61, 0.6)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, T);
    ctx.lineTo(cx, H - B);
    ctx.stroke();
    ctx.setLineDash([]);
    const r = 4 * Math.min(a * 3, 1);
    if (r > 0.5) {
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#b8ff3d';
      ctx.fill();
    }
    // Inline readout at the top, haloed and clamped, like the reference.
    const valTxt = this.chartSeries === 'pnl' ? this.usd(v, true) : this.chartFmtF(v);
    const sep = '  ·  ';
    const timeTxt = this.when(t);
    ctx.globalAlpha = a;
    ctx.font = '700 13px "Plus Jakarta Sans", sans-serif';
    const wVal = ctx.measureText(valTxt).width;
    ctx.font = '500 13px "Plus Jakarta Sans", sans-serif';
    const wRest = ctx.measureText(sep + timeTxt).width;
    let tx = cx - (wVal + wRest) / 2;
    tx = Math.max(L + 4, Math.min(W - R - wVal - wRest - 4, tx));
    const ty = T + 10;
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#161816';
    ctx.font = '700 13px "Plus Jakarta Sans", sans-serif';
    ctx.strokeText(valTxt, tx, ty);
    ctx.fillStyle = '#fff';
    ctx.fillText(valTxt, tx, ty);
    ctx.font = '500 13px "Plus Jakarta Sans", sans-serif';
    ctx.strokeText(sep + timeTxt, tx + wVal, ty);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(sep + timeTxt, tx + wVal, ty);
    ctx.restore();
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
    if (!it.animate) {
      if (it.node) { it.tx.textContent = ''; it.tx.appendChild(it.node); }
      else
      it.tx.textContent = it.text;
      if (stick) { term.scrollTop = term.scrollHeight; }
      this.drain();
      return;
    }
    let i = 0;
    const n = it.text.length;
    const step = n > 180 ? 3 : n > 90 ? 2 : 1;
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
    this.refreshTimer = setTimeout(() => this.zone.run(() => this.refresh()), 3000);
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
    this.updateChart();
  }

  private onTrade(x: ObsTrade): void {
    const at = x.updatedAt || x.at;
    if (at <= this.lastTradeAt) { return; }
    this.lastTradeAt = at;
    this.push([this.tradeLine(x, true)]);
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => this.zone.run(() => this.refresh()), 3000);
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

  when(ts: number): string {
    const d = new Date(ts), now = new Date();
    const pad = (n: number) => (n < 10 ? '0' : '') + n;
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === now.toDateString() ? t : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${t}`;
  }

  clock(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => (n < 10 ? '0' : '') + n;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /** Uppercase the first letter of every word, leaving the rest untouched ("2h ago" -> "2h Ago"). */
  private capWords(s: string): string {
    return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
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

  get feedHead(): string {
    const mode = this.status?.agent?.mode;
    return '@' + this.handle + (mode === 'live' ? ' · live' : mode === 'draft' ? ' · drafts' : '');
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
