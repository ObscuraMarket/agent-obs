import { test } from "node:test";
import assert from "node:assert/strict";
import { paperBalances, paperByKey, paperReport } from "../src/desk/paper.ts";

const t = (at: number, id: string, from: [string, number, number | null], to: [string, number, number | null]) => ({ at, id, status: "settled" as const, from: { asset: from[0], amount: from[1], usd: from[2] }, to: { asset: to[0], amount: to[1], usd: to[2] }, partner: "pool" });

test("paper balances are the real wallet with the paper trades applied, and the rails see them by key", () => {
  const chain = { ETH: 0.41 };
  const paper = [t(1, "paper-1", ["ETH", 0.05, 120], ["NVDA", 0.53, 119.6]), t(2, "paper-2", ["NVDA", 0.2, 45], ["ETH", 0.0186, 44.8])];
  const b = paperBalances(chain, paper);
  assert.ok(Math.abs(b.ETH - 0.3786) < 1e-9);
  assert.ok(Math.abs(b.NVDA - 0.33) < 1e-9);
  const k = paperByKey({ "ETH@robinhood": 0.41, "ETH@eth": 0, "USDG@robinhood": 0 }, b);
  assert.ok(Math.abs(k["ETH@robinhood"] - 0.3786) < 1e-9);
  assert.ok(Math.abs(k["NVDA@robinhood"] - 0.33) < 1e-9);
  assert.equal("USDG@robinhood" in k, false, "a zero balance is not a balance");
});

test("the paper report marks paper against real at one set of prices and sums the route cost", () => {
  const chain = { ETH: 0.41 };
  const paper = [t(1, "paper-1", ["ETH", 0.05, 120], ["NVDA", 0.53, 119.6])];
  const r = paperReport(chain, { ETH: 2400, NVDA: 230 }, paper, [{ at: 0, kind: "deposit", asset: "ETH", amount: 0.4, usd: 948.82 }], []);
  assert.equal(r.realEquityUsd, 0.41 * 2400);
  assert.ok(Math.abs((r.paperEquityUsd as number) - (0.36 * 2400 + 0.53 * 230)) < 1e-9);
  assert.ok(Math.abs((r.effectUsd as number) - (0.53 * 230 - 0.05 * 2400)) < 1e-9, "the trade's effect is what the NVDA is worth now minus the ETH it cost");
  assert.ok(Math.abs(r.feesUsd - 0.4) < 1e-9);
  assert.equal(r.positions.find((p) => p.asset === "NVDA")!.avgCostUsd, 120 / 0.53);
});
