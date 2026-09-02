import { Injectable } from '@angular/core';
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
  dailySwapUsd: number;
  maxOpenOrders: number;
  gasReserveEth: number;
  sentTodayUsd: number;
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
  at: number;
}

export interface ObsDecision {
  kind: 'hold' | 'propose-swap';
  reason?: string;
  from?: string;
  to?: string;
  amount?: number;
}

export interface ObsThought {
  at: number;
  observation: string[];
  thoughts: string[];
  decision: ObsDecision;
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
  capital: { netUsd: number; deposits: number; withdrawals: number };
  trades: { settled: number; pending: number; proposed: number; failed: number };
  canExecute: boolean;
  at: number;
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
}

export interface ObsReads {
  token: {
    address: string; name: string | null; symbol: string | null; decimals: number | null;
    totalSupply: string | null; holders: number | null;
    /** The explorer's own lagging figures. */
    explorerPriceUsd?: number | null; volume24hUsd?: number | null; marketCapUsd?: number | null;
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
 *   3. otherwise `environment.obsApiUrl` ('' means same-origin, see proxy.conf.json).
 */
export function resolveObsApiUrl(): string {
  const KEY = 'obsApiUrl';
  let url = environment.obsApiUrl;
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
  return url.replace(/\/+$/, '');
}

@Injectable({ providedIn: 'root' })
export class ObsDeskService {
  readonly base = resolveObsApiUrl();

  constructor(private http: HttpClient) {}

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

  reads(): Observable<ObsReads> {
    return this.http.get<ObsReads>(`${this.base}/api/obs/reads`);
  }

  market(hours = 168): Observable<ObsMarket> {
    return this.http.get<ObsMarket>(`${this.base}/api/obs/market`, { params: { hours } });
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
