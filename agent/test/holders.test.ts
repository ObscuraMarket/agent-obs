import { test } from "node:test";
import assert from "node:assert/strict";
import { balancesFrom, holderRead, holdersLine, holderRulesFromEnv, holderReadFromList, explorerHolderCount, withoutWalletCount, type TransferRow, type ExplorerHolder, type HolderRead } from "../src/desk/holders.ts";

const R = holderRulesFromEnv({} as NodeJS.ProcessEnv);

test("a token with days of trading is read from the explorer's holder list: contracts set aside, people counted, no first buyers asked", () => {
  // 69 on 2026-09-06: the transfer scan reached back hours and saw 0 wallets; the explorer knows 412 holders.
  const list: ExplorerHolder[] = [
    { address: "0xp00l000000000000000000000000000000000001", isContract: true, balance: 400_000_000 },
    { address: "0x1ock000000000000000000000000000000000002", isContract: true, balance: 150_000_000 },
    { address: "0xaaaa000000000000000000000000000000000003", isContract: false, balance: 60_000_000 },
    { address: "0xbbbb000000000000000000000000000000000004", isContract: false, balance: 40_000_000 },
    { address: "0xcccc000000000000000000000000000000000005", isContract: false, balance: 30_000_000 },
    ...Array.from({ length: 12 }, (_, i) => ({ address: `0xdddd0000000000000000000000000000000000${(10 + i).toString(16)}`, isContract: false, balance: 10_000_000 })),
  ];
  const rules = holderRulesFromEnv({ OBS_HOLDERS_MAX_TOP1_PCT: "50", OBS_HOLDERS_MAX_TOP10_PCT: "97" } as NodeJS.ProcessEnv);
  const h = holderReadFromList(list, 412, "SIXTYNINE", "0x69", 1_788_650_000_000, rules);
  assert.equal(h.ok, true, h.why);
  assert.equal(h.wallets, 412);
  assert.ok(Math.abs((h.top1Pct as number) - 24) < 0.5, `the largest wallet among people: ${h.top1Pct}`);
  assert.ok((h.top10Pct as number) < 97);
  assert.equal(h.bundlePct, null, "the first buyers are a launch-day question");
  assert.match(h.why, /412 wallets by the explorer/);
  assert.match(h.why, /2 contracts among the largest holders set aside/);
  const few = holderReadFromList(list.slice(0, 4), 12, "SIXTYNINE", "0x69", 1_788_650_000_000, rules);
  assert.equal(few.ok, false);
  assert.match(few.why, /12 wallets \(30 needed\); the largest wallet holds 60%/);
});

test("the explorer's holder count is read whichever name its API gives it, and a floor from the list under the bar is unknown, not a fail", () => {
  // 2026-09-06: the explorer's token record moved from `holders` to `holders_count`; every survivor read as 0 wallets and nothing was bought.
  assert.equal(explorerHolderCount({ holders_count: 785 }), 785);
  assert.equal(explorerHolderCount({ holders: "412" }), 412);
  assert.equal(explorerHolderCount({ holders_count: "0" }), null, "zero is no count");
  assert.equal(explorerHolderCount(null), null);
  const rules = holderRulesFromEnv({ OBS_HOLDERS_MAX_TOP1_PCT: "50", OBS_HOLDERS_MAX_TOP10_PCT: "97" } as NodeJS.ProcessEnv);
  const list: ExplorerHolder[] = Array.from({ length: 20 }, (_, i) => ({ address: `0xeeee0000000000000000000000000000000000${(10 + i).toString(16)}`, isContract: false, balance: 1_000_000 }));
  const floor = holderReadFromList(list, 20, "WHLR", "0x2e", 1_788_650_000_000, rules, [], true);
  assert.equal(floor.ok, true, floor.why);
  assert.match(floor.why, /at least 20 wallets by the explorer/);
  const exact = holderReadFromList(list, 20, "WHLR", "0x2e", 1_788_650_000_000, rules, [], false);
  assert.equal(exact.ok, false, "the same twenty, known to be all of them, is under the bar");
});

test("when the explorer refuses, a transfer scan's wallet count is not a verdict on a token with days of trading", () => {
  // RWAPACT, 2026-09-06 11:35Z: the explorer answered 403; the scan of recent transfers saw 17 wallets move and the gate failed a token with 280 holders.
  const base: HolderRead = { symbol: "RWAPACT", token: "0x4b", at: 1, transfers: 40, wallets: 17, top1Pct: 10, top10Pct: 60, earlyBuyers: 0, earlySameBlock: 0, earlySameSize: 0, bundlePct: null, freshTop10: null, infra: [], ok: false, why: "17 wallets (30 needed)" };
  const r = withoutWalletCount(base, "the explorer answered 403; read from recent transfers");
  assert.equal(r.ok, true, r.why);
  assert.match(r.why, /wallet count not read \(the explorer answered 403; read from recent transfers\); largest 10%, top ten 60%/);
  const concentrated = withoutWalletCount({ ...base, top1Pct: 70, why: "17 wallets (30 needed); the largest wallet holds 70% (50% allowed)" }, "the explorer answered 403; read from recent transfers");
  assert.equal(concentrated.ok, false, "a real concentration failure still stands");
  assert.match(concentrated.why, /^the largest wallet holds 70% \(50% allowed\) \(the explorer answered 403/);
  const fine = withoutWalletCount({ ...base, ok: true, wallets: 45, why: "45 wallets, largest 10%" }, "note");
  assert.equal(fine.ok, true);
  assert.match(fine.why, /45 wallets, largest 10% \(note\)/);
});
const now = 1_800_000_000_000;
const POOL = "0xpool";
const TOKEN = "0xtoken";
const ZERO = "0x0000000000000000000000000000000000000000";
let n = 0;
const t = (from: string, to: string, amount: number, block: number, at = now - 3600e3 + block * 100): TransferRow => ({ at, block, tx: `tx${n++}:0`, from, to, amount });

/** A clean launch: the mint to the pool, then buyers arriving over minutes in varied sizes. */
function cleanLaunch(): TransferRow[] {
  const rows = [t(ZERO, POOL, 1_000_000, 0)];
  for (let i = 0; i < 40; i++) rows.push(t(POOL, `0xw${i}`, 1000 + i * 37, 10 + i * 40));
  return rows;
}

test("balances follow the transfers, and the mint source is not a holder", () => {
  const b = balancesFrom([t(ZERO, POOL, 100, 0), t(POOL, "0xa", 30, 1), t(POOL, "0xb", 20, 2), t("0xa", "0xb", 10, 3)]);
  assert.equal(b.get(POOL), 50);
  assert.equal(b.get("0xa"), 20);
  assert.equal(b.get("0xb"), 30);
  assert.equal(b.has(ZERO), false);
});

test("a clean launch reads as many wallets, low concentration and no bundle", () => {
  const h = holderRead(cleanLaunch(), "TOK", TOKEN, now, R, [POOL]);
  assert.equal(h.ok, true, h.why);
  assert.equal(h.wallets, 40);
  assert.ok((h.top1Pct as number) < 5);
  assert.ok((h.top10Pct as number) < 35);
  assert.equal(h.bundlePct, 0, "no shared blocks, no identical sizes");
  assert.match(holdersLine(h), /HOLDERS OK/);
});

test("a bundle: many buyers in one block in identical sizes inside the first seconds", () => {
  const rows = [t(ZERO, POOL, 1_000_000, 0, now)];
  for (let i = 0; i < 12; i++) rows.push(t(POOL, `0xb${i}`, 5000, 2, now + 200));
  for (let i = 0; i < 25; i++) rows.push(t(POOL, `0xw${i}`, 900 + i * 13, 500 + i * 60, now + 50_000 + i * 6000));
  const h = holderRead(rows, "TOK", TOKEN, now + 300_000, R, [POOL]);
  assert.equal(h.ok, false);
  assert.match(h.why, /bundled/);
  assert.equal(h.earlyBuyers, 12);
  assert.equal(h.earlySameBlock, 12);
  assert.equal(h.bundlePct, 100);
});

test("one hand: a wallet holding most of circulating fails the read, and the busiest sender is treated as the pool even when unnamed", () => {
  const rows = [t(ZERO, POOL, 1_000_000, 0), t(POOL, "0xwhale", 300_000, 5)];
  for (let i = 0; i < 35; i++) rows.push(t(POOL, `0xw${i}`, 500, 10 + i * 40));
  const named = holderRead(rows, "TOK", TOKEN, now, R, [POOL]);
  assert.equal(named.ok, false);
  assert.match(named.why, /largest wallet holds 9[0-9]%/);
  const unnamed = holderRead(rows, "TOK", TOKEN, now, R, []);
  assert.equal(unnamed.wallets, named.wallets, "the busiest sender is set aside on its own");
});

test("fresh wallets among the top ten count against the token when their transaction counts are known", () => {
  const rows = cleanLaunch();
  const counts = new Map<string, number>();
  for (let i = 30; i < 40; i++) counts.set(`0xw${i}`, i < 38 ? 1 : 50);
  const h = holderRead(rows, "TOK", TOKEN, now, R, [POOL], counts);
  assert.equal(h.freshTop10, 8);
  assert.equal(h.ok, false);
  assert.match(h.why, /8 of the top ten wallets are fresh/);
  assert.equal(holderRead(rows, "TOK", TOKEN, now, R, [POOL], null).freshTop10, null, "unread counts are not a verdict");
});

test("too few wallets is a fail, and an empty read says so", () => {
  const rows = [t(ZERO, POOL, 1000, 0), t(POOL, "0xa", 10, 1), t(POOL, "0xb", 10, 2)];
  const h = holderRead(rows, "TOK", TOKEN, now, R, [POOL]);
  assert.match(h.why, /2 wallets \(30 needed\)/);
  assert.match(holdersLine(holderRead([], "TOK", TOKEN, now, R)), /not read yet/);
});
