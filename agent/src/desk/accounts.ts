// The wallet is the account. A person proves control of a wallet by signing a short challenge; the verified
// address then carries a bearer for a week, so the console does not ask for a signature on every line. The
// signature proves control only: it authorises no transaction and moves no funds. No email, no password, no
// server-side session store: the bearer is an HMAC over `address:expiry`, and the challenge nonce is an HMAC over
// `address:issuedAt`, so both verify on any instance and survive a restart when OBS_SESSION_SECRET is set (without
// it a random per-boot secret is used and everyone signs in again after a redeploy). The one thing kept per wallet
// is a revocation moment (obs-accounts.jsonl, below): a bearer issued before it is dead, so /logout ends a stolen
// bearer's week at once.
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "viem";
import { appendLedger, readLedger } from "../ledger.ts";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

/** A bearer that proves this already-verified wallet for a week. */
export function mintSession(address: string, now = Date.now()): WalletSession {
  const addr = address.toLowerCase();
  const expiresAt = now + SESSION_TTL_MS;
  const payload = Buffer.from(`${addr}:${expiresAt}`).toString("base64url");
  return { token: `${payload}.${hmac(payload)}`, address: addr, expiresAt };
}

/** The wallet a bearer proves, lower-cased, or null. */
export function verifySession(token: string | null | undefined, now = Date.now()): string | null {
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
  const idx = decoded.lastIndexOf(":");
  if (idx < 0) return null;
  const addr = decoded.slice(0, idx);
  const exp = Number(decoded.slice(idx + 1));
  if (!isAddress(addr) || !Number.isFinite(exp) || now > exp) return null;
  // The bearer carries its expiry only, so its issue moment is the expiry less the fixed week: that keeps every
  // bearer minted before the revocation row existed valid across the deploy, where a new payload shape would have
  // signed everyone out at once (2026-09-08).
  return issuedBeforeRevocation(exp - SESSION_TTL_MS, revokedBefore(addr)) ? null : addr;
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

interface RevocationRow {
  address?: unknown;
  revokedBefore?: unknown;
}

let revocations: Map<string, number> | null = null;

/** The moments, read once from the ledger and then kept in memory: verifySession runs on every signed request. */
function revocationMap(): Map<string, number> {
  if (revocations) return revocations;
  revocations = new Map();
  for (const row of readLedger<RevocationRow>("obs-accounts.jsonl")) {
    if (!isAddress(row.address) || typeof row.revokedBefore !== "number" || !Number.isFinite(row.revokedBefore)) continue;
    const addr = row.address.toLowerCase();
    revocations.set(addr, Math.max(revocations.get(addr) ?? 0, row.revokedBefore));
  }
  return revocations;
}

/** The wallet's revocation moment, or undefined when it never signed out. */
export function revokedBefore(address: string): number | undefined {
  return revocationMap().get(address.toLowerCase());
}

/** Sign the wallet out everywhere: every bearer issued before now is dead from here. Says whether the row landed. */
export function revokeSessions(address: string, now = Date.now()): boolean {
  const addr = address.toLowerCase();
  const map = revocationMap();
  map.set(addr, Math.max(map.get(addr) ?? 0, now));
  return appendLedger("obs-accounts.jsonl", { address: addr, revokedBefore: now, at: now });
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
