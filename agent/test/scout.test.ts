import { test } from "node:test";
import assert from "node:assert/strict";
import { scoutScore, rankScout, type ScoutRow } from "../src/desk/scout.ts";
import type { Candidate } from "../src/desk/candidates.ts";
import type { TapeStats } from "../src/desk/tape.ts";
import type { EntryRead } from "../src/desk/entry.ts";

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  at: 1, poolId: "0x0cdbf8c5c7fd4f03000000000000000000000000000000000000000000000000", token: "0x76c64776061cbf3ed3d14356b49bcf064b0ecaf4", symbol: "TRAIL", tierPct: 2, feePips: 0, tickSpacing: 200, gateOk: true, source: "pons-v2", hour: 53, volUsd: 2000, movePct: -7, senders: 0, swaps: 40, px: null, usdgIs0: false,
  record: { kind: "record", line: "record: 2.2 days old, cap $46k", ageH: 53, capUsd: 46_000, vol24: 190_000, vol1: 2_000, liveBar: 1000, liqUsd: 20_000 },
  ...over,
});
const stats = (over: Partial<TapeStats> = {}): TapeStats => ({ symbol: "TRAIL", windowMin: 60, swaps: 45, buys: 25, sells: 20, buyQuote: 1300, sellQuote: 700, buyPressurePct: 65, first: 1, last: 1.1, peak: 1.3, trough: 0.95, movePct: 10, offPeakPct: 15, buckets5m: [100, 120, 160, 210], trend: "rising", lastSwapAgoMin: 2, ...over });
const entry = (over: Partial<EntryRead> = {}): EntryRead => ({ symbol: "TRAIL", windowMin: 30, swaps: 30, pickup: true, volumeKnown: true, pickupRatio: 2, runPct: 30, offPeakPct: 15, higherLow: true, bouncePct: 4, recentBuyPressurePct: 62, rangePct: 6, state: "pullback", ok: true, why: "pullback holding, entry allowed", ...over });

test("the scout scores a live tape with buyers, off its peak but not broken, above a dead one, and says why", () => {
  const live = scoutScore(cand(), stats(), entry());
  assert.ok(live.score >= 80, `a setup worth watching scores high: ${live.score}`);
  assert.ok(live.reasons.some((r) => /buy pressure 65%/.test(r)));
  assert.ok(live.reasons.some((r) => /entry allowed now: pullback/.test(r)));
  const dead = scoutScore(cand({ record: { ...cand().record!, vol1: 0 } }), stats({ swaps: 3, buys: 1, sells: 2, buyPressurePct: 20, trend: "thin", lastSwapAgoMin: 48, offPeakPct: 70 }), entry({ state: "quiet", ok: false, why: "3 swaps in 30 min, too few to read" }));
  assert.equal(dead.score, 0, "a tape with three swaps in an hour scores nothing");
  assert.ok(dead.reasons.some((r) => /too few to read/.test(r)));
  const broken = scoutScore(cand(), stats({ trend: "rolling over", buyPressurePct: 35, offPeakPct: 40 }), entry({ state: "breakdown", ok: false }));
  assert.ok(broken.score < live.score);
});

test("the setup the desk hunts scores extra: a pump inside three hours, now pulling back with buyers still there", () => {
  // TRIBUTE, 2026-09-06: +137% from the window's start to its peak, then 30% off it with buyers at 55%.
  const long = stats({ windowMin: 180, first: 2.4e-8, peak: 5.43e-8, last: 3.8e-8, offPeakPct: 30, movePct: 58 });
  const pulling = scoutScore(cand(), stats({ buyPressurePct: 55 }), entry({ state: "pullback", ok: false, why: "pullback not held, no entry yet" }), long);
  assert.ok(pulling.reasons.some((r) => /pulling back 30% from a \+126% pump inside three hours, buyers still 55%/.test(r)), pulling.reasons.join(" | "));
  const gaveBack = scoutScore(cand(), stats({ buyPressurePct: 20 }), entry({ state: "breakdown", ok: false }), stats({ windowMin: 180, first: 2.4e-8, peak: 5.43e-8, last: 1.8e-8, offPeakPct: 67 }));
  assert.ok(gaveBack.reasons.some((r) => /gave back 67%/.test(r)), "a pump that gave back most of itself with no buyers is not the setup");
  assert.ok(pulling.score > gaveBack.score);
  const noPump = scoutScore(cand(), stats({ buyPressurePct: 55 }), entry({ state: "waiting", ok: false }), stats({ windowMin: 180, first: 2.4e-8, peak: 2.6e-8, last: 2.5e-8, offPeakPct: 4 }));
  assert.ok(!noPump.reasons.some((r) => /pump/.test(r)), "no pump, no pump points");
});

test("the watch's slots go to the highest scores, then the busiest last hour", () => {
  const row = (symbol: string, score: number, vol1: number): ScoutRow => ({ symbol, token: "0x", poolId: "0x", score, reasons: [], record: "", capUsd: 50_000, vol24: 100_000, vol1, liqUsd: 20_000, tape: { swaps: 20, buyPressurePct: 55, movePct: 0, offPeakPct: 10, trend: "holding", lastSwapAgoMin: 3 }, entry: { state: "waiting", ok: false, why: "" } });
  const ranked = rankScout([row("A", 40, 500), row("B", 70, 100), row("C", 70, 900), row("D", 10, 5000)], 3);
  assert.deepEqual(ranked.map((r) => r.symbol), ["C", "B", "A"]);
  assert.equal(rankScout([], 3).length, 0);
});
