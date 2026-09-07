import { test } from "node:test";
import assert from "node:assert/strict";
import { entryAmountEth, exitShare, followersFor, liveOn } from "../src/desk/mirror.ts";
import { followState, liveHoldings, liveTrades, liveBook, followLines, followEvents, deskReason, type FollowRow, type FollowTradeRow } from "../src/desk/follow.ts";

test("the agent tells the console what it did, in the first person, with the desk's reason beside it", () => {
  const T = 1_788_800_000_000;
  const desk: Record<string, ReturnType<typeof liveTrades>[number]> = {
    d1: { at: T, id: "d1", status: "settled", from: { asset: "ETH", amount: 0.08, usd: 200 }, to: { asset: "PENGUIN", amount: 1000, usd: 200 }, partner: null },
    d2: { at: T + 60_000, id: "d2", status: "settled", exit: true, from: { asset: "PENGUIN", amount: 600, usd: 180 }, to: { asset: "ETH", amount: 0.072, usd: 180 }, partner: null, note: "exit (trail), trailing stop: peaked at +40%, gave back 25% from the peak; pool then pool on chain" },
  };
  const entries = [{ at: T + 5_000, symbol: "PENGUIN", reason: "quiet base with buyers stepping in" }];
  assert.equal(deskReason(desk.d1, entries), "quiet base with buyers stepping in");
  assert.equal(deskReason(desk.d2, entries), "trailing stop: peaked at +40%, gave back 25% from the peak");
  assert.equal(deskReason(undefined, entries), null);
  const live = followState([{ address: "0x1111111111111111111111111111111111111111", at: T - 1, action: "start", sizeUsd: 10, mode: "live" }], "0x1111111111111111111111111111111111111111");
  const mine: FollowTradeRow[] = [
    { address: "0x1111111111111111111111111111111111111111", deskId: "d1", at: T + 10_000, id: "pool-1", status: "settled", from: { asset: "ETH", amount: 0.004, usd: 10 }, to: { asset: "PENGUIN", amount: 50, usd: 10 }, partner: "pool", venue: "pool" },
    { address: "0x1111111111111111111111111111111111111111", deskId: "d2", at: T + 70_000, id: "pool-2", status: "settled", exit: true, from: { asset: "PENGUIN", amount: 30, usd: 9 }, to: { asset: "ETH", amount: 0.0036, usd: 9 }, partner: "pool", venue: "pool" },
  ];
  const notes = [{ address: "0x1111111111111111111111111111111111111111", at: T + 80_000, deskId: "d3", note: "entry of DOHJ skipped: the agent's wallet holds 0.0100 ETH; $10 at $2500 an ETH needs 0.0040 ETH plus the 0.002 ETH gas reserve" }];
  const ev = followEvents(live, liveTrades(mine, "0x1111111111111111111111111111111111111111"), notes, (id) => desk[id], entries, T);
  assert.equal(ev.length, 3);
  assert.match(ev[0].text, /^Followed Agent OBS into PENGUIN: 0\.0040 ETH \(\$10\.00\) from my wallet, landed\. The desk's reason: quiet base with buyers stepping in$/);
  assert.match(ev[1].text, /^Sold my PENGUIN with the desk: 0\.0036 ETH \(\$9\.00\) back to my wallet, landed\. The desk's reason: trailing stop/);
  assert.match(ev[2].text, /^Sat this one out\. The desk entered DOHJ; the agent's wallet holds/);
  assert.equal(followEvents(live, liveTrades(mine, "0x1111111111111111111111111111111111111111"), notes, (id) => desk[id], entries, T + 75_000).length, 1, "only what is newer than the moment asked");
  for (const e of ev) assert.ok(!e.text.includes("—"));
});

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const T0 = 1_788_800_000_000;

test("an agent puts its size into an entry within what its wallet holds above the gas reserve, or says why not", () => {
  assert.deepEqual(entryAmountEth(100, 2500, 0.1, 0.002), { amount: 0.04 });
  assert.deepEqual(entryAmountEth(100, 2500, 0.03, 0.002), { amount: 0.028 }, "less than the size but more than half: the room it has");
  assert.match((entryAmountEth(100, 2500, 0.01, 0.002) as { reason: string }).reason, /holds 0\.0100 ETH; \$100 at \$2500 an ETH needs 0\.0400 ETH plus the 0\.002 ETH gas reserve/);
  assert.match((entryAmountEth(100, 0, 1, 0.002) as { reason: string }).reason, /unpriced/);
  assert.equal(exitShare(600, 1000), 0.6);
  assert.equal(exitShare(1000, 1000), 1);
  assert.equal(exitShare(5, null), 1, "no idea what the desk held: sell it all, never leave a bag");
  assert.equal(exitShare(1200, 1000), 1);
});

test("an entry is for every agent that is on and live; an exit is for every agent holding the token, on or off", () => {
  const rows: FollowRow[] = [
    { address: A, at: T0, action: "start", sizeUsd: 100, mode: "live" },
    { address: B, at: T0, action: "start", sizeUsd: 100 },
    { address: B, at: T0 + 1, action: "stop" },
  ];
  assert.deepEqual(followersFor("entry", rows, () => 0), [A], "B is paper, and off");
  assert.deepEqual(followersFor("exit", rows, (a) => (a === B ? 5 : 0)), [B], "B still holds the token, so B still sells");
  assert.deepEqual(followersFor("entry", [], () => 0), []);
  assert.equal(liveOn({ OBS_AGENT_WALLET_SEED: "x".repeat(40), OBS_FOLLOW_LIVE: "off" } as NodeJS.ProcessEnv), false, "the operator's switch");
  assert.equal(liveOn({ OBS_AGENT_WALLET_SEED: "x".repeat(40) } as NodeJS.ProcessEnv), true);
  assert.equal(liveOn({} as NodeJS.ProcessEnv), false, "no wallets, no live");
});

test("a start in the other mode is a fresh start, and the live book is the agent's own real rows", () => {
  const rows: FollowRow[] = [
    { address: A, at: T0, action: "start", sizeUsd: 100 },
    { address: A, at: T0 + 60_000, action: "start", sizeUsd: 100, mode: "live" },
  ];
  const s = followState(rows, A);
  assert.deepEqual([s.on, s.mode, s.since], [true, "live", T0 + 60_000]);
  const trades: FollowTradeRow[] = [
    { address: A, deskId: "d1", at: T0 + 70_000, id: "pool-1", status: "settled", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "PENGUIN", amount: 500, usd: 100 }, partner: "pool", venue: "pool" },
    { address: A, deskId: "d2", at: T0 + 80_000, id: "pool-2", status: "settled", exit: true, from: { asset: "PENGUIN", amount: 300, usd: 90 }, to: { asset: "ETH", amount: 0.036, usd: 90 }, partner: "pool", venue: "pool" },
    { address: A, deskId: "d3", at: T0 + 90_000, id: "pool-3", status: "failed", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "DOHJ", amount: 1, usd: 100 }, partner: "pool", venue: "pool" },
    { address: B, deskId: "d1", at: T0 + 70_000, id: "pool-9", status: "settled", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "PENGUIN", amount: 500, usd: 100 }, partner: "pool", venue: "pool" },
  ];
  assert.equal(liveTrades(trades, A).length, 2, "the failed row is not a trade");
  assert.deepEqual(liveHoldings(trades, A), { PENGUIN: 200 });
  const notes = [{ address: A, at: T0 + 90_000, deskId: "d3", note: "entry of DOHJ refused: the pool route costs 9.00% against the mark; the floor is 4.0%" }];
  const book = liveBook(A, s, trades, notes, { PENGUIN: 0.25 }, 0.05);
  assert.equal(book.positions.positions[0].asset, "PENGUIN");
  assert.equal(book.positions.positions[0].valueUsd, 50);
  assert.equal(Math.round(book.positions.realizedUsd), 30, "$90 back on $60 of cost");
  const lines = followLines(book, T0 + 100_000);
  assert.match(lines[0], /^Your agent is on, LIVE: real ETH from its own wallet, following Agent OBS since/);
  assert.ok(lines.some((l) => /its wallet holds 0\.05000 ETH/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /note: entry of DOHJ refused/.test(l)), lines.join("\n"));
  for (const l of lines) assert.ok(!l.includes("—"));
});
