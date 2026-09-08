// The running peak of every held position, kept across the tape's window
// and across a redeploy. The trail measures the give-back from the peak
// since the position's first buy, and until 2026-09-08 that peak came from
// the desk's own price samples, one per cycle: the tape's high between
// cycles was never seen, so real trails gave back 22 to 31% instead of the
// 15% they were set to (ECHELON that day: off the tape's peak the trail
// would have fired at +92% instead of +67%). The tape itself only holds
// about the last three hours (OBS_LIVE_TAPE_MIN), so the watch writes the
// highest dollar mark it has seen for each held token to
// data/obs-tape-peaks.json on every look that raises it, and railInput reads
// it as a third source beside the samples and the tape rows. A position's
// entry is keyed by its first buy: a re-entry after a close starts a fresh
// peak, and the watch drops the entry once the wallet no longer holds the
// token.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dataPath } from "../config.ts";
import type { SwapRow } from "./tape.ts";

export const TAPE_PEAKS_FILE = "obs-tape-peaks.json";

export interface TapePeak {
  symbol: string;
  /** The first buy of the position the peak belongs to; a different first buy is a different position. */
  firstBuy: number;
  /** The highest dollar mark seen for the position since its first buy. */
  peakPx: number;
  /** When the peak was last raised. */
  at: number;
}

/** The file's rows; an unreadable or missing file is no peaks. */
export function readTapePeaks(): TapePeak[] {
  const p = dataPath(TAPE_PEAKS_FILE);
  if (!existsSync(p)) return [];
  try {
    const rows = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return Array.isArray(rows) ? rows.filter(isTapePeak) : [];
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
  return !!x && typeof x.symbol === "string" && Number.isFinite(Number(x.firstBuy)) && Number(x.peakPx) > 0 && Number.isFinite(Number(x.at));
}

/**
 * PURE: the tape's highest post-swap price since the first buy, in dollars at the quote price handed in (the one the
 * mark is priced at, so the peak and the mark agree). Rows before the first buy belong to the run the desk bought
 * into, not to the position, and are ignored. Null with no priced row since the buy or no quote price.
 */
export function tapePeakSince(rows: SwapRow[], firstBuy: number, quotePriceUsd: number | null): number | null {
  if (quotePriceUsd == null || !(quotePriceUsd > 0)) return null;
  let peak = 0;
  for (const r of rows) if (r.at >= firstBuy && r.price > 0 && r.price > peak) peak = r.price;
  return peak > 0 ? peak * quotePriceUsd : null;
}

/** PURE: the persisted peak for the position, or null when the file holds none or holds one from an earlier position of the token. */
export function persistedPeak(peaks: TapePeak[], symbol: string, firstBuy: number): number | null {
  const row = peaks.find((p) => p.symbol === symbol && p.firstBuy === firstBuy);
  return row && row.peakPx > 0 ? row.peakPx : null;
}

/**
 * PURE: the rows with the position's peak raised to `peakPx` if it is higher than what is kept (or the position is
 * new to the file), else the rows as they are. `changed` says whether the caller should write.
 */
export function rememberPeak(peaks: TapePeak[], symbol: string, firstBuy: number, peakPx: number | null, at: number): { rows: TapePeak[]; changed: boolean } {
  if (peakPx == null || !(peakPx > 0)) return { rows: peaks, changed: false };
  const i = peaks.findIndex((p) => p.symbol === symbol);
  const kept = i >= 0 ? peaks[i] : null;
  if (kept && kept.firstBuy === firstBuy && kept.peakPx >= peakPx) return { rows: peaks, changed: false };
  const row: TapePeak = { symbol, firstBuy, peakPx, at };
  const rows = i >= 0 ? peaks.map((p, j) => (j === i ? row : p)) : [...peaks, row];
  return { rows, changed: true };
}

/** PURE: the rows for the tokens still held; a closed position's peak is dropped so a re-entry starts fresh. `changed` says whether the caller should write. */
export function keepHeldPeaks(peaks: TapePeak[], held: string[]): { rows: TapePeak[]; changed: boolean } {
  const keep = new Set(held);
  const rows = peaks.filter((p) => keep.has(p.symbol));
  return { rows, changed: rows.length !== peaks.length };
}
