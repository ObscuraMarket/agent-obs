import { test } from "node:test";
import assert from "node:assert/strict";
import { balancesFrom, holderRead, holdersLine, holderRulesFromEnv, type TransferRow } from "../src/desk/holders.ts";

const R = holderRulesFromEnv({} as NodeJS.ProcessEnv);
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
