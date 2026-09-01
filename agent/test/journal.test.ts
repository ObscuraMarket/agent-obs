import { test } from "node:test";
import assert from "node:assert/strict";
import { splitNote } from "../src/journal.ts";

test("a labelled reply splits into tweet and private note", () => {
  const r = splitNote("POST: The cashback is a rebate, not a yield.\nNOTE: check whether the monthly payout landed for the first cohort.");
  assert.equal(r.text, "The cashback is a rebate, not a yield.");
  assert.equal(r.note, "check whether the monthly payout landed for the first cohort.");
});

test("a mid-text POST: echo is cut off, the tweet is what came before", () => {
  const r = splitNote("Route and size stay private, which is the whole point. POST: Route and size stay private.\nNOTE: hold the thread.");
  assert.equal(r.text, "Route and size stay private, which is the whole point.");
  assert.equal(r.note, "hold the thread.");
});

test("an unlabelled reply is pure tweet text with no note", () => {
  const r = splitNote("Tokenized stocks trade on Sunday night while the underlying is closed.");
  assert.equal(r.text, "Tokenized stocks trade on Sunday night while the underlying is closed.");
  assert.equal(r.note, "");
});

test("PASS still carries a note", () => {
  const r = splitNote("PASS\nNOTE: nothing new since the last read.");
  assert.match(r.text, /^PASS/);
  assert.equal(r.note, "nothing new since the last read.");
});
