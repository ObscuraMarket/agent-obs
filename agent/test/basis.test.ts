import { test } from "node:test";
import assert from "node:assert/strict";
import { basisSignal, trackRecord } from "../src/desk/analysis.ts";
import { decodeNasdaq, decodeLighter } from "../src/obscura/stockRef.ts";
import { costBasis } from "../src/desk/book.ts";

test("the basis signal: cheap pool buys, rich pool sells, inside the cost nothing", () => {
  const ref = { perpUsd: 230.55, printUsd: 228.45 };
  const cheap = basisSignal(228.0, ref, 0.62, 0.25);
  assert.ok(cheap.gapToPerpPct != null && cheap.gapToPerpPct < -1.1);
  assert.ok(cheap.netEdgePct != null && cheap.netEdgePct > 0.25);
  assert.equal(cheap.side, "buy");
  const rich = basisSignal(233.5, ref, 0.62, 0.25);
  assert.equal(rich.side, "sell");
  const inside = basisSignal(230.1, ref, 0.62, 0.25);
  assert.equal(inside.side, "none");
  assert.ok(inside.netEdgePct != null && inside.netEdgePct < 0, "a 0.2% gap does not cover a 0.62% round trip");
  assert.equal(basisSignal(230.1, { perpUsd: null, printUsd: 228.45 }, 0.62, 0.25).side, "none", "no perp, no anchor, no trade");
});

test("reference payloads decode forgivingly", () => {
  const nq = decodeNasdaq({ data: { marketStatus: "Closed", primaryData: { lastSalePrice: "$228.45", lastTradeTimestamp: "Sep 3, 2026" }, secondaryData: null } });
  assert.deepEqual(nq, { printUsd: 228.45, printStatus: "closed", printAt: "Sep 3, 2026", extendedUsd: null });
  assert.equal(decodeNasdaq(null).printUsd, null);
  const lt = decodeLighter({ order_book_stats: [{ symbol: "NVDA/USDG", last_trade_price: 229.79, daily_trades_count: 7 }, { symbol: "NVDA", last_trade_price: 230.55, daily_trades_count: 15032, daily_price_change: 1.99 }] }, "NVDA");
  assert.deepEqual(lt, { perpUsd: 230.55, perpTradesDay: 15032, perpChangeDayPct: 1.99 });
  assert.equal(decodeLighter({}, "NVDA").perpUsd, null);
});

test("realized events become a track record: round trips, hit rate, averages, windows", () => {
  const now = Date.UTC(2026, 8, 4, 12, 0, 0);
  const flows = [{ at: now - 10 * 86400e3, kind: "deposit" as const, asset: "USDG", amount: 1000, usd: 1000 }];
  const t = (at: number, id: string, from: [string, number, number], to: [string, number, number]) => ({ at, id, status: "settled" as const, from: { asset: from[0], amount: from[1], usd: from[2] }, to: { asset: to[0], amount: to[1], usd: to[2] }, partner: "pool" });
  const trades = [
    t(now - 9 * 86400e3, "b1", ["USDG", 100, 100], ["NVDA", 0.5, 100]),
    t(now - 8 * 86400e3, "s1", ["NVDA", 0.5, 102], ["USDG", 102, 102]),
    t(now - 3 * 86400e3, "b2", ["USDG", 100, 100], ["NVDA", 0.4, 100]),
    t(now - 2 * 86400e3, "s2", ["NVDA", 0.4, 99], ["USDG", 99, 99]),
    t(now - 3600e3, "b3", ["USDG", 100, 100], ["NVDA", 0.42, 100]),
    t(now - 1800e3, "s3", ["NVDA", 0.42, 100.8], ["USDG", 100.8, 100.8]),
  ];
  const { events } = costBasis(flows, trades);
  assert.deepEqual(events.map((e) => [e.asset, Number(e.usd.toFixed(2))]), [["NVDA", 2], ["NVDA", -1], ["NVDA", 0.8]], "USDG legs are not round trips, the stock sells are");
  const tr = trackRecord(events, now);
  assert.equal(tr.roundTrips, 3);
  assert.equal(tr.wins, 2);
  assert.equal(tr.losses, 1);
  assert.ok(Math.abs((tr.hitRatePct as number) - 66.67) < 0.01);
  assert.ok(Math.abs((tr.avgWinUsd as number) - 1.4) < 1e-9);
  assert.ok(Math.abs((tr.avgLossUsd as number) + 1) < 1e-9);
  assert.ok(Math.abs(tr.realizedUsd - 1.8) < 1e-9);
  assert.ok(Math.abs(tr.realized24hUsd - 0.8) < 1e-9);
  assert.ok(Math.abs(tr.realized7dUsd + 0.2) < 1e-9);
  assert.ok(Math.abs(tr.last[0].usd - 0.8) < 1e-9, "newest first");
});
