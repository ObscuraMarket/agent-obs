import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { scoreLaunch, launchVerdict, launchLine, decodeLaunchCall, launchRulesFromEnv, launchRulesForRecord, ROUTER_ABI, type LaunchFacts } from "../src/desk/launch.ts";

test("a token with a trading record is read on the hard rules only: no socials and no score bar, the dev buy and the bundle still count", () => {
  const rules = launchRulesFromEnv({} as NodeJS.ProcessEnv);
  const record = launchRulesForRecord(rules);
  assert.equal(record.requireSocials, false);
  assert.equal(record.minScore, 0);
  assert.equal(record.maxDevSharePct, rules.maxDevSharePct);
  assert.equal(record.maxExempt, rules.maxExempt);
  assert.equal(rules.requireSocials, true, "the launch-day rules are untouched");
});

const R = launchRulesFromEnv({} as NodeJS.ProcessEnv);
const base: LaunchFacts = {
  token: "0xtoken", symbol: "TOK", at: 1, exists: true, phase: 0, deployer: "0xdev", curve: "0xcurve", feeRecipient: "0xdev", feeToThirdParty: false,
  creatorTaxBps: 100, pairToken: "0x0000000000000000000000000000000000000000", devBuyQuote: 0.05, devSharePct: 2.5, exemptions: [],
  socials: { twitter: true, website: true, telegram: false }, descriptionLen: 80, deployerPrior: 0, deployerGraduated: 0, earlyBuys: 20, earlyBuyers: 12, earlyTaxedBuys: 3, unread: [],
};

test("a clean launch scores high and passes: dev buy in the band, low tax, links, no bundle, fresh deployer, organic first minute", () => {
  const s = scoreLaunch(base);
  assert.equal(s.total, 100, "50 + 15 + 10 + 8 + 8 + 4 + 5 + 5 + 10 clamps to 100");
  assert.equal(s.reasons.length, 8, "one reason per scored fact; a first-party fee recipient and a missing telegram add none");
  const v = launchVerdict(base, s, R);
  assert.equal(v.ok, true, v.why);
  const line = launchLine({ ...base, score: s, verdict: v });
  assert.match(line, /^Launch TOK: pons v2, on its curve; dev buy 2\.50% of supply for 0\.0500 of the pair; creator tax 1%, fees to the deployer; no wallets exempt from the opening tax; an X link, a website; a fresh deployer; first minute 20 buys from 12 wallets, 3 paid the opening tax\. Score 100/);
  assert.match(line, /LAUNCH OK\.$/);
});

test("a declared bundle, a heavy dev buy and a serial deployer each fail the gate on their own", () => {
  const bundle = { ...base, exemptions: ["0xa", "0xb", "0xc", "0xd"] };
  assert.match(launchVerdict(bundle, scoreLaunch(bundle), R).why, /4 wallets were exempted from the opening tax \(2 allowed\)/);
  const heavy = { ...base, devSharePct: 12.5 };
  assert.match(launchVerdict(heavy, scoreLaunch(heavy), R).why, /dev buy is 12\.5% of supply \(8% allowed\)/);
  assert.ok(scoreLaunch(heavy).reasons.some((r) => r.startsWith("-25 dev buy")));
  const serial = { ...base, deployerPrior: 185, deployerGraduated: 0 };
  assert.match(launchVerdict(serial, scoreLaunch(serial), R).why, /serial deployer: 185 launches in the window, none graduated/);
  const swept = { ...base, phase: 1 };
  assert.match(launchVerdict(swept, scoreLaunch(swept), R).why, /swept/);
  const noLinks = { ...base, socials: { twitter: false, website: false, telegram: false } };
  assert.match(launchVerdict(noLinks, scoreLaunch(noLinks), R).why, /no X link, website or telegram/);
  assert.equal(launchVerdict(noLinks, scoreLaunch(noLinks), launchRulesFromEnv({ OBS_LAUNCH_REQUIRE_SOCIALS: "off", OBS_LAUNCH_MIN_SCORE: "0" } as unknown as NodeJS.ProcessEnv)).ok, true, "the socials rule is a switch");
});

test("bots-only first minutes and every-buy-taxed launches lose points; a graduated pool reads as such", () => {
  const bots = { ...base, earlyBuys: 9, earlyBuyers: 3, earlyTaxedBuys: 9 };
  assert.ok(scoreLaunch(bots).reasons.some((r) => /bots only/.test(r)));
  const pool = { ...base, phase: 2 };
  assert.match(launchLine({ ...pool, score: scoreLaunch(pool), verdict: launchVerdict(pool, scoreLaunch(pool), R) }), /graduated to its pool/);
});

test("a token the factory does not know passes with no launch read, and unread fields are said", () => {
  const other = { ...base, exists: false };
  assert.equal(launchVerdict(other, null, R).ok, true);
  assert.match(launchLine({ ...other, score: null, verdict: launchVerdict(other, null, R) }), /not a pons v2 launch, so no launch read/);
  const partial = { ...base, devSharePct: null, devBuyQuote: null, exemptions: null, unread: ["the launch transaction"] };
  const line = launchLine({ ...partial, score: scoreLaunch(partial), verdict: launchVerdict(partial, scoreLaunch(partial), R) });
  assert.match(line, /not read: the launch transaction/);
});

test("the launcher's buy and exemptions decode from launchAndBuy calldata", () => {
  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "launchAndBuy",
    args: [
      { name: "Tok", symbol: "TOK", logo: "", description: "", socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" }, creatorFeeRecipient: "0x000000000000000000000000000000000000dEaD", creatorTaxBps: 100, buybackEnabled: false, expectedEconomics: `0x${"0".repeat(64)}`, salt: `0x${"0".repeat(64)}` },
      0n,
      "0x0000000000000000000000000000000000000000",
      50_000_000_000_000_000n,
      0n,
      "0x000000000000000000000000000000000000dEaD",
      ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"],
    ],
  });
  const d = decodeLaunchCall(data);
  assert.ok(d);
  assert.equal(d.quoteIn, 50_000_000_000_000_000n);
  assert.deepEqual(d.exemptions, ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000b2"]);
  assert.equal(decodeLaunchCall("0x12345678"), null, "another path decodes to nothing");
});
