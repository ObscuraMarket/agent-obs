// The running peak of every held position, kept across the tape's window
// and across a redeploy. The trail measures the give-back from the peak
// since the position's first buy, and until 2026-09-08 that peak came from
// the desk's own price samples, one per cycle: the tape's high between
// cycles was never seen, so real trails gave back 22 to 31% instead of the
// 15% they were set to (ECHELON that day: off the tape's peak the trail
// would have fired at +92% instead of +67%). The tape itself only holds
// about the last three hours (OBS_LIVE_TAPE_MIN), so the watch writes the
// highest tape price it has seen for each held token to
// data/obs-tape-peaks.json on every look that raises it, and railInput reads
// it as a third source beside the samples and the tape rows. A position's
// entry is keyed by its first buy: a re-entry after a close starts a fresh
// peak, and the watch drops the entry once a wallet read says the token is
// no longer held.
//
// The peak is kept in the pool's quote units (quote per token, the tape's own
// figure) with the quote's symbol, never in dollars: the watch prices ETH at
// its last sample and the cycle at the feed, so a dollar peak written by one
// and compared with a mark priced by the other carried ETH's move between
// them into the give-back (review of 2026-09-08). Each reader multiplies by
// the quote price it prices the mark at, so the peak and the mark agree.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dataPath } from "../config.ts";
import { isHolding } from "./book.ts";
import type { SwapRow } from "./tape.ts";

export const TAPE_PEAKS_FILE = "obs-tape-peaks.json";

export interface TapePeak {
  symbol: string;
  /** The first buy of the position the peak belongs to; a different first buy is a different position. */
  firstBuy: number;
  /** The pool's quote symbol the peak is counted in (ETH, USDG); a peak in another quote is not read. */
  quote: string;
  /** The highest tape price seen for the position since its first buy, in quote units per token. */
  peakQuote: number;
  /** When the peak was last raised. */
  at: number;
}

/** The file's rows, each field cast to its type; an unreadable or missing file is no peaks. */
export function readTapePeaks(): TapePeak[] {
  const p = dataPath(TAPE_PEAKS_FILE);
  if (!existsSync(p)) return [];
  try {
    const rows = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!Array.isArray(rows)) return [];
    // A row with a numeric string where a number belongs passed the check but never matched a position's first buy
    // by identity, so its peak was silently ignored (review of 2026-09-08): the row is normalized, not kept as read.
    return rows.filter(isTapePeak).map((r) => ({ symbol: r.symbol, firstBuy: Number(r.firstBuy), quote: r.quote, peakQuote: Number(r.peakQuote), at: Number(r.at) }));
  } catch {
    return [];
  }
}

/** The file written whole, through a rename, so a reader never sees half of it. */
export function writeTapePeaks(rows: TapePeak[]): void {
  const p = dataPath(TAPE_PEAKS_FILE);
  writeFileSync(p + ".tmp", JSON.stringify(rows));
  renameSync(p + ".tmp", p);
}

function isTapePeak(r: unknown): r is TapePeak {
  const x = r as Partial<TapePeak> | null;
  return !!x && typeof x.symbol === "string" && typeof x.quote === "string" && Number.isFinite(Number(x.firstBuy)) && Number(x.peakQuote) > 0 && Number.isFinite(Number(x.at));
}

/**
 * PURE: the tape's highest post-swap price from `since` on, in quote units per token, skipping the desk's own
 * fills (`ownTx`: the transaction hashes of the position's buys). `since` is the buy's receipt, not the cycle's
 * start: the swap lands after the reads and the think, up to the gateway's 90 s later, and a row in that gap is
 * the run the desk bought into, not the position's peak; the desk's own buy prints the marginal price after its
 * own impact, a price nobody could sell at (review of 2026-09-08). Null with no such row.
 */
export function tapePeakSince(rows: SwapRow[], since: number, ownTx: Iterable<string> = []): number | null {
  const own = new Set([...ownTx].map((h) => h.toLowerCase()));
  let peak = 0;
  for (const r of rows) {
    if (r.at < since || !(r.price > 0) || r.price <= peak) continue;
    if (own.size && own.has(r.tx.split(":")[0].toLowerCase())) continue;
    peak = r.price;
  }
  return peak > 0 ? peak : null;
}

/** PURE: the persisted peak for the position in its quote units, or null when the file holds none, one from an earlier position of the token, or one in another quote. */
export function persistedPeak(peaks: TapePeak[], symbol: string, firstBuy: number, quote: string): number | null {
  const row = peaks.find((p) => p.symbol === symbol && p.firstBuy === firstBuy && p.quote === quote);
  return row && row.peakQuote > 0 ? row.peakQuote : null;
}

/**
 * PURE: the rows with the position's peak raised to `peakQuote` if it is higher than what is kept (or the position
 * is new to the file, or the kept row is in another quote), else the rows as they are. `changed` says whether the
 * caller should write.
 */
export function rememberPeak(peaks: TapePeak[], symbol: string, firstBuy: number, quote: string, peakQuote: number | null, at: number): { rows: TapePeak[]; changed: boolean } {
  if (peakQuote == null || !(peakQuote > 0)) return { rows: peaks, changed: false };
  const i = peaks.findIndex((p) => p.symbol === symbol);
  const kept = i >= 0 ? peaks[i] : null;
  if (kept && kept.firstBuy === firstBuy && kept.quote === quote && kept.peakQuote >= peakQuote) return { rows: peaks, changed: false };
  const row: TapePeak = { symbol, firstBuy, quote, peakQuote, at };
  const rows = i >= 0 ? peaks.map((p, j) => (j === i ? row : p)) : [...peaks, row];
  return { rows, changed: true };
}

/**
 * PURE: the rows after a wallet read: a token the read priced at no holding (sold out, or the dust a full sell
 * leaves) is closed and its peak dropped, so a re-entry starts fresh. A token the read did not answer for is absent
 * from `bySymbol` (walletBalances lists it under `unread`), and its row is kept: one throttled balanceOf on a held
 * token would otherwise have deleted the high the file exists to keep (review of 2026-09-08; the public RPC
 * throttled bursts that day). `changed` says whether the caller should write.
 */
export function peaksAfterWalletRead(peaks: TapePeak[], bySymbol: Record<string, number | null | undefined>): { rows: TapePeak[]; changed: boolean } {
  const rows = peaks.filter((p) => typeof bySymbol[p.symbol] !== "number" || isHolding(bySymbol[p.symbol]));
  return { rows, changed: rows.length !== peaks.length };
}
