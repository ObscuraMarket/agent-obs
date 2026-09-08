import { test } from "node:test";
import assert from "node:assert/strict";
import { followerSettle, receivedFromLogs, settleFollowers, type FollowTradeRow, type FollowerSettleDeps } from "../src/desk/follow.ts";
import { checkRails, railsFromEnv, type Intent, type RailContext } from "../src/desk/rails.ts";
import { resolveAsset } from "../src/desk/assets.ts";
import { INTENT_STALE_MIN, type Trade } from "../src/desk/book.ts";
import type { ReceiptRead } from "../src/desk/signer.ts";

// A follower row the mirror could not wait for stayed pending for good, and one without a hash rode as a token on
// its way forever; both PORT entry rows settled thirteen minutes late only because a later leg rewrote them
// (audit, 2026-09-08). These are the decisions the settle pass makes for every agent's row.
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "0x5555555555555555555555555555555555555555";
const HASH = "0x00000000000000000000000000000000000000000000000000000000000000ab" as const;
const T = Date.UTC(2026, 8, 8, 12, 0);
const min = (n: number) => n * 60_000;

const pad = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const transfer = (token: string, from: string, to: string, raw: bigint) => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: `0x${raw.toString(16).padStart(64, "0")}` });
const POOL = "0x9999999999999999999999999999999999999999";

const pending = (over: Partial<Trade> = {}): Trade => ({ at: T, id: "pool-1", status: "pending", venue: "pool", from: { asset: "ETH", network: "robinhood", amount: 0.04, usd: 100 }, to: { asset: "PORT", network: "robinhood", amount: 1000, usd: 100 }, partner: "pool", note: "ETH/USDG then PORT/USDG on chain; expected 1000 PORT", ...over });
const receipt = (status: ReceiptRead["status"], logs: ReceiptRead["logs"] = []): ReceiptRead => ({ status, from: AGENT, logs });
const token = { contract: TOKEN, decimals: 18 };

test("what a wallet received is the sum of the token's Transfer logs to it, and nothing else in the receipt", () => {
  const logs = [
    transfer(TOKEN, POOL, AGENT, 990n * 10n ** 18n),
    transfer(TOKEN, POOL, B, 5n * 10n ** 18n),
    transfer("0x4444444444444444444444444444444444444444", POOL, AGENT, 7n * 10n ** 18n),
    { address: TOKEN, topics: ["0x1234"], data: "0x01" },
  ];
  assert.equal(receivedFromLogs(logs, TOKEN, AGENT, 18), 990, "the other wallet's transfer and the other token's are not this wallet's");
  assert.equal(receivedFromLogs(logs, TOKEN.toUpperCase(), AGENT.toUpperCase(), 18), 990, "case never decides");
  assert.equal(receivedFromLogs([], TOKEN, AGENT, 18), null, "no log, no claim: the estimate stands");
  assert.equal(receivedFromLogs([transfer(TOKEN, POOL, AGENT, 1n), transfer(TOKEN, POOL, AGENT, 2n)], TOKEN, AGENT, 0), 3, "two transfers add up");
});

test("a row with a hash settles from its receipt with what arrived, and fails on a revert", () => {
  const t = pending({ settlementTx: HASH, updatedAt: T + min(1) });
  const settled = followerSettle(t, receipt("success", [transfer(TOKEN, POOL, AGENT, 987n * 10n ** 18n)]), T + min(5), token)!;
  assert.equal(settled.status, "settled");
  assert.equal(settled.to.amount, 987, "the logs, not the estimate");
  assert.equal(settled.to.usd, 98.7, "the dollar leg follows the amount at the row's price");
  assert.equal(settled.updatedAt, T + min(5), "the later row wins by time");
  assert.match(settled.note ?? "", /landed, received 987 PORT$/);
  const asEstimated = followerSettle(t, receipt("success"), T + min(5), token)!;
  assert.deepEqual([asEstimated.status, asEstimated.to.amount], ["settled", 1000], "no Transfer log to the wallet: settled at the estimate, and the note says so");
  assert.match(asEstimated.note ?? "", /amount as estimated/);
  const ethLeg = followerSettle(pending({ settlementTx: HASH, exit: true, from: { asset: "PORT", amount: 500, usd: 50 }, to: { asset: "ETH", amount: 0.02, usd: 50 } }), receipt("success"), T + min(5), null)!;
  assert.deepEqual([ethLeg.status, ethLeg.to.amount], ["settled", 0.02], "an ETH leg has no Transfer log; the estimate stands");
  const failed = followerSettle(t, receipt("reverted"), T + min(5), token)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.note ?? "", /reverted on chain$/);
  assert.equal(failed.settlementTx, HASH, "the hash stays on the failed row");
  assert.equal(followerSettle(t, null, T + min(5), token), null, "a hash with no receipt yet is left for the next pass");
});

test(`a row without a hash is judged after ${INTENT_STALE_MIN} minutes and left alone before that: the wallet's balance settles an entry, nothing fails it`, () => {
  const t = pending();
  assert.equal(followerSettle(t, null, T + min(INTENT_STALE_MIN) - 1, token), null, "under the allowance the send may still be in flight");
  assert.equal(followerSettle(t, null, T + min(INTENT_STALE_MIN) - 1, token, 990), null, "a balance changes nothing under the allowance");
  const failed = followerSettle(t, null, T + min(INTENT_STALE_MIN), token)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.note ?? "", new RegExp(`no hash was recorded within ${INTENT_STALE_MIN} min of the send`));
  assert.match(failed.note ?? "", /the agent's wallet says whether PORT arrived/);
  assert.equal(followerSettle(t, null, T + min(INTENT_STALE_MIN), token, 0)!.status, "failed", "the wallet holds none: the send never went out");
  assert.equal(followerSettle(t, null, T + min(INTENT_STALE_MIN), token, 1e-9)!.status, "failed", "dust is not a holding");
  // The redeploy case (review, 2026-09-08): the send went out, the process died in the receipt wait, no hash was
  // written, and the token is in the wallet. Settled at what the wallet holds, never above the estimate.
  const landed = followerSettle(t, null, T + min(INTENT_STALE_MIN), token, 990)!;
  assert.deepEqual([landed.status, landed.to.amount, landed.to.usd, landed.settlementTx], ["settled", 990, 99, undefined]);
  assert.match(landed.note ?? "", /landed by the wallet's balance \(990 PORT\), no hash recorded$/);
  assert.equal(followerSettle(t, null, T + min(INTENT_STALE_MIN), token, 1500)!.to.amount, 1000, "more than the estimate in the wallet is not this row's");
  const exit = pending({ exit: true, from: { asset: "PORT", amount: 500, usd: 50 }, to: { asset: "ETH", amount: 0.02, usd: 50 } });
  assert.equal(followerSettle(exit, null, T + min(INTENT_STALE_MIN), null, 0.5)!.status, "failed", "a hashless exit is failed whatever the balance; the sweep judges the token from there");
  assert.equal(followerSettle(pending({ updatedAt: T + min(10) }), null, T + min(20), token), null, "the allowance runs from the row's last writing");
  assert.equal(followerSettle(pending({ status: "settled" }), receipt("success"), T + min(60), token), null, "a settled row is never touched");
  assert.equal(followerSettle(pending({ venue: "obscura" }), null, T + min(60), token), null, "an Obscura order is pending with no hash by design");
});

test("the pass judges each agent's latest rows, writes each agent's own ledger, reads the wallet for a hashless entry, and alerts on one the wallet does not explain", async () => {
  const C = "0x3333333333333333333333333333333333333333";
  const rows: FollowTradeRow[] = [
    // A: the entry's pending row, then its hash; the receipt has landed since.
    { address: A, deskId: "d1", ...pending() },
    { address: A, deskId: "d1", ...pending({ settlementTx: HASH, updatedAt: T + min(1) }) },
    // B: the same id in another wallet's ledger (the desk's clock, another process), never given a hash, and the wallet holds none.
    { address: B, deskId: "d1", ...pending() },
    // B: an exit that already settled, not touched.
    { address: B, deskId: "d2", ...pending({ id: "pool-2", status: "settled", settlementTx: HASH, exit: true }) },
    // C: already holds 200 PORT from an earlier landed entry; the hashless second entry is judged by what is above that.
    { address: C, deskId: "d0", ...pending({ id: "pool-0", status: "settled", settlementTx: HASH, at: T - min(60), to: { asset: "PORT", network: "robinhood", amount: 200, usd: 20 } }) },
    { address: C, deskId: "d1", ...pending() },
  ];
  const written: Array<[string, string, Trade]> = [];
  const notes: Array<[string, string, string]> = [];
  const alerts: Array<[string, string]> = [];
  const asked: string[] = [];
  const balances: Array<[string, string]> = [];
  const deps: FollowerSettleDeps = {
    rows: () => rows,
    receipt: async (hash) => { asked.push(hash); return receipt("success", [transfer(TOKEN, POOL, AGENT, 990n * 10n ** 18n)]); },
    tokenOf: (s) => (s === "PORT" ? token : null),
    balance: async (address, t) => { balances.push([address, t.contract]); return address === C ? 1180 : 0; },
    write: (address, deskId, t) => { written.push([address, deskId, t]); return true; },
    note: (address, deskId, note) => { notes.push([address, deskId, note]); },
    alert: async (text, _now, key) => { alerts.push([key, text]); },
  };
  const out = await settleFollowers(T + min(20), deps);
  assert.deepEqual(asked, [HASH], "one receipt read, for the row that has a hash");
  assert.deepEqual(balances, [[B, TOKEN], [C, TOKEN]], "one balance read per hashless entry past the allowance, none for a row with a hash");
  assert.deepEqual(written.map(([a, d, t]) => [a, d, t.status, t.to.amount]), [[A, "d1", "settled", 990], [B, "d1", "failed", 1000], [C, "d1", "settled", 980]], "C's 1180 less the 200 its ledger already held is this entry's 980");
  assert.deepEqual(notes.map(([a, d]) => [a, d]), [[B, "d1"], [C, "d1"]], "the rows that never got their hash are notes, settled or failed");
  assert.match(notes[0][2], /entry of PORT never got its hash within 15 min and is failed on the book/);
  assert.match(notes[1][2], /never got its hash within 15 min, but the wallet holds 980 PORT: settled from the balance/);
  assert.deepEqual(alerts.map(([k]) => k), [`${B} PORT`], "the operator hears of the one failed with nothing in the wallet, keyed by wallet and token, as the desk's own settle alerts");
  assert.match(alerts[0][1], /never got its hash and the wallet holds none of it/);
  assert.deepEqual(out.map((t) => [t.address, t.id, t.status]), [[A, "pool-1", "settled"], [B, "pool-1", "failed"], [C, "pool-1", "settled"]]);
  // A receipt read that throws leaves the row for the next pass and never stops the others; so does a balance read.
  const out2 = await settleFollowers(T + min(20), { ...deps, receipt: async () => { throw new Error("rpc down"); } });
  assert.deepEqual(out2.map((t) => [t.address, t.status]), [[B, "failed"], [C, "settled"]]);
  const out3 = await settleFollowers(T + min(20), { ...deps, balance: async () => { throw new Error("rpc down"); } });
  assert.deepEqual(out3.map((t) => [t.address, t.status]), [[A, "settled"]], "a hashless entry whose balance could not be read waits, still pending and still visible to the exit");
});

// OBS_TRADING=off is the operator's brake on the house book. Until 2026-09-08 it also refused every follower
// exit and every /sell, so a person's money could not leave a token while the desk was paused.
test("with trading off an exit signed by an agent wallet passes the rails, and the desk's own exit is still refused", () => {
  const ETH = resolveAsset("ETH@robinhood")!;
  const port = { ...resolveAsset("USDG@robinhood")!, symbol: "PORT", contract: TOKEN, candidate: { poolId: "0x", tierPct: 1, tickSpacing: 200, usdgIs0: false } } as unknown as Intent["from"];
  const off = railsFromEnv({ OBS_TRADING: "off", OBS_CANDIDATES: "on" } as NodeJS.ProcessEnv);
  const on = railsFromEnv({ OBS_TRADING: "on", OBS_CANDIDATES: "on" } as NodeJS.ProcessEnv);
  const exit: Intent = { from: port, to: ETH, amount: 500, usd: 50, exit: true };
  const entry: Intent = { from: ETH, to: port, amount: 0.01, usd: 25 };
  const ctx = (over: Partial<RailContext>): RailContext => ({ rails: off, balances: { "PORT@robinhood": 500, "ETH@robinhood": 0.05 }, nativeOnFromChain: 0.05, openOrders: 0, ...over });
  assert.deepEqual(checkRails(exit, ctx({ runAs: true })), { ok: true }, "a follower's exit, or a /sell, leaves whatever the desk's switch says");
  assert.match((checkRails(exit, ctx({})) as { ok: false; reason: string }).reason, /trading is off/, "the desk's own exit is the operator's to hold");
  assert.match((checkRails(exit, ctx({ runAs: false })) as { ok: false; reason: string }).reason, /trading is off/);
  assert.match((checkRails(entry, ctx({ runAs: true })) as { ok: false; reason: string }).reason, /trading is off/, "an agent wallet's entry is still refused: nothing new is opened while the desk is paused");
  assert.deepEqual(checkRails(exit, ctx({ rails: on })), { ok: true }, "with trading on nothing changes for the desk");
  assert.match((checkRails({ ...exit, amount: 600 }, ctx({ runAs: true })) as { ok: false; reason: string }).reason, /holds 500/, "the other rails still stand for an agent wallet's exit");
});
