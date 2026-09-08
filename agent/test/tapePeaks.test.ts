// The data dir is fixed when config.ts loads, so the throwaway dir is set before anything under src is imported.
import "./tmpdata.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "../src/config.ts";
import { readTapePeaks, writeTapePeaks, rememberPeak, keepHeldPeaks, persistedPeak, tapePeakSince, TAPE_PEAKS_FILE, type TapePeak } from "../src/desk/tapePeaks.ts";
import type { SwapRow } from "../src/desk/tape.ts";

const M = 60e3;
const t0 = Date.UTC(2026, 8, 8, 10, 0, 0);
const row = (at: number, price: number, block: number): SwapRow => ({ at, block, tx: `0x${block}:0`, side: "buy", tokenAmount: 1, quoteAmount: price, price });

test("the tape's peak since the first buy, in dollars at the quote price; earlier rows and unpriced quotes count for nothing", () => {
  const rows = [row(t0 - M, 0.9, 1), row(t0, 0.5, 2), row(t0 + M, 0.7, 3), row(t0 + 2 * M, 0, 4), row(t0 + 3 * M, 0.6, 5)];
  assert.equal(tapePeakSince(rows, t0, 1), 0.7);
  assert.equal(tapePeakSince(rows, t0, 2500), 0.7 * 2500, "an ETH-quoted tape times ETH's dollar price");
  assert.equal(tapePeakSince(rows, t0 + 2 * M, 1), 0.6, "rows before the first buy are ignored");
  assert.equal(tapePeakSince(rows, t0 + 4 * M, 1), null, "no row since the buy");
  assert.equal(tapePeakSince(rows, t0, null), null);
  assert.equal(tapePeakSince(rows, t0, 0), null);
  assert.equal(tapePeakSince([], t0, 1), null);
});

test("the peak file: written whole, read back, raised only upward, keyed by the position's first buy, and cleared when the position closes", () => {
  const p = dataPath(TAPE_PEAKS_FILE);
  assert.equal(readTapePeaks().length, 0, "no file, no peaks");
  // The watch raises the peak on a look that sees a higher mark; a lower one changes nothing.
  let peaks: TapePeak[] = [];
  let r = rememberPeak(peaks, "TOK", t0, 0.0001, t0 + M);
  assert.equal(r.changed, true);
  peaks = r.rows;
  r = rememberPeak(peaks, "TOK", t0, 0.00009, t0 + 2 * M);
  assert.equal(r.changed, false, "a lower mark is not a peak");
  r = rememberPeak(peaks, "TOK", t0, 0.0001, t0 + 2 * M);
  assert.equal(r.changed, false, "the same mark is not a rise");
  r = rememberPeak(peaks, "TOK", t0, 0.00015, t0 + 3 * M);
  assert.equal(r.changed, true);
  peaks = r.rows;
  assert.deepEqual(peaks, [{ symbol: "TOK", firstBuy: t0, peakPx: 0.00015, at: t0 + 3 * M }]);
  assert.equal(rememberPeak(peaks, "TOK", t0, null, t0 + 4 * M).changed, false, "unpriced, nothing to remember");
  peaks = rememberPeak(peaks, "OTHER", t0 + M, 2, t0 + 4 * M).rows;
  writeTapePeaks(peaks);
  assert.ok(existsSync(p));
  assert.ok(!existsSync(p + ".tmp"), "written through a rename");
  assert.deepEqual(readTapePeaks(), peaks, "read back as written: a redeploy keeps the high");
  assert.equal(persistedPeak(peaks, "TOK", t0), 0.00015);
  assert.equal(persistedPeak(peaks, "TOK", t0 + M), null, "a different first buy is a different position");
  assert.equal(persistedPeak(peaks, "NONE", t0), null);
  // A re-entry after a close: the token's row is replaced, never raised from the old position's high.
  r = rememberPeak(peaks, "TOK", t0 + 60 * M, 0.00005, t0 + 61 * M);
  assert.equal(r.changed, true);
  assert.deepEqual(r.rows.find((x) => x.symbol === "TOK"), { symbol: "TOK", firstBuy: t0 + 60 * M, peakPx: 0.00005, at: t0 + 61 * M });
  // The position closes: the wallet no longer holds TOK, and its row goes with it.
  r = keepHeldPeaks(peaks, ["OTHER"]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.rows, [{ symbol: "OTHER", firstBuy: t0 + M, peakPx: 2, at: t0 + 4 * M }]);
  assert.equal(keepHeldPeaks(r.rows, ["OTHER"]).changed, false, "still held, nothing to write");
  writeTapePeaks(r.rows);
  assert.deepEqual(readTapePeaks().map((x) => x.symbol), ["OTHER"], "the closed position is cleared on disk");
  writeTapePeaks(keepHeldPeaks(r.rows, []).rows);
  assert.deepEqual(readTapePeaks(), [], "nothing held, nothing kept");
  // A damaged file or a row that is not a peak reads as no peaks rather than a crash on the watch's boot.
  writeFileSync(p, "{not json");
  assert.deepEqual(readTapePeaks(), []);
  writeFileSync(p, JSON.stringify([{ symbol: "TOK", firstBuy: t0, peakPx: 0, at: t0 }, { symbol: 5 }, { symbol: "OK", firstBuy: t0, peakPx: 1, at: t0 }]));
  assert.deepEqual(readTapePeaks(), [{ symbol: "OK", firstBuy: t0, peakPx: 1, at: t0 }], "only well-formed rows with a positive peak");
  assert.equal(JSON.parse(readFileSync(p, "utf8")).length, 3);
});
