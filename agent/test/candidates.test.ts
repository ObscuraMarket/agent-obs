import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, deriveTickSpacing, poolIdFor, exitSignal, candidateAsset, dynamicPoolSpec, resolveAny, gradeCandidate, gradeRulesFromEnv, earlyAsCandidate, toMs } from "../src/desk/candidates.ts";
import { checkCandidate, railsFromEnv, checkRails, type Intent } from "../src/desk/rails.ts";
import { resolveAsset } from "../src/desk/assets.ts";
import { routeFor, costFloorPct, encodeSwap } from "../src/desk/onchain.ts";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as const;
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as const;
const BLOKKS = "0x66e73ef65528baf192679222c6d2810d7d7e2c68" as const;
const BLOKKS_POOL = "0xe0e5deeec338dd231384f777d733d5d1769f51e079d49a1fbaec18c07dbf8893";

test("a pool id is rebuilt from its key, and the tick spacing derived from the id alone", () => {
  assert.equal(poolIdFor(USDG, NVDA, 3000, 60), "0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1");
  assert.equal(deriveTickSpacing(NVDA, 3000, "0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1"), 60);
  assert.equal(deriveTickSpacing(BLOKKS, 40000, BLOKKS_POOL), 400);
  assert.equal(deriveTickSpacing(BLOKKS, 3000, BLOKKS_POOL), null, "the wrong fee reproduces nothing");
});

const now = 1788400000000;
const feed = [
  { ts: now - 3600e3, kind: "candidate", id: BLOKKS_POOL, token: BLOKKS, symbol: "BLOKKS", tier: 4, gateOk: true, launchSource: "pons-v2", hour: 1, volUsd: 359927, movePct: 23.3, senders: 52, swaps: 3500, px: 0.000788 },
  { ts: now - 7200e3, kind: "candidate", id: "0xd88d31e1055c8fe6549cfc47807f57926fa052adaa64312b82dc77d57d155888", token: "0xf23250dac154d05bb671cb0d0ebef3c635c79ce2", symbol: "UPS", tier: 0.6, gateOk: false, launchSource: "doppler", hour: 3, volUsd: 121328, movePct: -0.4, senders: 15, swaps: 1031, px: 103.7 },
  { ts: now - 30 * 3600e3, kind: "candidate", id: BLOKKS_POOL, token: "0x1c1daef0300551adbfbe403e7d567b6c5aff566f", symbol: "OLD", tier: 4, gateOk: true, hour: 2, volUsd: 5, movePct: 0, senders: 1, swaps: 1 },
  { ts: now - 3000e3, kind: "hourly", id: BLOKKS_POOL, hour: 1, senders: 52, lastHour: { swaps: 97, usd: 2605, px: 0.000788, L: 1 } },
  { ts: now - 1800e3, kind: "hourly", id: BLOKKS_POOL, hour: 2, senders: 57, lastHour: { swaps: 40, usd: 956, px: 0.000647, L: 1 } },
  { ts: now - 600e3, kind: "hourly", id: BLOKKS_POOL, hour: 3, senders: 57, lastHour: { swaps: 10, usd: 263, px: 0.000426, L: 1 } },
  "this line is not json",
].map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");

test("the feed's tail parses into gated, recent, sane-tier candidates with their pools, plus hourly trails", () => {
  const snap = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 90 * 60e3 });
  assert.deepEqual(snap.candidates.map((c) => c.symbol), ["BLOKKS"], "UPS failed the gate, OLD is too old");
  const c = snap.candidates[0];
  assert.equal(c.feePips, 40000);
  assert.equal(c.tickSpacing, 400);
  assert.equal(c.usdgIs0, USDG.toLowerCase() < BLOKKS.toLowerCase());
  assert.equal(snap.hourly[BLOKKS_POOL].map((h) => h.usd).join(","), "2605,956,263");
  const loose = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: false, earlyMaxAgeMs: 90 * 60e3 });
  assert.deepEqual(loose.candidates.map((c) => c.symbol), ["BLOKKS", "UPS"], "gate off admits the ungated one, still sorted by volume");
  const a = candidateAsset(c);
  assert.equal(a.chain, "robinhood");
  assert.equal(a.deposit, false, "Obscura will not route a launch token; pool lane only");
  const spec = dynamicPoolSpec(a)!;
  assert.equal(spec.id, BLOKKS_POOL);
  assert.equal(spec.feePct, 4);
  assert.deepEqual(spec.usdToken === 0 ? [spec.token0, spec.decimals0] : [spec.token1, spec.decimals1], ["USDG", 6]);
  assert.equal(resolveAny("blokks@robinhood", { ...snap, readAt: now, path: "x" })!.contract, BLOKKS);
  assert.equal(resolveAny("BLOKKS@eth", { ...snap, readAt: now, path: "x" }), null);
  assert.equal(resolveAny("ETH", { ...snap, readAt: now, path: "x" })!.symbol, "ETH", "static assets still resolve first");
});

test("a candidate routes through its own pool and back to ETH", () => {
  const snap = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 90 * 60e3 });
  const a = candidateAsset(snap.candidates[0]);
  const eth = resolveAsset("ETH@robinhood")!;
  const buy = routeFor(eth, a)!;
  assert.deepEqual(buy.hops.map((h) => [h.key, h.fee, h.tickSpacing]), [["ETH/USDG", 100, 1], ["BLOKKS/USDG", 40000, 400]]);
  assert.equal(buy.hops[1].currencyOut, BLOKKS);
  const sell = routeFor(a, eth)!;
  assert.deepEqual(sell.hops.map((h) => h.key), ["BLOKKS/USDG", "ETH/USDG"]);
});

test("exit signals: time stop, floor, and volume rolling over two hours running", () => {
  const r = { candidateMaxHoldH: 8, candidateFloorPct: 40, candidateVolumeDropPct: 30 };
  const trail = [{ hour: 1, at: 1, usd: 2605, px: null, senders: 1 }, { hour: 2, at: 2, usd: 956, px: null, senders: 1 }, { hour: 3, at: 3, usd: 263, px: null, senders: 1 }];
  assert.match(exitSignal({ ageH: 8.5, pnlPct: 10, hourly: [] }, r)!, /time stop/);
  assert.match(exitSignal({ ageH: 1, pnlPct: -41, hourly: [] }, r)!, /floor/);
  assert.match(exitSignal({ ageH: 1, pnlPct: -5, hourly: trail }, r)!, /volume rolled over/);
  assert.equal(exitSignal({ ageH: 1, pnlPct: -5, hourly: trail.slice(0, 2) }, r), null, "two hours are not enough to call a roll-over");
  assert.equal(exitSignal({ ageH: 1, pnlPct: 5, hourly: [trail[0], { ...trail[1], usd: 2500 }, trail[2]] }, r), null, "one soft hour is noise");
});

test("candidate rails: probe first, proven sizes up, blacklisted never, one at a time, exits skip the caps", () => {
  const rails = railsFromEnv({ OBS_TRADING: "on", OBS_PROBE_USD: "5", OBS_MAX_CANDIDATES: "1" } as NodeJS.ProcessEnv);
  const snap = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 90 * 60e3 });
  const tok = candidateAsset(snap.candidates[0]);
  const eth = resolveAsset("ETH@robinhood")!;
  const buy: Intent = { from: eth, to: tok, amount: 0.01, usd: 24 };
  assert.deepEqual(checkCandidate(buy, null, [], rails), { ok: true, maxUsd: 5 }, "unknown token: a $5 probe");
  assert.deepEqual(checkCandidate(buy, { proven: true, blacklisted: false }, [], rails), { ok: true, maxUsd: 5, addOn: false }, "proven but ungraded: the probe size is the ceiling");
  assert.match((checkCandidate(buy, { proven: false, blacklisted: true }, [], rails) as { reason: string }).reason, /blacklisted/);
  assert.match((checkCandidate(buy, { proven: true, blacklisted: false }, ["HOTDOG"], rails) as { reason: string }).reason, /one launch position at a time/);
  assert.deepEqual(checkCandidate(buy, { proven: true, blacklisted: false }, ["BLOKKS"], rails), { ok: true, maxUsd: 5, addOn: false }, "adding to the one held is fine, at the ungraded ceiling");
  const ctx = { rails, balances: { "ETH@robinhood": 0.4, "BLOKKS@robinhood": 50000 }, nativeOnFromChain: 0.4, openOrders: 1, sentTodayUsd: 99 };
  assert.deepEqual(checkRails(buy, ctx).ok, false, "a buy at the daily cap with an order open is refused");
  const sell: Intent = { from: tok, to: eth, amount: 50000, usd: 300, exit: true };
  assert.deepEqual(checkRails(sell, ctx), { ok: true }, "an exit passes the caps and the open-order limit");
  const off = railsFromEnv({ OBS_TRADING: "on", OBS_CANDIDATES: "off" } as NodeJS.ProcessEnv);
  assert.match((checkRails(buy, { ...ctx, rails: off }) as { reason: string }).reason, /allowlist/, "with candidates off, a launch token is just not on the allowlist");
});

test("the cost floor is the ordinary allowance for the majors and the pool's own tier on top for a launch token", () => {
  const snap = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 90 * 60e3 });
  const tok = candidateAsset(snap.candidates[0]);
  const eth = resolveAsset("ETH@robinhood")!;
  assert.ok(Math.abs(costFloorPct({ from: eth, to: resolveAsset("NVDA@robinhood")!, amount: 1, usd: 1 }, 0.97) - 3) < 1e-9);
  assert.ok(Math.abs(costFloorPct({ from: eth, to: tok, amount: 1, usd: 1 }, 0.97) - 7) < 1e-9, "a 4% tier plus the 3% allowance");
  assert.ok(Math.abs(costFloorPct({ from: tok, to: eth, amount: 1, usd: 1 }, 0.97) - 7) < 1e-9, "selling it costs the tier too");
});

test("the bar: grade A clears every threshold and earns size, B ordinary size, C a probe, and rolling over is below the bar", () => {
  const r = gradeRulesFromEnv({} as NodeJS.ProcessEnv);
  const snap = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 90 * 60e3 });
  const base = snap.candidates[0];
  const holding = [{ hour: 1, at: 1, usd: 300000, px: 0.001, senders: 50 }, { hour: 2, at: 2, usd: 280000, px: 0.00098, senders: 60 }];
  const strong = { ...base, volUsd: 400000, senders: 60, movePct: 12, tierPct: 3, hour: 2 };
  const a = gradeCandidate(strong, holding, 30000, r);
  assert.equal(a.grade, "A");
  assert.equal(a.capUsd, 75);
  assert.equal(a.trend, "holding");
  const b = gradeCandidate({ ...strong, tierPct: 4 }, holding, 30000, r);
  assert.equal(b.grade, "B", "a 4% tier is short of A but fine for B");
  assert.equal(b.capUsd, 25);
  assert.match(b.why, /tier 4% over 3%/);
  const shallow = gradeCandidate(strong, holding, 5000, r);
  assert.equal(shallow.grade, "B", "thin depth is short of A");
  const c = gradeCandidate({ ...strong, volUsd: 40000, senders: 8 }, holding, 30000, r);
  assert.equal(c.grade, "C");
  assert.equal(c.capUsd, 5);
  const rolling = [{ hour: 1, at: 1, usd: 300000, px: 0.001, senders: 50 }, { hour: 2, at: 2, usd: 90000, px: 0.0006, senders: 60 }];
  const dead = gradeCandidate(strong, rolling, 30000, r);
  assert.equal(dead.grade, null);
  assert.match(dead.why, /below the bar/);
  const noTrail = gradeCandidate(strong, [], 30000, r);
  assert.equal(noTrail.grade, "B", "without a trail there is no proof of holding volume, so no size yet");
  const bled = gradeCandidate(strong, [{ hour: 1, at: 1, usd: 300000, px: 0.001, senders: 50 }, { hour: 2, at: 2, usd: 290000, px: 0.0005, senders: 60 }], 30000, r);
  assert.equal(bled.grade, null, "50% off its peak is below the bar even with volume holding");
});

test("grade caps size the position, the probe comes first, and scaling into a proven token is a continuation", () => {
  const rails = railsFromEnv({ OBS_TRADING: "on", OBS_PROBE_USD: "5" } as NodeJS.ProcessEnv);
  const snap = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 90 * 60e3 });
  const tok = candidateAsset(snap.candidates[0]);
  const eth = resolveAsset("ETH@robinhood")!;
  const buy: Intent = { from: eth, to: tok, amount: 0.05, usd: 120 };
  const A = { grade: "A" as const, capUsd: 75, why: "clears every bar for size" };
  assert.deepEqual(checkCandidate(buy, null, [], rails, A), { ok: true, maxUsd: 5 }, "unknown token: the probe first, whatever the grade");
  assert.deepEqual(checkCandidate(buy, { proven: true, blacklisted: false }, [], rails, A, 0), { ok: true, maxUsd: 75, addOn: false });
  assert.deepEqual(checkCandidate(buy, { proven: true, blacklisted: false }, ["BLOKKS"], rails, A, 5), { ok: true, maxUsd: 70, addOn: true }, "holding the probe: room to the cap, as a continuation");
  assert.match((checkCandidate(buy, { proven: true, blacklisted: false }, ["BLOKKS"], rails, A, 75) as { reason: string }).reason, /ceiling of \$75/);
  assert.match((checkCandidate(buy, { proven: true, blacklisted: false }, [], rails, { grade: null, capUsd: 0, why: "below the bar: volume rolling over" }) as { reason: string }).reason, /below the bar/);
  const ctx = { rails, balances: { "ETH@robinhood": 0.4 }, nativeOnFromChain: 0.4, openOrders: 0, sentTodayUsd: 0, now, lastEntryAt: now - 30 * 60e3, entriesToday: 1 };
  assert.deepEqual(checkRails({ from: eth, to: tok, amount: 0.03, usd: 70, capUsd: 75, addOn: true }, ctx), { ok: true }, "a $70 add-on passes under a $75 grade cap, and skips the spacing rule");
  assert.match((checkRails({ from: eth, to: tok, amount: 0.03, usd: 70, capUsd: 75 }, ctx) as { reason: string }).reason, /at least 2h apart/, "a fresh entry is still spaced");
  assert.match((checkRails({ from: eth, to: tok, amount: 0.04, usd: 96, capUsd: 75, addOn: true }, ctx) as { reason: string }).reason, /grade cap of \$75/);
});

test("early launches: seconds and milliseconds both read as time, ignition and a side pool make a probe candidate, the rest are watched", () => {
  assert.equal(toMs(1788495175.169), 1788495175169);
  assert.equal(toMs(1788495175169), 1788495175169);
  assert.equal(toMs("nope"), 0);
  const t0 = now - 20 * 60e3;
  const feedEarly = [
    { kind: "launch", token: "0xaaa0000000000000000000000000000000000001", source: "pons-v2", ts: t0 / 1000, symbol: "DATA", gate: { ok: true, standard: "PonsV2LauncherToken", reason: "" }, creatorTaxBps: 100, curvePoolId: "0xcurve", ignitionTs: null, firstSwapTs: (t0 + 60e3) / 1000 },
    { kind: "ignition", token: "0xaaa0000000000000000000000000000000000001", symbol: "DATA", launchTs: t0 / 1000, ignitionTs: (t0 + 8 * 60e3) / 1000, minutesAfterLaunch: 8 },
    { kind: "side-pool", id: BLOKKS_POOL, token: "0xaaa0000000000000000000000000000000000001", fee: 40000, tickSpacing: 400, launch: "pons-v2", ts: t0 + 9 * 60e3 },
    { kind: "launch", token: "0xbbb0000000000000000000000000000000000002", source: "pons-v2", ts: (now - 5 * 60e3) / 1000, symbol: "SC69", gate: { ok: true, standard: "PonsV2LauncherToken" }, creatorTaxBps: 100, ignitionTs: null, firstSwapTs: null },
    { kind: "launch", token: "0xccc0000000000000000000000000000000000003", source: "doppler", ts: (now - 3 * 3600e3) / 1000, symbol: "OLDIE", gate: { ok: true }, creatorTaxBps: 0 },
    { kind: "launch", token: "0xddd0000000000000000000000000000000000004", source: "pons-v2", ts: (now - 10 * 60e3) / 1000, symbol: "TAXY", gate: { ok: true }, creatorTaxBps: 500, ignitionTs: (now - 5 * 60e3) / 1000 },
    { kind: "side-pool", id: "0x" + "9".repeat(64), token: "0xddd0000000000000000000000000000000000004", fee: 30000, tickSpacing: 300, launch: "pons-v2", ts: now - 4 * 60e3 },
  ].map((r) => JSON.stringify(r)).join("\n");
  const snap = parseFeed(feedEarly, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 90 * 60e3 });
  assert.deepEqual(snap.early.map((e) => e.symbol), ["SC69", "TAXY", "DATA"], "newest first, the three-hour-old one is out of the window");
  const data = snap.early.find((e) => e.symbol === "DATA")!;
  assert.equal(data.ignitedAfterMin, 8);
  assert.equal(data.sidePools[0].tierPct, 4);
  assert.equal(data.standard, "PonsV2LauncherToken");
  const c = earlyAsCandidate(data, now)!;
  assert.equal(c.symbol, "DATA");
  assert.equal(c.poolId, BLOKKS_POOL);
  assert.equal(c.hour, 0);
  assert.equal(earlyAsCandidate(snap.early.find((e) => e.symbol === "SC69")!, now), null, "not ignited, no side pool: watched, not tradable");
  assert.equal(earlyAsCandidate(snap.early.find((e) => e.symbol === "TAXY")!, now), null, "a 5% creator tax is never a probe");
});

test("an ignited launch with no side pool trades through its curve: the key from chain, the quote hub, hooked hops with fee 0", () => {
  const t0 = now - 20 * 60e3;
  const feedEarly = [
    { kind: "launch", token: "0xeb1f90633946139ccdcb3b1bf53aa815b5a52b45", source: "pons-v2", ts: t0 / 1000, symbol: "SC69", gate: { ok: true, standard: "PonsV2LauncherToken" }, creatorTaxBps: 100, curvePoolId: "0xef6ae4928c618edc9c67bfdd285e9e2a96b8c69dc4f47c898561fe191c498451", pair: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", pairSymbol: "NVDA", ignitionTs: (t0 + 6 * 60e3) / 1000 },
  ].map((r) => JSON.stringify(r)).join("\n");
  const snap = parseFeed(feedEarly, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 90 * 60e3 });
  const l = snap.early[0];
  assert.equal(l.pairSymbol, "NVDA");
  assert.equal(l.ignitedAfterMin, 6);
  assert.equal(earlyAsCandidate(l, now, true, null), null, "no side pool and no curve key: not yet");
  const key = { poolId: "0xef6ae4928c618edc9c67bfdd285e9e2a96b8c69dc4f47c898561fe191c498451" as const, currency0: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" as const, currency1: "0xeb1f90633946139ccdcb3b1bf53aa815b5a52b45" as const, fee: 0, tickSpacing: 200, hooks: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044" as const };
  const c = earlyAsCandidate(l, now, true, key, 2)!;
  assert.equal(c.curve!.quote, "NVDA");
  assert.equal(c.curve!.quoteIs0, true, "NVDA is currency0 of that curve");
  assert.equal(c.feePips, 0);
  assert.equal(c.tickSpacing, 200);
  assert.ok(Math.abs(c.tierPct - 3) < 1e-9, "2% assumed hook fee plus 1% creator tax");
  const a = candidateAsset(c);
  const spec = dynamicPoolSpec(a)!;
  assert.deepEqual([spec.token0, spec.token1, spec.hookAddress, spec.feePips, spec.quote, spec.usdToken], ["NVDA", "SC69", key.hooks, 0, "NVDA", 0]);
  const eth = resolveAsset("ETH@robinhood")!;
  const buy = routeFor(eth, a)!;
  assert.deepEqual(buy.hops.map((h) => [h.key, h.fee, h.tickSpacing, h.spec.hookAddress ?? null]), [["ETH/USDG", 100, 1, null], ["NVDA/USDG", 3000, 60, null], ["NVDA/SC69", 0, 200, key.hooks]], "ETH to USDG to NVDA to the token, the last hop hooked with fee 0");
  const sell = routeFor(a, eth)!;
  assert.deepEqual(sell.hops.map((h) => h.key), ["NVDA/SC69", "NVDA/USDG", "ETH/USDG"]);
  const tx = encodeSwap(buy, 10n ** 16n, 1n, "0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38", 1n, "0x8876789976dEcBfCbBbe364623C63652db8C0904");
  assert.ok(tx.data.toLowerCase().includes(key.hooks.slice(2)), "the hook address rides in the path");
});
