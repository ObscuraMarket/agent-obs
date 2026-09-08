import { test } from "node:test";
import assert from "node:assert/strict";
import { entryAmountEth, exitShare, followersFor, liveOn, mirrorLegOn, canStartLive, mirrorWidth } from "../src/desk/mirror.ts";
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
  // The reserve is kept twice: the entry's gas and the exit's. 0.03 above 0.004 is 0.026, more than half the size.
  assert.deepEqual(entryAmountEth(100, 2500, 0.03, 0.002), { amount: 0.026 }, "less than the size but more than half: the room it has above a round trip of gas");
  assert.match((entryAmountEth(100, 2500, 0.01, 0.002) as { reason: string }).reason, /holds 0\.0100 ETH; \$100 at \$2500 an ETH needs 0\.0400 ETH plus 0\.0040 ETH of gas reserve for the round trip/);
  assert.match((entryAmountEth(100, 2500, 0.023, 0.002) as { reason: string }).reason, /round trip/, "0.023 leaves 0.019 above the round trip, under half the size: an entry that would strand the exit is refused");
  assert.match((entryAmountEth(100, 0, 1, 0.002) as { reason: string }).reason, /unpriced/);
  assert.equal(exitShare(600, 1000), 0.6);
  assert.equal(exitShare(1000, 1000), 1);
  assert.equal(exitShare(5, null), 1, "no idea what the desk held: sell it all, never leave a bag");
  assert.equal(exitShare(1200, 1000), 1);
});

test("agents are mirrored a few at a time: four unless the operator sets it, never under one", () => {
  assert.equal(mirrorWidth({} as NodeJS.ProcessEnv), 4);
  assert.equal(mirrorWidth({ OBS_FOLLOW_PARALLEL: "8" } as NodeJS.ProcessEnv), 8);
  assert.equal(mirrorWidth({ OBS_FOLLOW_PARALLEL: "0" } as NodeJS.ProcessEnv), 4);
  assert.equal(mirrorWidth({ OBS_FOLLOW_PARALLEL: "many" } as NodeJS.ProcessEnv), 4);
});

test("an agent may start live by the mirror's own bar, and one holding live tokens stays live whatever its ETH", () => {
  assert.deepEqual(canStartLive(10, 2500, 0.008, 0.002, false), { ok: true }, "the full size above a round trip of gas");
  assert.deepEqual(canStartLive(10, 2500, 0.0065, 0.002, false), { ok: true }, "more than half the size above the round trip: what the entry itself would take");
  const short = canStartLive(10, 2500, 0.0055, 0.002, false);
  assert.equal(short.ok, false, "0.0055 leaves 0.0015 above the round trip, under half of the 0.004 the size needs");
  assert.match((short as { reason: string }).reason, /holds 0\.0055 ETH; \$10 a trade needs at least 0\.0060 ETH \(half the size above 0\.0040 ETH of gas reserve for the round trip\)\. \/fund it first, or \/start paper\./);
  assert.deepEqual(canStartLive(10, 2500, 0.0001, 0.002, true), { ok: true }, "holding RWA and LENNY live after a /stop: back on live, not a paper start that hides them");
  assert.match((canStartLive(10, null, 1, 0.002, false) as { reason: string }).reason, /unpriced/);
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

test("the live switch gates entries only: an exit and the sweep run whenever the agent wallets exist", () => {
  // OBS_FOLLOW_LIVE=off stopped follower exits and the sweep while the desk kept selling (audit, 2026-09-08): off
  // means no new money in, never money left in a token the desk dumped. The wallets' seed is the only thing an
  // exit needs, since nothing can sign without it.
  const off = { OBS_FOLLOW_LIVE: "off", OBS_AGENT_WALLET_SEED: "x".repeat(40) } as NodeJS.ProcessEnv;
  assert.equal(mirrorLegOn("entry", off), false, "no new money in");
  assert.equal(mirrorLegOn("exit", off), true, "the desk's exit still reaches every follower");
  assert.equal(mirrorLegOn("sweep", off), true, "and the sweep still runs");
  const on = { OBS_AGENT_WALLET_SEED: "x".repeat(40) } as NodeJS.ProcessEnv;
  for (const k of ["entry", "exit", "sweep"] as const) assert.equal(mirrorLegOn(k, on), true, `${k} with the switch on`);
  const noSeed = { OBS_FOLLOW_LIVE: "on" } as NodeJS.ProcessEnv;
  for (const k of ["entry", "exit", "sweep"] as const) assert.equal(mirrorLegOn(k, noSeed), false, `${k} with no wallets to sign from`);
  assert.equal(liveOn(off), false, "the switch itself still reads off");
});
