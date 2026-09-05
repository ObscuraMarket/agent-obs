import { test } from "node:test";
import assert from "node:assert/strict";
import { researchLine } from "../src/desk/research.ts";

test("every research event reads as one plain sentence a newcomer follows", () => {
  assert.equal(researchLine({ kind: "launch", symbol: "PORK", ok: true, note: "pons v2, paired with ETH, creator tax 1%" }), "New launch PORK: pons v2, paired with ETH, creator tax 1%. Gate ok, watching for ignition.");
  assert.equal(researchLine({ kind: "launch", symbol: "QUACK", ok: false, note: "pons v2, paired with ETH, creator tax 3%, not the launcher's standard" }), "New launch QUACK: pons v2, paired with ETH, creator tax 3%, not the launcher's standard. Gate failed, never traded.");
  assert.equal(researchLine({ kind: "ignited", symbol: "PORK", ok: null, note: "3 minutes after launch" }), "PORK ignited 3 minutes after launch: real buyers on its curve. Reading its tape.");
  assert.equal(researchLine({ kind: "watch", symbol: "PORK", ok: null, note: "a launch that ignited with a low tax" }), "Now watching PORK's pool block by block (a launch that ignited with a low tax).");
  assert.equal(researchLine({ kind: "dropped", symbol: "OZZYIUS", ok: null, note: "it left the window" }), "Stopped watching OZZYIUS: it left the window.");
  assert.equal(researchLine({ kind: "entry", symbol: "PORK", ok: false, note: "spike" }), "PORK's tape: a spike, the top of a run. Not buying a spike.");
  assert.equal(researchLine({ kind: "entry", symbol: "PORK", ok: true, note: "pullback|20% off the peak, buy pressure 61%" }), "PORK's tape: a pullback that held a higher low and turned up (20% off the peak, buy pressure 61%). Entry allowed, thinking.");
  assert.equal(researchLine({ kind: "entry", symbol: "PORK", ok: false, note: "quiet|the last 10 min ran 0.4x the earlier tape" }), "PORK's tape: quiet, the last 10 min ran 0.4x the earlier tape.");
  assert.equal(researchLine({ kind: "holders", symbol: "PORK", ok: true, note: "140 wallets, largest 9%, top ten 31%" }), "PORK's holders: 140 wallets, largest 9%, top ten 31%. OK.");
  assert.equal(researchLine({ kind: "holders", symbol: "UNIT", ok: false, note: "largest 50%" }), "UNIT's holders: FAIL, largest 50%. Not buying.");
  assert.equal(researchLine({ kind: "launch-read", symbol: "COFF", ok: false, note: "dev buy 27.3%" }), "COFF's launch: FAIL, dev buy 27.3%. Not buying.");
  assert.equal(researchLine({ kind: "launch-read", symbol: "XI", ok: true, note: "dev buy 1.85%, no exempt wallets, links set, score 100" }), "XI's launch: dev buy 1.85%, no exempt wallets, links set, score 100. OK.");
  assert.equal(researchLine({ kind: "trigger", symbol: "JOHN", ok: null, note: "pullback holding, entry allowed" }), "JOHN gave an entry: pullback holding, entry allowed. Thinking now.");
  assert.equal(researchLine({ kind: "decision", symbol: "", ok: null, note: "hold. Candidates either fail launch safety checks or are gated by the entry read." }), "Decided: hold. Candidates either fail launch safety checks or are gated by the entry read.");
});
