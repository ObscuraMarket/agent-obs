// The data dir first: linkAccount and revokeSessions write obs-accounts.jsonl, and a test row must never land in
// the real ledger (2026-09-08).
import "./tmpdata.ts";
import { TEST_SESSION_SECRET } from "./sessionSecret.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { mintSession, verifySession, sessionOf, issueChallenge, linkAccount, bearerOf, signInMessage, issuedBeforeRevocation, revocationMoment, cappedMoment, revokeSessions, revokedBefore, SESSION_TTL_MS } from "../src/desk/accounts.ts";
import { appendLedger } from "../src/ledger.ts";

test("a session bearer proves the wallet for a week and nothing else", () => {
  const s = mintSession("0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38", 1_000_000);
  assert.equal(verifySession(s.token, 1_000_001), "0x89a26d6e7f572a12cdf0252fd0a581268dfa3f38");
  assert.equal(verifySession(s.token, s.expiresAt + 1), null, "expired");
  assert.equal(verifySession(s.token.slice(0, -2) + "zz"), null, "tampered signature");
  assert.equal(verifySession("nope"), null);
  assert.equal(verifySession(null), null);
  assert.equal(bearerOf("Bearer abc"), "abc");
  assert.equal(bearerOf("bearer  abc "), "abc");
  assert.equal(bearerOf("Basic abc"), null);
  assert.equal(bearerOf(undefined), null);
});

test("sign in: a real signature over the issued challenge mints a session; anything else is refused", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const now = Date.now();
  const c = issueChallenge(account.address, now);
  assert.ok(c);
  assert.match(c.message, /Sign in to the OBS console/);
  assert.match(c.message, /does not authorize any transaction/);
  assert.equal(c.message, signInMessage(account.address, c.nonce));
  const signature = await account.signMessage({ message: c.message });
  const good = await linkAccount({ address: account.address, nonce: c.nonce, signature }, now + 1000);
  assert.ok(good.ok);
  assert.equal(verifySession(good.session.token, now + 2000), account.address.toLowerCase());
  const replay = await linkAccount({ address: account.address, nonce: c.nonce, signature }, now + 1000);
  assert.ok(!replay.ok && /already used/.test(replay.error), "a nonce is used once");
  const other = privateKeyToAccount(generatePrivateKey());
  const c2 = issueChallenge(other.address, now);
  const wrongSigner = await linkAccount({ address: other.address, nonce: c2!.nonce, signature: await account.signMessage({ message: c2!.message }) }, now + 1000);
  assert.ok(!wrongSigner.ok && /does not match/.test(wrongSigner.error));
  const stale = issueChallenge(account.address, now - 11 * 60 * 1000)!;
  const expired = await linkAccount({ address: account.address, nonce: stale.nonce, signature: await account.signMessage({ message: stale.message }) }, now);
  assert.ok(!expired.ok && /expired/.test(expired.error));
  assert.equal(issueChallenge("0x12"), null);
  assert.ok(!(await linkAccount({ address: account.address, nonce: "x", signature: "0x00" })).ok);
});

test("the revocation rule: a bearer issued before the wallet's moment is dead; issued at it, after it, or with no moment, it lives", () => {
  assert.equal(issuedBeforeRevocation(999, 1000), true, "issued before");
  assert.equal(issuedBeforeRevocation(1000, 1000), false, "issued at the moment: the sign-in right after a logout, same millisecond");
  assert.equal(issuedBeforeRevocation(1001, 1000), false, "issued after");
  assert.equal(issuedBeforeRevocation(5, undefined), false, "a wallet that never signed out");
  assert.equal(issuedBeforeRevocation(5, Number.NaN), false, "a moment that is not a number revokes nothing");
});

test("signing out revokes the wallet's earlier bearers like expired ones; a bearer minted at or after the moment passes, and another wallet's is untouched", () => {
  const address = "0x4444444444444444444444444444444444444444";
  const other = "0x5555555555555555555555555555555555555555";
  const t0 = Date.UTC(2026, 8, 8, 9, 0, 0);
  const old = mintSession(address, t0);
  const theirs = mintSession(other, t0);
  assert.equal(verifySession(old.token, t0 + 1), address);
  assert.equal(revokedBefore(address), undefined);
  assert.equal(revokeSessions(address, t0 + 60_000), true, "the row landed");
  assert.equal(revokedBefore(address), t0 + 60_000);
  assert.equal(verifySession(old.token, t0 + 61_000), null, "issued before the moment: refused, the same null an expired bearer gets");
  assert.equal(verifySession(mintSession(address, t0 + 60_000).token, t0 + 61_000), address, "issued at the moment");
  assert.equal(verifySession(mintSession(address, t0 + 120_000).token, t0 + 121_000), address, "issued after");
  assert.equal(verifySession(theirs.token, t0 + 61_000), other, "another wallet's bearer lives");
  // A second sign-out stamped earlier moves nothing back: the moment only goes forward.
  assert.equal(revokeSessions(address, t0 + 30_000), true);
  assert.equal(revokedBefore(address), t0 + 60_000, "an earlier moment recorded later revives nothing");
});

test("the issue moment is the bearer's own, whatever its lifetime, so a shorter or longer TTL never revives or refuses one (review 2026-09-08)", () => {
  const address = "0x6666666666666666666666666666666666666666";
  const t0 = Date.UTC(2026, 8, 7, 9, 0, 0);
  const hour = mintSession(address, t0, 3600e3);
  assert.deepEqual(sessionOf(hour.token, t0 + 1), { address, issuedAt: t0, expiresAt: t0 + 3600e3 }, "an hour's bearer says when it was issued");
  assert.equal(verifySession(hour.token, t0 + 3600e3 + 1), null, "and expires after its hour");
  const month = mintSession(address, t0 - 1000, 30 * 24 * 3600e3);
  assert.equal(revokeSessions(address, t0 + 1000), true);
  assert.equal(verifySession(hour.token, t0 + 2000), null, "issued before the sign-out: dead, though its expiry less a week would read as issued in the future");
  assert.equal(verifySession(month.token, t0 + 2000), null, "issued before the sign-out: dead, though its expiry less a week would read as issued long after");
  assert.equal(verifySession(mintSession(address, t0 + 1000, 3600e3).token, t0 + 2000), address, "issued at the moment, an hour's life: passes");
  // The two-field shape from before 2026-09-08 (address:expiry) still verifies, read as issued a week before its
  // expiry, so nobody was signed out by the deploy; delete with the fallback after 2026-09-15.
  const legacy = (addr: string, exp: number): string => {
    const payload = Buffer.from(`${addr}:${exp}`).toString("base64url");
    return `${payload}.${createHmac("sha256", TEST_SESSION_SECRET).update(payload).digest("base64url")}`;
  };
  const other = "0x7777777777777777777777777777777777777777";
  assert.deepEqual(sessionOf(legacy(other, t0 + SESSION_TTL_MS), t0 + 1), { address: other, issuedAt: t0, expiresAt: t0 + SESSION_TTL_MS }, "the old shape, read as issued a week before its expiry");
  assert.equal(verifySession(legacy(other, t0 + SESSION_TTL_MS), t0 + 1), other);
  assert.equal(verifySession(legacy(other, t0 - 1), t0), null, "expired");
  assert.equal(verifySession(legacy(other, t0 + SESSION_TTL_MS).slice(0, -2) + "zz", t0 + 1), null, "tampered");
  assert.equal(sessionOf(`${Buffer.from(`${other}:1:2:3`).toString("base64url")}.x`, 1), null, "four fields is no bearer");
});

test("the sign-out's own bearer always dies, a clock step backwards included; a bearer minted after lives (review 2026-09-08)", () => {
  assert.equal(revocationMoment(1000), 1000);
  assert.equal(revocationMoment(1000, 500), 1000, "the caller was issued before now: now");
  assert.equal(revocationMoment(1000, 1000), 1001, "issued at now (the clock stepped back to it): one past");
  assert.equal(revocationMoment(1000, 1500), 1501, "issued after now (the clock stepped back past it): one past its issue");
  assert.equal(revocationMoment(1000, Number.NaN), 1000);
  const address = "0x8888888888888888888888888888888888888888";
  const t = Date.UTC(2026, 8, 7, 10, 0, 0);
  const s = mintSession(address, t);
  assert.equal(verifySession(s.token, t), address);
  assert.equal(revokeSessions(address, t, sessionOf(s.token, t)!.issuedAt), true, "signed out at the very moment it was minted (the clock stepped back)");
  assert.equal(verifySession(s.token, t + 1), null, "the bearer that asked to be revoked is dead");
  assert.equal(verifySession(mintSession(address, t + 1).token, t + 2), address, "the next millisecond's sign-in lives");
});

test("a revocation row stamped ahead of the clock revokes what existed at load, not the future, and a row another process wrote is read within the reload window", () => {
  assert.equal(cappedMoment(5000, 4000), 4000);
  assert.equal(cappedMoment(3000, 4000), 3000);
  const address = "0x9999999999999999999999999999999999999999";
  // Written straight to the ledger, as another process (or a hand edit) would: a day ahead of the clock.
  const clock = Date.now() + 10_000;
  const ahead = clock + 24 * 3600e3;
  assert.equal(appendLedger("obs-accounts.jsonl", { address, revokedBefore: ahead, at: ahead }), true);
  assert.equal(revokedBefore(address, clock), clock, "read on the next check, capped at the clock");
  assert.equal(verifySession(mintSession(address, clock - 1).token, clock), null, "what existed before the load is revoked");
  assert.equal(verifySession(mintSession(address, clock).token, clock + 1), address, "a bearer minted now passes: the wallet is not locked out until tomorrow");
  assert.equal(verifySession(mintSession(address, clock + 60_000).token, clock + 61_000), address);
});
