// The signal ledger: the board as rows, the stance, the convoy rule at each boundary, the console lines, the
// cycle writing it outside the auto-entry branch, and the tail read (2026-09-08). tmpdata first: the write and
// the tail read touch the ledger, and the data dir is fixed when config.ts loads.
import "./tmpdata.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { signalRows, strongSignal, stanceFor, stanceOfRefusal, latestBoardOf, latestBoard, tailSignals, readSignals, signalsFor, writeSignals, signalLines, signalBoardLines, convoyRulesFromEnv, SIGNALS_LEDGER, TAIL_BYTES, type BoardToken, type SignalRow, type SignalInputs } from "../src/desk/signalLedger.ts";
import { dataPath } from "../src/config.ts";

const RULES = { depthMult: 20, maxSwapUsd: 25, topConviction: 5 };
const AT = Date.UTC(2026, 8, 8, 14, 30, 0);

const goodEntry = { ok: true, state: "base" as const, why: "quiet in a 2.1% range for 10 min with the peak 14 min old, buy pressure 63% over the last 10 min: base, entry allowed" };
const goodHolders = { ok: true, why: "41 wallets, largest 8%, top ten 30%", transfers: 120, wallets: 41, top1Pct: 8, top10Pct: 30 };
const goodLaunch = { exists: true, unread: [] as string[], verdict: { ok: true, why: "dev buy 2.1%, no exempt wallets, links set, score 72" }, score: { total: 72, reasons: [] as string[] }, devSharePct: 2.1 };
const gradeA = { grade: "A" as const, capUsd: 200, depthUsd: 900 };
const token = (symbol: string, over: Partial<BoardToken> = {}): BoardToken => ({ symbol, token: "0x" + "ab".repeat(20), poolId: "0x" + "cd".repeat(32), lane: "launch", held: false, grade: gradeA, priceUsd: 0.0042, entry: goodEntry, holders: goodHolders, launch: goodLaunch, tape: { buyPressurePct: 63, trend: "rising" }, known: { proven: true, blacklisted: false }, ...over });
const inputs = (board: BoardToken[], over: Partial<SignalInputs> = {}): SignalInputs => ({ at: AT, cycleId: AT, board, decision: { kind: "hold", reason: "the tape is thin" }, want: null, executed: false, proposed: false, conviction: 5, rules: RULES, ...over });

test("a token the desk bought is took and strong; the rest of the board is held with the buy as the reason", () => {
  const rows = signalRows(inputs([token("LENNY"), token("OTHER", { grade: { grade: "B", capUsd: 100, depthUsd: 400 } })], { decision: { kind: "propose-swap", reason: "base, entry allowed; swapped 0.01 ETH on chain, settled" }, want: { symbol: "LENNY", exit: false }, executed: true }));
  assert.equal(rows.length, 2);
  const [lenny, other] = rows;
  assert.deepEqual([lenny.at, lenny.cycleId, lenny.symbol, lenny.lane, lenny.grade, lenny.capUsd, lenny.depthUsd, lenny.priceUsd], [AT, AT, "LENNY", "launch", "A", 200, 900, 0.0042]);
  assert.deepEqual(lenny.entry, { ok: true, kind: "base", why: goodEntry.why });
  assert.deepEqual(lenny.holders, { ok: true, complete: true, wallets: 41, largestPct: 8, topTenPct: 30, why: goodHolders.why });
  assert.deepEqual(lenny.launch, { ok: true, complete: true, score: 72, devSharePct: 2.1, why: goodLaunch.verdict.why });
  assert.deepEqual(lenny.tape, { buyPressurePct: 63, trend: "rising" });
  assert.deepEqual([lenny.proven, lenny.blacklisted, lenny.deskHeld], [true, false, false]);
  assert.equal(lenny.stance.kind, "took");
  assert.equal(lenny.strong, true);
  assert.deepEqual(other.stance, { kind: "held", why: "the desk bought LENNY this cycle instead" });
  assert.equal(other.strong, false, "grade B is never strong");
  // The rest of the board says what became of the want, not the model's reason about another token, and never
  // "bought" when nothing was (review of 2026-09-08).
  const proposed = signalRows(inputs([token("LENNY"), token("OTHER")], { decision: { kind: "propose-swap", reason: "base" }, want: { symbol: "LENNY", exit: false }, proposed: true }));
  assert.deepEqual(proposed[1].stance, { kind: "held", why: "the desk proposed LENNY this cycle instead" });
  const refused = signalRows(inputs([token("LENNY"), token("OTHER")], { decision: { kind: "hold", reason: "wanted 0.01 ETH@robinhood to LENNY@robinhood, refused: LENNY is at its grade A ceiling of $200" }, want: { symbol: "LENNY", exit: false, refused: "LENNY is at its grade A ceiling of $200" } }));
  assert.deepEqual(refused[1].stance, { kind: "held", why: "the desk wanted LENNY this cycle instead" });
  assert.equal(refused[1].strong, false, "the want was for LENNY, not OTHER");
  const sold = signalRows(inputs([token("LENNY", { held: true }), token("OTHER")], { decision: { kind: "propose-swap", reason: "time stop" }, want: { symbol: "LENNY", exit: true }, executed: true }));
  assert.deepEqual(sold[1].stance, { kind: "held", why: "the desk sold LENNY this cycle instead" });
  const failed = signalRows(inputs([token("LENNY"), token("OTHER")], { decision: { kind: "hold", reason: "wanted 0.01 ETH@robinhood to LENNY@robinhood, refused: execution reverted" }, want: { symbol: "LENNY", exit: false, failed: "execution reverted" } }));
  assert.deepEqual(failed[1].stance, { kind: "held", why: "the desk wanted LENNY this cycle instead" });
});

test("the model's hold is held with its reason, and a hold is never strong whatever the reads said", () => {
  const [r] = signalRows(inputs([token("LENNY")]));
  assert.deepEqual(r.stance, { kind: "held", why: "the tape is thin" });
  assert.equal(r.strong, false);
});

test("the cap's refusal is full, the spacing rail spaced, the brake brake, anything else refused; a refused want at full conviction stays strong", () => {
  assert.equal(stanceOfRefusal("LENNY is at its grade A ceiling of $200"), "full");
  assert.equal(stanceOfRefusal("$26.10 exceeds the per-swap cap of $25"), "full");
  assert.equal(stanceOfRefusal("the last entry was 0.5h ago; entries are at least 2h apart"), "spaced");
  assert.equal(stanceOfRefusal("daily loss brake: down $60.00 since 00:00 UTC, the limit is $50; no new entries until tomorrow"), "brake");
  assert.equal(stanceOfRefusal("the holders fail the read: one wallet holds 40%"), "refused");
  const [full] = signalRows(inputs([token("LENNY")], { decision: { kind: "hold", reason: "wanted 0.01 ETH@robinhood to LENNY@robinhood, refused: LENNY is at its grade A ceiling of $200" }, want: { symbol: "LENNY", exit: false, refused: "LENNY is at its grade A ceiling of $200" } }));
  assert.deepEqual(full.stance, { kind: "full", why: "LENNY is at its grade A ceiling of $200" });
  assert.equal(full.strong, true, "the desk's own cap does not weaken the signal for an agent with room");
  const [spaced] = signalRows(inputs([token("LENNY")], { want: { symbol: "LENNY", exit: false, refused: "the last entry was 0.5h ago; entries are at least 2h apart" } }));
  assert.equal(spaced.stance.kind, "spaced");
  const [brake] = signalRows(inputs([token("LENNY")], { want: { symbol: "LENNY", exit: false, refused: "daily loss brake: down 6.0% since 00:00 UTC, the limit is 5%; no new entries until tomorrow" } }));
  assert.equal(brake.stance.kind, "brake");
});

test("a sale is exit, an add-on is add-on, a proposal with trading off is took and says so", () => {
  assert.deepEqual(stanceFor("LENNY", { decision: { kind: "propose-swap", reason: "time stop" }, want: { symbol: "LENNY", exit: true }, executed: true, proposed: false }), { kind: "exit", why: "time stop" });
  assert.equal(stanceFor("LENNY", { decision: { kind: "propose-swap", reason: "adding" }, want: { symbol: "LENNY", exit: false, addOn: true }, executed: true, proposed: false }).kind, "add-on");
  const p = stanceFor("LENNY", { decision: { kind: "propose-swap", reason: "base" }, want: { symbol: "LENNY", exit: false }, executed: false, proposed: true });
  assert.equal(p.kind, "took");
  assert.match(p.why, /^proposed on the board, trading is off; base$/);
  assert.equal(stanceFor("LENNY", { decision: { kind: "hold", reason: "proposed 1 ETH to LENNY but one of them is not a registered asset; held instead" }, want: null, executed: false, proposed: false }).kind, "held");
  const [exit] = signalRows(inputs([token("LENNY", { held: true })], { decision: { kind: "propose-swap", reason: "time stop" }, want: { symbol: "LENNY", exit: true }, executed: true }));
  assert.equal(exit.deskHeld, true);
  assert.equal(exit.strong, false, "an exit is never strong");
});

test("a sale that was refused or that reverted is still an exit, never a want to buy: a held grade A token the desk could not leave is not strong (review 2026-09-08)", () => {
  const strongLooking = token("LENNY", { held: true });
  const [refused] = signalRows(inputs([strongLooking], { decision: { kind: "hold", reason: "wanted 1000 LENNY@robinhood to ETH@robinhood, refused: execution reverted" }, want: { symbol: "LENNY", exit: true, refused: "execution reverted" } }));
  assert.deepEqual(refused.stance, { kind: "exit", why: "the sale was refused: execution reverted" });
  assert.equal(refused.strong, false, "a sale the desk could not make is not a buy for the convoy");
  const [failed] = signalRows(inputs([strongLooking], { decision: { kind: "hold", reason: "wanted 1000 LENNY@robinhood to ETH@robinhood, refused: slippage" }, want: { symbol: "LENNY", exit: true, failed: "slippage" } }));
  assert.deepEqual(failed.stance, { kind: "exit", why: "the sale failed: slippage" });
  assert.equal(failed.strong, false);
  const [bought] = signalRows(inputs([strongLooking], { decision: { kind: "propose-swap", reason: "base" }, want: { symbol: "LENNY", exit: false }, executed: true }));
  assert.equal(bought.strong, true, "the same row with a buy that went through is strong, so the exit is what turned it off");
});

test("a want the model did not argue for is unargued, and a swap that was sent and did not go through is failed; neither is strong (review 2026-09-08)", () => {
  assert.equal(stanceOfRefusal("not argued for: needs a thesis; at least 3 evidence lines"), "unargued");
  assert.equal(stanceOfRefusal("no thesis, evidence, invalidation or conviction was stated"), "unargued");
  const [unargued] = signalRows(inputs([token("LENNY")], { decision: { kind: "hold", reason: "wanted 0.01 ETH@robinhood to LENNY@robinhood, refused: not argued for: needs a thesis" }, want: { symbol: "LENNY", exit: false, refused: "not argued for: needs a thesis" } }));
  assert.deepEqual(unargued.stance, { kind: "unargued", why: "not argued for: needs a thesis" });
  assert.equal(unargued.strong, false, "conviction 5 with too little evidence is not a want the model argued for");
  const [failed] = signalRows(inputs([token("LENNY")], { decision: { kind: "hold", reason: "wanted 0.01 ETH@robinhood to LENNY@robinhood, refused: the pool would not fill" }, want: { symbol: "LENNY", exit: false, failed: "the pool would not fill" } }));
  assert.deepEqual(failed.stance, { kind: "failed", why: "the pool would not fill" });
  assert.equal(failed.strong, false, "a pool that refused the desk's own fill is a bad convoy target whatever its depth");
  assert.match(signalLines([unargued])[0], /\. Unargued: not argued for/);
  assert.match(signalLines([failed])[0], /\. Failed: the pool would not fill$/);
});

test("a failed holder read is incomplete, names the failure, and is never strong", () => {
  const [r] = signalRows(inputs([token("LENNY", { holders: null, failed: { holders: "rpc timeout" } })], { want: { symbol: "LENNY", exit: false, refused: "the holder read did not complete for LENNY (rpc timeout), so there is no holder read" } }));
  assert.deepEqual(r.holders, { ok: false, complete: false, wallets: null, largestPct: null, topTenPct: null, why: "not read (rpc timeout)" });
  assert.equal(r.stance.kind, "refused");
  assert.equal(r.strong, false);
  const [empty] = signalRows(inputs([token("LENNY", { holders: { ...goodHolders, transfers: 0 } })]));
  assert.equal(empty.holders.complete, false, "a scan of zero transfers is no read");
  assert.equal(empty.holders.why, "not read (no transfers were read)");
});

test("an unread launch is incomplete; a token the factory does not know is a complete read with nothing to say", () => {
  const [unread] = signalRows(inputs([token("LENNY", { launch: { exists: false, unread: ["the factory record"], verdict: { ok: true, why: "the factory record could not be read" }, score: null, devSharePct: null } })], { want: { symbol: "LENNY", exit: false }, executed: true, decision: { kind: "propose-swap" } }));
  assert.deepEqual(unread.launch, { ok: false, complete: false, score: null, devSharePct: null, why: "not read (the factory record could not be read)" });
  assert.equal(unread.strong, false);
  const [none] = signalRows(inputs([token("LENNY", { launch: null })]));
  assert.equal(none.launch.why, "not read (not made this cycle)");
  const [notALaunch] = signalRows(inputs([token("LENNY", { launch: { exists: false, unread: [], verdict: { ok: true, why: "" }, score: null, devSharePct: null } })]));
  assert.deepEqual([notALaunch.launch.complete, notALaunch.launch.ok, notALaunch.launch.why], [true, true, "not a pons v2 launch, nothing to read"]);
});

test("a C grade and a blacklisted token carry their facts and are never strong; a missing tape is a null, not a pass", () => {
  const [c] = signalRows(inputs([token("PROBE", { grade: { grade: "C", capUsd: 10, depthUsd: 900 } })], { want: { symbol: "PROBE", exit: false }, executed: true, decision: { kind: "propose-swap" } }));
  assert.deepEqual([c.grade, c.capUsd, c.strong], ["C", 10, false]);
  const [b] = signalRows(inputs([token("RUG", { known: { proven: false, blacklisted: true } })], { want: { symbol: "RUG", exit: false, refused: "RUG could not be sold when probed; it is blacklisted" } }));
  assert.deepEqual([b.proven, b.blacklisted, b.stance.kind, b.strong], [false, true, "refused", false]);
  const [bare] = signalRows(inputs([{ symbol: "BARE", lane: "record", held: false }]));
  assert.deepEqual([bare.token, bare.poolId, bare.grade, bare.capUsd, bare.depthUsd, bare.priceUsd, bare.proven, bare.blacklisted], [null, null, null, null, null, null, null, false]);
  assert.deepEqual(bare.entry, { ok: false, kind: null, why: "no tape was read this cycle" });
  assert.deepEqual(bare.tape, { buyPressurePct: null, trend: null });
  assert.equal(bare.strong, false);
});

test("the convoy rule at each boundary: depth, conviction, grade, each read, the blacklist, the stance", () => {
  const base: Pick<SignalRow, "grade" | "entry" | "holders" | "launch" | "depthUsd" | "blacklisted" | "stance"> = {
    grade: "A", entry: { ok: true, kind: "base", why: "" }, holders: { ok: true, complete: true, wallets: 41, largestPct: 8, topTenPct: 30, why: "" }, launch: { ok: true, complete: true, score: 72, devSharePct: 2, why: "" }, depthUsd: 500, blacklisted: false, stance: { kind: "took", why: "" },
  };
  assert.equal(strongSignal(base, 5, RULES), true, "depth exactly 20 times the cap passes");
  assert.equal(strongSignal({ ...base, depthUsd: 499.99 }, 5, RULES), false, "a dollar under does not");
  assert.equal(strongSignal({ ...base, depthUsd: null }, 5, RULES), false, "an unread depth is not deep");
  assert.equal(strongSignal(base, 4, RULES), false, "conviction under the top mark");
  assert.equal(strongSignal(base, null, RULES), false);
  assert.equal(strongSignal({ ...base, grade: "B" }, 5, RULES), false);
  assert.equal(strongSignal({ ...base, entry: { ...base.entry, ok: false } }, 5, RULES), false);
  assert.equal(strongSignal({ ...base, holders: { ...base.holders, ok: false } }, 5, RULES), false);
  assert.equal(strongSignal({ ...base, holders: { ...base.holders, complete: false, ok: true } }, 5, RULES), false, "an incomplete holder read is not a pass");
  assert.equal(strongSignal({ ...base, launch: { ...base.launch, complete: false, ok: true } }, 5, RULES), false);
  assert.equal(strongSignal({ ...base, launch: { ...base.launch, ok: false } }, 5, RULES), false);
  assert.equal(strongSignal({ ...base, blacklisted: true }, 5, RULES), false);
  for (const kind of ["add-on", "full", "spaced", "brake", "refused"] as const) assert.equal(strongSignal({ ...base, stance: { kind, why: "" } }, 5, RULES), true, `${kind} was a want`);
  for (const kind of ["held", "exit", "unargued", "failed"] as const) assert.equal(strongSignal({ ...base, stance: { kind, why: "" } }, 5, RULES), false, `${kind} was not`);
  assert.equal(strongSignal(base, 5, { ...RULES, depthMult: 21 }), false, "the multiplier is the rule");
  assert.deepEqual(convoyRulesFromEnv({ OBS_CONVOY_DEPTH_MULT: "30", OBS_MAX_SWAP_USD: "40" }), { depthMult: 30, maxSwapUsd: 40, topConviction: 5 });
  assert.deepEqual(convoyRulesFromEnv({}), { depthMult: 20, maxSwapUsd: 25, topConviction: 5 });
});

test("the latest board is the rows of the latest cycle, in the order they were written", () => {
  const older = signalRows(inputs([token("A1"), token("B1")], { at: AT - 1800e3, cycleId: AT - 1800e3 }));
  const latest = signalRows(inputs([token("C1"), token("D1")]));
  const board = latestBoardOf([...older, ...latest, ...older]);
  assert.deepEqual(board.map((r) => r.symbol), ["C1", "D1"]);
  assert.deepEqual(latestBoardOf([]), []);
});

test("the writer counts the rows that landed, and the board is read from the ledger's tail, never the whole file (review 2026-09-08)", () => {
  assert.deepEqual(latestBoard(), [], "no file yet is an empty board, not a throw");
  assert.deepEqual(tailSignals(), []);
  // Enough cycles that the file is several times the tail (a row is about 850 bytes): only the last ones are parsed.
  // The writer's one log line per cycle is quieted for the loop.
  const CYCLES = 600;
  const first = AT - CYCLES * 60e3;
  let written = 0;
  const log = console.log;
  console.log = () => {};
  try {
    for (let k = 0; k < CYCLES; k++) {
      const at = first + k * 60e3;
      const w = writeSignals(inputs([token(`T${k}A`), token(`T${k}B`, { grade: { grade: "B", capUsd: 100, depthUsd: 400 } })], { at, cycleId: at, decision: { kind: "propose-swap", reason: "base" }, want: { symbol: `T${k}A`, exit: false }, executed: true }));
      assert.deepEqual([w.rows.length, w.strong, w.landed], [2, 1, 2]);
      written += w.landed;
    }
  } finally {
    console.log = log;
  }
  assert.equal(written, 2 * CYCLES);
  const size = statSync(dataPath(SIGNALS_LEDGER)).size;
  assert.ok(size > 3 * TAIL_BYTES, `the file is ${size} bytes, past the tail several times over`);
  const tail = tailSignals();
  assert.ok(tail.length > 2 && tail.length < 2 * CYCLES, `the tail holds some cycles, not all: ${tail.length} rows`);
  const cycles = [...new Set(tail.map((r) => r.cycleId))].sort((a, b) => a - b);
  // The chunk starts mid-row: the oldest cycle in the tail may keep only its later rows; every cycle after it is whole.
  for (const c of cycles.slice(1)) assert.equal(tail.filter((r) => r.cycleId === c).length, 2, "every cycle after the oldest is whole once the partial first line is dropped");
  assert.ok(tail.every((r) => typeof r.stance.kind === "string"), "no half-parsed row");
  const board = latestBoard();
  assert.deepEqual(board.map((r) => r.symbol), ["T599A", "T599B"]);
  assert.deepEqual(board.map((r) => r.strong), [true, false]);
  assert.deepEqual(latestBoardOf(readSignals()).map((r) => r.symbol), ["T599A", "T599B"], "the whole history agrees with the tail");
  assert.equal(readSignals().length, 2 * CYCLES);
  assert.deepEqual(signalsFor("t599a").map((r) => r.symbol), ["T599A"], "a symbol's rows, case-insensitive, from the tail");
  assert.deepEqual(tailSignals(1).length, 0, "a tail of one byte holds no whole row");
});

test("the console lines: one per row, the symbol first, the stance last, no em dash; the board's header counts the strong rows", () => {
  const rows = signalRows(inputs([token("LENNY"), token("OTHER", { grade: { grade: "B", capUsd: 100, depthUsd: 400 }, entry: { ok: false, state: "spike", why: "the top of its run" }, holders: { ...goodHolders, ok: false, why: "one wallet holds 40% of the float" }, launch: null, tape: { buyPressurePct: 41, trend: "rolling over" }, held: true })], { decision: { kind: "propose-swap", reason: "base, entry allowed; swapped 0.01 ETH on chain, settled" }, want: { symbol: "LENNY", exit: false }, executed: true }));
  const lines = signalLines(rows);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "LENNY: grade A, launch lane, depth $900, entry ok (base), holders ok (41 wallets, largest 8%), launch ok (score 72), buyers 63%, tape rising, strong. Took it: base, entry allowed; swapped 0.01 ETH on chain, settled");
  assert.equal(lines[1], "OTHER: grade B, launch lane, depth $400, entry no (spike), holders fail (one wallet holds 40% of the float), launch not read, buyers 41%, tape rolling over, held by the desk. Held: the desk bought LENNY this cycle instead");
  for (const l of lines) assert.ok(!l.includes("—"), "no em dash");
  const board = signalBoardLines(rows);
  assert.equal(board[0], "Board at 14:30Z: 2 tokens, 1 strong.");
  assert.equal(board.length, 3);
  assert.equal(signalBoardLines(rows, 1).length, 2, "n caps the rows");
  assert.deepEqual(signalBoardLines([]), ["No signals yet. The desk writes its board every time it thinks."]);
  assert.equal(SIGNALS_LEDGER, "obs-signals.jsonl");
});

test("the cycle writes the signal rows once, at the top level after the decision block, never inside the auto-entry branch, and the mirror runs after them", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "desk", "cycle.ts"), "utf8");
  const lines = src.split("\n");
  const writer = lines.filter((l) => l.includes("writeSignals("));
  assert.equal(writer.length, 1, "one write per cycle");
  assert.ok(writer[0].startsWith("const signals = writeSignals("), "the write is a top-level statement, not inside any branch, and its landed count is kept");
  assert.ok(src.includes("signals.landed < signals.rows.length"), "a board that did not land in full is said");
  const autoEntry = src.indexOf('(process.env.OBS_AUTO_ENTRY ?? "off") === "on"');
  assert.ok(lines.some((l) => l.startsWith("const heldSet = ")), "what the desk holds is known at the top level, for the pick and the rows alike");
  assert.ok(src.indexOf("const readsFor = ") > autoEntry, "the pick's own structure is built inside the auto-entry branch, the only place that reads it (review 2026-09-08)");
  assert.ok(src.indexOf("autoEntryPick(readsFor)") > autoEntry);
  assert.ok(src.includes("want.failed = r.reason"), "an executor failure is a failure on the want, not a refusal");
  const write = src.indexOf("writeSignals(");
  assert.ok(write > src.indexOf('if (decision.kind === "propose-swap" && decision.from'), "after the decision block");
  assert.ok(write > src.indexOf('console.log("DRY RUN, nothing recorded.")'), "a dry run writes nothing");
  assert.ok(src.indexOf("if (mirror) await mirror();") > write, "the rows land before the mirror");
  assert.ok(!src.includes("await mirrorForFollowers(intent"), "the in-line mirror was deferred, not duplicated");
});

test("the ledger reaches no public route: server.ts imports only the console's read of it", () => {
  const server = readFileSync(join(import.meta.dirname, "..", "src", "server.ts"), "utf8");
  assert.match(server, /import \{ latestBoard, signalBoardLines \} from "\.\/desk\/signalLedger\.ts";/);
  assert.ok(!server.includes("obs-signals"), "the file is never named on the server");
  assert.ok(!server.includes("readSignals(") && !server.includes("SIGNALS_LEDGER"), "the raw rows are never read there");
  const uses = server.split("\n").filter((l) => l.includes("latestBoard(") || l.includes("signalBoardLines("));
  assert.equal(uses.length, 1, "one use, the console's answer");
  assert.ok(uses[0].includes('effect: "signals"'));
});
