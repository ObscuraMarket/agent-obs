// The wallets' own records. Every buy and sell a wallet makes in a token the
// desk watches is priced by joining the token's Transfer events (who) with
// the pool's Swap events (at what price) through the transaction hash, and
// kept in obs-wallet-trades.jsonl. Reduced per wallet across tokens, that
// is a track record: what they put in, what they took out, how many tokens
// they won and lost. A token whose top wallets are repeat winners reads
// differently from one held by repeat losers or by wallets with no record
// at all. It fills from the first cycle and becomes a signal over days.
import { appendLedger, readLedger } from "../ledger.ts";
import type { TransferRow } from "./holders.ts";
import type { SwapRow } from "./tape.ts";

export const WALLET_TRADES_LEDGER = "obs-wallet-trades.jsonl";

export interface WalletTrade {
  at: number;
  wallet: string;
  token: string;
  symbol: string;
  side: "buy" | "sell";
  /** Token units moved. */
  tokens: number;
  /** Dollars, from the swap in the same transaction. */
  usd: number;
  tx: string;
}

const hashOf = (tx: string) => tx.split(":")[0].toLowerCase();

/**
 * PURE: the wallet trades in a set of transfers, priced by the swaps in the
 * same transactions. `infra` is the set of addresses that are not wallets
 * (the pool, the hooks, the router); a transfer out of it is a buy by the
 * receiver, a transfer into it is a sell by the sender. `quoteUsd` prices
 * the pool's quote currency.
 */
export function walletTrades(transfers: TransferRow[], swaps: SwapRow[], infra: Set<string>, symbol: string, token: string, quoteUsd: number): WalletTrade[] {
  const byHash = new Map<string, SwapRow>();
  for (const s of swaps) byHash.set(hashOf(s.tx), s);
  const out: WalletTrade[] = [];
  for (const t of transfers) {
    const swap = byHash.get(hashOf(t.tx));
    if (!swap) continue;
    const fromInfra = infra.has(t.from);
    const toInfra = infra.has(t.to);
    if (fromInfra && !toInfra && swap.side === "buy") out.push({ at: t.at, wallet: t.to, token: token.toLowerCase(), symbol, side: "buy", tokens: t.amount, usd: swap.quoteAmount * quoteUsd, tx: t.tx });
    else if (toInfra && !fromInfra && swap.side === "sell") out.push({ at: t.at, wallet: t.from, token: token.toLowerCase(), symbol, side: "sell", tokens: t.amount, usd: swap.quoteAmount * quoteUsd, tx: t.tx });
  }
  return out;
}

export function readWalletTrades(): WalletTrade[] {
  return readLedger<WalletTrade>(WALLET_TRADES_LEDGER).filter((r) => r && typeof r.wallet === "string" && Number.isFinite(Number(r.usd)));
}

/** Append the trades not yet in the ledger (by tx). Returns how many were new. */
export function recordWalletTrades(trades: WalletTrade[]): number {
  const seen = new Set(readWalletTrades().map((r) => r.tx));
  let n = 0;
  for (const t of trades) {
    if (seen.has(t.tx)) continue;
    appendLedger(WALLET_TRADES_LEDGER, t as unknown as Record<string, unknown>);
    seen.add(t.tx);
    n++;
  }
  return n;
}

export interface WalletRecord {
  wallet: string;
  tokens: number;
  buysUsd: number;
  sellsUsd: number;
  /** Sells less buys across tokens where the wallet sold anything: realized dollars, ignoring what it still holds. */
  realizedUsd: number;
  wins: number;
  losses: number;
  label: "winner" | "loser" | "mixed" | "holder";
}

/** PURE: one record per wallet across every token in the ledger. */
export function walletRecords(rows: WalletTrade[]): Map<string, WalletRecord> {
  const per = new Map<string, Map<string, { buys: number; sells: number }>>();
  for (const r of rows) {
    const w = per.get(r.wallet) ?? per.set(r.wallet, new Map()).get(r.wallet)!;
    const t = w.get(r.token) ?? w.set(r.token, { buys: 0, sells: 0 }).get(r.token)!;
    if (r.side === "buy") t.buys += r.usd;
    else t.sells += r.usd;
  }
  const out = new Map<string, WalletRecord>();
  for (const [wallet, toks] of per) {
    let buysUsd = 0, sellsUsd = 0, realized = 0, wins = 0, losses = 0;
    for (const t of toks.values()) {
      buysUsd += t.buys;
      sellsUsd += t.sells;
      if (t.sells > 0) {
        realized += t.sells - t.buys;
        if (t.sells > t.buys) wins++;
        else losses++;
      }
    }
    const label: WalletRecord["label"] = wins + losses === 0 ? "holder" : wins > 0 && losses === 0 ? "winner" : losses > 0 && wins === 0 ? "loser" : "mixed";
    out.set(wallet, { wallet, tokens: toks.size, buysUsd, sellsUsd, realizedUsd: realized, wins, losses, label });
  }
  return out;
}

/** PURE: the top wallets of a token against the records, as one line. */
export function walletsLine(symbol: string, topWallets: string[], records: Map<string, WalletRecord>, thisToken: string): string {
  const known = topWallets.map((w) => records.get(w)).filter((r): r is WalletRecord => !!r && r.tokens > 1);
  if (!topWallets.length) return `Records ${symbol}: no top wallets to check.`;
  if (!known.length) return `Records ${symbol}: none of the top ${topWallets.length} wallets has a record on other tokens the desk watched.`;
  const winners = known.filter((r) => r.label === "winner");
  const losers = known.filter((r) => r.label === "loser");
  const sum = (xs: WalletRecord[]) => xs.reduce((s, r) => s + r.realizedUsd, 0);
  const bits = [`${known.length} of the top ${topWallets.length} wallets have a record on other tokens`];
  if (winners.length) bits.push(`${winners.length} repeat winner${winners.length > 1 ? "s" : ""} (${sum(winners) >= 0 ? "+" : "-"}$${Math.abs(sum(winners)).toFixed(0)} realized across ${winners.reduce((s, r) => s + r.tokens, 0)} tokens)`);
  if (losers.length) bits.push(`${losers.length} repeat loser${losers.length > 1 ? "s" : ""} (${sum(losers) >= 0 ? "+" : "-"}$${Math.abs(sum(losers)).toFixed(0)})`);
  const mixed = known.length - winners.length - losers.length;
  if (mixed) bits.push(`${mixed} mixed or still holding`);
  void thisToken;
  return `Records ${symbol}: ${bits.join("; ")}.`;
}
