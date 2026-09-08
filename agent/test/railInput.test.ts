import { test } from "node:test";
import assert from "node:assert/strict";
import { railInput, quoteUsd, tapeLastUsd, latestSampleUsd } from "../src/desk/railInput.ts";
import { exitVerdict, type ExitRails, type HourlyStat } from "../src/desk/candidates.ts";
import type { Trade } from "../src/desk/book.ts";
import type { SwapRow } from "../src/desk/tape.ts";

const H = 3600e3;
const M = 60e3;
const t0 = Date.UTC(2026, 8, 8, 10, 0, 0);
// The ledger's own shapes: a buy carries the ETH spent in dollars and the tokens received; a sell the tokens at their marked value.
// A buy's `at` is the cycle's start; its receipt (`updatedAt`) lands a minute later here, its hash the fill's.
const buy = (id: string, at: number, usd: number, tokens: number, status: Trade["status"] = "settled"): Trade => ({ at, id, status, venue: "pool", partner: "pool", from: { asset: "ETH", amount: usd / 2500, usd }, to: { asset: "TOK", amount: tokens, usd: null }, updatedAt: at + M, settlementTx: `0xfill${id}` });
const sell = (id: string, at: number, tokens: number, marked: number, note: string): Trade => ({ at, id, status: "settled", venue: "pool", partner: "pool", exit: true, from: { asset: "TOK", amount: tokens, usd: marked }, to: { asset: "ETH", amount: marked / 2500, usd: marked }, updatedAt: at + M, note });
const sample = (at: number, priceUsd: number, symbol = "TOK") => ({ at, symbol, priceUsd });
const rails: ExitRails = { candidateMaxHoldH: 6, candidateFloorPct: 30, candidateVolumeDropPct: 30, candidateTrailArmPct: 30, candidateTrailPct: 25, candidateTakeProfitPct: 60, candidateTakeProfitShare: 0.5 };
const base = { symbol: "TOK", qty: 1_000_000, flows: [], hourly: [] as HourlyStat[], tapeTrend: "holding" as const, tapeBuyPressurePct: 55 };
const near = (a: number | null, b: number, msg?: string) => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${msg ?? "near"}: ${a} vs ${b}`);

test("one input for the watch and the cycle: the same ledgers at the same mark, and the mark decides the floor", () => {
  const trades = [buy("b1", t0, 100, 1_000_000)];
  const samples = [sample(t0 + 30 * M, 0.00012), sample(t0 + H, 2500, "ETH")];
  const now = t0 + 2 * H;
  const atTape = railInput({ ...base, priceUsd: 0.00007, trades, samples, now });
  assert.equal(atTape.firstBuy, t0);
  assert.equal(atTape.ageH, 2);
  near(atTape.avgCostUsd, 0.0001);
  near(atTape.pnlPct, -30);
  near(atTape.peakPnlPct, 20, "the peak is the desk's own samples since entry");
  assert.equal(atTape.tookProfit, false);
  assert.deepEqual(atTape.hourly, []);
  assert.equal(atTape.tapeTrend, "holding");
  assert.equal(atTape.tapeBuyPressurePct, 55);
  assert.equal(exitVerdict(atTape, rails)?.kind, "floor", "at the tape's mark the floor trips");
  // The cycle once priced the same position from the feed, a hair above the floor, and dismissed the rail the watch had tripped (2026-09-08).
  const atFeed = railInput({ ...base, priceUsd: 0.000075, trades, samples, now });
  near(atFeed.pnlPct, -25);
  assert.equal(exitVerdict(atFeed, rails), null, "a feed mark above the floor sees nothing");
  assert.deepEqual(railInput({ ...base, priceUsd: 0.00007, trades, samples, now, seenAt: t0 - H }), atTape, "the cycle's sighting changes nothing while the ledger has the buy");
  near(railInput({ ...base, priceUsd: 0.00016, trades, samples, now }).peakPnlPct, 60, "the mark itself is a peak when it is above every sample");
});

test("without a mark the time stop and the volume roll still read; the floor and the trail cannot", () => {
  const trades = [buy("b1", t0, 100, 1_000_000)];
  const samples = [sample(t0 + 30 * M, 0.00012)];
  const now = t0 + 2 * H;
  const unpriced = railInput({ ...base, priceUsd: null, trades, samples, now });
  assert.equal(unpriced.pnlPct, null);
  near(unpriced.avgCostUsd, 0.0001);
  near(unpriced.peakPnlPct, 20, "the peak still comes from the samples");
  assert.equal(exitVerdict(unpriced, rails), null);
  assert.equal(exitVerdict({ ...unpriced, ageH: 6.5 }, rails)?.kind, "time-stop");
  const hourly: HourlyStat[] = [{ hour: 1, at: t0, usd: 1000, px: null, senders: 5 }, { hour: 2, at: t0 + H, usd: 600, px: null, senders: 5 }, { hour: 3, at: t0 + 2 * H, usd: 300, px: null, senders: 5 }];
  assert.equal(exitVerdict(railInput({ ...base, priceUsd: null, trades, samples, hourly, now }), rails)?.kind, "volume");
});

test("the clock, the peak and the take-profit memory start at the open span, never at a round trip closed earlier", () => {
  const trades = [
    buy("b1", t0, 100, 1_000_000),
    sell("s1", t0 + H, 500_000, 80, "take profit: up 60%, selling 50% into strength and trailing the rest"),
    sell("s2", t0 + 2 * H, 500_000, 70, "the tape rolled over again after the scale-out"),
    buy("b2", t0 + 3 * H, 200, 1_000_000),
  ];
  const samples = [sample(t0 + 30 * M, 0.0005), sample(t0 + 3 * H + 10 * M, 0.00022)];
  const r = railInput({ ...base, priceUsd: 0.0002, trades, samples, now: t0 + 4 * H });
  assert.equal(r.firstBuy, t0 + 3 * H, "the re-entry");
  assert.equal(r.ageH, 1);
  assert.equal(r.tookProfit, false, "the morning's scale-out is not this position's");
  near(r.avgCostUsd, 0.0002);
  near(r.peakPnlPct, 10, "the morning's peak is not this position's");
  near(r.pnlPct, 0);
  const scaled = [...trades, sell("s3", t0 + 3 * H + 20 * M, 500_000, 160, "the trade is up 60% and the buyers are thinning (buy pressure 40% over the window, under the 45% bar): selling 50%")];
  assert.equal(railInput({ ...base, qty: 500_000, priceUsd: 0.0002, trades: scaled, samples, now: t0 + 4 * H }).tookProfit, true, "a scale-out inside the span is remembered");
});

test("a pending buy opens the clock; with no buy at all it starts at the caller's sighting, else now", () => {
  const pending = [buy("b1", t0, 100, 1_000_000, "pending")];
  assert.equal(railInput({ ...base, priceUsd: null, trades: pending, samples: [], now: t0 + H }).firstBuy, t0);
  assert.equal(railInput({ ...base, priceUsd: null, trades: [], samples: [], now: t0 + H, seenAt: t0 - H }).firstBuy, t0 - H);
  const fresh = railInput({ ...base, priceUsd: 0.0001, trades: [], samples: [], now: t0 + H });
  assert.equal(fresh.firstBuy, t0 + H);
  assert.equal(fresh.ageH, 0);
  assert.equal(fresh.pnlPct, null, "no buy in the ledger, no cost, no PnL");
});

test("the tape's last swap in dollars: the quote priced, the window kept, silence is null", () => {
  const row = (at: number, price: number, block: number): SwapRow => ({ at, block, tx: `0x${block}:0`, side: "buy", tokenAmount: 1, quoteAmount: price, price });
  const now = t0 + 2 * H;
  const rows = [row(t0, 0.9, 1), row(t0 + H, 1.1, 2), row(t0 + 2 * H - M, 1.2, 3)];
  assert.equal(tapeLastUsd(rows, 1, now, 180), 1.2);
  assert.equal(tapeLastUsd(rows, 2500, now, 180), 3000, "an ETH-quoted tape times ETH's dollar price");
  assert.equal(tapeLastUsd(rows, null, now, 180), null, "an unpriced quote prices nothing");
  assert.equal(tapeLastUsd(rows, 0, now, 180), null);
  assert.equal(tapeLastUsd(rows.slice(0, 1), 1, now, 60), null, "a swap older than the window is not the mark");
  assert.equal(tapeLastUsd([...rows, row(t0 + 2 * H, 0, 4)], 1, now, 180), 1.2, "a row without a price is skipped");
  assert.equal(tapeLastUsd([], 1, now, 180), null);
});

test("the quote's dollar price: a dollar stable is one, the feed first, the desk's own sample within three hours after it", () => {
  const now = t0;
  const samples = [sample(t0 - 2 * H, 2400, "ETH"), sample(t0 - H, 2500, "ETH"), sample(t0 - 4 * H, 2600, "ETH"), sample(t0 - 5 * H, 170, "NVDA")];
  assert.equal(quoteUsd("USDG", {}, [], now), 1);
  assert.equal(quoteUsd("USDC", { USDC: 0.99 }, [], now), 1);
  assert.equal(quoteUsd("ETH", { ETH: 2510 }, samples, now), 2510, "the feed first");
  assert.equal(quoteUsd("ETH", { ETH: null }, samples, now), 2500, "the latest sample within three hours");
  assert.equal(quoteUsd("ETH", {}, samples, now), 2500);
  assert.equal(quoteUsd("NVDA", {}, samples, now), null, "a sample five hours old is no price");
  assert.equal(quoteUsd("NVDA", { NVDA: 175 }, samples, now), 175);
  assert.equal(latestSampleUsd(samples, "ETH", now), 2500);
  assert.equal(latestSampleUsd(samples, "ETH", now, H / 2), null);
  assert.equal(latestSampleUsd(samples, "ETH", now + 2 * H), 2500, "still within three hours of a later now");
  assert.equal(latestSampleUsd([], "ETH", now), null);
});

test("the peak since entry: the samples alone, then the tape's higher swaps, then a persisted high above both; rows before the receipt and the desk's own fill are not the position's", () => {
  const row = (at: number, price: number, block: number, tx = `0x${block}:0`): SwapRow => ({ at, block, tx, side: "buy", tokenAmount: 1, quoteAmount: price, price });
  const trades = [buy("b1", t0, 100, 1_000_000)];
  const samples = [sample(t0 + 30 * M, 0.00012)];
  const now = t0 + 2 * H;
  const args = { ...base, priceUsd: 0.0001, trades, samples, now, quote: "ETH" };
  // Samples only: the cycle-time read, +20% off a $0.0001 cost.
  const alone = railInput(args);
  near(alone.peakPnlPct, 20, "samples only");
  near(alone.peakPx, 0.00012);
  assert.equal(alone.tapePeakQuote, null, "no tape, no tape peak");
  // The tape between cycles went higher: an ETH-quoted pool priced at the quote price the mark uses. Real trails
  // read from cycle-time samples alone gave back 22 to 31% instead of 15% (2026-09-08).
  const rows = [row(t0 + 45 * M, 0.00015 / 2500, 1), row(t0 + 50 * M, 0.00013 / 2500, 2)];
  const withTape = railInput({ ...args, tapeRows: rows, quotePriceUsd: 2500 });
  near(withTape.peakPnlPct, 50, "the tape's high wins over the samples");
  near(withTape.peakPx, 0.00015);
  near(withTape.tapePeakQuote, 0.00015 / 2500, "the tape's own peak, in the quote's units, is what the watch persists");
  const unpriced = railInput({ ...args, tapeRows: rows, quotePriceUsd: null });
  near(unpriced.peakPnlPct, 20, "an unpriced quote prices no tape row");
  near(unpriced.tapePeakQuote, 0.00015 / 2500, "but the tape's peak in quote units still reads");
  // A row before the first buy is the run the desk bought into, not the position's peak.
  const before = [row(t0 - 10 * M, 0.0005 / 2500, 0), ...rows];
  near(railInput({ ...args, tapeRows: before, quotePriceUsd: 2500 }).peakPnlPct, 50, "rows before the first buy are ignored");
  // The gap between the intent and the receipt: the buy's `at` is the cycle's start, the fill lands after the
  // think. A row at twice the price 30 s in, before the receipt, is the run the desk bought a dip of, not the
  // position's high (review of 2026-09-08).
  const gap = [row(t0 + 30e3, 0.0002 / 2500, 0), ...rows];
  near(railInput({ ...args, tapeRows: gap, quotePriceUsd: 2500 }).peakPnlPct, 50, "a row between the intent and the receipt is ignored");
  // The desk's own fill, the marginal price after its own impact, prints at the receipt and is skipped by its hash.
  const ownFill = [row(t0 + M, 0.0003 / 2500, 0, "0xFILLB1:3"), ...rows];
  near(railInput({ ...args, tapeRows: ownFill, quotePriceUsd: 2500 }).peakPnlPct, 50, "the desk's own buy is not the peak");
  near(railInput({ ...args, tapeRows: [row(t0 + M, 0.0003 / 2500, 0, "0xother:3"), ...rows], quotePriceUsd: 2500 }).peakPnlPct, 200, "another swap at the receipt is");
  // A pending buy that has not sent yet has no receipt: the window opens at the intent.
  const pending = [{ ...buy("b1", t0, 100, 1_000_000, "pending"), updatedAt: undefined, settlementTx: undefined }];
  near(railInput({ ...args, trades: pending, tapeRows: gap, quotePriceUsd: 2500 }).peakPx, 0.0002, "no receipt yet, the window opens at the intent");
  // The persisted high, from a window that has rolled off the tape, above both, in the quote's units.
  const peaks = [{ symbol: "TOK", firstBuy: t0, quote: "ETH", peakQuote: 0.0002 / 2500, at: t0 + 20 * M }];
  near(railInput({ ...args, tapeRows: rows, quotePriceUsd: 2500, tapePeaks: peaks }).peakPnlPct, 100, "the persisted peak wins over both");
  near(railInput({ ...args, tapePeaks: peaks, quotePriceUsd: 2500 }).peakPnlPct, 100, "and reads without tape rows");
  near(railInput({ ...args, tapePeaks: peaks, quotePriceUsd: 2600 }).peakPnlPct, 108, "at the reader's own quote price, so the peak and the mark agree");
  near(railInput({ ...args, tapePeaks: peaks, quotePriceUsd: null }).peakPnlPct, 20, "unpriced, the persisted peak prices nothing");
  near(railInput({ ...args, tapePeaks: peaks, quotePriceUsd: 2500, quote: "USDG" }).peakPnlPct, 20, "a peak in another quote is not read");
  // A persisted peak from an earlier position of the token (a different first buy) is not this one's.
  const stale = [{ symbol: "TOK", firstBuy: t0 - 5 * H, quote: "ETH", peakQuote: 0.0009 / 2500, at: t0 - 4 * H }];
  near(railInput({ ...args, tapeRows: rows, quotePriceUsd: 2500, tapePeaks: stale }).peakPnlPct, 50, "an earlier position's peak is ignored");
  near(railInput({ ...args, tapeRows: rows, quotePriceUsd: 2500, tapePeaks: peaks, priceUsd: 0.0003 }).peakPnlPct, 200, "the mark itself still counts");
  // The trail decides off that peak: at +50% peak and a mark at cost, the 25% trail has fired; off the samples alone it had not.
  assert.equal(exitVerdict(withTape, rails)?.kind, "trail");
  assert.equal(exitVerdict(alone, rails), null);
});
