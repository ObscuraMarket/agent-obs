import { test } from "node:test";
import assert from "node:assert/strict";
import { triggersFor, watchRulesFromEnv, heartbeatLine, holdingNote, lockHeld, type WatchState } from "../src/desk/watch.ts";

const R = watchRulesFromEnv({} as NodeJS.ProcessEnv);
const now = 1_800_000_000_000;
const M = 60e3;
const st = (over: Partial<WatchState>): WatchState => ({ symbol: "TOK", role: "launch", entryState: "waiting", entryOk: false, trend: "holding", offPeakPct: 5, swaps: 40, lastSwapAgoMin: 1, why: "", ...over });

test("an entry fires once when it appears, waits out the cooldown, and gets a fresh look while it lasts", () => {
  const allowed = st({ entryOk: true, entryState: "pullback", why: "pullback holding, entry allowed" });
  assert.deepEqual(triggersFor({}, [allowed], {}, now, R).map((t) => t.kind), ["entry"], "first sight of an entry");
  assert.deepEqual(triggersFor({ TOK: allowed }, [allowed], { TOK: now - 4 * M }, now, R), [], "still allowed, already looked at: no repeat");
  assert.deepEqual(triggersFor({}, [allowed], { TOK: now - 1 * M }, now, R), [], "inside the cooldown, even a fresh entry waits");
  assert.equal(triggersFor({ TOK: allowed }, [allowed], { TOK: now - 16 * M }, now, R)[0]?.kind, "entry", "a persistent entry is looked at again after a while");
  assert.deepEqual(triggersFor({}, [st({ entryOk: false, entryState: "spike" })], {}, now, R), [], "no entry, no cycle");
});

test("a held token fires an exit trigger the moment its tape breaks, and a review on a cadence otherwise", () => {
  const held = st({ symbol: "HLD", role: "held" });
  const rolled = st({ symbol: "HLD", role: "held", trend: "rolling over" });
  assert.deepEqual(triggersFor({ HLD: held }, [rolled], { HLD: now - 1 * M }, now, R).map((t) => t.kind), ["exit"], "a roll-over ignores the cooldown");
  assert.deepEqual(triggersFor({ HLD: rolled }, [rolled], { HLD: now - 1 * M }, now, R), [], "already rolled over, already fired");
  const gave = st({ symbol: "HLD", role: "held", offPeakPct: 26 });
  assert.match(triggersFor({ HLD: held }, [gave], { HLD: now - 1 * M }, now, R)[0].reason, /26% off its tape peak/);
  assert.deepEqual(triggersFor({ HLD: held }, [held], { HLD: now - 2 * M }, now, R), [], "quiet and recently reviewed");
  assert.equal(triggersFor({ HLD: held }, [held], { HLD: now - 6 * M }, now, R)[0]?.kind, "held", "due a review");
  assert.equal(triggersFor({}, [held], {}, now, R)[0]?.reason, "held HLD, not reviewed yet");
  assert.equal(triggersFor({ HLD: held }, [rolled], { HLD: now - 1 * M }, now, R)[0].what, "the tape rolled over", "the short form for the terminal");
  assert.equal(triggersFor({ HLD: held }, [held], { HLD: now - 6 * M }, now, R)[0]?.what, "6 min since its last review");
  const thinning = st({ symbol: "HLD", role: "held", buyPressurePct: 38 });
  assert.match(triggersFor({ HLD: st({ symbol: "HLD", role: "held", buyPressurePct: 55 }) }, [thinning], { HLD: now - 1 * M }, now, R)[0].reason, /buyers are thinning/);
  assert.deepEqual(triggersFor({ HLD: thinning }, [thinning], { HLD: now - 1 * M }, now, R), [], "already thin, already fired");
});

test("a rail tripping at the tape's price fires an exit the look it appears, once per kind, ahead of everything", () => {
  const held = st({ symbol: "HLD", role: "held" });
  const floored = st({ symbol: "HLD", role: "held", rail: "floor: down 31% from cost, through the 30% floor", railKind: "floor" });
  const t = triggersFor({ HLD: held }, [floored], { HLD: now - 1 * M }, now, R);
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, "exit");
  assert.equal(t[0].reason, "held HLD tripped its floor rail: floor: down 31% from cost, through the 30% floor");
  assert.equal(t[0].what, "floor: down 31% from cost, through the 30% floor", "the short form is the rail's own sentence");
  assert.deepEqual(triggersFor({ HLD: floored }, [floored], { HLD: now - 1 * M }, now, R), [], "the same rail does not fire again every look");
  const trailed = st({ symbol: "HLD", role: "held", rail: "trailing stop: peaked at +40%, gave back 16%", railKind: "trail" });
  assert.match(triggersFor({ HLD: floored }, [trailed], { HLD: now - 1 * M }, now, R)[0].reason, /tripped its trail rail/, "a different rail is a new trigger");
  // A rail outranks the tape's own breaks on the same look.
  const both = st({ symbol: "HLD", role: "held", trend: "rolling over", rail: "take profit: up 32%", railKind: "take-profit" });
  assert.match(triggersFor({ HLD: held }, [both], { HLD: now - 1 * M }, now, R)[0].reason, /tripped its take-profit rail/);
});

test("a rail still tripped fires again once the re-fire gap has passed since the token's last cycle, while it is held", () => {
  const floored = st({ symbol: "HLD", role: "held", rail: "floor: down 31% from cost, through the 30% floor", railKind: "floor" });
  assert.equal(R.railRefireMin, 3, "three minutes unless set");
  assert.deepEqual(triggersFor({ HLD: floored }, [floored], { HLD: now - 1 * M }, now, R), [], "a minute after the cycle: not yet");
  assert.deepEqual(triggersFor({ HLD: floored }, [floored], { HLD: now - 2.9 * M }, now, R), [], "just under the gap: not yet");
  const t = triggersFor({ HLD: floored }, [floored], { HLD: now - 3 * M }, now, R);
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, "exit");
  assert.equal(t[0].reason, "held HLD is still through its floor rail 3 min after its last cycle: floor: down 31% from cost, through the 30% floor");
  assert.equal(t[0].what, "floor: down 31% from cost, through the 30% floor", "the short form is still the rail's own sentence");
  assert.equal(triggersFor({ HLD: floored }, [floored], { HLD: now - 6 * M }, now, R)[0]?.kind, "exit", "past the review cadence it is the rail that fires, not a review");
  assert.equal(triggersFor({ HLD: floored }, [floored], {}, now, R)[0]?.reason, "held HLD is still through its floor rail with no cycle yet: floor: down 31% from cost, through the 30% floor", "never thought about, it fires until a cycle runs");
  const R10 = watchRulesFromEnv({ OBS_LIVE_RAIL_REFIRE_MIN: "10" } as NodeJS.ProcessEnv);
  assert.equal(R10.railRefireMin, 10);
  assert.deepEqual(triggersFor({ HLD: floored }, [floored], { HLD: now - 5 * M }, now, R10).map((x) => x.kind), ["held"], "a longer gap waits longer: the review cadence runs, the rail does not re-fire yet");
  assert.equal(triggersFor({ HLD: floored }, [floored], { HLD: now - 10 * M }, now, R10)[0]?.kind, "exit");
  // Sold: the token is no longer held, and a stale rail on it fires nothing.
  const sold = st({ symbol: "HLD", role: "launch", rail: floored.rail, railKind: floored.railKind });
  assert.deepEqual(triggersFor({ HLD: floored }, [sold], { HLD: now - 10 * M }, now, R), [], "not held: no rail, no re-fire");
});

test("the cycle's lock counts as held only while its pid lives and it is under fifteen minutes old", () => {
  assert.equal(lockHeld({ pid: 146, at: now - 60e3 }, now, () => true), true);
  assert.equal(lockHeld({ pid: 146, at: now - 60e3 }, now, () => false), false, "a dead pid is a stale lock");
  assert.equal(lockHeld({ pid: 146, at: now - 16 * M }, now, () => true), false, "older than fifteen minutes is stale");
  assert.equal(lockHeld(null, now, () => true), false);
  assert.equal(lockHeld({ pid: 146 } as { pid: number; at: number }, now, () => true), false, "a lock without a time is not held");
});

test("exits come before entries before reviews, and the heartbeat reads at a glance", () => {
  const states = [st({ symbol: "A", role: "held" }), st({ symbol: "B", entryOk: true, entryState: "base", why: "base" }), st({ symbol: "C", role: "held", trend: "rolling over" })];
  const t = triggersFor({ C: st({ symbol: "C", role: "held" }) }, states, {}, now, R);
  assert.deepEqual(t.map((x) => `${x.kind}:${x.symbol}`), ["exit:C", "entry:B", "held:A"]);
  assert.equal(heartbeatLine(states, 1234, null), "[live] block 1234: A held holding, B launch ENTRY, C held rolling over");
  assert.equal(heartbeatLine([], null, "10:00:00Z x"), "[live] block ?: nothing in play; last trigger 10:00:00Z x");
  assert.equal(heartbeatLine([], 7, null, 1234), "[live] block 7 (looks 1.2 s): nothing in play");
  assert.equal(watchRulesFromEnv({ OBS_CANDIDATE_TRAIL_PCT: "20" } as NodeJS.ProcessEnv).giveBackPct, 20, "the give-back follows the trailing stop unless set");
});

test("a held token's line is what its tape is doing, not its entry read", () => {
  assert.equal(holdingNote(st({ role: "held", offPeakPct: 12, buyPressurePct: 58.4, swaps: 14 })), "tape holding, 12% off its peak, buy pressure 58%, 14 swaps in the last 15 min");
  assert.equal(holdingNote(st({ role: "held", trend: "rising", offPeakPct: 0, buyPressurePct: null, swaps: 1 })), "tape rising, at its peak, 1 swap in the last 15 min");
  assert.equal(holdingNote(st({ role: "held", trend: "thin", offPeakPct: null, swaps: 0 })), "tape thin, no swaps in the last 15 min");
  const held = st({ symbol: "HLD", role: "held", entryOk: true, entryState: "pullback" });
  assert.equal(heartbeatLine([held], 1, null), "[live] block 1: HLD held holding", "an entry read on a held token is not an ENTRY");
});
