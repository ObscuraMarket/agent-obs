import { test } from "node:test";
import assert from "node:assert/strict";
import { chainLaunchRow, pairSymbolOf } from "../src/desk/chainlaunch.ts";
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
  // The watcher's later row for the same token wins the merge and adds the ignition.
  const watcher = { ...row, ignitionTs: Math.floor((now - 10e3) / 1000), from: undefined };
  const merged = parseFeed(JSON.stringify(row) + "\n" + JSON.stringify(watcher) + "\n", now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 30 * 60e3 });
  assert.equal(merged.early.length, 1);
  assert.equal(merged.early[0].ignitedAfterMin, 1);
});
