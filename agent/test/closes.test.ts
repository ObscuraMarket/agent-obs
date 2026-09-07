import { test } from "node:test";
import { openSpanStart } from "../src/desk/trade-memory.ts";

test("the open position's clock starts at its own first buy, never at a round trip closed earlier", async () => {
  const T = 1_788_800_000_000;
  const rows = [
    { at: T, id: "b1", status: "settled" as const, from: { asset: "ETH", amount: 0.08, usd: 200 }, to: { asset: "PENGUIN", amount: 1000, usd: 200 }, partner: null },
    { at: T + 3_600_000, id: "s1", status: "settled" as const, exit: true, from: { asset: "PENGUIN", amount: 1000, usd: 296 }, to: { asset: "ETH", amount: 0.12, usd: 296 }, partner: null },
    { at: T + 7_200_000, id: "b2", status: "settled" as const, from: { asset: "ETH", amount: 0.08, usd: 200 }, to: { asset: "PENGUIN", amount: 900, usd: 200 }, partner: null },
  ];
  assert.equal(openSpanStart(rows, "PENGUIN"), T + 7_200_000, "the re-entry, not the morning's buy");
  assert.equal(openSpanStart(rows.slice(0, 2), "PENGUIN"), null, "sold out: nothing open");
  assert.equal(openSpanStart(rows, "OTHER"), null);
});
import assert from "node:assert/strict";
import { positionSpans, closeFromSpan, ethUsdAt, entryForSpan, closeRow, reconcileCloses, dedupeCloses, closeKey, type TradeClose, type TradeEntry } from "../src/desk/trade-memory.ts";
import { legUsd } from "../src/desk/onchain.ts";
import { resolveAsset } from "../src/desk/assets.ts";
import type { Trade } from "../src/desk/book.ts";

// The shapes are the ledger's own: a buy carries the ETH spent in dollars and the tokens received; a sell the tokens
// sold at their marked value and the ETH that came back, which the model's exits recorded with no dollar value.
const H = 3600e3;
const t0 = Date.UTC(2026, 8, 6, 12, 0, 0);
const buy = (id: string, at: number, sym: string, eth: number, usd: number, tokens: number): Trade => ({ at, id, status: "settled", venue: "pool", partner: "pool", from: { asset: "ETH", amount: eth, usd }, to: { asset: sym, amount: tokens, usd: null }, updatedAt: at + 60e3 });
const sell = (id: string, at: number, sym: string, tokens: number, marked: number, eth: number, ethUsd: number | null = null, note = ""): Trade => ({ at, id, status: "settled", venue: "pool", partner: "pool", exit: true, from: { asset: sym, amount: tokens, usd: marked }, to: { asset: "ETH", amount: eth, usd: ethUsd }, updatedAt: at + 60e3, note });
const samples = [{ at: t0, symbol: "ETH", priceUsd: 2400 }, { at: t0 + 1 * H, symbol: "ETH", priceUsd: 2500 }, { at: t0 + 4 * H, symbol: "ETH", priceUsd: 2500 }, { at: t0, symbol: "NSDX", priceUsd: 0.0001 }];
const ethAt = ethUsdAt(samples);

// NSDX twice: a $100 round trip, then a $200 one whose sell came back unpriced; the second must not inherit the first.
const nsdx: Trade[] = [
  buy("b1", t0, "NSDX", 0.04, 100, 1_000_000),
  sell("s1", t0 + 1 * H, "NSDX", 1_000_000, 105, 0.0408),
  buy("b2", t0 + 3 * H, "NSDX", 0.08, 200, 2_000_000),
  { ...sell("s2", t0 + 4 * H, "NSDX", 2_000_000, 305.63, 0.1156), updatedAt: undefined },
  { at: t0 + 5 * H, id: "prop", status: "proposed", from: { asset: "ETH", amount: 0.08, usd: 200 }, to: { asset: "NSDX", amount: 0, usd: null }, partner: null },
];

test("a token's round trips are read off the ledger one span at a time, dust and proposals aside", () => {
  const spans = positionSpans(nsdx, "NSDX");
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map((s) => [s.enteredAt, s.exitedAt, s.entries.length, s.exits.length]), [[t0, t0 + 1 * H + 60e3, 1, 1], [t0 + 3 * H, t0 + 4 * H, 1, 1]]);
  // A partial sell, then the rest, with a float hair left over: one span, closed.
  const stock = [buy("b", t0, "STOCKKIT", 0.08, 199.9, 1_348_991.5), sell("p", t0 + 4 * 60e3, "STOCKKIT", 674_495.75, 156.2, 0.0602, 150.27, "exit (take-profit), up 56%"), sell("q", t0 + 11 * 60e3, "STOCKKIT", 168_623.9, 67.1, 0.0263), sell("r", t0 + 34 * 60e3, "STOCKKIT", 505_871.85 - 1e-7, 209.9, 0.0819)];
  const [s] = positionSpans(stock, "STOCKKIT");
  assert.equal(positionSpans(stock, "STOCKKIT").length, 1);
  assert.deepEqual([s.exits.length, s.exitedAt], [3, t0 + 34 * 60e3 + 60e3]);
  // Still held: the span is open.
  const open = positionSpans([buy("b", t0, "X", 0.08, 200, 10)], "X");
  assert.deepEqual([open.length, open[0].exitedAt], [1, null]);
  // A sell of something never bought here is not a round trip.
  assert.equal(positionSpans([sell("s", t0, "AIRDROP", 5, 1, 0.001)], "AIRDROP").length, 0);
});

test("a close is what came back against what went in: the unpriced ETH leg is priced at the time, never counted as nothing", () => {
  const [first, second] = positionSpans(nsdx, "NSDX");
  const r1 = closeFromSpan(first, ethAt);
  assert.deepEqual([r1.usdIn, r1.usdOut, r1.unpricedLegs], [100, 0.0408 * 2500, 0]);
  assert.ok(Math.abs(r1.realizedUsd - 2) < 1e-9 && Math.abs((r1.realizedPct as number) - 2) < 1e-9, "a hair over flat, not a full loss");
  const r2 = closeFromSpan(second, ethAt);
  assert.ok(Math.abs(r2.realizedUsd - 89) < 1e-9, `the second round trip stands on its own: ${r2.realizedUsd}`);
  assert.ok(Math.abs((r2.realizedPct as number) - 44.5) < 1e-9);
  assert.equal(r2.holdH, 1);
  // A priced ETH leg is taken as written; an ETH leg with no price within three hours falls back to the token as marked, and is still not nothing.
  const far = positionSpans([buy("b", t0 + 30 * H, "Y", 0.08, 200, 10), sell("s", t0 + 31 * H, "Y", 10, 190, 0.07, 180)], "Y")[0];
  assert.equal(closeFromSpan(far, ethAt).usdOut, 180);
  const marked = positionSpans([buy("b", t0 + 30 * H, "Y", 0.08, 200, 10), sell("s", t0 + 31 * H, "Y", 10, 190, 0.07)], "Y")[0];
  assert.deepEqual([closeFromSpan(marked, ethAt).usdOut, closeFromSpan(marked, ethAt).unpricedLegs], [190, 0]);
  // A buy with no dollar value: ETH at the time, else the entry the desk recorded.
  const blind = positionSpans([{ ...buy("b", t0, "Z", 0.05, 0, 10), from: { asset: "ETH", amount: 0.05, usd: null } }, sell("s", t0 + 1 * H, "Z", 10, 130, 0.05)], "Z")[0];
  assert.equal(closeFromSpan(blind, ethAt).usdIn, 0.05 * 2400);
  assert.equal(closeFromSpan(blind, () => null, t0 + 2 * H, 123).usdIn, 123);
});

test("ETH's price at a moment comes from the desk's own samples, nearest within three hours", () => {
  assert.equal(ethAt(t0 + 50 * 60e3), 2500);
  assert.equal(ethAt(t0 + 10 * 60e3), 2400);
  assert.equal(ethAt(t0 + 20 * H), null, "too far from any sample");
  assert.equal(ethUsdAt(samples, 2487)(t0 + 20 * H), 2487, "the fallback stands in");
  assert.equal(ethUsdAt([], 2487)(t0), 2487);
});

test("a route that never priced ETH still prices the ETH leg of the trade row, and nothing else", () => {
  const eth = resolveAsset("ETH@robinhood")!;
  const usdg = resolveAsset("USDG@robinhood")!;
  assert.equal(legUsd(eth, 0.1, null, 2500), 250);
  assert.equal(legUsd(eth, 0.1, 2400, 2500), 240, "the route's own price wins when it has one");
  assert.equal(legUsd(usdg, 5, null, 2500), null, "only ETH is priced off the desk's sample");
  assert.equal(legUsd(eth, 0.1, null, null), null);
});

test("the entry recorded for a span is the one that landed inside it, so a second round trip keeps its own grade", () => {
  const e = (at: number, grade: "A" | "B"): TradeEntry => ({ at, symbol: "NSDX", token: "0x1", source: "pons-v2", grade, tierPct: 3.8, ignitedAfterMin: null, via: "curve", usd: 100, reason: "", paper: false });
  const entries = [e(t0, "B"), e(t0 + 3 * H, "A"), { ...e(t0 + 3 * H + 1, "A"), paper: true }];
  const [first, second] = positionSpans(nsdx, "NSDX");
  assert.equal(entryForSpan(entries, first, false)?.grade, "B");
  assert.equal(entryForSpan(entries, second, false)?.grade, "A");
  assert.equal(entryForSpan(entries, { ...second, enteredAt: t0 + 20 * H, exitedAt: t0 + 21 * H }, false)?.grade, "A", "with nothing inside the span, the latest for the symbol");
  const row = closeRow(second, entries[1], closeFromSpan(second, ethAt), "0x1", 12, "model", false, t0 + 4 * H);
  assert.deepEqual([row.grade, row.enteredAt, row.usdIn, Math.round(row.realizedUsd), row.peakPct, row.exitKind], ["A", t0 + 3 * H, 200, 89, 12, "model"]);
});

test("the record reconciles against the ledger: a close that read as a full loss is replaced, once, and a right one is left alone", () => {
  const entries: TradeEntry[] = [{ at: t0, symbol: "NSDX", token: "0x1", source: "pons-v2", grade: "B", tierPct: 3.8, ignitedAfterMin: null, via: "curve", usd: 100, reason: "", paper: false }];
  const c = (over: Partial<TradeClose>): TradeClose => ({ at: t0 + 4 * H, symbol: "NSDX", token: "0x1", source: "pons-v2", grade: "B", tierPct: 3.8, ignitedAfterMin: null, via: "curve", enteredAt: t0 + 3 * H, holdH: 1, usdIn: 200, realizedUsd: -200, realizedPct: -100, peakPct: null, exitKind: "model", paper: false, ...over });
  const closes = [
    // The first round trip, written with the book's running realized and the right entry time.
    c({ at: t0 + 1 * H, enteredAt: t0, usdIn: 100, realizedUsd: 2, realizedPct: 2 }),
    // The second: its ETH leg unpriced, so it read as a full loss.
    c({}),
    // A paper row is never touched, and a token with no round trips in the ledger is left as it is.
    c({ symbol: "ZZZ", paper: true, realizedUsd: -100 }),
    c({ symbol: "GHOST", realizedUsd: -50 }),
  ];
  const fixes = reconcileCloses(closes, nsdx, entries, ethAt, t0 + 5 * H);
  assert.equal(fixes.length, 1, "only the wrong row is rewritten");
  const f = fixes[0];
  assert.ok(Math.abs(f.realizedUsd - 89) < 1e-9 && Math.abs((f.realizedPct as number) - 44.5) < 1e-9);
  assert.equal(f.replaces, closeKey(closes[1]));
  assert.equal(f.at, closes[1].at, "the close keeps its time");
  assert.match(f.corrected ?? "", /\$200\.00 in, \$289\.00 back over 1 sell; the first row said -\$200\.00/);
  // Read back: one row per position, the corrected one standing for the wrong one; and nothing more to do.
  const rows = dedupeCloses([...closes, ...fixes]);
  assert.deepEqual(rows.filter((r) => r.symbol === "NSDX").map((r) => Math.round(r.realizedUsd)), [2, 89]);
  assert.equal(reconcileCloses(rows, nsdx, entries, ethAt, t0 + 5 * H).length, 0);
  // A recomputation that moves the entry time (a row once keyed to the token's first-ever buy) retires the old row by name.
  const wrongKey = [c({ enteredAt: t0 - 5 * H, realizedUsd: -200 })];
  const moved = reconcileCloses(wrongKey, nsdx, entries, ethAt, t0 + 5 * H);
  assert.deepEqual([moved.length, moved[0].enteredAt, moved[0].replaces], [1, t0 + 3 * H, `NSDX:${t0 - 5 * H}:real`]);
  assert.equal(dedupeCloses([...wrongKey, ...moved]).length, 1);
});
