import { test } from "node:test";
import assert from "node:assert/strict";
import { holdingsFrom, latestTrades, netCapitalUsd, snapshot, series, type Trade, type CapitalFlow } from "../src/desk/book.ts";

const flows: CapitalFlow[] = [
  { at: 1, kind: "deposit", asset: "ETH", amount: 1, usd: 2500 },
  { at: 2, kind: "deposit", asset: "USDG", amount: 500, usd: 500 },
  { at: 3, kind: "withdraw", asset: "USDG", amount: 100, usd: 100 },
];
const trades: Trade[] = [
  { at: 10, id: "a", status: "pending", from: { asset: "ETH", amount: 0.5, usd: 1250 }, to: { asset: "USDG", amount: 1240, usd: 1240 }, partner: "Relay" },
  { at: 11, id: "a", updatedAt: 12, status: "settled", from: { asset: "ETH", amount: 0.5, usd: 1250 }, to: { asset: "USDG", amount: 1240, usd: 1240 }, partner: "Relay", settlementTx: "0xabc" },
  { at: 13, id: "b", status: "pending", from: { asset: "USDG", amount: 200, usd: 200 }, to: { asset: "BTC", amount: 0.002, usd: null }, partner: "SwapSpace" },
  { at: 14, id: "c", status: "proposed", from: { asset: "ETH", amount: 0.1, usd: 250 }, to: { asset: "USDG", amount: 248, usd: 248 }, partner: null },
];

test("the latest row per id wins and proposals never touch holdings", () => {
  const latest = latestTrades(trades);
  assert.deepEqual(latest.map((t) => t.id), ["c", "b", "a"]);
  assert.equal(latest.find((t) => t.id === "a")?.status, "settled");
  const h = holdingsFrom(flows, trades);
  // 1 ETH deposited, 0.5 swapped out (settled), proposal untouched.
  assert.equal(h.ETH, 0.5);
  // 500 in, 100 out, +1240 from the settled swap, -200 in flight.
  assert.equal(h.USDG, 1440);
  assert.equal(h.BTC, undefined, "an in-flight to-leg has not landed");
});

test("PnL is equity minus net capital, with in-flight value kept and unpriced assets named", () => {
  assert.equal(netCapitalUsd(flows), 2900);
  const s = snapshot(flows, trades, { ETH: 2400 }, 100);
  // 0.5 ETH * 2400 + 1440 USDG (stable at 1) + 200 in flight.
  assert.equal(s.equityUsd, 1200 + 1440 + 200);
  assert.equal(s.inFlightUsd, 200);
  assert.equal(s.pnlUsd, 2840 - 2900);
  assert.ok(Math.abs((s.pnlPct ?? 0) - -60 / 2900) < 1e-12);
  assert.deepEqual(s.unpriced, []);
  const unpriced = snapshot(flows, [...trades, { at: 20, id: "d", status: "settled", from: { asset: "USDG", amount: 40, usd: 40 }, to: { asset: "XMR", amount: 0.3, usd: null }, partner: null }], { ETH: 2400 }, 100);
  assert.deepEqual(unpriced.unpriced, ["XMR"]);
});

test("an empty desk marks as empty, not as a loss", () => {
  const s = snapshot([], [], {}, 5);
  assert.equal(s.equityUsd, 0);
  assert.equal(s.pnlUsd, 0);
  assert.equal(s.pnlPct, null);
});

test("the series is windowed and oldest first", () => {
  const snaps = [
    { at: 50, holdings: {}, equityUsd: 10, inFlightUsd: 0, netCapitalUsd: 10, pnlUsd: 0, pnlPct: 0, unpriced: [] },
    { at: 90, holdings: {}, equityUsd: 12, inFlightUsd: 0, netCapitalUsd: 10, pnlUsd: 2, pnlPct: 0.2, unpriced: [] },
    { at: 5, holdings: {}, equityUsd: 9, inFlightUsd: 0, netCapitalUsd: 10, pnlUsd: -1, pnlPct: -0.1, unpriced: [] },
  ];
  assert.deepEqual(series(snaps, 60, 100).map((p) => p.at), [50, 90]);
});
