import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSwap, tapeStats, tapeLine, dedupeRows, type SwapRow } from "../src/desk/tape.ts";
import { similarity, recallLike, launchRecord, launchRecordLine, recallLine, type TradeClose } from "../src/desk/trade-memory.ts";
import { exitVerdict } from "../src/desk/candidates.ts";

const spec = { venue: "uniswap-v4" as const, id: "0x01", token0: "USDG", token1: "TOK", decimals0: 6, decimals1: 18, usdToken: 0 as const, feePct: 4, tickSpacing: 400 };
const Q96 = 2n ** 96n;

test("a swap decodes by the pool's deltas: the pool giving the token out is a buy, taking it in is a sell", () => {
  const sqrtP = Q96; // price 1 in raw units -> 1e-12 USDG per token at these decimals
  const buy = decodeSwap({ amount0: 10_000_000n, amount1: -(5n * 10n ** 18n), sqrtPriceX96: sqrtP }, spec, false, 1000, 10, "a")!;
  assert.equal(buy.side, "buy");
  assert.equal(buy.tokenAmount, 5);
  assert.equal(buy.quoteAmount, 10);
  const sell = decodeSwap({ amount0: -4_000_000n, amount1: 2n * 10n ** 18n, sqrtPriceX96: sqrtP }, spec, false, 2000, 11, "b")!;
  assert.equal(sell.side, "sell");
  assert.equal(sell.quoteAmount, 4);
  assert.equal(decodeSwap({ amount0: 1n, amount1: 0n, sqrtPriceX96: sqrtP }, spec, false, 1, 1, "c"), null, "no token moved, no row");
});

test("the tape reduces to buys against sells, price path, 5-minute buckets and a trend", () => {
  const now = 1_000_000_000_000;
  const row = (minAgo: number, side: "buy" | "sell", quote: number, price: number): SwapRow => ({ at: now - minAgo * 60e3, block: 1, tx: `${minAgo}-${side}`, side, tokenAmount: quote / price, quoteAmount: quote, price });
  const rows = [row(14, "buy", 100, 1.0), row(12, "buy", 200, 1.2), row(8, "sell", 50, 1.1), row(6, "buy", 40, 1.15), row(3, "sell", 30, 1.05), row(1, "buy", 10, 1.02)];
  const t = tapeStats(rows, "TOK", now, 15, 30);
  assert.equal(t.swaps, 6);
  assert.equal(t.buys, 4);
  assert.equal(t.sells, 2);
  assert.equal(t.buyQuote, 350);
  assert.equal(t.sellQuote, 80);
  assert.ok(Math.abs((t.buyPressurePct as number) - 81.4) < 0.1);
  assert.equal(t.peak, 1.2);
  assert.ok(Math.abs((t.movePct as number) - 2) < 1e-9, "1.0 to 1.02");
  assert.ok(Math.abs((t.offPeakPct as number) - 15) < 1e-9);
  assert.deepEqual(t.buckets5m, [300, 90, 40], "oldest first: minutes 15-10, 10-5, 5-0");
  assert.equal(t.trend, "rolling over", "300 then 90 then 40, each down 30%+");
  assert.equal(tapeStats(rows, "TOK", now, 15).lastSwapAgoMin, 1);
  const rising = tapeStats([row(12, "buy", 10, 1), row(7, "buy", 20, 1), row(2, "buy", 40, 1)], "TOK", now, 15).trend;
  assert.equal(rising, "rising");
  assert.equal(tapeStats([], "TOK", now, 15).trend, "thin");
  assert.match(tapeLine(t, 1, "USDG"), /6 swaps; buys \$350 vs sells \$80 \(81% buy pressure\)/);
  assert.match(tapeLine(tapeStats([], "TOK", now, 15), 1, "USDG"), /no swaps/);
});

test("a rolling-over tape exits a trade that has not paid whole; after a scale-out it takes the rest", () => {
  const r = { candidateMaxHoldH: 8, candidateFloorPct: 40, candidateVolumeDropPct: 30, candidateTakeProfitPct: 60, candidateTakeProfitShare: 0.5, candidateTrailArmPct: 30, candidateTrailPct: 25 };
  assert.equal(exitVerdict({ ageH: 0.5, pnlPct: 5, hourly: [], tapeTrend: "rolling over" }, r)!.kind, "volume");
  const rest = exitVerdict({ ageH: 0.5, pnlPct: 45, hourly: [], peakPnlPct: 50, tapeTrend: "rolling over", tookProfit: true }, r);
  assert.equal(rest?.kind, "volume");
  assert.match(rest?.reason ?? "", /the rest leaves/);
  assert.equal(exitVerdict({ ageH: 0.5, pnlPct: 45, hourly: [], peakPnlPct: 50, tapeTrend: "holding", tookProfit: true }, r), null, "after the scale-out, with the tape holding, the trail owns the rest");
});

test("trade memory: like setups recall, the launch record tallies", () => {
  const c = (over: Partial<TradeClose>): TradeClose => ({ at: 2000, symbol: "X", token: "0x1", source: "pons-v2", grade: "C", tierPct: 4, ignitedAfterMin: 8, via: "curve", enteredAt: 1000, holdH: 2, usdIn: 5, realizedUsd: -1, realizedPct: -20, peakPct: 10, exitKind: "volume", paper: false, ...over });
  const closes = [c({ symbol: "A" }), c({ symbol: "B", source: "doppler", grade: "B", tierPct: 1, via: "side pool", realizedUsd: 3, realizedPct: 60, exitKind: "trail", paper: true }), c({ symbol: "Cc", grade: "A", tierPct: 3, ignitedAfterMin: 5, realizedUsd: 12, exitKind: "take-profit" })];
  const setup = { source: "pons-v2", grade: "C" as const, tierPct: 4, ignitedAfterMin: 9, via: "curve", hourUtc: new Date(1000).getUTCHours() };
  const rec = recallLike(setup, closes, 3);
  assert.equal(rec[0].close.symbol, "A", "the same source, grade, tier, ignition and route recalls first");
  assert.ok(rec[0].score > 0.9);
  assert.ok(similarity(setup, { source: "doppler", grade: "B", tierPct: 1, ignitedAfterMin: 8, via: "side pool", hourUtc: 12 }) < 0.5);
  assert.match(recallLine(closes[1]), /B \(paper\): doppler, grade B, 1% tier, ignited at \+8 min, in via side pool for \$5, held 2\.0h, peaked \+10%, left on trail, \+\$3\.00 \(\+60%\)/);
  const r = launchRecord(closes);
  assert.deepEqual([r.trades, r.wins, r.losses, r.paperTrades], [3, 2, 1, 1]);
  assert.ok(Math.abs(r.realizedUsd - 14) < 1e-9);
  assert.equal(r.byExit.volume, 1);
  assert.equal(r.byGrade.A.trades, 1);
  assert.match(launchRecordLine(r), /3 closed \(1 paper\), 2 wins, 1 losses, \+\$14\.00 realized/);
  assert.match(launchRecordLine(launchRecord([])), /no closed launch trades yet/);
});

test("a tape appended by two processes reads as one row per swap, in block order", () => {
  const r = (block: number, tx: string): SwapRow => ({ at: block, block, tx, side: "buy", tokenAmount: 1, quoteAmount: 1, price: 1 });
  const rows = dedupeRows([r(2, "b:0"), r(1, "a:0"), r(2, "b:0"), r(3, "c:1")]);
  assert.deepEqual(rows.map((x) => x.tx), ["a:0", "b:0", "c:1"]);
});

test("the tape exit: a paid trade whose buyers are thinning scales out on the data, and only once", () => {
  const r = { candidateMaxHoldH: 8, candidateFloorPct: 40, candidateVolumeDropPct: 30, candidateTakeProfitPct: 40, candidateTakeProfitShare: 0.5, candidateTrailArmPct: 20, candidateTrailPct: 20, candidateTapeExitMinPct: 15, candidateTapeExitPressurePct: 45, candidateTapeExitShare: 0.6 };
  const thin = exitVerdict({ ageH: 1, pnlPct: 22, hourly: [], tapeTrend: "holding", tapeBuyPressurePct: 38 }, r);
  assert.equal(thin?.kind, "tape-profit");
  assert.equal(thin?.share, 0.6);
  assert.match(thin?.reason ?? "", /buyers are thinning/);
  const rolling = exitVerdict({ ageH: 1, pnlPct: 18, hourly: [], tapeTrend: "rolling over", tapeBuyPressurePct: 60 }, r);
  assert.equal(rolling?.kind, "tape-profit", "volume rolling over counts as thinning");
  assert.equal(exitVerdict({ ageH: 1, pnlPct: 22, hourly: [], tapeTrend: "holding", tapeBuyPressurePct: 62 }, r), null, "buyers still there: nothing to do");
  assert.equal(exitVerdict({ ageH: 1, pnlPct: 8, hourly: [], tapeTrend: "holding", tapeBuyPressurePct: 30 }, r), null, "not paid enough yet: the floor and the roll-over rules own that");
  assert.equal(exitVerdict({ ageH: 1, pnlPct: 22, hourly: [], tookProfit: true, tapeTrend: "holding", tapeBuyPressurePct: 30, peakPnlPct: 22 }, r), null, "already scaled out once; the trail owns the rest");
});
