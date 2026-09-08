// The data dir is fixed when config.ts loads, so the throwaway dir is set before anything under src is imported.
import "./tmpdata.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "../src/config.ts";
import { readTapePeaks, writeTapePeaks, rememberPeak, peaksAfterWalletRead, persistedPeak, tapePeakSince, TAPE_PEAKS_FILE, type TapePeak } from "../src/desk/tapePeaks.ts";
import type { SwapRow } from "../src/desk/tape.ts";

const M = 60e3;
const t0 = Date.UTC(2026, 8, 8, 10, 0, 0);
const row = (at: number, price: number, block: number, tx = `0x${block}:0`): SwapRow => ({ at, block, tx, side: "buy", tokenAmount: 1, quoteAmount: price, price });

test("the tape's peak since the receipt, in quote units; earlier rows and the desk's own fills count for nothing", () => {
  const rows = [row(t0 - M, 0.9, 1), row(t0, 0.5, 2), row(t0 + M, 0.7, 3), row(t0 + 2 * M, 0, 4), row(t0 + 3 * M, 0.6, 5)];
  assert.equal(tapePeakSince(rows, t0), 0.7);
  assert.equal(tapePeakSince(rows, t0 + 2 * M), 0.6, "rows before the window are ignored");
  assert.equal(tapePeakSince(rows, t0 + 4 * M), null, "no row since the receipt");
  assert.equal(tapePeakSince([], t0), null);
  // The desk's own buy prints the marginal price after its own impact; the row is known by its hash and skipped,
  // whatever the case of the hash or the log index after it (review of 2026-09-08).
  const own = [row(t0, 0.5, 2), row(t0 + M, 0.9, 3, "0xABCDEF:2"), row(t0 + 2 * M, 0.6, 4)];
  assert.equal(tapePeakSince(own, t0, ["0xabcdef"]), 0.6, "the desk's own fill is not the peak");
  assert.equal(tapePeakSince(own, t0, ["0x999"]), 0.9, "another hash skips nothing");
  assert.equal(tapePeakSince(own.slice(1, 2), t0, ["0xabcdef"]), null, "the own fill alone is no peak");
});

test("the peak file: written whole, read back in its types, raised only upward, keyed by the position's first buy and its quote", () => {
  const p = dataPath(TAPE_PEAKS_FILE);
  assert.equal(readTapePeaks().length, 0, "no file, no peaks");
  // The watch raises the peak on a look that sees a higher tape price; a lower one changes nothing.
  let peaks: TapePeak[] = [];
  let r = rememberPeak(peaks, "TOK", t0, "ETH", 0.0001, t0 + M);
  assert.equal(r.changed, true);
  peaks = r.rows;
  r = rememberPeak(peaks, "TOK", t0, "ETH", 0.00009, t0 + 2 * M);
  assert.equal(r.changed, false, "a lower price is not a peak");
  r = rememberPeak(peaks, "TOK", t0, "ETH", 0.0001, t0 + 2 * M);
  assert.equal(r.changed, false, "the same price is not a rise");
  r = rememberPeak(peaks, "TOK", t0, "ETH", 0.00015, t0 + 3 * M);
  assert.equal(r.changed, true);
  peaks = r.rows;
  assert.deepEqual(peaks, [{ symbol: "TOK", firstBuy: t0, quote: "ETH", peakQuote: 0.00015, at: t0 + 3 * M }]);
  assert.equal(rememberPeak(peaks, "TOK", t0, "ETH", null, t0 + 4 * M).changed, false, "no tape row, nothing to remember");
  peaks = rememberPeak(peaks, "OTHER", t0 + M, "USDG", 2, t0 + 4 * M).rows;
  writeTapePeaks(peaks);
  assert.ok(existsSync(p));
  assert.ok(!existsSync(p + ".tmp"), "written through a rename");
  assert.deepEqual(readTapePeaks(), peaks, "read back as written: a redeploy keeps the high");
  assert.equal(persistedPeak(peaks, "TOK", t0, "ETH"), 0.00015);
  assert.equal(persistedPeak(peaks, "TOK", t0 + M, "ETH"), null, "a different first buy is a different position");
  assert.equal(persistedPeak(peaks, "TOK", t0, "USDG"), null, "a peak in another quote is not read in this one");
  assert.equal(persistedPeak(peaks, "NONE", t0, "ETH"), null);
  // A re-entry after a close: the token's row is replaced, never raised from the old position's high.
  r = rememberPeak(peaks, "TOK", t0 + 60 * M, "ETH", 0.00005, t0 + 61 * M);
  assert.equal(r.changed, true);
  assert.deepEqual(r.rows.find((x) => x.symbol === "TOK"), { symbol: "TOK", firstBuy: t0 + 60 * M, quote: "ETH", peakQuote: 0.00005, at: t0 + 61 * M });
  // The pool re-quoted (a curve in ETH, a side pool in USDG): a lower figure in the new quote replaces the row.
  r = rememberPeak(peaks, "TOK", t0, "USDG", 0.00001, t0 + 5 * M);
  assert.equal(r.changed, true);
  assert.equal(r.rows.find((x) => x.symbol === "TOK")?.quote, "USDG");
  // A damaged file or a row that is not a peak reads as no peaks rather than a crash on the watch's boot, and a
  // row's numbers come back as numbers even when the file holds them as strings (review of 2026-09-08).
  writeFileSync(p, "{not json");
  assert.deepEqual(readTapePeaks(), []);
  writeFileSync(p, JSON.stringify([{ symbol: "TOK", firstBuy: t0, quote: "ETH", peakQuote: 0, at: t0 }, { symbol: 5 }, { symbol: "NOQ", firstBuy: t0, peakQuote: 1, at: t0 }, { symbol: "OK", firstBuy: String(t0), quote: "ETH", peakQuote: "1", at: String(t0) }]));
  assert.deepEqual(readTapePeaks(), [{ symbol: "OK", firstBuy: t0, quote: "ETH", peakQuote: 1, at: t0 }], "only well-formed rows with a positive peak and a quote, their numbers cast");
  assert.equal(persistedPeak(readTapePeaks(), "OK", t0, "ETH"), 1, "a row read from strings still matches its position");
  assert.equal(JSON.parse(readFileSync(p, "utf8")).length, 4);
});

test("a wallet read drops the peak of a token it priced at nothing, and keeps the one it could not read", () => {
  const p = dataPath(TAPE_PEAKS_FILE);
  const peaks: TapePeak[] = [
    { symbol: "TOK", firstBuy: t0, quote: "ETH", peakQuote: 0.00015, at: t0 + M },
    { symbol: "OTHER", firstBuy: t0 + M, quote: "USDG", peakQuote: 2, at: t0 + 4 * M },
    { symbol: "DUST", firstBuy: t0 + 2 * M, quote: "USDG", peakQuote: 3, at: t0 + 5 * M },
  ];
  // TOK sold out (zero), DUST holds the dust a full sell leaves, OTHER did not answer (absent: unread, not zero).
  let r = peaksAfterWalletRead(peaks, { TOK: 0, DUST: 1e-9, ETH: 0.1 });
  assert.equal(r.changed, true);
  assert.deepEqual(r.rows.map((x) => x.symbol), ["OTHER"], "sold out and dust are closed; the unread token keeps its peak");
  assert.equal(peaksAfterWalletRead(r.rows, { OTHER: 500 }).changed, false, "still held, nothing to write");
  assert.equal(peaksAfterWalletRead(r.rows, {}).changed, false, "a read that answered for nothing closes nothing");
  assert.equal(peaksAfterWalletRead(r.rows, { OTHER: null }).changed, false, "a null balance is unread, not a close");
  writeTapePeaks(r.rows);
  assert.deepEqual(readTapePeaks().map((x) => x.symbol), ["OTHER"], "the closed positions are cleared on disk");
  r = peaksAfterWalletRead(r.rows, { OTHER: 0 });
  assert.equal(r.changed, true);
  writeTapePeaks(r.rows);
  assert.deepEqual(readTapePeaks(), [], "nothing held, nothing kept");
  assert.ok(existsSync(p));
});
