import { test } from "node:test";
import assert from "node:assert/strict";
import { readsGate, holderReadComplete, launchReadComplete, type ReadGate, type ReadGateInput } from "../src/desk/readgate.ts";

const entry = { ok: true, why: "quiet in a 8.9% range for 10 min with the peak 30 min old: base, entry allowed" };
const holders = { ok: true, why: "140 wallets, largest 9%, top ten 31%", transfers: 900 };
const launch = { exists: true, unread: [] as string[], verdict: { ok: true, why: "score 80" } };
const other = { exists: false, unread: [] as string[], verdict: { ok: true, why: "not a pons v2 launch, no launch read" } };
const factoryUnread = { exists: false, unread: ["the factory record"], verdict: { ok: true, why: "the factory record could not be read" } };
const g = (over: Partial<ReadGateInput>): ReadGate => readsGate({ symbol: "LENNY", held: false, entry, holders, launch, ...over });
const reason = (r: ReadGate): string => (r.ok ? "" : r.reason);

test("a new entry needs every read made and passed: a read that did not complete refuses by name (2026-09-08)", () => {
  assert.deepEqual(g({}), { ok: true });
  assert.deepEqual(g({ launch: other }), { ok: true }, "a token the factory does not know is a completed read with nothing to say");
  assert.equal(reason(g({ entry: null })), "no tape was read for LENNY this cycle, so there is no entry read");
  assert.match(reason(g({ entry: { ok: false, why: "12% off its peak: breakdown, no entry" } })), /^the tape gives no entry: 12% off its peak/);
  assert.equal(reason(g({ holders: null, failed: { holders: "explorer answered 502" } })), "the holder read did not complete for LENNY (explorer answered 502), so there is no holder read");
  assert.equal(reason(g({ holders: null })), "the holder read did not complete for LENNY (it was not made this cycle), so there is no holder read");
  assert.equal(reason(g({ holders: { ok: false, why: "no transfers read", transfers: 0 } })), "the holder read did not complete for LENNY (no transfers were read), so there is no holder read", "a scan the RPC refused is no read, not a pass");
  assert.match(reason(g({ holders: { ...holders, ok: false, why: "the largest wallet holds 50% (25% allowed)" } })), /^the holders fail the read: the largest wallet holds 50%/);
  assert.equal(reason(g({ launch: null, failed: { launch: "timeout" } })), "the launch read did not complete for LENNY (timeout), so there is no launch read");
  assert.equal(reason(g({ launch: null })), "the launch read did not complete for LENNY (it was not made this cycle), so there is no launch read");
  assert.equal(reason(g({ launch: factoryUnread })), "the launch read did not complete for LENNY (the factory record could not be read), so there is no launch read", "a factory that did not answer is no read, not 'not a launch'");
  assert.match(reason(g({ launch: { ...launch, verdict: { ok: false, why: "the dev buy is 27.3% of supply (8% allowed)" } } })), /^the launch fails the read: the dev buy is 27.3%/);
  // The tape comes first: a token with no tape is refused on that, whatever else is missing.
  assert.match(reason(g({ entry: null, holders: null, launch: null })), /^no tape was read for LENNY/);
});

test("a token already held is judged as before: a failed read refuses the add-on, a missing one does not, and the entry read is still needed", () => {
  const h = { held: true };
  assert.deepEqual(g({ ...h, holders: null, launch: null }), { ok: true });
  assert.deepEqual(g({ ...h, holders: { ok: false, why: "no transfers read", transfers: 0 }, launch: factoryUnread }), { ok: true });
  assert.match(reason(g({ ...h, holders: { ...holders, ok: false, why: "the top ten hold 80% (60% allowed)" } })), /^the holders fail the read: the top ten hold 80%/);
  assert.match(reason(g({ ...h, launch: { ...launch, verdict: { ok: false, why: "the launch is swept: between its curve and its pool nothing can trade" } } })), /^the launch fails the read: the launch is swept/);
  assert.match(reason(g({ ...h, entry: null })), /^no tape was read for LENNY/);
  assert.match(reason(g({ ...h, entry: { ok: false, why: "breakdown, no entry" } })), /^the tape gives no entry/);
});

test("which reads count as complete", () => {
  assert.equal(holderReadComplete(null), false);
  assert.equal(holderReadComplete(undefined), false);
  assert.equal(holderReadComplete({ transfers: 0 }), false, "an empty scan is no read");
  assert.equal(holderReadComplete({ transfers: 1 }), true);
  assert.equal(launchReadComplete(null), false);
  assert.equal(launchReadComplete(factoryUnread), false, "the factory did not answer");
  assert.equal(launchReadComplete(other), true, "the factory answered: not one of its launches");
  assert.equal(launchReadComplete({ exists: true, unread: ["the launch transaction"] }), true, "a launch read with a part unread still completed on the factory record");
});
