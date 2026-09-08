import { test } from "node:test";
import assert from "node:assert/strict";
import { autoEntryPick, autoEntryFor, type AutoEntryReads } from "../src/desk/autoentry.ts";
import { evidenceCheck } from "../src/desk/analysis.ts";

const r = (over: Partial<AutoEntryReads>): AutoEntryReads => ({ symbol: "ZZZ", grade: "B", entryOk: true, entryWhy: "quiet in a 8.9% range for 10 min with the peak 30 min old, buy pressure 57% over the last 10 min: base, entry allowed", holdersRead: true, holdersOk: true, launchRead: true, launchOk: true, held: false, ...over });

test("the reads pick the entry: the first graded, unheld candidate that passed every read", () => {
  assert.equal(autoEntryPick([r({ symbol: "MEME", entryOk: false }), r({ symbol: "ZZZ" })])?.symbol, "ZZZ");
  assert.equal(autoEntryPick([r({ holdersOk: false })]), null, "a failed holder read is a veto");
  assert.equal(autoEntryPick([r({ launchOk: false })]), null, "a failed launch read is a veto");
  assert.equal(autoEntryPick([r({ launchOk: null })])?.symbol, "ZZZ", "no launch read is not a failure");
  assert.equal(autoEntryPick([r({ grade: null })]), null, "below the bar is not bought");
  assert.equal(autoEntryPick([r({ held: true })]), null, "a token already held is not bought again here");
});

test("a read the cycle does not have is not a pass: a missing holder read or launch read is refused (2026-09-08)", () => {
  assert.equal(autoEntryPick([r({ holdersRead: false, holdersOk: false })]), null, "the holder read threw, or its scan came back empty");
  assert.equal(autoEntryPick([r({ holdersRead: false, holdersOk: true })]), null, "a pass without a read behind it is no pass");
  assert.equal(autoEntryPick([r({ launchRead: false, launchOk: null })]), null, "the launch read threw, or the factory did not answer: not the same as 'not a launchpad token'");
  assert.equal(autoEntryPick([r({ symbol: "MEME", launchRead: false, launchOk: null }), r({ symbol: "ZZZ" })])?.symbol, "ZZZ", "the next candidate with every read is picked");
});

test("the entry is argued from the observation's own lines, at the rails' size, and the rails accept the argument", () => {
  const observation = [
    "Book: 0.41 ETH.",
    "Size of a new entry: $100 of ETH, which is 0.0402 ETH at $2490.56; a buy names that amount of ETH.",
    "Launch candidates from the watcher, graded against the bar: ZZZ@robinhood GRADE B, up to $100.00 (record: 25 h old, cap $21.3M, $25.2M in 24h, $853k last hour, 60,955 swaps in 24h, liquidity $468k): hour 25, 0.0h ago",
    "Tape ZZZ (last 15 min): 210 swaps; buys $61,200 vs sells $45,900 (57% buy pressure); price +1.2% over the window.",
    "Entry ZZZ (last 30 min, 420 swaps): volume established by its hourly figures; quiet in a 8.9% range for 10 min with the peak 30 min old, buy pressure 57% over the last 10 min: base, entry allowed. BASE, ENTRY ALLOWED.",
    "Holders ZZZ (9237 transfers): 715 wallets; largest 9%; top ten 32% of circulating; 0 of the top ten wallets are fresh. HOLDERS OK.",
    "Entry MEME (last 30 min, 154 swaps): 12% off its peak: breakdown, no entry. BREAKDOWN, NO ENTRY.",
  ];
  const a = autoEntryFor(r({}), observation, 100, 2490.56, 10);
  assert.equal(a.symbol, "ZZZ");
  assert.equal(a.amountEth, 0.04015);
  assert.equal(a.analysis.evidence.length, 4, "the board line, the tape, the entry and the holders");
  assert.ok(a.analysis.evidence.every((l) => l.includes("ZZZ")));
  assert.match(a.reason, /^the reads made this entry: ZZZ passed the entry read/);
  assert.match(a.analysis.invalidation, /floor at -10%/);
  const check = evidenceCheck(a.analysis, observation, { minEvidence: 3, minConviction: 4 });
  assert.equal(check.ok, true, "the rails' own evidence check accepts lines copied from the observation");
});
