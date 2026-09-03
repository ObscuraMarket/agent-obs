import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, deriveTickSpacing, poolIdFor, exitSignal, candidateAsset, dynamicPoolSpec, resolveAny } from "../src/desk/candidates.ts";
import { checkCandidate, railsFromEnv, checkRails, type Intent } from "../src/desk/rails.ts";
import { resolveAsset } from "../src/desk/assets.ts";
import { routeFor } from "../src/desk/onchain.ts";

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
  const snap = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true });
  assert.deepEqual(snap.candidates.map((c) => c.symbol), ["BLOKKS"], "UPS failed the gate, OLD is too old");
  const c = snap.candidates[0];
  assert.equal(c.feePips, 40000);
  assert.equal(c.tickSpacing, 400);
  assert.equal(c.usdgIs0, USDG.toLowerCase() < BLOKKS.toLowerCase());
  assert.equal(snap.hourly[BLOKKS_POOL].map((h) => h.usd).join(","), "2605,956,263");
  const loose = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: false });
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
  const snap = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true });
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
  const snap = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true });
  const tok = candidateAsset(snap.candidates[0]);
  const eth = resolveAsset("ETH@robinhood")!;
  const buy: Intent = { from: eth, to: tok, amount: 0.01, usd: 24 };
  assert.deepEqual(checkCandidate(buy, null, [], rails), { ok: true, maxUsd: 5 }, "unknown token: a $5 probe");
  assert.deepEqual(checkCandidate(buy, { proven: true, blacklisted: false }, [], rails), { ok: true });
  assert.match((checkCandidate(buy, { proven: false, blacklisted: true }, [], rails) as { reason: string }).reason, /blacklisted/);
  assert.match((checkCandidate(buy, { proven: true, blacklisted: false }, ["HOTDOG"], rails) as { reason: string }).reason, /one launch position at a time/);
  assert.deepEqual(checkCandidate(buy, { proven: true, blacklisted: false }, ["BLOKKS"], rails), { ok: true }, "adding to the one held is fine");
  const ctx = { rails, balances: { "ETH@robinhood": 0.4, "BLOKKS@robinhood": 50000 }, nativeOnFromChain: 0.4, openOrders: 1, sentTodayUsd: 99 };
  assert.deepEqual(checkRails(buy, ctx).ok, false, "a buy at the daily cap with an order open is refused");
  const sell: Intent = { from: tok, to: eth, amount: 50000, usd: 300, exit: true };
  assert.deepEqual(checkRails(sell, ctx), { ok: true }, "an exit passes the caps and the open-order limit");
  const off = railsFromEnv({ OBS_TRADING: "on", OBS_CANDIDATES: "off" } as NodeJS.ProcessEnv);
  assert.match((checkRails(buy, { ...ctx, rails: off }) as { reason: string }).reason, /allowlist/, "with candidates off, a launch token is just not on the allowlist");
});
