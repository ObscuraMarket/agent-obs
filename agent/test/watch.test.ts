import { test } from "node:test";
import assert from "node:assert/strict";
import { triggersFor, watchRulesFromEnv, heartbeatLine, type WatchState } from "../src/desk/watch.ts";

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
});

test("exits come before entries before reviews, and the heartbeat reads at a glance", () => {
  const states = [st({ symbol: "A", role: "held" }), st({ symbol: "B", entryOk: true, entryState: "base", why: "base" }), st({ symbol: "C", role: "held", trend: "rolling over" })];
  const t = triggersFor({ C: st({ symbol: "C", role: "held" }) }, states, {}, now, R);
  assert.deepEqual(t.map((x) => `${x.kind}:${x.symbol}`), ["exit:C", "entry:B", "held:A"]);
  assert.equal(heartbeatLine(states, 1234, null), "[live] block 1234: A held waiting/holding, B launch ENTRY, C held waiting/rolling over");
  assert.equal(heartbeatLine([], null, "10:00:00Z x"), "[live] block ?: nothing in play; last trigger 10:00:00Z x");
  assert.equal(heartbeatLine([], 7, null, 1234), "[live] block 7 (look took 1.2 s): nothing in play");
  assert.equal(watchRulesFromEnv({ OBS_CANDIDATE_TRAIL_PCT: "20" } as NodeJS.ProcessEnv).giveBackPct, 20, "the give-back follows the trailing stop unless set");
});
