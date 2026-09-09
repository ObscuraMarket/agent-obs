import { test } from "node:test";
import assert from "node:assert/strict";
import { basisRow, correctedNote, correctedRow, scaleReceivedClause } from "../src/desk/correction.ts";
import type { Trade } from "../src/desk/book.ts";

// The real history of pool-1788962278285, the 13:57 BYCOCKET exit on 2026-09-09: the chain sold 4,044,006.97
// BYCOCKET for 0.13219099164859882 ETH, of which only 2,760,749.88 was the desk's own lot.
const SWAP = 4_044_006.97;
const DESK = 2_760_749.8811390866;
const OUT = 0.13219099164859882;

const settled = (at: number, note: string, from = SWAP, to = OUT): Trade =>
  ({
    id: "pool-1788962278285",
    at: 1788962278285,
    updatedAt: at,
    status: "settled",
    venue: "pool",
    exit: true,
    settlementTx: "0xb6513e13",
    from: { asset: "BYCOCKET", network: "robinhood", amount: from, usd: 235.38559517 },
    to: { asset: "ETH", network: "robinhood", amount: to, usd: 331.28 },
    note,
  }) as unknown as Trade;

const ORIGINAL = "exit (tape-profit), the trade is up 18%; received 0.13219099164859882 ETH";

test("a correction is built from the row the chain wrote, never from one a correction wrote", () => {
  const first = correctedRow(basisRow([settled(1, ORIGINAL)])!, DESK, "the-desk-owned-part", 100);
  assert.match(first.note!, /68\.27% of the swap/, "the share is the share of the real swap");

  // Running it a second time against a book that now holds the corrected row must not compound the share.
  const again = correctedRow(basisRow([settled(1, ORIGINAL), first])!, DESK, "the-desk-owned-part", 200);
  assert.match(again.note!, /68\.27% of the swap/, "a re-run reports the same true share, not 100%");
  assert.equal(again.to.amount, first.to.amount, "and writes the same amounts: the correction is idempotent");
  assert.equal(again.from.amount, first.from.amount);
});

test("the basis is the newest UNCORRECTED row, so a pending row never outranks the settled one", () => {
  const pending = { ...settled(1, "pending", SWAP, 0.132194524448595), status: "pending" } as Trade;
  const rows = [pending, settled(2, ORIGINAL), settled(3, ORIGINAL)];
  assert.equal(basisRow(rows)?.updatedAt, 3);
  // With nothing uncorrected left, the newest corrected row is better than nothing.
  const onlyCorrected = [settled(9, `${ORIGINAL}; CORRECTED to the desk's own share (68.27% of the swap): x`)];
  assert.equal(basisRow(onlyCorrected)?.updatedAt, 9);
  assert.equal(basisRow([]), null);
});

test("the received clause is narrowed with the row, so a corrected row never contradicts its own amount", () => {
  // This contradiction is what made a correct row read as a 32% bad fill on 2026-09-09.
  const note = correctedNote(settled(1, ORIGINAL), DESK / SWAP, "why");
  const said = Number(/received ([0-9.]+) ETH/.exec(note)![1]);
  const row = correctedRow(settled(1, ORIGINAL), DESK, "why", 1);
  assert.equal(said, row.to.amount, "what the note says was received is what the row carries");
  assert.ok(said < OUT, "and it is the desk's share, not the whole swap");
});

test("a note with no received clause is left alone, and the whole-swap fact still stands", () => {
  const note = correctedNote(settled(1, "exit (floor), down 31.0%"), 0.5, "half-was-the-desk");
  assert.match(note, /CORRECTED to the desk's own share \(50\.00% of the swap\)/);
  assert.match(note, /The chain moved the full amount and 0xb6513e13 still shows it\./);
  assert.equal(scaleReceivedClause("no clause here", 0.5), "no clause here");
});

test("the note is rebuilt from the basis, so an earlier correction's words never carry forward", () => {
  // A note is public: /api/obs/trades serves it whole. Anything said once must be removable.
  const leaky = settled(1, `${ORIGINAL}; CORRECTED to the desk's own share (68.27% of the swap): a-private-reason`);
  const rebuilt = correctedNote(basisRow([settled(2, ORIGINAL), leaky])!, DESK / SWAP, "a-public-reason");
  assert.doesNotMatch(rebuilt, /a-private-reason/);
  assert.match(rebuilt, /a-public-reason/);
});
