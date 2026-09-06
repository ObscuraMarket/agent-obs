import { test } from "node:test";
import assert from "node:assert/strict";
import { chainLaunchRow, pairSymbolOf, ignitionAt, ignitionRow, ignitionRulesFromEnv } from "../src/desk/chainlaunch.ts";
import { parseFeed, curvePoolIdFor } from "../src/desk/candidates.ts";

const now = 1_788_650_000_000;
const TOKEN = "0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a" as const;

test("the pair's symbol from its address: ETH, USDG, NVDA, and nothing else", () => {
  assert.equal(pairSymbolOf("0x0000000000000000000000000000000000000000"), "ETH");
  assert.equal(pairSymbolOf("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"), "USDG");
  assert.equal(pairSymbolOf("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"), "NVDA");
  assert.equal(pairSymbolOf("0xeeca2e7dc194a320d349122d88259bb9595a4cb0"), null);
});

test("a launch read from the chain becomes a feed row the parser takes as an early launch, with its curve pool named", () => {
  const row = chainLaunchRow({ token: TOKEN, symbol: "ZZZ", name: "Sleepy", pairToken: "0x0000000000000000000000000000000000000000", creatorTaxBps: 100, at: now - 40e3, block: 55_500_000, tx: "0xabc" }, now);
  assert.equal(row.kind, "launch");
  assert.equal(row.source, "pons-v2");
  assert.equal(row.ts, Math.floor((now - 40e3) / 1000), "seconds, like the watcher");
  assert.equal(row.pairSymbol, "ETH");
  assert.equal(row.curvePoolId, curvePoolIdFor(TOKEN, "ETH", null));
  assert.deepEqual(row.gate, { ok: true, standard: "PonsV2LauncherToken" });
  const snap = parseFeed(JSON.stringify(row) + "\n", now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 30 * 60e3 });
  assert.equal(snap.early.length, 1);
  const e = snap.early[0];
  assert.equal(e.symbol, "ZZZ");
  assert.equal(e.gateOk, true);
  assert.equal(e.creatorTaxBps, 100);
  assert.equal(e.curvePoolId, row.curvePoolId);
  assert.equal(e.ignitedAfterMin, null, "the chain row knows nothing of ignition; the watcher's later row can add it");
  assert.equal(e.firstSwapAt, null, "no pool yet");
  // The pool's creation re-emits the row with the first swap on it: the moment the desk can trade the launch.
  const pooled = chainLaunchRow({ token: TOKEN, symbol: "ZZZ", name: "Sleepy", pairToken: "0x0000000000000000000000000000000000000000", creatorTaxBps: 100, at: now - 40e3, block: 55_500_000, tx: "0xabc", firstSwapAt: now - 5e3 }, now);
  assert.equal(pooled.firstSwapTs, Math.floor((now - 5e3) / 1000));
  const withPool = parseFeed(JSON.stringify(row) + "\n" + JSON.stringify(pooled) + "\n", now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 30 * 60e3 });
  assert.equal(withPool.early.length, 1);
  assert.equal(withPool.early[0].firstSwapAt, Math.floor((now - 5e3) / 1000) * 1000);
  // The watcher's later row for the same token wins the merge and adds the ignition.
  const watcher = { ...row, ignitionTs: Math.floor((now - 10e3) / 1000), from: undefined };
  const merged = parseFeed(JSON.stringify(row) + "\n" + JSON.stringify(watcher) + "\n", now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 30 * 60e3 });
  assert.equal(merged.early.length, 1);
  assert.equal(merged.early[0].ignitedAfterMin, 1);
});

test("ignition: enough swaps from enough wallets with enough dollars, inside the window, and the dollar bar is waived when nothing could be priced", () => {
  const R = ignitionRulesFromEnv({} as NodeJS.ProcessEnv);
  assert.deepEqual(R, { windowSec: 600, minSwaps: 60, minSenders: 20, minUsd: 10_000 });
  const launchAt = now;
  const crowd = (n: number, wallets: number, usdEach: number, fromSec = 10) => Array.from({ length: n }, (_, i) => ({ at: launchAt + (fromSec + i) * 1000, sender: `0x${String(i % wallets).padStart(40, "0")}`, usd: usdEach }));
  assert.equal(ignitionAt(launchAt, crowd(60, 20, 200), R), launchAt + 69 * 1000, "the sixtieth swap, when the wallets and the dollars were already there");
  assert.equal(ignitionAt(launchAt, crowd(80, 10, 200), R), null, "eighty swaps from ten wallets is not a crowd");
  assert.equal(ignitionAt(launchAt, crowd(80, 30, 50), R), null, "eighty swaps from thirty wallets but $4,000: not enough money");
  assert.equal(ignitionAt(launchAt, crowd(80, 30, 0), R), launchAt + 69 * 1000, "an unpriced pair ignites on swaps and wallets alone");
  assert.equal(ignitionAt(launchAt, crowd(80, 30, 200, 700), R), null, "a crowd that arrives after the window is not an ignition");
  assert.equal(ignitionAt(launchAt, [...crowd(30, 30, 200), ...crowd(30, 30, 200, 601)], R), null, "only the swaps inside the window count");
  assert.equal(ignitionAt(launchAt, crowd(59, 30, 200), R), null, "one short");
});

test("the ignition row and the re-emitted launch row both tell the parser the launch ignited", () => {
  const f = { token: TOKEN, symbol: "ZZZ", name: "Sleepy", pairToken: "0x0000000000000000000000000000000000000000" as const, creatorTaxBps: 100, at: now - 8 * 60e3, block: 55_500_000, tx: "0xabc", firstSwapAt: now - 7 * 60e3 };
  const ignitedAt = now - 3 * 60e3;
  const ign = ignitionRow(f, ignitedAt, now);
  assert.equal(ign.kind, "ignition");
  assert.equal(ign.minutesAfterLaunch, 5);
  assert.equal(ign.ignitionTs, ignitedAt / 1000, "seconds, like the watcher");
  const opts = { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 30 * 60e3 };
  const viaIgnitionRow = parseFeed(JSON.stringify(chainLaunchRow(f, now)) + "\n" + JSON.stringify(ign) + "\n", now, opts);
  assert.equal(viaIgnitionRow.early[0].ignitedAfterMin, 5, "the ignition row alone marks it");
  const viaLaunchRow = parseFeed(JSON.stringify(chainLaunchRow({ ...f, ignitedAt }, now)) + "\n", now, opts);
  assert.equal(viaLaunchRow.early[0].ignitedAfterMin, 5, "so does the re-emitted launch row");
  assert.equal(parseFeed(JSON.stringify(chainLaunchRow(f, now)) + "\n", now, opts).early[0].ignitedAfterMin, null, "and without either it is not ignited");
});
