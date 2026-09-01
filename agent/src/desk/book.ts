// The desk's book: what OBS holds, what it is worth, and the PnL against the
// capital he was handed. Deterministic arithmetic over three append-only
// ledgers; the dashboard's PnL is this and nothing else.
//
//   obs-capital.jsonl   operator moves: {at, kind: deposit|withdraw, asset, amount, usd}
//   obs-trades.jsonl    swaps through Obscura: one row per status change, same id
//   obs-book.jsonl      equity snapshots, one per desk cycle
//
// A trade is a swap: one asset leaves the wallet (from), another arrives (to).
// While it is pending the from leg has left and the to leg has not landed, so
// its dollar value rides as "in flight" rather than vanishing from equity.
// PnL is equity minus net capital: honest, mark-to-market, no accrual games.
import { appendLedger, readLedger } from "../ledger.ts";

export type TradeStatus = "proposed" | "pending" | "settled" | "failed" | "cancelled";

export interface Leg {
  asset: string;
  network?: string | null;
  amount: number;
  /** Dollar value at the time the row was written; null when unpriced. */
  usd: number | null;
}

export interface Trade {
  at: number;
  /** Obscura order id once one exists; a local id for a proposal. */
  id: string;
  status: TradeStatus;
  from: Leg;
  to: Leg;
  partner: string | null;
  settlementTx?: string | null;
  explorerUrl?: string | null;
  /** The deposit the desk sent to open the swap, and where to see it. */
  depositTx?: string | null;
  depositTxUrl?: string | null;
  /** Obscura's public order page for this swap. */
  trackUrl?: string | null;
  /** The desk's stated reason, public. */
  note?: string;
  updatedAt?: number;
}

export interface CapitalFlow {
  at: number;
  kind: "deposit" | "withdraw";
  asset: string;
  amount: number;
  usd: number | null;
}

export interface BookSnapshot {
  at: number;
  /** "chain" when holdings were read from the wallet, "ledger" when derived from the ledgers. */
  source?: "chain" | "ledger";
  holdings: Record<string, number>;
  /** Dollar value of priced holdings plus in-flight swaps; null if nothing could be priced. */
  equityUsd: number | null;
  inFlightUsd: number;
  netCapitalUsd: number;
  pnlUsd: number | null;
  pnlPct: number | null;
  /** Assets held with no price this cycle; their value is missing from equity, and the snapshot says so. */
  unpriced: string[];
}

export type Prices = Record<string, number | null>;

const STABLES = new Set(["USDG", "USDC", "USDT", "DAI", "USDE"]);
const EPS = 1e-12;

/** PURE: the latest row per trade id (the ledger is append-only, updates re-append). */
export function latestTrades(rows: Trade[]): Trade[] {
  const byId = new Map<string, Trade>();
  for (const r of rows) {
    if (!r?.id) continue;
    const prev = byId.get(r.id);
    if (!prev || (r.updatedAt ?? r.at) >= (prev.updatedAt ?? prev.at)) byId.set(r.id, r);
  }
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

/** PURE: what the wallet holds after every capital move and every settled or in-flight swap. */
export function holdingsFrom(flows: CapitalFlow[], trades: Trade[]): Record<string, number> {
  const h: Record<string, number> = {};
  const add = (asset: string, qty: number) => {
    const k = asset.toUpperCase();
    h[k] = (h[k] ?? 0) + qty;
  };
  for (const f of flows) add(f.asset, f.kind === "deposit" ? f.amount : -f.amount);
  for (const t of latestTrades(trades)) {
    if (t.status === "settled") {
      add(t.from.asset, -t.from.amount);
      add(t.to.asset, t.to.amount);
    } else if (t.status === "pending") {
      add(t.from.asset, -t.from.amount);
    }
  }
  for (const k of Object.keys(h)) if (Math.abs(h[k]) < EPS) delete h[k];
  return h;
}

/** PURE: capital in minus capital out, in dollars as recorded at the time. */
export function netCapitalUsd(flows: CapitalFlow[]): number {
  let n = 0;
  for (const f of flows) n += (f.kind === "deposit" ? 1 : -1) * (f.usd ?? 0);
  return n;
}

/** PURE: dollar value of holdings at these prices. Stables are a dollar unless priced. */
export function valueHoldings(holdings: Record<string, number>, prices: Prices): { usd: number; priced: number; unpriced: string[] } {
  let usd = 0;
  let priced = 0;
  const unpriced: string[] = [];
  for (const [asset, qty] of Object.entries(holdings)) {
    const p = prices[asset] ?? (STABLES.has(asset) ? 1 : null);
    if (p == null) {
      unpriced.push(asset);
      continue;
    }
    usd += qty * p;
    priced++;
  }
  return { usd, priced, unpriced };
}

/** PURE: the book right now. */
export function snapshot(flows: CapitalFlow[], trades: Trade[], prices: Prices, now: number): BookSnapshot {
  const holdings = holdingsFrom(flows, trades);
  const { usd, priced, unpriced } = valueHoldings(holdings, prices);
  const inFlightUsd = latestTrades(trades)
    .filter((t) => t.status === "pending")
    .reduce((s, t) => s + (t.from.usd ?? 0), 0);
  const net = netCapitalUsd(flows);
  const anyValue = priced > 0 || inFlightUsd > 0 || Object.keys(holdings).length === 0;
  const equityUsd = anyValue ? usd + inFlightUsd : null;
  const pnlUsd = equityUsd == null ? null : equityUsd - net;
  const pnlPct = pnlUsd == null || net <= 0 ? null : pnlUsd / net;
  return { at: now, source: "ledger", holdings, equityUsd, inFlightUsd, netCapitalUsd: net, pnlUsd, pnlPct, unpriced };
}

/**
 * PURE: the book from what the chain says the wallet holds. Once a wallet
 * exists this is the truth: gas, fees and dust all show up here, where the
 * ledger alone would drift. In-flight swaps still ride as dollars because
 * their from-leg has left the wallet and their to-leg has not landed.
 */
export function snapshotFromChain(flows: CapitalFlow[], trades: Trade[], balances: Record<string, number>, prices: Prices, now: number): BookSnapshot {
  const holdings: Record<string, number> = {};
  for (const [k, v] of Object.entries(balances)) if (v != null && Math.abs(v) >= EPS) holdings[k.toUpperCase()] = (holdings[k.toUpperCase()] ?? 0) + v;
  const { usd, priced, unpriced } = valueHoldings(holdings, prices);
  const inFlightUsd = latestTrades(trades)
    .filter((t) => t.status === "pending")
    .reduce((s, t) => s + (t.from.usd ?? 0), 0);
  const net = netCapitalUsd(flows);
  const anyValue = priced > 0 || inFlightUsd > 0 || Object.keys(holdings).length === 0;
  const equityUsd = anyValue ? usd + inFlightUsd : null;
  const pnlUsd = equityUsd == null ? null : equityUsd - net;
  const pnlPct = pnlUsd == null || net <= 0 ? null : pnlUsd / net;
  return { at: now, source: "chain", holdings, equityUsd, inFlightUsd, netCapitalUsd: net, pnlUsd, pnlPct, unpriced };
}

/** PURE: the PnL curve from stored snapshots, oldest first, within a window. */
export function series(snapshots: BookSnapshot[], sinceMs: number, now: number): Array<{ at: number; equityUsd: number | null; pnlUsd: number | null }> {
  return snapshots
    .filter((s) => s.at >= now - sinceMs)
    .sort((a, b) => a.at - b.at)
    .map((s) => ({ at: s.at, equityUsd: s.equityUsd, pnlUsd: s.pnlUsd }));
}

// Positions: each holding with what it cost. Average cost from the ledgers,
// in time order: a deposit adds units at the dollars recorded for it, a
// withdrawal removes units at average cost, a settled swap sells the from leg
// at average cost (the difference to what it fetched is realized) and buys
// the to leg at what was spent. A pending swap parks the from leg's cost in
// flight. Where no dollar figure was recorded the basis is unknown and the
// position says so instead of pretending a zero cost and a fat gain.
interface Lot {
  qty: number;
  usd: number;
  /** False once any unit came in without a dollar figure, or more left than the ledger knew of. */
  known: boolean;
}

export interface CostBasis {
  lots: Record<string, Lot>;
  /** Realized dollars per asset from settled sells, where the basis was known. */
  realized: Record<string, number>;
  inFlight: Array<{ id: string; from: Leg; to: Leg; usd: number | null; costUsd: number | null }>;
}

/** PURE: average cost per asset after every flow and swap, oldest first. */
export function costBasis(flows: CapitalFlow[], trades: Trade[]): CostBasis {
  const lots: Record<string, Lot> = {};
  const realized: Record<string, number> = {};
  const inFlight: CostBasis["inFlight"] = [];
  const lot = (a: string): Lot => (lots[a.toUpperCase()] ??= { qty: 0, usd: 0, known: true });
  const avg = (a: string): number | null => {
    const l = lot(a);
    return l.known && l.qty > EPS ? l.usd / l.qty : null;
  };
  const put = (a: string, q: number, usd: number | null) => {
    const l = lot(a);
    l.qty += q;
    if (usd == null) l.known = false;
    else l.usd += usd;
  };
  /** Remove q units at average cost; the cost removed, or null when unknown. */
  const take = (a: string, q: number): number | null => {
    const l = lot(a);
    const c = avg(a);
    if (q > l.qty + EPS) l.known = false;
    const cost = c == null ? null : c * Math.min(q, l.qty);
    l.qty -= q;
    if (cost != null) l.usd -= cost;
    if (l.qty <= EPS) {
      l.qty = 0;
      l.usd = 0;
    }
    return cost;
  };
  type Ev = { at: number; flow?: CapitalFlow; trade?: Trade };
  const events: Ev[] = [
    ...flows.map((f) => ({ at: f.at, flow: f })),
    ...latestTrades(trades)
      .filter((t) => t.status === "settled" || t.status === "pending")
      .map((t) => ({ at: t.at, trade: t })),
  ].sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.flow) {
      if (e.flow.kind === "deposit") put(e.flow.asset, e.flow.amount, e.flow.usd);
      else take(e.flow.asset, e.flow.amount);
      continue;
    }
    const t = e.trade as Trade;
    const cost = take(t.from.asset, t.from.amount);
    if (t.status === "pending") {
      inFlight.push({ id: t.id, from: t.from, to: t.to, usd: t.from.usd, costUsd: cost });
      continue;
    }
    const spent = t.from.usd ?? t.to.usd;
    if (cost != null && spent != null) realized[t.from.asset.toUpperCase()] = (realized[t.from.asset.toUpperCase()] ?? 0) + (spent - cost);
    put(t.to.asset, t.to.amount, spent);
  }
  return { lots, realized, inFlight };
}

export interface Position {
  asset: string;
  qty: number;
  priceUsd: number | null;
  valueUsd: number | null;
  /** Average dollars paid per unit; null when the ledgers never recorded a cost. */
  avgCostUsd: number | null;
  costUsd: number | null;
  unrealizedUsd: number | null;
  unrealizedPct: number | null;
  /** Realized on this asset so far, from settled sells. */
  realizedUsd: number;
  /** Share of priced equity, 0 to 1. */
  share: number | null;
}

export interface Positions {
  positions: Position[];
  realizedUsd: number;
  inFlight: CostBasis["inFlight"];
}

/** PURE: every holding as a position with its cost, its mark and its PnL, largest first. */
export function positions(flows: CapitalFlow[], trades: Trade[], holdings: Record<string, number>, prices: Prices): Positions {
  const { lots, realized, inFlight } = costBasis(flows, trades);
  const total = valueHoldings(holdings, prices).usd;
  const rows: Position[] = [];
  for (const [asset, qty] of Object.entries(holdings)) {
    if (!(qty > EPS)) continue;
    const priceUsd = prices[asset] ?? (STABLES.has(asset) ? 1 : null);
    const valueUsd = priceUsd == null ? null : qty * priceUsd;
    const l = lots[asset];
    const avgCostUsd = l && l.known && l.qty > EPS ? l.usd / l.qty : null;
    const costUsd = avgCostUsd == null ? null : avgCostUsd * qty;
    const unrealizedUsd = valueUsd != null && costUsd != null ? valueUsd - costUsd : null;
    rows.push({
      asset,
      qty,
      priceUsd,
      valueUsd,
      avgCostUsd,
      costUsd,
      unrealizedUsd,
      unrealizedPct: unrealizedUsd != null && costUsd != null && costUsd > 0 ? unrealizedUsd / costUsd : null,
      realizedUsd: realized[asset] ?? 0,
      share: valueUsd != null && total > 0 ? valueUsd / total : null,
    });
  }
  rows.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  return { positions: rows, realizedUsd: Object.values(realized).reduce((s, v) => s + v, 0), inFlight };
}

export function readBook(): { flows: CapitalFlow[]; trades: Trade[]; snapshots: BookSnapshot[] } {
  return {
    flows: readLedger<CapitalFlow>("obs-capital.jsonl").filter((f) => f && f.asset && Number.isFinite(Number(f.amount))),
    trades: readLedger<Trade>("obs-trades.jsonl").filter((t) => t && t.id && t.from && t.to),
    snapshots: readLedger<BookSnapshot>("obs-book.jsonl").filter((s) => s && Number.isFinite(Number(s.at))),
  };
}

export function recordSnapshot(s: BookSnapshot): void {
  appendLedger("obs-book.jsonl", s as unknown as Record<string, unknown>);
}
export function recordTrade(t: Trade): void {
  appendLedger("obs-trades.jsonl", t as unknown as Record<string, unknown>);
}
export function recordCapital(f: CapitalFlow): void {
  appendLedger("obs-capital.jsonl", f as unknown as Record<string, unknown>);
}
