// The data dir first: linkAccount and revokeSessions write obs-accounts.jsonl, and a test row must never land in
// the real ledger (2026-09-08).
import "./tmpdata.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { mintSession, verifySession, issueChallenge, linkAccount, bearerOf, signInMessage, issuedBeforeRevocation, revokeSessions, revokedBefore } from "../src/desk/accounts.ts";

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
