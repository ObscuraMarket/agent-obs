import { test } from "node:test";
import assert from "node:assert/strict";
import { holdingsFrom, latestTrades, netCapitalUsd, snapshot, snapshotFromChain, series, type BookSnapshot, type Trade, type CapitalFlow, positions, isFailedReadMark, markIsTrustworthy, boughtSymbols, saneMark, latestSaneMark, isHolding, bookMovedSince, closedTrades, capitalEth } from "../src/desk/book.ts";

test("a mark a thousand times the capital is a price read gone wrong, never the book: not shown, not recorded", () => {
  // SHARD dust after the full sell, priced off the drained pool: equity 1.08e41 on $948.82 of capital.
  const bad = { at: 2, holdings: { ETH: 0.4176, SHARD: 3.18e-10 }, equityUsd: 1.0833582409281056e41, inFlightUsd: 0, netCapitalUsd: 948.82, pnlUsd: 1e41, pnlPct: 1e38, unpriced: [] };
  const good = { at: 1, holdings: { ETH: 0.4176 }, equityUsd: 1047.05, inFlightUsd: 0, netCapitalUsd: 948.82, pnlUsd: 98.23, pnlPct: 0.1035, unpriced: [] };
  assert.equal(saneMark(bad), false);
  assert.equal(saneMark(good), true);
  assert.equal(latestSaneMark([good, bad])?.at, 1, "the latest mark shown is the latest sane one");
  assert.equal(markIsTrustworthy(bad, good, []), false, "and it is never recorded");
  assert.deepEqual(series([good, bad], 1e9, 3).map((s) => s.at), [1]);
  // The dust itself is left out of positions and of the equity.
  const pos = positions([], [], { ETH: 0.4176, SHARD: 3.18e-10 }, { ETH: 2500, SHARD: 3.4e50 });
  assert.deepEqual(pos.positions.map((p) => p.asset), ["ETH"]);
  assert.equal(isHolding(3.18e-10), false);
});

test("only what the desk bought is a holding: an airdrop in the wallet is never counted, watched or sold", () => {
  const rows: Trade[] = [
    { at: 1, id: "a", status: "settled", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "ZZZ", amount: 3214, usd: null }, partner: "pool" },
    { at: 2, id: "b", status: "pending", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "SHARD", amount: 506137, usd: null }, partner: "pool" },
    { at: 3, id: "c", status: "cancelled", from: { asset: "ETH", amount: 0.002, usd: 5 }, to: { asset: "KET", amount: 0, usd: null }, partner: null },
    { at: 4, id: "d", status: "failed", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "MEME", amount: 0, usd: null }, partner: "pool" },
  ];
  const bought = boughtSymbols(rows);
  assert.deepEqual([...bought].sort(), ["SHARD", "ZZZ"]);
  assert.equal(bought.has("KET"), false, "a withdrawn proposal bought nothing");
  assert.equal(bought.has("MEME"), false, "a failed swap bought nothing");
  assert.equal(bought.has("AIRDROP"), false, "a token that simply appears in the wallet was never bought");
});

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
  assert.deepEqual(series(snaps, 60, 100).map((p) => p.netCapitalUsd), [10, 10], "the capital rides along, as the page's contract says");
});

test("a mark taken before the deposit was recorded keeps its equity and has no PnL", () => {
  const snaps = [
    { at: 1, holdings: { ETH: 0.4 }, equityUsd: 972.63, inFlightUsd: 0, netCapitalUsd: 0, pnlUsd: 972.63, pnlPct: null, unpriced: [] },
    { at: 2, holdings: { ETH: 0.4 }, equityUsd: 973.07, inFlightUsd: 0, netCapitalUsd: 948.82, pnlUsd: 24.25, pnlPct: 0.0256, unpriced: [] },
  ];
  assert.deepEqual(series(snaps, 100, 10).map((p) => [p.equityUsd, p.pnlUsd]), [[972.63, null], [973.07, 24.25]]);
});

test("the book moved when a swap settled after a wallet read began", () => {
  const sell: Trade = { at: 100, updatedAt: 170, id: "s", status: "settled", from: { asset: "TRIBUTE", amount: 1, usd: 142 }, to: { asset: "ETH", amount: 0.05, usd: null }, partner: "pool" };
  assert.equal(bookMovedSince([sell], 150), true, "the read began before the sell settled");
  assert.equal(bookMovedSince([sell], 180), false, "the read began after it");
  assert.equal(bookMovedSince([{ ...sell, status: "pending", updatedAt: 190 }], 150), false, "a swap still in flight has not moved the wallet");
  assert.equal(bookMovedSince([{ ...sell, updatedAt: undefined, at: 160 }], 150), true, "without an update time the trade's own time counts");
});

test("positions carry average cost, unrealized and realized PnL, and share of equity", () => {
  const flows = [{ at: 1, kind: "deposit" as const, asset: "ETH", amount: 1, usd: 2400 }];
  const trades = [
    { at: 2, id: "a", status: "pending" as const, from: { asset: "ETH", amount: 0.5, usd: 1250 }, to: { asset: "USDG", amount: 1240, usd: 1240 }, partner: "x" },
    { at: 2, updatedAt: 3, id: "a", status: "settled" as const, from: { asset: "ETH", amount: 0.5, usd: 1250 }, to: { asset: "USDG", amount: 1240, usd: 1240 }, partner: "x" },
  ];
  const held = holdingsFrom(flows, trades);
  const p = positions(flows, trades, held, { ETH: 2600 });
  const eth = p.positions.find((x) => x.asset === "ETH")!;
  const usdg = p.positions.find((x) => x.asset === "USDG")!;
  assert.equal(eth.qty, 0.5);
  assert.equal(eth.avgCostUsd, 2400);
  assert.equal(eth.costUsd, 1200);
  assert.equal(eth.valueUsd, 1300);
  assert.equal(eth.unrealizedUsd, 100);
  assert.ok(Math.abs((eth.unrealizedPct as number) - 100 / 1200) < 1e-12);
  assert.equal(eth.realizedUsd, 50, "sold 0.5 ETH that cost 1200 for 1250");
  assert.equal(usdg.qty, 1240);
  assert.ok(Math.abs((usdg.avgCostUsd as number) - 1250 / 1240) < 1e-12, "USDG cost what the ETH leg was worth");
  assert.ok(Math.abs((usdg.unrealizedUsd as number) + 10) < 1e-9);
  assert.equal(p.realizedUsd, 50);
  assert.equal(p.positions[0].asset, "ETH", "largest value first");
  assert.ok(Math.abs((eth.share as number) - 1300 / 2540) < 1e-12);
  assert.deepEqual(p.inFlight, []);
});

test("a pending swap parks its cost in flight, and an unrecorded cost stays unknown", () => {
  const flows = [{ at: 1, kind: "deposit" as const, asset: "ETH", amount: 1, usd: 2400 }, { at: 1, kind: "deposit" as const, asset: "NVDA", amount: 2, usd: null }];
  const trades = [{ at: 2, id: "p", status: "pending" as const, from: { asset: "ETH", amount: 0.25, usd: 650 }, to: { asset: "USDG", amount: 640, usd: 640 }, partner: null }];
  const p = positions(flows, trades, holdingsFrom(flows, trades), { ETH: 2600, NVDA: 200 });
  const eth = p.positions.find((x) => x.asset === "ETH")!;
  assert.equal(eth.qty, 0.75);
  assert.equal(eth.costUsd, 1800);
  assert.equal(p.inFlight.length, 1);
  assert.equal(p.inFlight[0].costUsd, 600);
  assert.equal(p.inFlight[0].usd, 650);
  const nvda = p.positions.find((x) => x.asset === "NVDA")!;
  assert.equal(nvda.valueUsd, 400);
  assert.equal(nvda.avgCostUsd, null, "no dollar figure was recorded, so no basis is invented");
  assert.equal(nvda.unrealizedUsd, null);
  // Selling more than the ledger knew of poisons the basis rather than faking a gain.
  const over = positions(flows, [{ at: 3, id: "o", status: "settled" as const, from: { asset: "ETH", amount: 2, usd: 5000 }, to: { asset: "USDG", amount: 4990, usd: 4990 }, partner: null }], { ETH: 0.5, USDG: 4990 }, { ETH: 2600 });
  assert.equal(over.positions.find((x) => x.asset === "ETH")!.avgCostUsd, null);
});

test("a failed wallet read never becomes a point on the curve, and is not recorded as a mark", () => {
  const snap = (at: number, holdings: Record<string, number>, equityUsd: number | null) => ({ at, holdings, equityUsd, inFlightUsd: 0, netCapitalUsd: 948, pnlUsd: equityUsd == null ? null : equityUsd - 948, pnlPct: null, unpriced: [] as string[] });
  const good1 = snap(1000, { ETH: 0.41 }, 1027);
  const bad = snap(2000, {}, 0);
  const good2 = snap(3000, { ETH: 0.41 }, 1027.2);
  assert.equal(isFailedReadMark(good1, bad, good2), true);
  assert.equal(isFailedReadMark(undefined, snap(500, {}, 0), good1), false, "an empty desk at the very start is an empty desk");
  assert.deepEqual(series([good2, bad, good1], 10_000, 3000).map((p) => p.equityUsd), [1027, 1027.2], "the curve skips it, whatever order the rows came in");
  assert.equal(markIsTrustworthy(bad, good1, ["ETH@robinhood", "USDG@robinhood"]), false, "nothing read while the last mark held something");
  assert.equal(markIsTrustworthy(snap(4000, { USDG: 5 }, 5), good1, ["ETH@robinhood"]), false, "the asset held last time could not be read");
  assert.equal(markIsTrustworthy(snap(4000, { ETH: 0.41 }, 1030), good1, ["USDC@erc20"]), true, "an unread asset the book never held does not matter");
  assert.equal(markIsTrustworthy(bad, null, ["ETH@robinhood"]), true, "no previous mark, nothing to contradict");
});

test("a token that arrived on its own is wallet value, not a position", () => {
  // 2026-09-06 13:07Z: 0.000062 NVDA landed in the wallet from an outside address; the page listed it as a position and the operator read it as an entry.
  const flows = [{ at: 1, kind: "deposit" as const, asset: "ETH", amount: 0.4, usd: 948.82 }];
  const trades = [{ at: 2, id: "n", status: "settled" as const, from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "NSDX", amount: 1_720_174, usd: 100 }, partner: "pool" }];
  const holdings = { ETH: 0.3657, NSDX: 1_720_174, NVDA: 0.0001 };
  const p = positions(flows, trades, holdings, { ETH: 2500, NSDX: 0.0000675, NVDA: 231 });
  assert.deepEqual(p.positions.map((x) => x.asset).sort(), ["ETH", "NSDX"], "NVDA was never bought or deposited");
  assert.ok(p.positions.every((x) => x.share != null), "shares are of the whole wallet, the NVDA included");
});

test("a mark that carried the desk's own token is not on the curve and never a stand-in", () => {
  // 2026-09-06, 13:24 to 13:45Z: the token was on the book for half an hour and its price swings swamped the trading result.
  const snaps: BookSnapshot[] = [
    { at: 1, holdings: { ETH: 0.4 }, equityUsd: 1028, inFlightUsd: 0, netCapitalUsd: 948.82, pnlUsd: 79, pnlPct: 0.08, unpriced: [] },
    { at: 2, holdings: { ETH: 0.4, AOBS: 9_900_000 }, equityUsd: 10040, inFlightUsd: 0, netCapitalUsd: 10611.82, pnlUsd: -571, pnlPct: -0.05, unpriced: [] },
    { at: 3, holdings: { ETH: 0.4 }, equityUsd: 1031, inFlightUsd: 0, netCapitalUsd: 948.82, pnlUsd: 82, pnlPct: 0.09, unpriced: [] },
  ];
  assert.deepEqual(series(snaps, 100, 10).map((p) => p.at), [1, 3]);
  assert.equal(latestSaneMark(snaps.slice(0, 2))!.at, 1, "the stand-in is the last mark of the book, not the token's");
  assert.deepEqual(positions([], [], { ETH: 0.4, AOBS: 9_900_000 }, { ETH: 2500, AOBS: 0.001 }).positions.map((x) => x.asset), ["ETH"], "never a position");
});

test("closed round trips pair each realized sell with the buy that opened it, name how it ended, and read newest first", () => {
  const now = 1_788_708_000_000;
  const trades: Trade[] = [
    { at: now - 120 * 60e3, id: "b1", status: "settled", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "WHLR", amount: 1_267_652, usd: 100 }, partner: "pool", settlementTx: "0xb1" },
    { at: now - 10 * 60e3, updatedAt: now - 9 * 60e3, id: "s1", status: "settled", exit: true, from: { asset: "WHLR", amount: 760_000, usd: 94.2 }, to: { asset: "ETH", amount: 0.037, usd: null }, partner: "pool", note: "exit (tape-profit), the trade is up 57%", settlementTx: "0xs1" },
    { at: now - 9 * 60e3, updatedAt: now - 8 * 60e3, id: "s2", status: "settled", exit: true, from: { asset: "WHLR", amount: 507_652, usd: 57.7 }, to: { asset: "ETH", amount: 0.023, usd: null }, partner: "pool", note: "exit (trail), trailing stop", settlementTx: "0xs2" },
    { at: now - 5 * 60e3, id: "b2", status: "settled", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "NSDX", amount: 1_720_174, usd: 100 }, partner: "pool", settlementTx: "0xb2" },
    { at: now - 2 * 60e3, updatedAt: now - 60e3, id: "s3", status: "settled", exit: true, from: { asset: "NSDX", amount: 1_720_174, usd: 103 }, to: { asset: "ETH", amount: 0.041, usd: null }, partner: "pool", note: "ETH/NSDX on chain; expected 0.04", settlementTx: "0xs3" },
  ];
  const events = [{ at: now - 9 * 60e3, asset: "WHLR", usd: 34.2, id: "s1" }, { at: now - 8 * 60e3, asset: "WHLR", usd: 17.67, id: "s2" }, { at: now - 60e3, asset: "NSDX", usd: 3.0, id: "s3" }, { at: now - 60e3, asset: "ETH", usd: -0.4, id: "b2" }];
  const c = closedTrades(trades, events, 24 * 3600e3, now);
  assert.deepEqual(c.map((x) => [x.asset, x.how, x.resultUsd, x.heldMin]), [["NSDX", "the model", 3.0, 4], ["WHLR", "trail", 17.67, 112], ["WHLR", "tape-profit", 34.2, 111]]);
  assert.equal(c[0].tx, "0xs3");
  assert.equal(closedTrades(trades, events, 5 * 60e3, now).length, 1, "the window is honoured: only the close a minute ago");
  assert.equal(capitalEth([{ at: 1, kind: "deposit", asset: "ETH", amount: 0.4, usd: 948.82 }, { at: 2, kind: "deposit", asset: "ETH", amount: 0.01, usd: 23.72 }, { at: 3, kind: "deposit", asset: "AOBS", amount: 9_900_000, usd: 9663 }]), 0.41);
});
