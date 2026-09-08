import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldEndTurn, meteredReply } from "../src/desk/chatTurn.ts";

test("a request refused before the guard admitted it gives no slot back", () => {
  // Body too large, bad JSON, an empty message, a closed door: none of these held a slot, so ending one would
  // clear another turn's in-flight mark and decrement the shared count (the leak fixed 2026-09-08).
  assert.equal(shouldEndTurn({ guarded: false, ended: false }), false);
  assert.equal(shouldEndTurn({ guarded: false, ended: true }), false);
});

test("a turn the guard admitted gives its slot back once, whether it finished, failed or was refused for credits", () => {
  assert.equal(shouldEndTurn({ guarded: true, ended: false }), true);
  // A second release for the same request must not decrement the shared count twice.
  assert.equal(shouldEndTurn({ guarded: true, ended: true }), false);
});

test("nothing came back from the gateway, nothing is owed", () => {
  assert.equal(meteredReply({ delivered: 0, final: "", streamed: "" }), null);
});

test("a finished stream is metered on its final text", () => {
  assert.equal(meteredReply({ delivered: 5, final: "the whole reply", streamed: "the whole reply" }), "the whole reply");
  // A gateway that sends only a final, no deltas, is metered on it too.
  assert.equal(meteredReply({ delivered: 1, final: "just the final", streamed: "" }), "just the final");
});

test("a socket closed mid-reply is metered on what had streamed", () => {
  // Until 2026-09-08 this turn was free: the charge only ran after a finished stream.
  assert.equal(meteredReply({ delivered: 3, final: "", streamed: "the first half of" }), "the first half of");
});

test("a turn cut before its first token still owes for the prompt", () => {
  assert.equal(meteredReply({ delivered: 1, final: "", streamed: "" }), "");
});

test("two answers around a tool call are metered on the deltas the last final does not cover", () => {
  assert.equal(meteredReply({ delivered: 9, final: "and the second answer", streamed: "the first answer, and the second answer" }), "the first answer, and the second answer");
});
