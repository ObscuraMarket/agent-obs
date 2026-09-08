// One signer, one transaction at a time. A person's agent wallet is signed for by two processes that know nothing of
// each other: the console's server on /withdraw, and the desk's cycle on a mirrored trade. Each reads the balance,
// prices its transaction and sends it under the wallet's next nonce, so two at once collide: the later send fails
// on the nonce or, worse, a "withdraw all" sweeps the ETH an entry priced a moment earlier, and the entry reverts
// or lands short (found in review, 2026-09-08). This is the lock between them: a file per address under
// DATA_DIR/locks, created with "wx" so the file system lets exactly one process make it, holding who took it and
// for what.
//
// Advisory, the way the cycle's own lock is (cycle.ts): a lock whose process is gone, or older than
// OBS_WALLET_LOCK_MIN minutes (three unless set), is stale and taken over, so a crash mid-send never freezes a
// wallet. The rule for "held" is pure and tested; the file work is the thin part.
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../config.ts";

export interface LockRecord { pid: number; at: number; what: string }

export const DEFAULT_LOCK_MIN = 3;

/** PURE: how long a lock counts as held, in milliseconds (OBS_WALLET_LOCK_MIN): three minutes unless set to a positive number. */
export function lockStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OBS_WALLET_LOCK_MIN ?? DEFAULT_LOCK_MIN);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_LOCK_MIN) * 60e3;
}

/**
 * PURE: whether a lock record is held by a live process: its pid alive and the record younger than the stale
 * window. The same rule as watch.ts's lockHeld for the cycle's lock, with the window a parameter: a wallet lock
 * covers one transaction, not a cycle. A record without a pid or a time, or none at all, is not held.
 */
export function lockIsHeld(record: LockRecord | null | undefined, now: number, alive: (pid: number) => boolean, staleMs: number = DEFAULT_LOCK_MIN * 60e3): boolean {
  if (!record || typeof record.pid !== "number" || typeof record.at !== "number") return false;
  return alive(record.pid) && now - record.at < staleMs;
}

/** Whether a process is running: the signal-zero probe the cycle's lock uses. A pid we may not signal counts as gone. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export const lockDir = (): string => dataPath("locks");

export interface AcquireOptions {
  /** Where the lock files live; DATA_DIR/locks unless a test says otherwise. */
  dir?: string;
  now?: number;
  pid?: number;
  alive?: (pid: number) => boolean;
  staleMs?: number;
}

/** What the lock file holds right now, or null when there is none or it does not parse. */
export function readLock(address: string, dir: string = lockDir()): LockRecord | null {
  try { return JSON.parse(readFileSync(lockPathOf(address, dir), "utf8")) as LockRecord; } catch { return null; }
}

function lockPathOf(address: string, dir: string): string {
  const a = address.toLowerCase();
  // The address is the file's name; anything that is not one would name a file outside the lock's shape.
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error("a wallet lock needs an address");
  return join(dir, `${a}.json`);
}

/**
 * Take the wallet's lock for one piece of work. Returns the release, or null when another live process holds it.
 * The release removes only the record this call made: after a stale takeover by another process, the earlier
 * holder's release leaves the new holder's lock alone (the cycle's lock checks its pid on exit the same way).
 */
export function acquire(address: string, what: string, opts: AcquireOptions = {}): (() => void) | null {
  const dir = opts.dir ?? lockDir();
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? lockStaleMs();
  const path = lockPathOf(address, dir);
  const current = readLock(address, dir);
  if (lockIsHeld(current, now, opts.alive ?? processAlive, staleMs)) return null;
  if (current) {
    // Stale: cleared so "wx" can make ours, but only while it is still the record just judged. One that changed
    // between the two reads is someone else's fresh lock, and this call leaves rather than pull it from under them.
    const again = readLock(address, dir);
    if (!again || again.pid !== current.pid || again.at !== current.at) return null;
    try { unlinkSync(path); } catch { /* already gone */ }
  } else {
    // A file that did not parse is either one made a moment ago and not yet written (open and write are two
    // steps), which is held, or an old corrupt one, which goes. No file at all falls through to "wx".
    try {
      if (now - statSync(path).mtimeMs < staleMs) return null;
      unlinkSync(path);
    } catch { /* no file: nothing to clear */ }
  }
  mkdirSync(dir, { recursive: true });
  const record: LockRecord = { pid: opts.pid ?? process.pid, at: now, what };
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    // Someone made it between the read and the open: theirs, not ours.
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
  try { writeFileSync(fd, JSON.stringify(record)); } finally { closeSync(fd); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const cur = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
      if (cur.pid === record.pid && cur.at === record.at) unlinkSync(path);
    } catch { /* already gone, or someone else's now */ }
  };
}
