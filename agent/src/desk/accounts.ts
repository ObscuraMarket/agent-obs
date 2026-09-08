// The wallet is the account. A person proves control of a wallet by signing a short challenge; the verified
// address then carries a bearer for a week, so the console does not ask for a signature on every line. The
// signature proves control only: it authorises no transaction and moves no funds. No email, no password, no
// server-side session store: the bearer is an HMAC over `address:issuedAt:expiry`, and the challenge nonce is an
// HMAC over `address:issuedAt`, so both verify on any instance and survive a restart when OBS_SESSION_SECRET is
// set (without it a random per-boot secret is used and everyone signs in again after a redeploy). The one thing
// kept per wallet is a revocation moment (obs-accounts.jsonl, below): a bearer issued before it is dead, so
// /logout ends a stolen bearer's week at once.
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { verifyMessage } from "viem";
import { appendLedger, readLedger } from "../ledger.ts";
import { dataPath } from "../config.ts";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const SECRET = process.env.OBS_SESSION_SECRET || randomBytes(32).toString("hex");

export const isAddress = (a: unknown): a is `0x${string}` => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

const hmac = (s: string): string => createHmac("sha256", SECRET).update(s).digest("base64url");
const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface WalletSession {
  token: string;
  address: string;
  expiresAt: number;
}

/**
 * A bearer that proves this already-verified wallet, for a week unless the caller says otherwise. The payload
 * carries when it was issued as well as when it expires: the revocation rule reads the issue moment, and derived
 * from the expiry it was only right while every bearer lived exactly the week (a shorter TTL would have revived a
 * revoked bearer, a longer one refused fresh ones; review, 2026-09-08).
 */
export function mintSession(address: string, now = Date.now(), ttlMs = SESSION_TTL_MS): WalletSession {
  const addr = address.toLowerCase();
  const expiresAt = now + ttlMs;
  const payload = Buffer.from(`${addr}:${now}:${expiresAt}`).toString("base64url");
  return { token: `${payload}.${hmac(payload)}`, address: addr, expiresAt };
}

export interface SessionRead { address: string; issuedAt: number; expiresAt: number }

/** PURE apart from the secret: what a bearer says of itself, unexpired and unrevoked, or null. */
export function sessionOf(token: string | null | undefined, now = Date.now()): SessionRead | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!same(token.slice(dot + 1), hmac(payload))) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString();
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  const addr = parts[0];
  const exp = Number(parts[parts.length - 1]);
  if (!isAddress(addr) || !Number.isFinite(exp) || now > exp) return null;
  // The two-field shape is a bearer minted before 2026-09-08 carrying its expiry only, and its issue moment is
  // the expiry less the week it was minted with, so nobody was signed out by the deploy. Every such bearer has
  // aged out by 2026-09-15: delete this branch then, and refuse the two-field shape.
  const issuedAt = parts.length === 3 ? Number(parts[1]) : exp - SESSION_TTL_MS;
  if (!Number.isFinite(issuedAt) || issuedAt > exp) return null;
  return issuedBeforeRevocation(issuedAt, revokedBefore(addr, now)) ? null : { address: addr, issuedAt, expiresAt: exp };
}

/** The wallet a bearer proves, lower-cased, or null. */
export function verifySession(token: string | null | undefined, now = Date.now()): string | null {
  return sessionOf(token, now)?.address ?? null;
}

// ---- per-wallet revocation: the one piece of session state the desk keeps ---------------------------------------
// Audit finding 2026-09-08: a seven-day bearer could not be revoked per wallet (no server-side list, no logout
// route), so a stolen bearer kept /sell, /stop, resize and /start live for a week. A wallet's /logout records the
// moment in obs-accounts.jsonl as {address, revokedBefore, at}; verifySession refuses a bearer issued before it,
// with the same null a stale one gets, and a fresh sign-in after it mints a bearer that passes.
//
// Next step, not built here: a fresh wallet signature on /sell, /withdraw and /start live, so the bearer alone
// (a week of console reads and shaping) never moves money, revoked or not.

/** PURE: the revocation rule. Dead when issued strictly before the moment; issued at it or after it lives. */
export function issuedBeforeRevocation(issuedAt: number, revokedBefore: number | undefined): boolean {
  return revokedBefore !== undefined && Number.isFinite(revokedBefore) && issuedAt < revokedBefore;
}

/**
 * PURE: the moment a sign-out stamps: now, or one past the calling bearer's own issue moment when the clock has
 * stepped back to or before it (NTP between sign-in and sign-out), so the bearer that asked to be revoked always
 * dies. Without this the logout's own bearer kept its week after a clock step (review, 2026-09-08).
 */
export function revocationMoment(now: number, callerIssuedAt?: number): number {
  return callerIssuedAt != null && Number.isFinite(callerIssuedAt) ? Math.max(now, callerIssuedAt + 1) : now;
}

/**
 * PURE: a row's moment as the map keeps it: never past the clock at load. A row stamped ahead of the clock (a
 * server clock that ran ahead and was stepped back, a hand edit of the ledger) would refuse every bearer the wallet
 * mints until the clock passed it, and the wallet could not reach /stop or /withdraw (review, 2026-09-08); capped,
 * it revokes what existed at load and nothing minted after.
 */
export function cappedMoment(revokedBefore: number, loadedAt: number): number {
  return Math.min(revokedBefore, loadedAt);
}

interface RevocationRow {
  address?: unknown;
  revokedBefore?: unknown;
}

const LEDGER = "obs-accounts.jsonl";
/** How often the ledger's size and mtime are looked at, at most: a stat is cheap, and verifySession runs on every signed request. */
const RELOAD_CHECK_MS = 3_000;

let revocations: Map<string, number> | null = null;
let loadedStamp = "";
let checkedAt = 0;

const ledgerStamp = (): string => {
  try { const s = statSync(dataPath(LEDGER)); return `${s.size}:${s.mtimeMs}`; } catch { return "missing"; }
};

/**
 * The moments, kept in memory and merged again from the ledger whenever its size or mtime has changed, checked at
 * most every few seconds: a revocation written by another process (a second API process, a rolling deploy with
 * two alive) reaches this one within that, where a once-per-process load honoured the dead bearer until a
 * restart (review, 2026-09-08). The ledger is append-only and the merge takes the later moment, so it is safe to
 * repeat; a moment set in memory by revokeSessions is never moved back by it.
 */
function revocationMap(now = Date.now()): Map<string, number> {
  if (revocations && now - checkedAt < RELOAD_CHECK_MS) return revocations;
  checkedAt = now;
  const stamp = ledgerStamp();
  if (revocations && stamp === loadedStamp) return revocations;
  const map = revocations ?? new Map<string, number>();
  for (const row of readLedger<RevocationRow>(LEDGER)) {
    if (!isAddress(row.address) || typeof row.revokedBefore !== "number" || !Number.isFinite(row.revokedBefore)) continue;
    const addr = row.address.toLowerCase();
    const capped = cappedMoment(row.revokedBefore, now);
    if (capped !== row.revokedBefore) console.log(`[account] a revocation row for ${addr} is stamped ${new Date(row.revokedBefore).toISOString()}, ahead of the clock; read as now`);
    map.set(addr, Math.max(map.get(addr) ?? 0, capped));
  }
  revocations = map;
  loadedStamp = stamp;
  return map;
}

/** The wallet's revocation moment, or undefined when it never signed out; `now` is the clock the reload check and the cap read. */
export function revokedBefore(address: string, now = Date.now()): number | undefined {
  return revocationMap(now).get(address.toLowerCase());
}

/**
 * Sign the wallet out everywhere: every bearer issued before the moment (revocationMoment) is dead from here.
 * Says whether the row landed. A stolen bearer that is still valid can call this too and sign the owner out
 * everywhere, once: it dies in the same call, and the owner signs in again with a signature it cannot produce.
 */
export function revokeSessions(address: string, now = Date.now(), callerIssuedAt?: number): boolean {
  const addr = address.toLowerCase();
  const moment = revocationMoment(now, callerIssuedAt);
  const map = revocationMap(now);
  map.set(addr, Math.max(map.get(addr) ?? 0, moment));
  const landed = appendLedger(LEDGER, { address: addr, revokedBefore: moment, at: now });
  // The row this process wrote is already in its map: the next stat must not read the file as someone else's change.
  loadedStamp = ledgerStamp();
  return landed;
}

/** The bearer out of an Authorization header, or null. */
export function bearerOf(header: string | undefined): string | null {
  const h = header ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

const usedNonces = new Map<string, number>();

function signedNonce(address: string, issuedAt: number): string {
  const payload = Buffer.from(`${address.toLowerCase()}:${issuedAt}`).toString("base64url");
  return `${payload}.${hmac(`nonce:${payload}`)}`;
}

/** PURE apart from the secret: the exact text the wallet signs. Plain words, because a wallet shows it. */
export function signInMessage(address: string, nonce: string): string {
  return ["Sign in to the OBS console.", "", "This links the console to this wallet. It does not authorize any transaction and moves no funds.", "", `Wallet: ${address}`, `Nonce: ${nonce}`].join("\n");
}

/** A one-time challenge for an address: the nonce and the message to sign. */
export function issueChallenge(address: unknown, now = Date.now()): { message: string; nonce: string } | null {
  if (!isAddress(address)) return null;
  const nonce = signedNonce(address, now);
  return { message: signInMessage(address, nonce), nonce };
}

function verifyNonce(address: string, nonce: string, now: number): string | null {
  const dot = nonce.indexOf(".");
  if (dot <= 0) return "unknown challenge; reconnect and try again";
  const payload = nonce.slice(0, dot);
  if (!same(nonce.slice(dot + 1), hmac(`nonce:${payload}`))) return "invalid challenge; reconnect and try again";
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString();
  } catch {
    return "malformed challenge";
  }
  const idx = decoded.lastIndexOf(":");
  if (idx < 0 || decoded.slice(0, idx) !== address.toLowerCase()) return "the challenge does not match this wallet";
  const iat = Number(decoded.slice(idx + 1));
  if (!Number.isFinite(iat) || now - iat > NONCE_TTL_MS) return "the challenge expired; reconnect and try again";
  for (const [n, t] of usedNonces) if (now - t > NONCE_TTL_MS) usedNonces.delete(n);
  if (usedNonces.has(nonce)) return "that challenge was already used; reconnect and try again";
  usedNonces.set(nonce, now);
  return null;
}

/** Verify a signed challenge and mint the session. The address is recorded once as an account. */
export async function linkAccount(body: { address?: unknown; nonce?: unknown; signature?: unknown }, now = Date.now(), verify: typeof verifyMessage = verifyMessage): Promise<{ ok: true; session: WalletSession } | { ok: false; error: string }> {
  const { address, nonce, signature } = body ?? {};
  if (!isAddress(address)) return { ok: false, error: "a wallet address is required" };
  if (typeof nonce !== "string" || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return { ok: false, error: "the challenge and its signature are required" };
  const bad = verifyNonce(address, nonce, now);
  if (bad) return { ok: false, error: bad };
  let valid = false;
  try {
    valid = await verify({ address, message: signInMessage(address, nonce), signature: signature as `0x${string}` });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "the signature does not match this wallet" };
  appendLedger("obs-accounts.jsonl", { address: address.toLowerCase(), linkedAt: now });
  return { ok: true, session: mintSession(address, now) };
}
