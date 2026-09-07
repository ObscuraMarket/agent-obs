import { test } from "node:test";
import assert from "node:assert/strict";
import { holderVerdict, gateOn, minObs, minAobs } from "../src/desk/gate.ts";

test("the door opens for a wallet holding enough OBS or enough AOBS, and says what it needs otherwise", () => {
  assert.equal(holderVerdict(1000, 0, 1000, 1000).ok, true, "OBS alone clears it");
  assert.equal(holderVerdict(0, 5000, 1000, 1000).ok, true, "AOBS alone clears it");
  assert.equal(holderVerdict(999.99, 999.99, 1000, 1000).ok, false);
  const v = holderVerdict(12.3, 0, 1000, 500);
  assert.match(v.reason ?? "", /holds 12 OBS and 0 AOBS; it needs at least 1,000 OBS or 500 AOBS/);
  assert.equal(holderVerdict(0, 0, 0, 0).ok, true, "no minimums means no gate");
  assert.equal(holderVerdict(0, 0, 0, 1000).ok, false, "a zero minimum on one token does not open the other");
  assert.equal(gateOn({} as NodeJS.ProcessEnv), true);
  assert.equal(gateOn({ OBS_CONSOLE_GATE: "off" } as NodeJS.ProcessEnv), false);
  assert.deepEqual([minObs({} as NodeJS.ProcessEnv), minAobs({ OBS_CONSOLE_MIN_AOBS: "250000" } as NodeJS.ProcessEnv)], [1000, 250000]);
});
