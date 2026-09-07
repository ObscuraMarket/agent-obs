import { test } from "node:test";
import assert from "node:assert/strict";
import { holderVerdict, gateOn, minObs, minAobs, gateMode, allowlist, allowlisted, holderGate, NOT_INVITED } from "../src/desk/gate.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

test("the operator's list lets a wallet in whatever it holds, and is the only way in while the gate is list-only", async () => {
  const env = { OBS_CONSOLE_ALLOWLIST: `${A.toUpperCase().replace("0X", "0x")}, ${B}\n not-an-address` } as NodeJS.ProcessEnv;
  assert.deepEqual([...allowlist(env)], [A, B], "commas, spaces and newlines between addresses; anything else ignored");
  assert.equal(allowlisted(A.toUpperCase().replace("0X", "0x"), env), true, "case does not matter");
  assert.equal(allowlisted("0x3333333333333333333333333333333333333333", env), false);
  assert.deepEqual([gateMode({} as NodeJS.ProcessEnv), gateMode({ OBS_CONSOLE_GATE: "Allowlist" } as NodeJS.ProcessEnv), gateMode({ OBS_CONSOLE_GATE: "off" } as NodeJS.ProcessEnv)], ["on", "allowlist", "off"]);
  assert.equal(gateOn({ OBS_CONSOLE_GATE: "allowlist" } as NodeJS.ProcessEnv), true, "list-only is still a gate");
  // On the list: in without a chain read, in either mode.
  const invited = await holderGate(A, 0, env);
  assert.deepEqual([invited.ok, invited.invited], [true, true]);
  const listOnly = { ...env, OBS_CONSOLE_GATE: "allowlist" } as NodeJS.ProcessEnv;
  assert.equal((await holderGate(B, 0, listOnly)).ok, true);
  // Not on the list while list-only: told so, no chain read.
  const out = await holderGate("0x3333333333333333333333333333333333333333", 0, listOnly);
  assert.deepEqual([out.ok, out.reason], [false, NOT_INVITED]);
  assert.equal((await holderGate("0x3333333333333333333333333333333333333333", 0, { OBS_CONSOLE_GATE: "off" } as NodeJS.ProcessEnv)).ok, true, "off is everyone");
});

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
