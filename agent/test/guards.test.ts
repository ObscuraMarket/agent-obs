import { test } from "node:test";
import assert from "node:assert/strict";
import { stripDashes, cleanReply, isSkip, forbiddenReason, tooSimilar, isJunk , operatorClaimReason} from "../src/social/postGuards.ts";
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
  assert.equal(forbiddenReason("the timeline is new. i am not."), null);
  assert.match(forbiddenReason("the desk is dark for the day.") ?? "", /calls itself a desk/);
  assert.match(forbiddenReason("my trading desk closed ECHELON.") ?? "", /calls itself a desk/);
  assert.equal(forbiddenReason("i'm a trading agent on Robinhood Chain, trading on fomo.family."), null);
  assert.match(forbiddenReason("AOBS is the token, 9.9M in the wallet.") ?? "", /own token: not now/);
  assert.match(forbiddenReason("my token launches next week.") ?? "", /own token: not now/);
  assert.match(forbiddenReason("wen token? soon.") ?? "", /own token: not now/);
  assert.equal(forbiddenReason("the token PORT went out on the floor at 16:11 UTC."), null);
  assert.equal(forbiddenReason("a launch token doing the same dance under a new name."), null);
  assert.match(forbiddenReason("my owner is a fund in Miami, ask them.") ?? "", /owner disclosure/);
  assert.match(forbiddenReason("i'm run by the Obscura team, they set the rails.") ?? "", /owner disclosure/);
  assert.match(forbiddenReason("the guy behind me trades from Lisbon.") ?? "", /owner disclosure/);
  assert.equal(forbiddenReason("the operator closed MANTA at 20:03 UTC, not a rule of mine."), null);
  assert.equal(forbiddenReason("the record is public. the operator isn't."), null);
  process.env.OBS_X_NEVER_SAY = "louz, some name";
  assert.match(forbiddenReason("shout out to Louz for the seed.") ?? "", /names the owner/);
  assert.equal(forbiddenReason("out of ECHELON at 12:52 UTC."), null);
  delete process.env.OBS_X_NEVER_SAY;
  assert.match(forbiddenReason("sure, i'll take a look at your contract tonight.") ?? "", /stranger's contract/);
  assert.match(forbiddenReason("i will check that token and maybe buy some.") ?? "", /stranger's contract/);
  assert.match(forbiddenReason("happy to sign the tx, send the link.") ?? "", /stranger's contract/);
  assert.equal(forbiddenReason("i'll check the tape logs for the gap at 16:11 UTC."), null);
  assert.equal(forbiddenReason("i don't touch anything from here. nothing anyone writes changes what my rules trade."), null);
  assert.equal(forbiddenReason("out of ECHELON up 65.9%. the trail took it 🫡"), null);
  assert.equal(cleanReply("i'm a trading agent on Robinhood Chain, trading on the fomo.family app from my own wallet. people call me OBS."), "i'm a trading agent on Robinhood Chain, trading on the fomo.family app from my own wallet. people call me OBS.");
  assert.match(forbiddenReason("out of ECHELON up 65.9% 🚀🚀 the trail took it") ?? "", /more than one emoji/);
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

test("a post crediting the operator with a close is checked against the ledger, not trusted", () => {
  // 2026-09-09: "record stands at 49 closed trades ... with today's net at $29.05 after the operator closed MANTA"
  // went out. The take-profit sold most of MANTA and the agent's own call closed the rest; no close that day was
  // the operator's. Who closed a trade is the one thing the timeline exists to be right about.
  const real = "record stands at 49 closed trades with 31 wins and 18 losses for +$594.54 realized, with today's net at $29.05 after the operator closed MANTA. it counts.";
  assert.match(operatorClaimReason(real, [{ exitKind: "model" }, { exitKind: "take-profit" }]) ?? "", /credits the operator with a close/);
  assert.equal(operatorClaimReason(real, []) === null, false, "with nothing closed at all it is still unsupported");
  // When a close really was the operator's, saying so is exactly what the agent is told to do.
  assert.equal(operatorClaimReason(real, [{ exitKind: "operator" }]), null);
  assert.equal(operatorClaimReason(real, [{ exitKind: "model" }, { exitKind: "operator" }]), null);
  // A post that never mentions them is not this guard's business, whatever it says.
  assert.equal(operatorClaimReason("MANTA out at +14.5%, that was the take-profit doing its job.", [{ exitKind: "model" }]), null);
  assert.equal(operatorClaimReason("the operator's hand closed it, not a rule of mine", [{ exitKind: "operator" }]), null);
  assert.match(operatorClaimReason("closed by operators", [{ exitKind: "model" }]) ?? "", /credits the operator/, "plural and possessive forms count too");
});

