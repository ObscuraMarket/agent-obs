import { test } from "node:test";
import assert from "node:assert/strict";
import { stripDashes, cleanReply, isSkip, forbiddenReason, tooSimilar, isJunk } from "../src/social/postGuards.ts";
import { OBS_CONTRACT } from "../src/config.ts";

test("dashes used as punctuation become commas", () => {
  assert.equal(stripDashes("private by default — settled to your wallet"), "private by default, settled to your wallet");
  assert.equal(stripDashes("one route – many venues"), "one route, many venues");
});

test("cleanReply keeps a domain intact and strips format markers", () => {
  assert.equal(cleanReply("POST: Verify the contract on obscura.market before anything else. Then trade."), "Verify the contract on obscura.market before anything else. Then trade.");
  assert.equal(cleanReply('"Quotes are stripped."'), "Quotes are stripped.");
  // The self-echo shape the gateway sometimes returns.
  assert.equal(cleanReply("Route and size stay private.route and size stay private."), "Route and size stay private.");
  // A number with a decimal is one number, not a sentence break.
  assert.equal(cleanReply("Cashback moves from 0.25% to 0.5% at the top tier."), "Cashback moves from 0.25% to 0.5% at the top tier.");
});

test("a declined reply is recognised however the model phrases it", () => {
  assert.equal(isSkip("SKIP"), true);
  assert.equal(isSkip("**SKIP** pure bait"), true);
  assert.equal(isSkip("I'm skipping this one, it is price hype."), true);
  assert.equal(isSkip(""), true);
  assert.equal(isSkip("You can skip the manual step and let the route settle."), false);
});

test("the hard boundaries catch what the prompt forbids", () => {
  assert.match(forbiddenReason("The presale opens Friday.") ?? "", /token sale vocabulary/);
  assert.match(forbiddenReason("Send it to 0x000000000000000000000000000000000000dEaD and wait.") ?? "", /not the token/);
  assert.equal(forbiddenReason(`The token lives at ${OBS_CONTRACT} and the site shows it.`), null);
  assert.match(forbiddenReason("Obscura partnered with Robinhood on this.") ?? "", /affiliation/);
  assert.match(forbiddenReason("i'm new to this so be gentle with the record.") ?? "", /newcomer/);
  assert.match(forbiddenReason("just started trading launches and already down.") ?? "", /newcomer/);
  assert.equal(forbiddenReason("the timeline is new. the desk is not."), null);
  assert.equal(forbiddenReason("a new token on the board, nothing new about the dance."), null);
  assert.match(forbiddenReason("Dark Orders are coming soon.") ?? "", /timing hint/);
  assert.match(forbiddenReason("We will burn a slice of supply next month.") ?? "", /future burn/);
  assert.match(forbiddenReason("Use it to get around KYC.") ?? "", /illicit-use/);
  assert.match(forbiddenReason("This is not financial advice but it is guaranteed.") ?? "", /advice or price promise/);
  // Ordinary product facts pass.
  assert.equal(forbiddenReason("No account, no KYC, settled straight to your own wallet. Cashback lands monthly as tokenized stocks on Robinhood Chain."), null);
  assert.equal(forbiddenReason("The 0.25% cashback rate scales with 30-day volume."), null);
});

test("near-duplicates are caught by word overlap", () => {
  const recent = ["A public order tells everyone the pair, the size, and that you are in a hurry."];
  assert.ok(tooSimilar("A public order tells the whole book the pair, the size and that you are in a hurry.", recent));
  assert.equal(tooSimilar("Tokenized stocks trade on Sunday night while the underlying is closed.", recent), null);
});

test("junk filter catches promo spray", () => {
  assert.equal(isJunk("100x gem, presale live, dm me"), true);
  assert.equal(isJunk("How does the cashback settle if I pick a diversified mix?"), false);
});
