import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockIsHeld, lockStaleMs, acquire, readLock, processAlive, DEFAULT_LOCK_MIN } from "../src/desk/walletLock.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const now = 1_800_000_000_000;
const M = 60e3;
const yes = () => true;
const no = () => false;

test("a wallet lock counts as held only while its pid lives and it is under the stale window, three minutes unless set", () => {
  assert.equal(lockIsHeld({ pid: 146, at: now - M, what: "withdraw" }, now, yes), true);
  assert.equal(lockIsHeld({ pid: 146, at: now - M, what: "withdraw" }, now, no), false, "a dead pid is a stale lock");
  assert.equal(lockIsHeld({ pid: 146, at: now - 3 * M, what: "withdraw" }, now, yes), false, "three minutes old is stale");
  assert.equal(lockIsHeld({ pid: 146, at: now - 3 * M + 1, what: "withdraw" }, now, yes), true, "a moment under three minutes is held");
  assert.equal(lockIsHeld({ pid: 146, at: now - 4 * M, what: "entry X" }, now, yes, 5 * M), true, "the window is the operator's when set");
  assert.equal(lockIsHeld(null, now, yes), false);
  assert.equal(lockIsHeld(undefined, now, yes), false);
  assert.equal(lockIsHeld({ pid: 146 } as { pid: number; at: number; what: string }, now, yes), false, "a lock without a time is not held");
  assert.equal(lockIsHeld({ at: now } as { pid: number; at: number; what: string }, now, yes), false, "a lock without a pid is not held");
  assert.equal(lockStaleMs({} as NodeJS.ProcessEnv), DEFAULT_LOCK_MIN * M);
  assert.equal(lockStaleMs({ OBS_WALLET_LOCK_MIN: "5" } as NodeJS.ProcessEnv), 5 * M);
  assert.equal(lockStaleMs({ OBS_WALLET_LOCK_MIN: "0" } as NodeJS.ProcessEnv), 3 * M, "zero would make every lock stale at once: the default stands");
  assert.equal(lockStaleMs({ OBS_WALLET_LOCK_MIN: "soon" } as NodeJS.ProcessEnv), 3 * M);
  assert.equal(processAlive(process.pid), true);
});

test("one process takes a wallet's lock, a second is refused, and the release lets the next one in", () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-wallet-lock-"));
  try {
    const locks = join(dir, "locks");
    const release = acquire(A, "withdraw", { dir: locks, now });
    assert.ok(release, "the first taker holds it");
    assert.deepEqual(readLock(A, locks), { pid: process.pid, at: now, what: "withdraw" }, "the file says who holds it and for what");
    assert.deepEqual(readdirSync(locks), [`${A}.json`], "one file per address, under the locks directory");
    assert.equal(acquire(A, "entry PENGUIN", { dir: locks, now: now + 1000 }), null, "the same wallet, a moment later: held");
    assert.equal(acquire(A.toUpperCase().replace("0X", "0x"), "entry PENGUIN", { dir: locks, now: now + 1000 }), null, "case does not make it another wallet");
    const other = acquire(B, "entry PENGUIN", { dir: locks, now: now + 1000 });
    assert.ok(other, "another wallet's lock is its own");
    other!();
    release!();
    assert.equal(readLock(A, locks), null, "released: the file is gone");
    release!();
    const next = acquire(A, "entry PENGUIN", { dir: locks, now: now + 2000 });
    assert.ok(next, "free again");
    assert.equal(readLock(A, locks)?.what, "entry PENGUIN");
    next!();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock whose process is gone, or which is past the window, is stale and taken over; a live one is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-wallet-lock-"));
  try {
    const locks = join(dir, "locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${A}.json`), JSON.stringify({ pid: 999_999, at: now - 10_000, what: "withdraw" }));
    assert.equal(acquire(A, "entry X", { dir: locks, now, alive: yes }), null, "fresh and its pid alive: held");
    const dead = acquire(A, "entry X", { dir: locks, now, alive: no });
    assert.ok(dead, "its pid is gone: taken over");
    assert.equal(readLock(A, locks)?.what, "entry X");
    dead!();
    writeFileSync(join(locks, `${A}.json`), JSON.stringify({ pid: 999_999, at: now - 3 * M, what: "withdraw" }));
    const old = acquire(A, "entry Y", { dir: locks, now, alive: yes });
    assert.ok(old, "three minutes old with its pid alive: stale by age, taken over");
    old!();
    writeFileSync(join(locks, `${A}.json`), JSON.stringify({ pid: 999_999, at: now - 4 * M, what: "withdraw" }));
    assert.equal(acquire(A, "entry Y", { dir: locks, now, alive: yes, staleMs: 5 * M }), null, "the operator's longer window keeps it held");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release after a takeover leaves the new holder's lock alone, and a file mid-write is held while a corrupt old one goes", () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-wallet-lock-"));
  try {
    const locks = join(dir, "locks");
    const first = acquire(A, "withdraw", { dir: locks, now: now - 5 * M, pid: 4242 });
    assert.ok(first);
    const taker = acquire(A, "exit PENGUIN", { dir: locks, now, alive: yes });
    assert.ok(taker, "five minutes old: stale, taken over");
    first!();
    assert.deepEqual(readLock(A, locks), { pid: process.pid, at: now, what: "exit PENGUIN" }, "the earlier holder's release did not remove the new lock");
    taker!();
    assert.equal(readLock(A, locks), null);
    // The file made by "wx" and not yet written: not ours to clear.
    const real = Date.now();
    writeFileSync(join(locks, `${A}.json`), "");
    assert.equal(acquire(A, "withdraw", { dir: locks, now: real }), null, "an empty lock file a moment old is someone mid-write");
    assert.ok(existsSync(join(locks, `${A}.json`)));
    const late = acquire(A, "withdraw", { dir: locks, now: real + 4 * M });
    assert.ok(late, "the same file past the window is a corrupt leftover, cleared and taken");
    late!();
    assert.throws(() => acquire("not-an-address", "withdraw", { dir: locks, now }), /needs an address/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
