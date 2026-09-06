import { test } from "node:test";
import assert from "node:assert/strict";
import { recordFails, pickPool, recordLine, screenerRulesFromEnv, type ScreenerPair, type ScreenerToken } from "../src/desk/screener.ts";
import { screenerCandidates, gradeCandidate, gradeRulesFromEnv } from "../src/desk/candidates.ts";

const now = 1_788_650_000_000;
const HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044" as const;
const ZZZ = "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a" as const;
const pool = (over: Partial<ScreenerPair> = {}): ScreenerPair => ({
  poolId: "0x6538e2c223ed70228114983afecbe5e69fe627e2fafdf367bdd6bdeff2ad391f", dex: "uniswap", labels: ["v4"], quoteSymbol: "ETH", quoteAddress: "0x0000000000000000000000000000000000000000",
  priceUsd: 0.027, vol24: 27_438_423, vol6: 3_511_531, vol1: 2_023_076, txns24: 71_065, txns1: 3056, buys1: 1437, sells1: 1619, liqUsd: 480_264, chg1: 66.9, chg24: 3398, fdvUsd: 22_449_025, capUsd: 22_449_025, pairCreatedAt: now - 24.2 * 3600e3,
  ...over,
});
const R = screenerRulesFromEnv({} as NodeJS.ProcessEnv);

test("the record rule: a day of volume, a live last hour, swaps, liquidity, and a day that is not over", () => {
  assert.equal(recordFails(pool(), R), null);
  assert.match(recordFails(pool({ vol24: 36_221 }), R) as string, /24h volume \$36,221 under/);
  assert.match(recordFails(pool({ vol1: 0 }), R) as string, /last hour \$0 under/);
  assert.match(recordFails(pool({ txns24: 700 }), R) as string, /700 swaps in 24h under 1000/);
  assert.match(recordFails(pool({ liqUsd: 4_377 }), R) as string, /liquidity \$4,377 under/);
  assert.match(recordFails(pool({ vol6: 100_000 }), R) as string, /the day is over/);
});

test("the pool the desk would trade: a v4 pool in a quote it can reach, deepest first", () => {
  const shallowUsdg = pool({ poolId: "0x3a555810ab87a47d031b44aa8382209d182ee539809f12a51293d6641660af47", quoteSymbol: "USDG", liqUsd: 194_256 });
  const v3 = pool({ poolId: "0x24107d152f14aa1b0c9e1f0e1c7a6c3c1b2d3e4f", dex: "ramses", labels: [], liqUsd: 9_999_999 });
  const lit = pool({ poolId: "0x1fd5516e648b8190000000000000000000000000000000000000000000000000", quoteSymbol: "LIT", liqUsd: 9_999_999 });
  assert.equal(pickPool([shallowUsdg, pool(), v3, lit])?.poolId, pool().poolId, "the deep ETH pool wins; the v3 pool and the LIT quote are not the desk's lane");
  assert.equal(pickPool([v3, lit]), null);
});

test("a survivor becomes a grade B candidate with its record as the reason, under the same age floor as the feed", () => {
  const t: ScreenerToken = { token: ZZZ, symbol: "ZZZ", source: "pons-v2", launchAt: now - 25 * 3600e3, creatorTaxBps: 0, pool: pool(), key: { currency0: "0x0000000000000000000000000000000000000000", currency1: ZZZ, fee: 0, tickSpacing: 200, hooks: HOOK }, kept: "record", capUsd: 22_449_025, readAt: now - 60e3 };
  const opts = { maxAgeMs: 6 * 3600e3, minTokenAgeMs: 24 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 0 };
  const [c] = screenerCandidates([t], now, opts, {} as NodeJS.ProcessEnv);
  assert.ok(c, "one candidate");
  assert.equal(c.symbol, "ZZZ");
  assert.equal(c.curve?.quote, "ETH");
  assert.equal(c.curve?.quoteIs0, true);
  assert.equal(c.tierPct, 2, "the hook's fee and no creator tax");
  assert.equal(c.hour, 25);
  assert.match(c.record?.line ?? "", /record: 25 h old, cap \$22\.4M, \$27\.4M in 24h, \$3\.5M in 6h, \$2\.0M last hour, 71,065 swaps in 24h, liquidity \$480k/);
  assert.equal(c.record?.kind, "record");
  assert.match(recordLine(t, now), /on its ETH pool/);
  const g = gradeCandidate(c, [], null, { ...gradeRulesFromEnv({} as NodeJS.ProcessEnv), requireStable: true });
  assert.equal(g.grade, "B", "the record is the grade even with the stability rule on");
  assert.equal(g.capUsd, 25);
  assert.match(g.why, /^record:/);
  // Too young for the floor: not a candidate. No key yet: not a candidate. Quiet last hour: on the board but below the bar.
  assert.equal(screenerCandidates([{ ...t, launchAt: now - 20 * 3600e3 }], now, opts, {} as NodeJS.ProcessEnv).length, 0);
  assert.equal(screenerCandidates([{ ...t, key: null }], now, opts, {} as NodeJS.ProcessEnv).length, 0);
  const quiet = screenerCandidates([{ ...t, pool: pool({ vol1: 20_000 }) }], now, opts, {} as NodeJS.ProcessEnv)[0];
  assert.equal(gradeCandidate({ ...quiet, record: { ...quiet.record!, vol1: 0 } }, [], null, gradeRulesFromEnv({} as NodeJS.ProcessEnv)).grade, null);
});

test("a launchpad token at a million of market cap is on watch whatever its record, and bought only while its last hour is live", () => {
  // Fails the record rule (too few swaps in 24h) but sits at $1.4M of cap: on the board by cap.
  const thin = pool({ txns24: 300, capUsd: 1_400_000, vol1: 12_000 });
  const t: ScreenerToken = { token: ZZZ, symbol: "ZZZ", source: "pons-v2", launchAt: now - 60 * 3600e3, creatorTaxBps: 100, pool: thin, key: { currency0: "0x0000000000000000000000000000000000000000", currency1: ZZZ, fee: 0, tickSpacing: 200, hooks: HOOK }, kept: "cap", capUsd: 1_400_000, readAt: now };
  const opts = { maxAgeMs: 6 * 3600e3, minTokenAgeMs: 24 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 0 };
  const r = gradeRulesFromEnv({} as NodeJS.ProcessEnv);
  const [c] = screenerCandidates([t], now, opts, {} as NodeJS.ProcessEnv);
  assert.ok(c, "on the board");
  assert.equal(c.record?.kind, "cap");
  assert.equal(c.tierPct, 3, "the hook's fee plus a 1% creator tax");
  assert.match(c.record?.line ?? "", /^on watch by market cap: 2\.5 days old, cap \$1\.4M/);
  assert.equal(gradeCandidate(c, [], null, r).grade, "B", "its last hour clears the live bar");
  const quiet = screenerCandidates([{ ...t, pool: pool({ txns24: 300, capUsd: 1_400_000, vol1: 4_000 }) }], now, opts, {} as NodeJS.ProcessEnv)[0];
  const g = gradeCandidate(quiet, [], null, r);
  assert.equal(g.grade, null);
  assert.match(g.why, /on watch, not tradable: its last hour \(\$4,000\) is under the \$10,000 a live hour needs/);
  // Under the cap floor and short of the record: not a candidate at all.
  assert.equal(screenerCandidates([{ ...t, capUsd: 600_000, pool: pool({ txns24: 300, capUsd: 600_000 }) }], now, opts, {} as NodeJS.ProcessEnv).length, 0);
});
