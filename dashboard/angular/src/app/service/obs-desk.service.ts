import { Injectable, InjectionToken, Type } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../environments/environment';

// Typed mirror of the OBS dashboard API (agent-obs, dashboard/INTEGRATION.md).
// All responses are read-only JSON; every numeric field can be null, which
// means "not measured this cycle", never zero. Timestamps are Unix ms.

export interface ObsDeskSummary {
  equityUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  netCapitalUsd: number;
  trades: { settled: number; pending: number; proposed: number };
  lastThoughtAt: number | null;
  markedAt: number | null;
  canExecute: boolean;
}

export interface ObsWalletLink { address: string; explorerUrl: string; }

/** The limits every swap is checked against, next to what is used. */
export interface ObsRails {
  tradingOn: boolean;
  maxSwapUsd: number;
  maxOpenOrders: number;
  gasReserveEth: number;
  openOrders: number;
  allowedAssets: string[];
  /** null = any Obscura route may be used. */
  allowedPartners: string[] | null;
}

export interface ObsStatus {
  agent: { operator: string; voice: string; handle: string; mode: 'live' | 'draft' | 'unconfigured' };
  desk: ObsDeskSummary;
  posts: { total: number; published: number; drafts: number; lastAt: number | null };
  replies: { total: number; published: number; lastAt: number | null };
  decisions: { post: number; hold: number };
  token: { contract: string; site: string };
  limits: { maxTweetChars: number };
  rails?: ObsRails;
  wallet?: ObsWalletLink | null;
  /** What the console offers today: how its door is kept, and whether apps and credit purchases are switched on. */
  console?: { gate: 'on' | 'allowlist' | 'off'; apps: boolean; credits: boolean; freeCredits: number };
  at: number;
}

export interface ObsDecision {
  kind: 'hold' | 'propose-swap';
  reason?: string;
  from?: string;
  to?: string;
  amount?: number;
}

/** One token in play, as the desk digested it for the page. */
export interface ObsTokenDigest {
  symbol: string;
  role: 'held' | 'launch';
  line: string;
  tone: 'good' | 'bad' | 'quiet';
  /** The gates, structured: the page draws one chip per gate; `short` is the failing reason in a few words, `why` the whole of it. */
  entry?: { state: string; ok: boolean; why: string };
  holders?: { ok: boolean; why: string; short: string };
  launch?: { ok: boolean; score: number | null; why: string; short: string };
  records?: string;
  tape?: string;
}

/** The cycle digested for a reader: the verdict, one sentence, each token's status, the argument when there was one. Additive. */
export interface ObsDigest {
  verdict: 'hold' | 'probe' | 'sell' | 'swap' | 'refused';
  headline: string;
  /** The agent's own lines without repeats and without the one that restates the headline. */
  lines?: string[];
  wanted?: string;
  tokens: ObsTokenDigest[];
  board?: { early: number; probeAllowed: number; gateFailed: number; graded: number; belowBar: number };
  argument?: { thesis: string; evidence: string[]; invalidation: string; conviction: number | null };
}

export interface ObsThought {
  at: number;
  observation: string[];
  thoughts: string[];
  decision: ObsDecision;
  digest?: ObsDigest;
}

/** The agent's own token, read from its pool and its transfers; every figure null until it can be measured. */
export interface ObsAgentToken {
  contract: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: number | null;
  phase: string | null;
  pair: string | null;
  poolId: string | null;
  priceUsd: number | null;
  depthUsd2pct: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  swaps24h: number | null;
  holders: number | null;
  /** What the pool holds, in dollars (one full-range locked position). */
  tvlUsd?: number | null;
  /** The price against the oldest sample inside the last day, a fraction; null until there are two samples. */
  change24hPct?: number | null;
  /** The same for TVL, the 24-hour volume and the holder count, measured by the API, not the browser. */
  change24h?: { price: number | null; liquidity: number | null; volume: number | null; holders: number | null };
  launchedAt: number | null;
  explorerUrl: string;
  at: number;
}

/** One line of the research log: what the desk learned about a token, as it learned it (stream event `research`, endpoint `/api/obs/research`). */
export interface ObsResearchEvent {
  at: number;
  kind: 'launch' | 'ignited' | 'watch' | 'dropped' | 'entry' | 'holders' | 'launch-read' | 'trigger' | 'holding' | 'decision' | 'scout';
  symbol: string;
  ok: boolean | null;
  note: string;
  line: string;
}

/** The live watch between cycles: one line a minute on the stream's `watch` event, and every trigger as it fires. */
export interface ObsWatchEvent {
  at: number;
  block: number | null;
  lookMs: number | null;
  line: string;
  trigger: string | null;
  /** What the trigger was: `entry` on a watched token, `held` (a review) or `exit` (its tape broke) on a token the desk holds. */
  triggerKind?: 'exit' | 'entry' | 'held' | null;
  cycleRunning: boolean;
}

/** One token the live watch is following, as `/api/obs/live` lists it. */
export interface ObsLiveWatch {
  symbol: string;
  role: 'held' | 'launch' | 'stable';
  entryState?: string | null;
  entryOk?: boolean;
}

/** The live watch's heartbeat: the page polls it when the stream is down, so the watch line keeps moving. */
export interface ObsLive {
  live: boolean;
  at: number;
  block: number | null;
  lookMs: number | null;
  watching: ObsLiveWatch[];
  lastTrigger: string | null;
  cycles: number;
  cycleRunning: boolean;
}

export interface ObsTradeLeg { asset: string; network: string; amount: number | null; usd: number | null; }

export interface ObsTrade {
  at: number;
  id: string;
  status: 'proposed' | 'pending' | 'settled' | 'failed' | 'cancelled';
  from: ObsTradeLeg;
  to: ObsTradeLeg;
  partner: string | null;
  settlementTx?: string | null;
  explorerUrl?: string | null;
  depositTx?: string | null;
  depositTxUrl?: string | null;
  trackUrl?: string | null;
  note?: string;
  updatedAt?: number;
}

export interface ObsBookSnapshot {
  at: number;
  /** "chain" when holdings were read from the wallet, "ledger" otherwise. */
  source?: 'chain' | 'ledger';
  holdings: { [asset: string]: number };
  equityUsd: number | null;
  inFlightUsd: number;
  netCapitalUsd: number;
  pnlUsd: number | null;
  pnlPct: number | null;
  unpriced: string[];
}

/** One holding as a position: size, average cost, mark and its PnL. */
export interface ObsPosition {
  asset: string;
  qty: number;
  priceUsd: number | null;
  valueUsd: number | null;
  /** null when the ledgers never recorded a cost: show "no cost recorded". */
  avgCostUsd: number | null;
  costUsd: number | null;
  unrealizedUsd: number | null;
  unrealizedPct: number | null;
  realizedUsd: number;
  /** Share of priced equity, 0 to 1. */
  share: number | null;
}

export interface ObsInFlight {
  id: string;
  from: ObsTradeLeg;
  to: ObsTradeLeg;
  usd: number | null;
  costUsd: number | null;
}

export interface ObsPnl {
  snapshot: ObsBookSnapshot;
  prices: { [asset: string]: number | null };
  positions?: ObsPosition[];
  realizedUsd?: number;
  inFlight?: ObsInFlight[];
  series: Array<{ at: number; equityUsd: number | null; pnlUsd: number | null }>;
  capital: { netUsd: number; deposits: number; withdrawals: number; ethIn?: number };
  trades: { settled: number; pending: number; proposed: number; failed: number };
  /** Round trips closed in the last 24 hours, newest first (since September 6). */
  closed?: ObsClosedTrade[];
  canExecute: boolean;
  at: number;
}

export interface ObsClosedTrade {
  asset: string;
  openedAt: number;
  closedAt: number;
  heldMin: number;
  inUsd: number | null;
  outUsd: number | null;
  resultUsd: number;
  /** "trail", "floor", "tape-profit", "take-profit", "time-stop", "volume", or "the model". */
  how: string;
  tx: string | null;
}

export interface ObsFeedItem {
  at: number;
  kind: 'post' | 'reply';
  text: string;
  posted: boolean;
  mode: 'live' | 'draft' | 'unconfigured';
  id?: string;
  url?: string;
  inReplyToId?: string;
}

export interface ObsWalletReads {
  address: string;
  ethRobinhood: number | null;
  ethMainnet: number | null;
  usdg: number | null;
  obs: number | null;
  rewards?: { swaps: number; volumeUsd: number; rewardsUsd: number; paidUsd: number } | null;
}

/** $OBS priced by its own on-chain pool; null when the chain did not answer. */
export interface ObsPoolRead {
  priceUsd: number | null;
  /** Dollars that move the price 2%. */
  depthUsd2pct: number | null;
  venue: string | null;
  feePct: number | null;
  usdgInPool: number | null;
  obsInPool: number | null;
  tvlUsd: number | null;
  /** The pool's quote asset: USDG for the Ramses pool, ETH for the v4 pool (since September 5). */
  quote?: 'USDG' | 'ETH';
}

export interface ObsReads {
  token: {
    address: string; name: string | null; symbol: string | null; decimals: number | null;
    totalSupply: string | null; holders: number | null;
    /** The explorer's own lagging figures. */
    explorerPriceUsd?: number | null; volume24hUsd?: number | null; marketCapUsd?: number | null;
    /** 24-hour changes measured by the API from its own samples, as fractions. */
    change24h?: { volume: number | null; holders: number | null; liquidity: number | null };
  };
  prices: { btcUsd: number | null; ethUsd: number | null };
  market?: ObsPoolRead | null;
  siteUp: boolean;
  apiUp: boolean;
  wallet?: ObsWalletReads | null;
  block: string;
  at: number;
}

/** The $OBS price over time, sampled from the pool. */
export interface ObsMarket {
  series: Array<{ at: number; priceUsd: number | null; depthUsd2pct: number | null }>;
  change24hPct: number | null;
  samples: number;
  at: number;
}

export interface ObsItems<T> { items: T[]; at: number; }

/** One row of CoinGecko's /coins/markets, for the Market asset switcher. */
export interface CgMarket {
  id: string;
  current_price: number | null;
  market_cap: number | null;
  total_volume: number | null;
  high_24h: number | null;
  low_24h: number | null;
  circulating_supply: number | null;
  price_change_percentage_24h: number | null;
  market_cap_change_percentage_24h: number | null;
}

/**
 * The API base URL, resolved once per page load:
 *   1. `?api=https://host` in the address bar wins and is remembered in localStorage,
 *      `?api=reset` forgets it (handy when testing the front end against another backend);
 *   2. otherwise whatever was remembered;
 *   3. otherwise, on obscura.market or obscura.markets, `https://obs-api.obscura.markets`,
 *      the API name that has a certificate today (the name in the obscura.market zone
 *      still waits on an ownership record; a probe of it cost every visitor four seconds);
 *   4. otherwise `environment.obsApiUrl` ('' means same-origin, see proxy.conf.json).
 */
/** The desk's direct address, used when a site's own API name does not answer (DNS or certificate not ready). */
export const OBS_API_FALLBACK = 'https://desk-production-18ad.up.railway.app';
let resolved: string | null = null;

export function resolveObsApiUrl(): string {
  if (resolved !== null) { return resolved; }
  const KEY = 'obsApiUrl';
  let url = environment.obsApiUrl;
  try {
    const host = window.location.hostname.replace(/^www\./, '');
    // Both domains use the API name that has a certificate today (obs-api.obscura.markets). The name in the
    // obscura.market zone waits on an ownership record; probing it first cost every visitor a four-second wait.
    if (host === 'obscura.market' || host === 'obscura.markets') { url = 'https://obs-api.obscura.markets'; }
  } catch { /* no window: keep the environment value */ }
  try {
    const q = new URLSearchParams(window.location.search).get('api');
    if (q === 'reset') {
      localStorage.removeItem(KEY);
    } else if (q !== null) {
      localStorage.setItem(KEY, q.trim());
    }
    const saved = localStorage.getItem(KEY);
    if (saved !== null) { url = saved; }
  } catch { /* no window/localStorage (tests, SSR): keep the environment value */ }
  resolved = url.replace(/\/+$/, '');
  return resolved;
}

/**
 * If the chosen name does not answer within a few seconds (a fresh DNS record, a
 * certificate still being issued), switch to the desk's direct address for this
 * page load. The service reads `base` on every call, so the next poll uses it.
 */
export function probeObsApiUrl(): void {
  const url = resolveObsApiUrl();
  if (!url || url === OBS_API_FALLBACK || typeof fetch === 'undefined') { return; }
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), 4000);
  fetch(`${url}/api/obs/health`, { signal: ctl?.signal, cache: 'no-store' })
    .then((r) => { if (!r.ok) { resolved = OBS_API_FALLBACK; } })
    .catch(() => { resolved = OBS_API_FALLBACK; })
    .finally(() => clearTimeout(timer));
}

/** One transaction the person's own wallet signs for a console swap: the one-time approvals a token input needs, then the swap. */
export interface ObsConsoleStep { id: 'approve-token' | 'approve-permit2' | 'swap'; to: string; data: string; value: string; chainId: number; note: string; }
/** `/api/obs/console/quote`: the pair through the desk's router, the app's Relay route beside it, and the steps. */
export interface ObsConsoleQuote {
  from: string; to: string; amountIn: number;
  pool: { amountOut: number; minOut: number; costPct: number | null; feePct: number; route: string[]; priceInUsd: number | null; priceOutUsd: number | null };
  relay: { amountOut: number | null; feeUsd: number | null; error: string | null } | null;
  steps: ObsConsoleStep[]; deadline: number;
}
/** `/api/obs/console/swaps`: the swaps a wallet made through the console, shown back to it; never a gate. */
export interface ObsStanding {
  address: string; swaps: number;
  recent: Array<{ at: number; txHash: string; from: string; to: string; amountIn: number; amountOut: number | null }>;
}
export interface ObsConsoleSwapReply { ok: boolean; already?: boolean; reason?: string; standing?: ObsStanding; }
/** `/api/obs/account/challenge` and `/link`: the wallet is the account; a signed challenge mints a week's bearer. */
export interface ObsChallenge { ok: boolean; message: string; nonce: string; }
export interface ObsSession { token: string; address: string; expiresAt: number; }
export interface ObsLinkReply { ok: boolean; error?: string; session?: ObsSession; standing?: ObsStanding; }
/** `/api/obs/console/cli`: one typed line in, lines out, plus the effect the page applies. */
export interface ObsCliReply {
  ok: boolean; lines?: string[]; effect?: string; suggest?: string[]; text?: string;
  action?: string; amount?: number; from?: string; to?: string; settings?: ObsUserSettings; standing?: ObsStanding;
  /** A view effect: which of the site's pages to open beside the console, or null to close it. */
  view?: string | null;
  /** Links to open, such as an app's sign-in; rendered as chips that open a new tab. */
  links?: Array<{ label: string; url: string }>;
  /** A pay effect: the one transaction the wallet signs to add credits, priced before signing. */
  pay?: ObsPayment;
  /** Credits after a credits effect. */
  balance?: number;
}
export interface ObsPayment { to: string; data: string; value: string; chainId: number; note: string; token: string; amount: number; creditsUsd: number; credits: number; bonusPct: number; }
/** Credits, a cent each: a thousand are $10 of USDG. */
export interface ObsCredits { ok: boolean; balance: number; granted: number; deposited: number; spent: number; turns: number; creditsPerUsd: number; model: string; canBuy: boolean; }
export interface ObsUserSettings { name?: string; style?: 'concise' | 'balanced' | 'deep'; voice?: string; goal?: string; }
export interface ObsEnsureReply { ok: boolean; code?: string; error?: string; ready?: boolean; created?: boolean; name?: string; settings?: ObsUserSettings; }
export interface ObsHistoryTurn { role: string; content: string; ts: string; }

/**
 * The site's own pages the console can open beside itself, by command name: trade, rewards, cards, yield (see below): cards, referral,
 * yield. The site's module provides the map from its components (the relay wires it); this repo's build provides
 * none, so a view command here says the view is not in this build.
 */
export const CONSOLE_VIEWS = new InjectionToken<Record<string, Type<unknown>>>('obs.console.views', { providedIn: 'root', factory: () => ({}) });

/** One wallet the site detected in the browser (EIP-6963, or the injected fallback). */
export interface ConsoleWalletOption { uuid: string; name: string; rdns: string; provider: any; }
/**
 * The site's own wallet connection, when it has one: the same picker and the same provider the header uses, so
 * signing in to the console uses the wallet the person already chose. A structural subset of the site's
 * WalletService; this repo's build provides none and the console falls back to window.ethereum.
 */
export interface ConsoleWallet {
  readonly address: string | null;
  readonly provider: any;
  readonly address$: { subscribe: (next: (address: string | null) => void) => { unsubscribe(): void } };
  list(): ConsoleWalletOption[];
  connect(option: ConsoleWalletOption): Promise<void>;
}
export const CONSOLE_WALLET = new InjectionToken<ConsoleWallet | null>('obs.console.wallet', { providedIn: 'root', factory: () => null });


@Injectable({ providedIn: 'root' })
export class ObsDeskService {
  /** Read on every call, so a fallback chosen by the probe takes effect on the next request. */
  get base(): string { return resolveObsApiUrl(); }

  constructor(private http: HttpClient) { probeObsApiUrl(); }

  status(): Observable<ObsStatus> {
    return this.http.get<ObsStatus>(`${this.base}/api/obs/status`);
  }

  pnl(hours = 168): Observable<ObsPnl> {
    return this.http.get<ObsPnl>(`${this.base}/api/obs/pnl`, { params: { hours } });
  }

  thoughts(limit = 12): Observable<ObsItems<ObsThought>> {
    return this.http.get<ObsItems<ObsThought>>(`${this.base}/api/obs/thoughts`, { params: { limit } });
  }

  trades(limit = 20): Observable<ObsItems<ObsTrade>> {
    return this.http.get<ObsItems<ObsTrade>>(`${this.base}/api/obs/trades`, { params: { limit } });
  }

  feed(limit = 8): Observable<ObsItems<ObsFeedItem>> {
    return this.http.get<ObsItems<ObsFeedItem>>(`${this.base}/api/obs/feed`, { params: { limit } });
  }

  agentToken(): Observable<ObsAgentToken> {
    return this.http.get<ObsAgentToken>(`${this.base}/api/obs/agent-token`);
  }

  reads(): Observable<ObsReads> {
    return this.http.get<ObsReads>(`${this.base}/api/obs/reads`);
  }

  market(hours = 168): Observable<ObsMarket> {
    return this.http.get<ObsMarket>(`${this.base}/api/obs/market`, { params: { hours } });
  }

  /** The research log, newest first: what the desk learned between cycles. Polled when the stream is down. */
  research(limit = 40): Observable<ObsItems<ObsResearchEvent>> {
    return this.http.get<ObsItems<ObsResearchEvent>>(`${this.base}/api/obs/research`, { params: { limit } });
  }

  /** The live watch's heartbeat. Polled when the stream is down. */
  live(): Observable<ObsLive> {
    return this.http.get<ObsLive>(`${this.base}/api/obs/live`);
  }

  /** The swap console: a quote through the desk's router with the transactions the person's wallet signs. */
  consoleQuote(from: string, to: string, amount: number, user: string): Observable<ObsConsoleQuote> {
    return this.http.get<ObsConsoleQuote>(`${this.base}/api/obs/console/quote`, { params: { from, to, amount, user } });
  }

  consoleSwaps(address: string): Observable<ObsStanding> {
    return this.http.get<ObsStanding>(`${this.base}/api/obs/console/swaps`, { params: { address } });
  }

  /** Sign in: the wallet is the account. A challenge to sign, then the signature for a bearer. */
  accountChallenge(address: string): Observable<ObsChallenge> {
    return this.http.post<ObsChallenge>(`${this.base}/api/obs/account/challenge`, { address });
  }

  accountLink(address: string, nonce: string, signature: string): Observable<ObsLinkReply> {
    return this.http.post<ObsLinkReply>(`${this.base}/api/obs/account/link`, { address, nonce, signature });
  }

  private bearer(token: string): { headers: { Authorization: string } } {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  /** One typed console line; the desk routes it and answers, or hands back an effect for the page. */
  cli(token: string, line: string): Observable<ObsCliReply> {
    return this.http.post<ObsCliReply>(`${this.base}/api/obs/console/cli`, { line }, this.bearer(token));
  }

  myAgentEnsure(token: string): Observable<ObsEnsureReply> {
    return this.http.post<ObsEnsureReply>(`${this.base}/api/obs/my-agent/ensure`, {}, this.bearer(token));
  }

  myAgentHistory(token: string): Observable<{ ok: boolean; turns: ObsHistoryTurn[] }> {
    return this.http.get<{ ok: boolean; turns: ObsHistoryTurn[] }>(`${this.base}/api/obs/my-agent/history`, this.bearer(token));
  }

  /** The stream is read with fetch, because HttpClient buffers; this is the URL and the headers for it. */
  /** The person's answer to an approval their agent asked for: a tool call inside one of their apps. */
  myAgentApprove(token: string, toolCallId: string, approved: boolean): Observable<{ ok: boolean; resolved?: boolean }> {
    return this.http.post<{ ok: boolean; resolved?: boolean }>(`${this.base}/api/obs/my-agent/approve`, { toolCallId, approved }, this.bearer(token));
  }

  credits(token: string): Observable<ObsCredits> {
    return this.http.get<ObsCredits>(`${this.base}/api/obs/credits`, this.bearer(token));
  }

  creditsVerify(token: string, txHash: string): Observable<{ ok: boolean; already?: boolean; usd?: number; token?: string; amount?: number; balance?: number; reason?: string }> {
    return this.http.post<{ ok: boolean; already?: boolean; usd?: number; token?: string; amount?: number; balance?: number; reason?: string }>(`${this.base}/api/obs/credits/verify`, { txHash }, this.bearer(token));
  }

  myAgentStream(token: string): { url: string; headers: Record<string, string> } {
    return { url: `${this.base}/api/obs/my-agent/stream`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
  }

  /** Report a swap the person sent; the desk reads it off the chain before it counts. */
  consoleSwap(body: { address: string; txHash: string; from: string; to: string; amountIn: number }): Observable<ObsConsoleSwapReply> {
    return this.http.post<ObsConsoleSwapReply>(`${this.base}/api/obs/console/swap`, body);
  }

  /** URL of the SSE terminal stream (hello/thought/trade events), for EventSource. */
  streamUrl(limit = 12): string {
    return `${this.base}/api/obs/stream?limit=${limit}`;
  }

  /** Public CoinGecko read (no key, CORS-open) for the Market asset switcher. */
  assetMarkets(): Observable<CgMarket[]> {
    return this.http.get<CgMarket[]>('https://api.coingecko.com/api/v3/coins/markets', {
      params: { vs_currency: 'usd', ids: 'ethereum,bitcoin,binancecoin,solana,global-dollar' }
    });
  }
}
