// One read of a held token's exit rails for the watch and the cycle alike.
// The watch reads the rails at the tape's last price on every look, and the
// cycle's exit pass reads them again before it thinks. Each built the
// verdict's input on its own, and they priced the position differently: the
// watch from the tape's last swap, the cycle from the price feed. A floor the
// watch saw tripped was dismissed by the cycle it woke, and since the watch
// fired a rail kind once per change, the position kept sliding (2026-09-08).
// Both sides build the input here, from the same ledgers at the same mark,
// and the mark itself is read from the tape the same way on both.
import { positions, latestTrades, type Trade, type CapitalFlow } from "./book.ts";
import { openSpanStart } from "./trade-memory.ts";
import type { PriceSample } from "./analysis.ts";
import type { HourlyStat } from "./candidates.ts";
import type { SwapRow, TapeStats } from "./tape.ts";
import { tapePeakSince, persistedPeak, type TapePeak } from "./tapePeaks.ts";

export interface RailInputArgs {
  symbol: string;
  /** Units of the token the wallet holds now. */
  qty: number;
  /** The mark in dollars per token, the tape's last swap on both sides. Null when neither the tape nor the feed prices it; the time stop and the volume rules still read. */
  priceUsd: number | null;
  trades: Trade[];
  flows: CapitalFlow[];
  /** The desk's own price samples: one source of the peak since entry. */
  samples: PriceSample[];
  /**
   * The pool's tape, the rows both readers hold: its post-swap prices since the first buy's receipt are the second
   * source of the peak, in dollars at `quotePriceUsd`, the same quote price the mark is priced at. The samples alone
   * are one read per cycle and missed the tape's high between cycles: real trails gave back 22 to 31% instead of 15% (2026-09-08).
   */
  tapeRows?: SwapRow[];
  /** The pool's quote symbol (ETH, USDG) and its dollar price: the tape's prices and the persisted peak are in quote units. */
  quote?: string;
  quotePriceUsd?: number | null;
  /** The peaks the watch persisted (obs-tape-peaks.json), the third source: the tape's window is short and a redeploy empties the memory. */
  tapePeaks?: TapePeak[];
  hourly: HourlyStat[];
  tapeTrend: TapeStats["trend"] | null;
  tapeBuyPressurePct: number | null;
  now: number;
  /** When the clock starts if the ledger holds no buy of the token: the candidate's first sighting on the cycle; now on the watch. */
  seenAt?: number;
}

/** The exit verdict's input, with the two figures a caller wants beside it: when the position opened, and what it cost. */
export interface RailInput {
  ageH: number;
  pnlPct: number | null;
  hourly: HourlyStat[];
  peakPnlPct: number | null;
  tookProfit: boolean;
  tapeTrend: TapeStats["trend"] | null;
  tapeBuyPressurePct: number | null;
  /** When the position held now was opened: its age, its peak and its take-profit memory start here, never at a round trip closed earlier. */
  firstBuy: number;
  /** Average dollars paid per unit; null when the ledgers never recorded a cost. */
  avgCostUsd: number | null;
  /** The highest dollar mark seen for the position since its first buy, across every source; null when nothing priced it. */
  peakPx: number | null;
  /** The tape's own high since the first buy's receipt, in quote units per token, the desk's fills skipped; null without a row. The watch persists this one, in the quote's units, so the cycle reads it at its own quote price. */
  tapePeakQuote: number | null;
}

/** PURE: the exit verdict's input for a held token, from the ledgers and the mark handed in. */
export function railInput(a: RailInputArgs): RailInput {
  const buys = a.trades.filter((t) => t.to.asset === a.symbol && (t.status === "settled" || t.status === "pending"));
  // The span still open, else the latest buy (a pending one that has not settled opens the clock too), else what the caller knows.
  const firstBuy = openSpanStart(a.trades, a.symbol) ?? buys.map((t) => t.at).sort((x, y) => x - y).pop() ?? a.seenAt ?? a.now;
  const p = positions(a.flows, a.trades, { [a.symbol]: a.qty }, { [a.symbol]: a.priceUsd }).positions.find((x) => x.asset === a.symbol);
  const avgCostUsd = p?.avgCostUsd ?? null;
  // The peak since entry, against the average cost: the highest of the desk's own samples from the first buy on,
  // the tape's swaps from the first buy's receipt on, the peak the watch persisted for this position, and the mark.
  const samplePeak = a.samples.filter((s) => s.symbol === a.symbol && s.at >= firstBuy).reduce((m, s) => Math.max(m, s.priceUsd), 0);
  // The tape's window opens at the receipt of the first buy, not at its intent: a buy's `at` is the cycle's start,
  // and the fill lands after the reads and the think, so the rows in between (the run's top when the desk bought a
  // dip inside that gap, and the desk's own post-impact print) are not the position's high (review of 2026-09-08).
  // The samples keep the first buy as their start: a token bought in a cycle is not sampled until the next one.
  const entries = latestTrades(buys).filter((t) => t.at >= firstBuy);
  const tapeFrom = entries.find((t) => t.at === firstBuy)?.updatedAt ?? firstBuy;
  const ownFills = entries.map((t) => t.settlementTx).filter((h): h is string => !!h);
  const tapePeakQuote = a.tapeRows ? tapePeakSince(a.tapeRows, tapeFrom, ownFills) : null;
  const quotePriceUsd = a.quotePriceUsd != null && a.quotePriceUsd > 0 ? a.quotePriceUsd : null;
  const keptQuote = a.tapePeaks && a.quote ? persistedPeak(a.tapePeaks, a.symbol, firstBuy, a.quote) : null;
  const inUsd = (q: number | null) => (q != null && quotePriceUsd != null ? q * quotePriceUsd : 0);
  const peak = Math.max(samplePeak, inUsd(tapePeakQuote), inUsd(keptQuote), a.priceUsd ?? 0);
  const peakPx = peak > 0 ? peak : null;
  const peakPnlPct = avgCostUsd != null && avgCostUsd > 0 && peakPx != null ? ((peakPx - avgCostUsd) / avgCostUsd) * 100 : null;
  const tookProfit = a.trades.some((t) => t.from.asset === a.symbol && t.exit && t.at >= firstBuy && /take profit|buyers are thinning/.test(t.note ?? ""));
  return {
    ageH: (a.now - firstBuy) / 3600e3,
    pnlPct: p?.unrealizedPct != null ? p.unrealizedPct * 100 : null,
    hourly: a.hourly,
    peakPnlPct,
    tookProfit,
    tapeTrend: a.tapeTrend,
    tapeBuyPressurePct: a.tapeBuyPressurePct,
    firstBuy,
    avgCostUsd,
    peakPx,
    tapePeakQuote,
  };
}

/** PURE: the latest sample of a symbol within `maxAgeMs` (three hours unless said), or null: the desk's own read of a leg no feed prices. */
export function latestSampleUsd(samples: PriceSample[], symbol: string, now: number, maxAgeMs = 3 * 3600e3): number | null {
  let best: PriceSample | null = null;
  for (const s of samples) if (s.symbol === symbol && now - s.at <= maxAgeMs && (!best || s.at > best.at)) best = s;
  return best != null && best.priceUsd > 0 ? best.priceUsd : null;
}

/**
 * PURE: the dollar price of a pool's quote side, to turn the tape's quote-per-token into a mark: a dollar stable is
 * one; anything else is the price feed's figure when the caller has one, else the desk's latest sample of it within
 * three hours (the watch carries no feed and prices ETH this way). Null when nothing prices it.
 */
export function quoteUsd(quote: string, prices: Record<string, number | null>, samples: PriceSample[], now: number): number | null {
  if (/^USD/.test(quote)) return 1;
  const p = prices[quote];
  if (p != null && p > 0) return p;
  return latestSampleUsd(samples, quote, now);
}

/**
 * PURE: the tape's last swap in dollars, the mark the watch and the cycle both price a held token at: the last row
 * inside the window with a price (rows in block order, as readTape and updateTapes hand them), times the quote's
 * dollar price. Null when the pool has not traded in the window or the quote is unpriced; the cycle then falls back
 * to the price feed, and the watch reads the rails that need no price.
 */
export function tapeLastUsd(rows: SwapRow[], quotePriceUsd: number | null, now: number, windowMin: number): number | null {
  if (quotePriceUsd == null || !(quotePriceUsd > 0)) return null;
  const since = now - windowMin * 60e3;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.at >= since && r.price > 0) return r.price * quotePriceUsd;
  }
  return null;
}
