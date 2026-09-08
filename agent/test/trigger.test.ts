import { test } from "node:test";
import assert from "node:assert/strict";
import { triggerFromEnv, sliceWithTrigger, boardOrder, thoughtFloor, type CycleTrigger } from "../src/desk/trigger.ts";

const now = 1_800_000_000_000;
const M = 60e3;
const board = (over: Partial<Parameters<typeof boardOrder>[0]>) => boardOrder({ held: ["HLD"], launches: ["L1", "L2", "L3", "L4"], candidates: ["C1", "C2", "C3"], trigger: null, maxLaunches: 3, maxCandidates: 2, ...over });

test("the trigger comes to the cycle as a symbol and a kind; an unknown kind reads as a held review", () => {
  assert.equal(triggerFromEnv({} as NodeJS.ProcessEnv), null, "a timer cycle has no trigger");
  assert.deepEqual(triggerFromEnv({ OBS_LIVE_TRIGGER_SYMBOL: "echelon", OBS_LIVE_TRIGGER_KIND: "entry" } as NodeJS.ProcessEnv), { symbol: "ECHELON", kind: "entry" });
  assert.deepEqual(triggerFromEnv({ OBS_LIVE_TRIGGER_SYMBOL: "HLD", OBS_LIVE_TRIGGER_KIND: "exit" } as NodeJS.ProcessEnv), { symbol: "HLD", kind: "exit" });
  assert.deepEqual(triggerFromEnv({ OBS_LIVE_TRIGGER_SYMBOL: "HLD" } as NodeJS.ProcessEnv), { symbol: "HLD", kind: "held" }, "no kind: the conservative side, the global floor");
  assert.equal(triggerFromEnv({ OBS_LIVE_TRIGGER_SYMBOL: "  ", OBS_LIVE_TRIGGER_KIND: "entry" } as NodeJS.ProcessEnv), null);
});

test("the feed's slice takes the trigger's row along when it sits past the slice", () => {
  const rows = ["A", "B", "C", "D"].map((symbol) => ({ symbol }));
  assert.deepEqual(sliceWithTrigger(rows, 2, null).map((r) => r.symbol), ["A", "B"]);
  assert.deepEqual(sliceWithTrigger(rows, 2, "B").map((r) => r.symbol), ["A", "B"], "already inside: nothing added");
  assert.deepEqual(sliceWithTrigger(rows, 2, "D").map((r) => r.symbol), ["A", "B", "D"], "past the slice: graded too");
  assert.deepEqual(sliceWithTrigger(rows, 2, "ZZZ").map((r) => r.symbol), ["A", "B"], "not in the feed at all: the slice as it was");
});

test("the board without a trigger is held, then three launches, then the read candidates, in feed order", () => {
  assert.deepEqual(board({}), { board: ["HLD", "L1", "L2", "L3", "C1", "C2"], trigger: null });
  assert.deepEqual(board({ launches: ["HLD", "L1"], candidates: ["L1", "C1"] }).board, ["HLD", "L1", "C1"], "a token counts once, held first");
});

test("a trigger that is a graded candidate is read first, and the board stays the same size", () => {
  // The token that fired was off the board in 42% of 565 triggered thinks until 2026-09-08.
  assert.deepEqual(board({ trigger: "C2" }), { board: ["HLD", "C2", "L1", "L2", "L3", "C1"], trigger: "candidate" }, "already on the board: moved up, nothing dropped");
  assert.deepEqual(board({ trigger: "C3" }), { board: ["HLD", "C3", "L1", "L2", "L3", "C1"], trigger: "candidate" }, "past the read slice: it displaces the last feed-order candidate");
  assert.equal(board({ trigger: "C3" }).board.length, board({}).board.length);
});

test("a trigger that is a tradable launch is read first, and displaces the last candidate before a launch", () => {
  assert.deepEqual(board({ trigger: "L4" }), { board: ["HLD", "L4", "L1", "L2", "L3", "C1"], trigger: "launch" });
  assert.deepEqual(board({ trigger: "L4", candidates: [] }), { board: ["HLD", "L4", "L1", "L2"], trigger: "launch" }, "no candidates: the third launch goes");
  assert.deepEqual(board({ trigger: "L2" }).board, ["HLD", "L2", "L1", "L3", "C1", "C2"], "already on the board: only the order changes");
});

test("a trigger the cycle does not know leaves the board as it was, and a held trigger stays with the positions", () => {
  assert.deepEqual(board({ trigger: "ZZZ" }), { board: ["HLD", "L1", "L2", "L3", "C1", "C2"], trigger: "unknown" });
  assert.deepEqual(board({ trigger: "HLD" }), { board: ["HLD", "L1", "L2", "L3", "C1", "C2"], trigger: "held" });
  assert.deepEqual(board({ held: ["HLD", "HLD2"], trigger: "HLD2", candidates: ["HLD2", "C1"] }).board, ["HLD", "HLD2", "L1", "L2", "L3", "C1"], "held before candidate, whatever the feed says");
});

test("the trigger never displaces a held token", () => {
  const r = board({ held: ["H1", "H2", "H3"], launches: [], candidates: ["C1", "C2"], maxCandidates: 1, trigger: "C2" });
  assert.deepEqual(r.board, ["H1", "H2", "H3", "C2"], "the one candidate slot goes to the trigger; every held token stays");
  const none = board({ held: ["H1", "H2"], launches: [], candidates: ["C1"], maxCandidates: 0, trigger: "C1" });
  assert.deepEqual(none.board, ["H1", "H2"], "no slot to take: the board is the held tokens, still the same size");
});

test("the cadence floor is per symbol for an entry trigger: another token's think a minute ago does not silence a fresh flip", () => {
  // live.ts stamps the symbol before it spawns and the cycle's floor was global, so a flip inside three minutes of
  // any think printed "Holding" and was quiet for the fifteen-minute refire: 16.5% of entry triggers since 2026-09-06.
  const entryA: CycleTrigger = { symbol: "AAA", kind: "entry" };
  const aboutB = { at: now - 1 * M, trigger: { symbol: "BBB", kind: "entry" } };
  const aboutA = { at: now - 1 * M, trigger: { symbol: "AAA", kind: "entry" } };
  assert.equal(thoughtFloor([aboutB], entryA, now, 3), null, "a trigger 1 min after another symbol's think thinks");
  assert.deepEqual(thoughtFloor([aboutA], entryA, now, 3), { agoMin: 1, about: "AAA" }, "a second trigger of the same symbol 1 min after its own think is held");
  assert.equal(thoughtFloor([aboutB, { at: now - 2 * M, trigger: { symbol: "AAA", kind: "entry" } }], entryA, now, 3)?.agoMin, 2, "the last thought about the symbol, not the last thought");
  assert.equal(thoughtFloor([{ at: now - 4 * M, trigger: { symbol: "AAA", kind: "entry" } }, aboutB], entryA, now, 3), null, "past the gap it thinks again");
  assert.equal(thoughtFloor([{ at: now - 1 * M, trigger: { symbol: "AAA", kind: "held" } }], entryA, now, 3)?.about, "AAA", "a review of the same token counts as a thought about it");
  assert.equal(thoughtFloor([], entryA, now, 3), null, "nothing thought yet");
});

test("a thought without a stamp counts for every symbol, and a held review or an exit keeps the global floor", () => {
  const entryA: CycleTrigger = { symbol: "AAA", kind: "entry" };
  const unstamped = { at: now - 1 * M };
  assert.deepEqual(thoughtFloor([unstamped], entryA, now, 3), { agoMin: 1, about: null }, "a timer cycle's thought, or a row from before the stamp");
  const aboutB = { at: now - 1 * M, trigger: { symbol: "BBB", kind: "entry" } };
  assert.equal(thoughtFloor([aboutB], { symbol: "HLD", kind: "held" }, now, 3)?.about, "BBB", "a review a minute after any think waits, as before");
  assert.equal(thoughtFloor([aboutB], { symbol: "HLD", kind: "exit" }, now, 3)?.about, "BBB", "an exit trigger too: its rails ran before the floor");
  assert.equal(thoughtFloor([aboutB], null, now, 3)?.about, "BBB", "a timer cycle: the last thought of any symbol");
  assert.equal(thoughtFloor([aboutB], null, now, 1), null, "at the gap it thinks");
  assert.equal(thoughtFloor([{ at: now - 10 * M, trigger: { symbol: "AAA", kind: "entry" } }, aboutB], entryA, now, 3), null, "rows arrive newest first or not; the floor sorts them");
});
