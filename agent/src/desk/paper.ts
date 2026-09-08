// Paper mode: the desk trades at full size against the real book without
// sending anything. Every step of the pool lane runs (rails, route, live
// pool quote, cost floor, the exact call simulated from the real wallet when
// the wallet actually holds the from-leg), and the trade is recorded in its
// own ledger, obs-paper.jsonl, never in the real book. Later cycles see the
// paper positions as if they were held, the rails' exits apply to them, and
// the report marks the paper book against the real one at current prices:
// what the trades changed, fees included.
import { appendLedger, readLedger } from "../ledger.ts";
import { checkRails, type Intent, type RailContext } from "./rails.ts";
import { latestTrades, positions, type Trade, type Prices, type CapitalFlow, type Position } from "./book.ts";
import { quoteOnChain, encodeSwap, costFloorPct, legUsd, latestEthUsd, nextTradeId } from "./onchain.ts";
import { simulateFromWallet } from "./signer.ts";
import { WALLET_ADDRESS } from "../config.ts";

export const PAPER_LEDGER = "obs-paper.jsonl";
export const PAPER_BOOK = "obs-paper-book.jsonl";

export function readPaper(): Trade[] {
  return readLedger<Trade>(PAPER_LEDGER).filter((t) => t && t.id && t.from && t.to);
}
export function recordPaper(t: Trade): void {
  appendLedger(PAPER_LEDGER, t as unknown as Record<string, unknown>);
}

/** PURE: the real wallet's balances with the paper trades applied on top, by symbol. */
export function paperBalances(chain: Record<string, number>, paper: Trade[]): Record<string, number> {
  const h: Record<string, number> = { ...chain };
  for (const t of latestTrades(paper)) {
    if (t.status !== "settled") continue;
    h[t.from.asset] = (h[t.from.asset] ?? 0) - t.from.amount;
    h[t.to.asset] = (h[t.to.asset] ?? 0) + t.to.amount;
  }
  for (const k of Object.keys(h)) if (!(h[k] > 1e-12)) delete h[k];
  return h;
}

/** PURE: the rails read balances by SYMBOL@network; on this desk every traded leg is on Robinhood Chain. */
export function paperByKey(realByKey: Record<string, number>, paperBySymbol: Record<string, number>): Record<string, number> {
  const out = { ...realByKey };
  for (const [s, v] of Object.entries(paperBySymbol)) out[`${s}@robinhood`] = s === "ETH" ? v - (realByKey["ETH@eth"] ?? 0) : v;
  for (const k of Object.keys(out)) if (k.endsWith("@robinhood") && !(paperBySymbol[k.split("@")[0]] > 0)) delete out[k];
  return out;
}

export type PaperResult = { ok: true; trade: Trade } | { ok: false; reason: string };

/** The pool lane without the send. `realBalances` decides whether the call can be simulated from the real wallet. */
export async function paperExecute(i: Intent, c: RailContext, realBalances: Record<string, number>, now = Date.now()): Promise<PaperResult> {
  // Paper is the point of a paper session: the switch is treated as on for the verdict only. Every other rail applies as written.
  const gate = checkRails(i, { ...c, rails: { ...c.rails, tradingOn: true } });
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const q = await quoteOnChain(i.from, i.to, i.amount);
  if (!q) return { ok: false, reason: `no pool route from ${i.from.symbol} to ${i.to.symbol}, or the pools did not answer` };
  const floor = costFloorPct(i, c.rails.minFillRatio);
  if (!i.exit && q.costPct != null && q.costPct > floor) return { ok: false, reason: `the pool route costs ${q.costPct.toFixed(2)}% against the mark; the floor is ${floor.toFixed(1)}%` };
  let sim = "simulation skipped: a paper position has no real balance to simulate with";
  if ((realBalances[i.from.symbol] ?? 0) >= i.amount && i.from.kind === "native") {
    const tx = encodeSwap(q.route, q.amountInRaw, q.minOutRaw, WALLET_ADDRESS as `0x${string}`, BigInt(Math.floor(now / 1000) + 1200));
    const s = await simulateFromWallet(i.from, tx);
    if (!s.ok) return { ok: false, reason: `the swap would revert: ${s.reason}` };
    sim = "the exact call simulated OK from the real wallet";
  }
  const trade: Trade = {
    at: now,
    id: nextTradeId(now, "paper"),
    status: "settled",
    venue: "pool",
    ...(i.exit ? { exit: true } : {}),
    from: { asset: i.from.symbol, network: i.from.network, amount: i.amount, usd: i.usd },
    to: { asset: i.to.symbol, network: i.to.network, amount: q.amountOut, usd: legUsd(i.to, q.amountOut, q.priceOutUsd, latestEthUsd(now)) },
    partner: "pool",
    note: `PAPER${i.exit ? " exit" : ""}: ${q.route.hops.map((h) => h.key).join(" then ")}; ${q.amountOut} ${i.to.symbol} expected${q.costPct != null ? `, cost ${q.costPct.toFixed(2)}% (fees ${q.feePct.toFixed(2)}%)` : ""}; ${sim}`,
    updatedAt: now,
  };
  recordPaper(trade);
  return { ok: true, trade };
}

export interface PaperReport {
  trades: Trade[];
  holdings: Record<string, number>;
  positions: Position[];
  /** The real book and the paper book, both at the same prices. */
  realEquityUsd: number | null;
  paperEquityUsd: number | null;
  /** What the paper trades changed: paper equity minus real equity. */
  effectUsd: number | null;
  /** Dollars the paper trades paid in route cost, where both legs were priced. */
  feesUsd: number;
  unpriced: string[];
}

/** PURE: the paper book marked against the real one at the given prices. */
export function paperReport(chain: Record<string, number>, prices: Prices, paper: Trade[], flows: CapitalFlow[], realTrades: Trade[]): PaperReport {
  const trades = latestTrades(paper).sort((a, b) => a.at - b.at);
  const holdings = paperBalances(chain, paper);
  const value = (h: Record<string, number>) => {
    let usd = 0;
    const unpriced: string[] = [];
    let priced = 0;
    for (const [s, q] of Object.entries(h)) {
      if (!(q > 1e-12)) continue;
      const p = prices[s] ?? (["USDG", "USDC", "USDT", "DAI"].includes(s) ? 1 : null);
      if (p == null) unpriced.push(s);
      else {
        usd += q * p;
        priced++;
      }
    }
    return { usd: priced || !Object.keys(h).length ? usd : null, unpriced };
  };
  const real = value(chain);
  const pap = value(holdings);
  const feesUsd = trades.reduce((s, t) => s + (t.from.usd != null && t.to.usd != null ? Math.max(0, t.from.usd - t.to.usd) : 0), 0);
  return {
    trades,
    holdings,
    positions: positions(flows, [...realTrades, ...paper], holdings, prices).positions,
    realEquityUsd: real.usd,
    paperEquityUsd: pap.usd,
    effectUsd: real.usd != null && pap.usd != null ? pap.usd - real.usd : null,
    feesUsd,
    unpriced: [...new Set([...real.unpriced, ...pap.unpriced])],
  };
}
