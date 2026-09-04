import { test } from "node:test";
import assert from "node:assert/strict";
import { walletTrades, walletRecords, walletsLine } from "../src/desk/wallets.ts";
import type { TransferRow } from "../src/desk/holders.ts";
import type { SwapRow } from "../src/desk/tape.ts";

const POOL = "0xpool";
const infra = new Set([POOL]);
const swap = (hash: string, side: "buy" | "sell", quote: number): SwapRow => ({ at: 1, block: 1, tx: `${hash}:3`, side, tokenAmount: 1, quoteAmount: quote, price: 1 });
const xfer = (hash: string, from: string, to: string, amount: number): TransferRow => ({ at: 1, block: 1, tx: `${hash}:1`, from, to, amount });

test("a wallet's buys and sells are priced by the swap in the same transaction, and unmatched transfers are ignored", () => {
  const trades = walletTrades(
    [xfer("0xa", POOL, "0xw1", 1000), xfer("0xb", "0xw1", POOL, 400), xfer("0xc", "0xw1", "0xw2", 100), xfer("0xd", POOL, "0xw3", 50)],
    [swap("0xa", "buy", 10), swap("0xb", "sell", 8)],
    infra, "TOK", "0xTOKEN", 1,
  );
  assert.deepEqual(trades.map((t) => [t.wallet, t.side, t.usd]), [["0xw1", "buy", 10], ["0xw1", "sell", 8]]);
  assert.equal(trades[0].token, "0xtoken", "tokens are lowercased");
  const priced = walletTrades([xfer("0xa", POOL, "0xw1", 1000)], [swap("0xa", "buy", 0.004)], infra, "TOK", "0xT", 2500);
  assert.equal(priced[0].usd, 10, "an ETH-quoted pool prices through the quote");
});

test("records add up across tokens: winners, losers, mixed, and holders who never sold", () => {
  const rows = [
    { at: 1, wallet: "0xw", token: "t1", symbol: "A", side: "buy" as const, tokens: 1, usd: 100, tx: "1" },
    { at: 2, wallet: "0xw", token: "t1", symbol: "A", side: "sell" as const, tokens: 1, usd: 160, tx: "2" },
    { at: 3, wallet: "0xw", token: "t2", symbol: "B", side: "buy" as const, tokens: 1, usd: 50, tx: "3" },
    { at: 4, wallet: "0xw", token: "t2", symbol: "B", side: "sell" as const, tokens: 1, usd: 90, tx: "4" },
    { at: 5, wallet: "0xl", token: "t1", symbol: "A", side: "buy" as const, tokens: 1, usd: 100, tx: "5" },
    { at: 6, wallet: "0xl", token: "t1", symbol: "A", side: "sell" as const, tokens: 1, usd: 30, tx: "6" },
    { at: 7, wallet: "0xl", token: "t2", symbol: "B", side: "buy" as const, tokens: 1, usd: 20, tx: "7" },
    { at: 8, wallet: "0xh", token: "t1", symbol: "A", side: "buy" as const, tokens: 1, usd: 10, tx: "8" },
  ];
  const r = walletRecords(rows);
  assert.equal(r.get("0xw")?.label, "winner");
  assert.equal(r.get("0xw")?.realizedUsd, 100);
  assert.equal(r.get("0xw")?.wins, 2);
  assert.equal(r.get("0xl")?.label, "loser");
  assert.equal(r.get("0xl")?.realizedUsd, -70, "the unsold second token does not count as realized");
  assert.equal(r.get("0xh")?.label, "holder");
  const line = walletsLine("TOK", ["0xw", "0xl", "0xh", "0xnew"], r, "t3");
  assert.match(line, /2 of the top 4 wallets have a record/);
  assert.match(line, /1 repeat winner \(\+\$100 realized across 2 tokens\)/);
  assert.match(line, /1 repeat loser \(-\$70\)/);
  assert.match(walletsLine("TOK", ["0xnew"], r, "t3"), /none of the top 1 wallets has a record/);
});
