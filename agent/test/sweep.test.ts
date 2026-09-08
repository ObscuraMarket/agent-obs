// The follower sweep's pure parts: who needs sweeping, what each leg gets, the correction row, and the throttle.
// A skipped, refused, thrown or redeploy-killed mirrored exit was never retried until 2026-09-08, so a follower
// could be left holding a token the desk had already sold; these are the rules the sweep runs on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepTargets, sweepLeg, sweepDue, sweepMinutes, deskHeldSymbols, correctionEvidence, correctionRow, sweepId, sweepLine, DEFAULT_SWEEP_MIN } from "../src/desk/mirror.ts";
import { liveHoldings, type FollowTradeRow } from "../src/desk/follow.ts";
import type { AgentCapitalRow } from "../src/desk/agentWallet.ts";
import type { Trade, CapitalFlow } from "../src/desk/book.ts";

const A = "0x1111111111111111111111111111111111111111";
const T = 1_788_800_000_000;
const env = {} as NodeJS.ProcessEnv;
const HASH = "0x00000000000000000000000000000000000000000000000000000000000000ab";

test("a token the follower holds and the desk does not is a sweep target; one the desk still holds is not", () => {
  const held = { PENGUIN: 50, DOHJ: 12 };
  // The desk sold PENGUIN and still holds DOHJ: its DOHJ exit is coming, and the mirror will carry it.
  assert.deepEqual(sweepTargets(held, new Set(["DOHJ"])), ["PENGUIN"]);
  assert.deepEqual(sweepTargets(held, ["dohj", "penguin"]), []);
  assert.deepEqual(sweepTargets(held, []), ["DOHJ", "PENGUIN"]);
  // A ledger that holds nothing, or a zero, is nobody's target.
  assert.deepEqual(sweepTargets({}, []), []);
  assert.deepEqual(sweepTargets({ PENGUIN: 0 }, []), []);
});

test("the desk's held tokens are what it bought and still holds on the chain, above dust, base assets aside; a pending sell with a hash is gone", () => {
  const flows: CapitalFlow[] = [{ at: T, kind: "deposit", asset: "ETH", amount: 1, usd: 2500 }];
  const trades: Trade[] = [
    { at: T + 1, id: "d1", status: "settled", from: { asset: "ETH", amount: 0.1, usd: 250 }, to: { asset: "PENGUIN", amount: 1000, usd: 250 }, partner: "pool" },
    { at: T + 2, id: "d2", status: "settled", from: { asset: "ETH", amount: 0.1, usd: 250 }, to: { asset: "DOHJ", amount: 500, usd: 250 }, partner: "pool" },
    // A pending sell of the whole DOHJ, sent (it has its hash), counts as gone: the mirror's exit already ran on it.
    { at: T + 3, id: "d3", status: "pending", exit: true, settlementTx: HASH, from: { asset: "DOHJ", amount: 500, usd: 240 }, to: { asset: "ETH", amount: 0.096, usd: 240 }, partner: "pool" },
    // A full sell of PENGUIN that left a billionth behind is a full sell.
    { at: T + 4, id: "d4", status: "settled", exit: true, from: { asset: "PENGUIN", amount: 999.9999999, usd: 200 }, to: { asset: "ETH", amount: 0.08, usd: 200 }, partner: "pool" },
    { at: T + 5, id: "d5", status: "settled", from: { asset: "ETH", amount: 0.1, usd: 250 }, to: { asset: "LENNY", amount: 300, usd: 250 }, partner: "pool" },
  ];
  const book = { flows, trades };
  const chain = { bySymbol: { ETH: 0.7, PENGUIN: 0.0000001, DOHJ: 500, LENNY: 300, AIRDROP: 5000 } };
  assert.deepEqual([...deskHeldSymbols(book, chain, env)], ["LENNY"], "PENGUIN is dust, DOHJ is on its way out with a hash, AIRDROP was never bought");
  // The same pending sell with no hash yet may never have gone out: the token is still held.
  const unsent = { flows, trades: trades.map((t) => (t.id === "d3" ? { ...t, settlementTx: undefined } : t)) };
  assert.deepEqual([...deskHeldSymbols(unsent, chain, env)], ["DOHJ", "LENNY"]);
  // Phantom dust (review, 2026-09-08): an entry settled at its 1000 estimate and a full sell clamped to the chain's
  // 980 leaves +20 PORT on the book, above dust; the chain says none, and the chain decides.
  const phantom: Trade[] = [
    { at: T + 1, id: "p1", status: "settled", from: { asset: "ETH", amount: 0.1, usd: 250 }, to: { asset: "PORT", amount: 1000, usd: 250 }, partner: "pool" },
    { at: T + 2, id: "p2", status: "settled", exit: true, from: { asset: "PORT", amount: 980, usd: 240 }, to: { asset: "ETH", amount: 0.096, usd: 240 }, partner: "pool" },
  ];
  assert.deepEqual([...deskHeldSymbols({ flows, trades: phantom }, { bySymbol: { ETH: 0.9, PORT: 0 } }, env)], [], "the book's 20 PORT are phantom; the chain holds none");
  assert.deepEqual([...deskHeldSymbols({ flows, trades: phantom }, { bySymbol: { ETH: 0.9, PORT: 20 } }, env)], ["PORT"], "the chain holding 20 is a holding");
  assert.deepEqual(sweepTargets({ PORT: 50 }, deskHeldSymbols({ flows, trades: phantom }, { bySymbol: { ETH: 0.9, PORT: 0 } }, env)), ["PORT"], "so a follower's 50 PORT is a target");
  // A token the chain read did not answer for, or no read at all, is judged by the book as before: unread is unknown, not zero.
  assert.deepEqual([...deskHeldSymbols({ flows, trades: phantom }, { bySymbol: { ETH: 0.9 }, unread: ["PORT@robinhood"] }, env)], ["PORT"]);
  assert.deepEqual([...deskHeldSymbols({ flows, trades: phantom }, { bySymbol: { ETH: 0.9 } }, env)], ["PORT"], "absent from the read: the book");
  assert.deepEqual([...deskHeldSymbols({ flows, trades: phantom }, null, env)], ["PORT"]);
});

test("a wallet holding none of what its ledger says is written off only with evidence: a token withdrawal or a hashless failed exit after the last entry", () => {
  const entry = (id: string, at: number, sym = "PENGUIN"): FollowTradeRow => ({ address: A, deskId: id, at, id, status: "settled", from: { asset: "ETH", amount: 0.004, usd: 10 }, to: { asset: sym, amount: 50, usd: 10 }, partner: "pool", venue: "pool" });
  const rows: FollowTradeRow[] = [entry("d1", T)];
  const withdraw = (at: number, over: Partial<AgentCapitalRow> = {}): AgentCapitalRow => ({ address: A, at, kind: "withdraw-token", asset: "PENGUIN", amount: 50, usd: 10, txHash: HASH, ...over });
  assert.equal(correctionEvidence([], rows, A, "PENGUIN"), null, "a balance of zero alone is no evidence");
  assert.match(correctionEvidence([withdraw(T + 100)], rows, A, "PENGUIN")!, /^withdrawn as a token at/);
  assert.equal(correctionEvidence([withdraw(T - 100)], rows, A, "PENGUIN"), null, "a withdrawal before the entry explains nothing about this holding");
  assert.equal(correctionEvidence([withdraw(T + 100, { asset: "DOHJ" })], rows, A, "PENGUIN"), null, "another token's withdrawal");
  assert.equal(correctionEvidence([withdraw(T + 100, { address: "0x2222222222222222222222222222222222222222" })], rows, A, "PENGUIN"), null, "another wallet's withdrawal");
  assert.match(correctionEvidence([withdraw(T - 100, { landedAt: T + 100 })], rows, A, "PENGUIN")!, /withdrawn/, "placed by when it landed");
  const failedExit = (at: number, over: Partial<Trade> = {}): FollowTradeRow => ({ address: A, deskId: "d2", at, id: "x1", status: "failed", exit: true, from: { asset: "PENGUIN", amount: 50, usd: 12 }, to: { asset: "ETH", amount: 0.005, usd: 12 }, partner: "pool", venue: "pool", ...over });
  assert.match(correctionEvidence([], [...rows, failedExit(T + 50)], A, "penguin")!, /never got its hash and is failed on the book/);
  assert.equal(correctionEvidence([], [...rows, failedExit(T + 50, { settlementTx: HASH })], A, "PENGUIN"), null, "a reverted exit (a hash, failed) leaves the token in the wallet: no evidence");
  assert.equal(correctionEvidence([], [...rows, failedExit(T - 50)], A, "PENGUIN"), null, "an exit failed before this entry is not this holding's");
  // The ledger's latest row per id decides: an exit later settled with a hash is not the hashless failure it once was.
  assert.equal(correctionEvidence([], [...rows, failedExit(T + 50), failedExit(T + 50, { status: "settled", settlementTx: HASH, updatedAt: T + 60 })], A, "PENGUIN"), null);
});

test("a follower's ledger that says held, against the chain: a balance sells, none corrects, none with a buy in flight waits", () => {
  assert.equal(sweepLeg(50, false, env), "sell");
  assert.equal(sweepLeg(50, true, env), "sell");
  // The wallet holds nothing, or dust: /sell by hand or /withdraw SYMBOL emptied it, and the ledger is corrected.
  assert.equal(sweepLeg(0, false, env), "correct");
  assert.equal(sweepLeg(1e-9, false, env), "correct");
  // A pending entry row: the token may still be on its way, so nothing is written off yet.
  assert.equal(sweepLeg(0, true, env), "wait");
});

test("the correction row makes liveHoldings stop reporting the token, and prices nothing", () => {
  const rows: FollowTradeRow[] = [
    { address: A, deskId: "d1", at: T, id: "pool-1", status: "settled", from: { asset: "ETH", amount: 0.004, usd: 10 }, to: { asset: "PENGUIN", amount: 50, usd: 10 }, partner: "pool", venue: "pool" },
    { address: A, deskId: "d2", at: T + 1, id: "pool-2", status: "settled", from: { asset: "ETH", amount: 0.004, usd: 10 }, to: { asset: "DOHJ", amount: 20, usd: 10 }, partner: "pool", venue: "pool" },
  ];
  const before = liveHoldings(rows, A);
  assert.deepEqual(before, { PENGUIN: 50, DOHJ: 20 });
  const id = sweepId("penguin", T + 100);
  assert.equal(id, `sweep-PENGUIN-${T + 100}`);
  const row = correctionRow("PENGUIN", before.PENGUIN, id, "the wallet holds none", T + 100);
  assert.equal(row.status, "settled");
  assert.equal(row.exit, true);
  assert.equal(row.from.amount, 50);
  assert.equal(row.to.amount, 0);
  assert.equal(row.from.usd, null);
  assert.equal(row.to.usd, null);
  const after = liveHoldings([...rows, { ...row, address: A, deskId: id }], A);
  assert.deepEqual(after, { DOHJ: 20 });
  // And with the token gone from the ledger, it is no longer a target, whatever the desk holds.
  assert.deepEqual(sweepTargets(after, []), ["DOHJ"]);
});

test("the throttle: due with no stamp, not within the window, due again after it; zero means every cycle", () => {
  assert.equal(sweepDue(null, T, 5), true);
  assert.equal(sweepDue(T - 60e3, T, 5), false);
  assert.equal(sweepDue(T - 5 * 60e3, T, 5), true);
  assert.equal(sweepDue(T - 60e3, T, 0), true);
  // A stamp from the future (a clock set back) never blocks a sweep.
  assert.equal(sweepDue(T + 3600e3, T, 5), true);
  assert.equal(sweepDue(Number.NaN, T, 5), true);
  assert.equal(sweepMinutes({} as NodeJS.ProcessEnv), DEFAULT_SWEEP_MIN);
  assert.equal(sweepMinutes({ OBS_FOLLOW_SWEEP_MIN: "15" } as NodeJS.ProcessEnv), 15);
  assert.equal(sweepMinutes({ OBS_FOLLOW_SWEEP_MIN: "0" } as NodeJS.ProcessEnv), 0);
  assert.equal(sweepMinutes({ OBS_FOLLOW_SWEEP_MIN: "-3" } as NodeJS.ProcessEnv), DEFAULT_SWEEP_MIN);
  assert.equal(sweepMinutes({ OBS_FOLLOW_SWEEP_MIN: "soon" } as NodeJS.ProcessEnv), DEFAULT_SWEEP_MIN);
});

test("the sweep's log line carries the counts, or why it did not run", () => {
  assert.equal(sweepLine({ skipped: "throttled", followers: 0, targets: 0, sold: 0, corrected: 0, waited: 0, failed: 0 }), "[follow] sweep skipped: throttled");
  assert.equal(sweepLine({ skipped: null, followers: 3, targets: 1, sold: 1, corrected: 0, waited: 0, failed: 0 }), "[follow] sweep: 3 followers checked, 1 target, 1 sold, 0 corrected, 0 waiting, 0 failed");
});
