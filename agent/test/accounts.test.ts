import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { mintSession, verifySession, issueChallenge, linkAccount, bearerOf, signInMessage } from "../src/desk/accounts.ts";

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
