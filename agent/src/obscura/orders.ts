// Obscura's swap API, called the way the app itself calls it. The read paths
// (currencies, quote, order status) have no side effects and are safe to
// poll. Creating an order allocates a deposit address at a partner and is
// the first step of moving money, so it is gated: it needs an explicit
// receiving address and OBS_TRADING=on, and no loop in this repo calls it
// today. See DESIGN.md, the execution stage.
//
// Request shapes, from the app:
//   POST /quote         {fromCurrency, fromNetwork, toCurrency, toNetwork, amount}
//                       -> [{partner, toAmount, fixed, cex_id, isRelay?, ...}]
//   POST /order         {cex, fromCurrency, fromNetwork, fromImage, toCurrency,
//                        toNetwork, toImage, amount, address, extraId, fixed, cex_id}
//                       -> {status_id: 200, id}
//   POST /order/status  {order_id} -> {id, status, from:{address, amount}, to:{...}, date:{createdAt}}
//   GET  /currencies    -> [{code, network, id, name, popular, deposit, withdrawal, contractAddress, ...}]
import { API_URL } from "../config.ts";
import type { QuoteRead } from "../desk/thoughts.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface AssetRef {
  code: string;
  network: string;
}
export interface Currency extends AssetRef {
  id?: string;
  name?: string;
  networkName?: string;
  popular?: boolean;
  deposit?: boolean;
  withdrawal?: boolean;
  contractAddress?: string;
}
export interface Quote {
  partner: string;
  toAmount: number;
  fixed: boolean | null;
  cexId: string | number | null;
  isRelay: boolean;
  raw: Record<string, unknown>;
}
export interface OrderStatus {
  id: string;
  status: string;
  from: { amount: number | null; currency: string | null; address: string | null };
  to: { amount: number | null; currency: string | null; txHash: string | null };
  createdAt: string | null;
  raw: Record<string, unknown>;
}

async function call<T>(path: string, init: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(API_URL + path, { ...init, headers: { "content-type": "application/json", "User-Agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function currencies(): Promise<Currency[]> {
  const body = await call<unknown>("/currencies", { method: "GET" });
  return Array.isArray(body) ? (body as Currency[]).filter((c) => c && c.code && c.network) : [];
}

/** PURE: quotes with a real output, best first. Exported for tests. */
export function parseQuotes(body: unknown): Quote[] {
  if (!Array.isArray(body)) return [];
  const out: Quote[] = [];
  for (const q of body as Array<Record<string, unknown>>) {
    if (!q || typeof q !== "object") continue;
    const toAmount = Number(q.toAmount);
    if (!Number.isFinite(toAmount) || toAmount <= 0) continue;
    out.push({
      partner: String(q.partner ?? "").trim() || "unknown",
      toAmount,
      fixed: typeof q.fixed === "boolean" ? q.fixed : null,
      // The app forwards the quote's cex_id into the order; live quotes carry
      // the partner's reference as `id` on some routes and `cex_id` on others.
      cexId: typeof q.cex_id === "string" || typeof q.cex_id === "number" ? q.cex_id : typeof q.id === "string" && q.id ? q.id : null,
      isRelay: q.isRelay === true,
      raw: q,
    });
  }
  return out.sort((a, b) => b.toAmount - a.toAmount);
}

export async function quote(from: AssetRef, to: AssetRef, amount: number): Promise<Quote[]> {
  if (!(amount > 0)) return [];
  const body = await call<unknown>("/quote", { method: "POST", body: JSON.stringify({ fromCurrency: from.code, fromNetwork: from.network, toCurrency: to.code, toNetwork: to.network, amount }) });
  return parseQuotes(body);
}

/** PURE: an order as the app reads it, or null for a miss. The deposit
 *  address is returned to the caller (the execution stage needs it) and
 *  never written to any ledger. Exported for tests. */
export function parseOrderStatus(body: unknown): OrderStatus | null {
  const o = body as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !o.id || o.error || Number(o.status_id) === 404) return null;
  const from = (o.from ?? {}) as Record<string, unknown>;
  const to = (o.to ?? {}) as Record<string, unknown>;
  const date = (o.date ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const str = (v: unknown) => (v == null || v === "" ? null : String(v));
  return {
    id: String(o.id),
    status: String(o.status ?? "unknown"),
    from: { amount: num(from.amount), currency: str(from.currency ?? from.code), address: str(from.address) },
    to: { amount: num(to.amount), currency: str(to.currency ?? to.code), txHash: str(to.txHash ?? to.hash ?? o.txHash ?? o.hash) },
    createdAt: str(date.createdAt),
    raw: o,
  };
}

export async function orderStatus(id: string): Promise<OrderStatus | null> {
  if (!id) return null;
  return parseOrderStatus(await call<unknown>("/order/status", { method: "POST", body: JSON.stringify({ order_id: id }) }));
}

export interface WatchItem {
  from: AssetRef;
  to: AssetRef;
  amount: number;
}

/** PURE: "eth/eth->usdc/erc20:0.1,btc/btc->eth/eth:0.01". Bad entries are dropped. */
export function parseWatchlist(spec: string): WatchItem[] {
  const out: WatchItem[] = [];
  for (const part of (spec ?? "").split(",")) {
    const m = part.trim().match(/^([a-z0-9]+)\/([a-z0-9-]+)\s*->\s*([a-z0-9]+)\/([a-z0-9-]+)\s*:\s*([\d.]+)$/i);
    if (!m) continue;
    const amount = Number(m[5]);
    if (!(amount > 0)) continue;
    out.push({ from: { code: m[1].toLowerCase(), network: m[2].toLowerCase() }, to: { code: m[3].toLowerCase(), network: m[4].toLowerCase() }, amount });
  }
  return out;
}

export const DEFAULT_WATCHLIST = "eth/eth->usdc/erc20:0.1,btc/btc->eth/eth:0.01";

/** The best route for each watched pair right now, as the desk observes it. */
export async function quoteWatchlist(now = Date.now(), spec = process.env.OBS_QUOTE_WATCHLIST ?? DEFAULT_WATCHLIST): Promise<QuoteRead[]> {
  const items = parseWatchlist(spec);
  const results = await Promise.all(items.map((w) => quote(w.from, w.to, w.amount)));
  return items.map((w, i) => {
    const best = results[i][0];
    return { from: w.from.code.toUpperCase(), to: w.to.code.toUpperCase(), amountIn: w.amount, amountOut: best ? best.toAmount : null, partner: best ? best.partner : null, at: now };
  });
}

export interface CreateOrderInput {
  from: AssetRef;
  to: AssetRef;
  amount: number;
  /** The wallet that receives the output. Never a model-authored value. */
  address: string;
  partner: string;
  fixed?: boolean | null;
  cexId?: string | number | null;
  extraId?: string;
}

/**
 * Create an order at Obscura. Gated twice: OBS_TRADING must be exactly "on",
 * and the receiving address must be supplied by the caller from configuration,
 * never from a model reply. Returns the order id; the deposit address comes
 * from orderStatus() afterwards and stays out of every ledger.
 */
export async function createOrder(input: CreateOrderInput): Promise<{ id: string; raw: Record<string, unknown> } | null> {
  if (process.env.OBS_TRADING !== "on") throw new Error("createOrder refused: OBS_TRADING is not on");
  if (!/^[A-Za-z0-9]{20,64}$/.test(input.address)) throw new Error("createOrder refused: receiving address is not a plausible address");
  if (!(input.amount > 0)) throw new Error("createOrder refused: amount must be positive");
  const body = await call<Record<string, unknown>>("/order", {
    method: "POST",
    body: JSON.stringify({
      cex: input.partner,
      fromCurrency: input.from.code,
      fromNetwork: input.from.network,
      fromImage: "",
      toCurrency: input.to.code,
      toNetwork: input.to.network,
      toImage: "",
      amount: input.amount,
      address: input.address,
      extraId: input.extraId ?? "",
      fixed: input.fixed ?? false,
      cex_id: input.cexId ?? null,
    }),
  });
  if (!body || Number(body.status_id) !== 200 || !body.id) return null;
  return { id: String(body.id), raw: body };
}
