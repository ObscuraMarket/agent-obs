import { test } from "node:test";
import assert from "node:assert/strict";
import { followState, mirrorTrades, mirrorHoldings, followBook, followLines, checkSize, DEFAULT_SIZE_USD } from "../src/desk/follow.ts";
import type { Trade } from "../src/desk/book.ts";

const A = "0x1111111111111111111111111111111111111111";
const T0 = 1_788_800_000_000;
const min = (n: number) => T0 + n * 60_000;

// The desk: buys PENGUIN for $200 of ETH, sells 60% into strength, then the rest; buys DOHJ after the follower stopped.
const desk: Trade[] = [
  { at: min(0), id: "d1", status: "settled", from: { asset: "ETH", amount: 0.08, usd: 200 }, to: { asset: "PENGUIN", amount: 1000, usd: 200 }, partner: null, venue: "pool" },
  { at: min(30), id: "d2", status: "settled", exit: true, from: { asset: "PENGUIN", amount: 600, usd: 180 }, to: { asset: "ETH", amount: 0.072, usd: 180 }, partner: null, venue: "pool" },
  { at: min(60), id: "d3", status: "settled", exit: true, from: { asset: "PENGUIN", amount: 400, usd: 100 }, to: { asset: "ETH", amount: 0.04, usd: 100 }, partner: null, venue: "pool" },
  { at: min(90), id: "d4", status: "settled", from: { asset: "ETH", amount: 0.08, usd: 200 }, to: { asset: "DOHJ", amount: 5000, usd: 200 }, partner: null, venue: "pool" },
  { at: min(95), id: "d5", status: "pending", from: { asset: "ETH", amount: 0.08, usd: 200 }, to: { asset: "KOT", amount: 1, usd: 200 }, partner: null, venue: "pool" },
];

test("the agent's state is a replay of its rows: on, off, size, since and stopped", () => {
  assert.deepEqual(followState([], A), { on: false, sizeUsd: DEFAULT_SIZE_USD, since: null, stoppedAt: null, mode: "paper" });
  const rows = [
    { address: A, at: min(1), action: "start" as const, sizeUsd: 50 },
    { address: A, at: min(2), action: "size" as const, sizeUsd: 150 },
    { address: "0x2222222222222222222222222222222222222222", at: min(3), action: "stop" as const },
    { address: A, at: min(4), action: "stop" as const },
    { address: A, at: min(5), action: "start" as const },
  ];
  assert.deepEqual(followState(rows.slice(0, 2), A), { on: true, sizeUsd: 150, since: min(1), stoppedAt: null, mode: "paper" });
  assert.deepEqual(followState(rows.slice(0, 4), A), { on: false, sizeUsd: 150, since: min(1), stoppedAt: min(4), mode: "paper" });
  const again = followState(rows, A);
  assert.deepEqual([again.on, again.since, again.stoppedAt, again.sizeUsd], [true, min(5), null, 150], "turned on again: a fresh since, the size kept");
  assert.equal(followState([{ address: A, at: min(1), action: "size", sizeUsd: 5 }], A).sizeUsd, DEFAULT_SIZE_USD, "a size under the floor is ignored");
});

test("a size is whole dollars between the floor and what the desk trades", () => {
  assert.deepEqual(checkSize("150", 200), { sizeUsd: 150 });
  assert.deepEqual(checkSize("$1,000", 1000), { sizeUsd: 1000 });
  assert.match((checkSize("abc", 200) as { error: string }).error, /Say a size in dollars/);
  assert.match((checkSize(5, 200) as { error: string }).error, /smallest size is \$10/);
  assert.match((checkSize(250, 200) as { error: string }).error, /largest size is \$200/);
});

test("the agent mirrors the desk's entries at its size and the desk's exits by share, from the moment it was turned on", () => {
  // On before the first entry, $100 a trade: half the desk's $200 entry, then the same 60% and 100% exits.
  const on = followState([{ address: A, at: min(-1), action: "start", sizeUsd: 100 }], A);
  const m = mirrorTrades(desk, on);
  assert.deepEqual(m.map((t) => t.id), ["f-d1", "f-d2", "f-d3", "f-d4"]);
  assert.equal(m[0].to.amount, 500);
  assert.equal(m[0].from.usd, 100);
  assert.equal(m[1].from.amount, 300, "60% of what it held");
  assert.equal(m[1].to.usd, 90, "the proceeds scale with what was sold");
  assert.equal(m[2].from.amount, 200, "the rest");
  assert.deepEqual(mirrorHoldings(m), { DOHJ: 2500 }, "PENGUIN is gone, DOHJ is held; the pending KOT never was");
  const book = followBook(desk, on, { DOHJ: 0.05, PENGUIN: 0.2 });
  assert.equal(book.positions.positions.length, 1);
  assert.equal(book.positions.positions[0].asset, "DOHJ");
  assert.equal(book.positions.positions[0].valueUsd, 125);
  assert.equal(Math.round(book.positions.realizedUsd), 40, "PENGUIN: $90 + $50 back on $100 in");
  // Turned on after the first entry: PENGUIN was never its trade, so its exits are not either.
  const late = followState([{ address: A, at: min(10), action: "start", sizeUsd: 100 }], A);
  assert.deepEqual(mirrorTrades(desk, late).map((t) => t.id), ["f-d4"]);
  // Stopped before DOHJ: no new entry, but the PENGUIN exits still mirror, so it is never left holding.
  const stopped = followState([{ address: A, at: min(-1), action: "start", sizeUsd: 100 }, { address: A, at: min(45), action: "stop" }], A);
  assert.deepEqual(mirrorTrades(desk, stopped).map((t) => t.id), ["f-d1", "f-d2", "f-d3"]);
  assert.deepEqual(mirrorHoldings(mirrorTrades(desk, stopped)), {});
  assert.deepEqual(mirrorTrades(desk, followState([], A)), [], "never started, nothing mirrored");
});

test("the console lines say on or off, the size, what it holds and what it made, without an em dash", () => {
  const off = followLines(followBook(desk, followState([], A), {}), min(100));
  assert.match(off[0], /^Your agent is off\./);
  assert.match(off[1], /\/start turns it on/);
  const on = followState([{ address: A, at: min(-1), action: "start", sizeUsd: 100 }], A);
  const lines = followLines(followBook(desk, on, { DOHJ: 0.05 }), min(100));
  assert.match(lines[0], /^Your agent is on, paper, following Agent OBS since \d\d:\d\dZ, \$100 a trade\./);
  assert.ok(lines.some((l) => /holding DOHJ \$125\.00 \(\+25\.0%\)/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /2 entries, 2 exits, realized \$40\.00 since you started/.test(l)), lines.join("\n"));
  const idle = followLines(followBook([], followState([{ address: A, at: min(0), action: "start" }], A), {}), min(12));
  assert.ok(idle.some((l) => /no position yet: the desk has made no entry in the 12 min since you started/.test(l)), idle.join("\n"));
  for (const l of [...off, ...lines, ...idle]) assert.ok(!l.includes("\u2014"));
});
