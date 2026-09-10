import "./tmpdata.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDeskLock } from "../src/desk/onchain.ts";
import { acquire } from "../src/desk/walletLock.ts";

const DESK = "0x2dA43C49cE0af0e463CB581202b000E2B8a52b5d";
const settled = { ok: true as const, trade: { id: "t1" } as never };

test("the desk's send waits its turn: another live holder of the wallet's lock makes it a refusal, not a second signer", async () => {
  // Review 2026-09-10: the cycle's lock goes stale after fifteen minutes and scripts sign with no lock at all, so two
  // processes could sign from the desk wallet at once and sell the same lot twice.
  const dir = mkdtempSync(join(tmpdir(), "desklock-"));
  const other = acquire(DESK, "exit HELD", { dir, pid: 999_991, alive: () => true });
  assert.ok(other, "someone else holds the wallet");
  let sent = 0;
  const busy = await withDeskLock(DESK, "exit X", async () => { sent++; return settled; }, { dir, alive: () => true });
  assert.equal(sent, 0, "nothing is signed while it is held");
  assert.equal(busy.ok, false);
  assert.match((busy as { reason: string }).reason, /busy with another send; this goes again on the next look/);
  other!();

  const free = await withDeskLock(DESK, "exit X", async () => { sent++; return settled; }, { dir });
  assert.equal(sent, 1);
  assert.equal(free.ok, true);
  assert.equal(readdirSync(dir).length, 0, "and the lock is released after the send");
});

test("a send that throws still releases the desk's lock, so the wallet never freezes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desklock-"));
  await assert.rejects(withDeskLock(DESK, "entry Y", async () => { throw new Error("rpc down"); }, { dir }), /rpc down/);
  assert.equal(existsSync(join(dir, `${DESK.toLowerCase()}.json`)), false);
});
