import { test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { sendSwap, type SendLane, type SendJob } from "../src/desk/onchain.ts";
import { resolveAsset } from "../src/desk/assets.ts";
import { intentTimedOut, latestTrades, boughtSymbols, holdingsFrom, costBasis, INTENT_STALE_MIN, type Trade } from "../src/desk/book.ts";
import { appendLedger, ledgerWriteFailures } from "../src/ledger.ts";
import { dataPath } from "../src/config.ts";

// Money moved on chain before any row existed: until 2026-09-08 the lane sent the swap, waited up to two minutes
// for the receipt, and only then wrote the row. A process that died in between left the token in the wallet with
// no row, and the exit scan sells only what the ledger says was bought. The rows here are what the lane writes now.
const ETH = resolveAsset("ETH@robinhood")!;
const NVDA = resolveAsset("NVDA@robinhood")!;
const T = Date.UTC(2026, 8, 8, 12, 0);
const HASH = "0x00000000000000000000000000000000000000000000000000000000000000ab" as const;
// A throwaway key for the lane's wallet slot; nothing here signs, and the fake lane never reads it.
const account = privateKeyToAccount(generatePrivateKey());

const base = (): Trade => ({ at: T, id: "pool-1", status: "pending", venue: "pool", from: { asset: "ETH", network: "robinhood", amount: 0.04, usd: 100 }, to: { asset: "NVDA", network: "robinhood", amount: 0.5, usd: 100 }, partner: "pool", note: "ETH/USDG then NVDA/USDG on chain; expected 0.5 NVDA, floor 0.495" });
const job = (rows: Trade[], log: string[], recordOk = true): SendJob => ({
  intent: { from: ETH, to: NVDA, amount: 0.04, usd: 100 },
  base: base(),
  tx: { to: "0x0000000000000000000000000000000000000001", data: "0x", value: 4n * 10n ** 16n },
  quote: { amountOut: 0.5, amountOutRaw: 5n * 10n ** 17n, priceOutUsd: 200 },
  address: account.address,
  ethUsd: 2500,
  now: T,
  runAs: { wallet: { address: account.address, account }, record: (t) => { rows.push(t); log.push(`record ${t.status}${t.settlementTx ? " with hash" : " no hash"}`); return recordOk; } },
});
const lane = (log: string[], over: Partial<SendLane> = {}): SendLane => {
  let reads = 0;
  return {
    send: async () => { log.push("send"); return HASH; },
    wait: async () => { log.push("wait"); return { status: "success", gasCostWei: 0n }; },
    // Before the send the wallet holds none; after it, the half NVDA the quote promised.
    balance: async () => (reads++ === 0 ? 0n : 5n * 10n ** 17n),
    alert: async (kind) => { log.push(`alert ${kind}`); return true; },
    clock: () => T + 90e3,
    ...over,
  };
};

test("the row is on the book before the send, and the same id is written again with the hash and the outcome", async () => {
  const rows: Trade[] = [];
  const log: string[] = [];
  const r = await sendSwap(job(rows, log), lane(log));
  assert.deepEqual(log, ["record pending no hash", "send", "wait", "record settled with hash"], "the ledger sees the swap before the chain does");
  assert.ok(r.ok);
  const [intent, settled] = rows;
  assert.deepEqual([intent.id, intent.status, intent.settlementTx ?? null, intent.at], ["pool-1", "pending", null, T]);
  assert.match(intent.note ?? "", /no hash yet$/);
  assert.deepEqual([settled.id, settled.status, settled.settlementTx, settled.to.amount, settled.to.usd], ["pool-1", "settled", HASH, 0.5, 100]);
  assert.ok((settled.updatedAt as number) > settled.at, "the later row stamps its update, so it wins by time and not by luck of append order");
  assert.deepEqual(latestTrades(rows).map((t) => t.status), ["settled"], "one trade on the book, its latest row");
  // The crash the row is for: the process dies after the send and only the first row is ever written. The token is
  // still known as bought, so the exit scan will find it in the wallet, and the ETH that left rides in flight.
  assert.ok(boughtSymbols([intent]).has("NVDA"));
  assert.equal(holdingsFrom([{ at: 1, kind: "deposit", asset: "ETH", amount: 1, usd: 2500 }], [intent]).ETH, 0.96);
  assert.deepEqual(costBasis([{ at: 1, kind: "deposit", asset: "ETH", amount: 1, usd: 2500 }], [intent]).inFlight.map((f) => [f.id, f.usd]), [["pool-1", 100]]);
});

test("a send that throws is written again as failed with the reason, and a failed row moves nothing", async () => {
  const rows: Trade[] = [];
  const log: string[] = [];
  const r = await sendSwap(job(rows, log), lane(log, { send: async () => { log.push("send"); throw new Error("nonce too low"); } }));
  assert.deepEqual(log, ["record pending no hash", "send", "record failed no hash"]);
  assert.deepEqual([r.ok, "reason" in r ? r.reason : null], [false, "not sent: nonce too low"]);
  assert.equal(latestTrades(rows)[0].status, "failed");
  assert.equal(boughtSymbols(rows).size, 0, "nothing was bought");
  assert.deepEqual(holdingsFrom([{ at: 1, kind: "deposit", asset: "ETH", amount: 1, usd: 2500 }], rows), { ETH: 1 }, "the ETH never left");
});

test("no receipt in time leaves the row pending with its hash; a revert fails it with its hash", async () => {
  const rows: Trade[] = [];
  const log: string[] = [];
  const r = await sendSwap(job(rows, log), lane(log, { wait: async () => null }));
  assert.ok(r.ok);
  assert.deepEqual(rows.map((t) => [t.status, t.settlementTx ?? null]), [["pending", null], ["pending", HASH]]);
  assert.equal(latestTrades(rows)[0].settlementTx, HASH, "the hashed row is the one the settle pass will find");
  const reverted: Trade[] = [];
  const r2 = await sendSwap(job(reverted, []), lane([], { wait: async () => ({ status: "reverted", gasCostWei: 0n }) }));
  assert.equal(r2.ok, false);
  assert.deepEqual(reverted.map((t) => [t.status, t.settlementTx ?? null]), [["pending", null], ["failed", HASH]]);
});

test("a row the ledger did not take raises the cycle alarm, and the swap still returns", async () => {
  const rows: Trade[] = [];
  const log: string[] = [];
  const r = await sendSwap(job(rows, log, false), lane(log));
  assert.ok(r.ok);
  assert.deepEqual(log, ["record pending no hash", "alert cycle", "send", "wait", "record settled with hash", "alert cycle"]);
});

test("a pool row pending with no hash is failed after the allowance, never settled, and an Obscura order is not judged", () => {
  const intent: Trade = { ...base(), id: "pool-2" };
  assert.equal(intentTimedOut(intent, T + (INTENT_STALE_MIN - 1) * 60e3), false, "the lane may still be waiting for its receipt");
  assert.equal(intentTimedOut(intent, T + INTENT_STALE_MIN * 60e3), true, "past it, the send did not come back");
  assert.equal(intentTimedOut({ ...intent, settlementTx: HASH }, T + 3600e3), false, "a hash means a receipt to wait for");
  assert.equal(intentTimedOut({ ...intent, venue: undefined }, T + 3600e3), false, "an Obscura order carries no settlement hash until it settles");
  assert.equal(intentTimedOut({ ...intent, status: "settled" }, T + 3600e3), false);
  assert.equal(intentTimedOut({ ...intent, status: "failed" }, T + 3600e3), false);
  // The time is the row's latest writing, so a re-appended pending row is measured from that.
  assert.equal(intentTimedOut({ ...intent, updatedAt: T + 10 * 60e3 }, T + 20 * 60e3), false);
  // Failed as the settle pass writes it: off the bought list, nothing in flight.
  const failed: Trade = { ...intent, status: "failed", updatedAt: T + 15 * 60e3 };
  assert.equal(boughtSymbols([intent, failed]).has("NVDA"), false);
  assert.deepEqual(costBasis([], [intent, failed]).inFlight, []);
});

test("a ledger append says whether the row landed, and counts the ones that did not", () => {
  const before = ledgerWriteFailures();
  assert.equal(appendLedger("no-such-dir-for-obs-tests/x.jsonl", { at: 1 }), false);
  assert.equal(ledgerWriteFailures(), before + 1);
  const file = `obs-test-ledger-${process.pid}.jsonl`;
  try {
    assert.equal(appendLedger(file, { at: 1 }), true);
    assert.equal(ledgerWriteFailures(), before + 1, "a row that landed is not a failure");
  } finally {
    try { unlinkSync(dataPath(file)); } catch { /* nothing to clean */ }
  }
});
