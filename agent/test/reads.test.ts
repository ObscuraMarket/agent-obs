import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeString, decodeUint, formatSupply, readsBlock, balanceOfData, fromRaw } from "../src/obscura/reads.ts";

// ABI-encoded "Obscura" as returned by name() on the real contract.
const NAME_HEX =
  "0x" +
  "0000000000000000000000000000000000000000000000000000000000000020" +
  "0000000000000000000000000000000000000000000000000000000000000007" +
  "4f62736375726100000000000000000000000000000000000000000000000000";

test("ABI string and uint returns decode", () => {
  assert.equal(decodeString(NAME_HEX), "Obscura");
  assert.equal(decodeString("0x1234"), null);
  assert.equal(decodeUint("0x" + "0".repeat(62) + "12"), 18n);
  assert.equal(decodeUint("0x12"), null);
});

test("supply formats to whole tokens", () => {
  assert.equal(formatSupply(1_000_000_000n * 10n ** 18n, 18), "1,000,000,000");
});

test("the reads block only carries measured values", () => {
  const block = readsBlock({
    at: 0,
    token: { address: "0xabc", name: "Obscura", symbol: "OBS", decimals: 18, totalSupply: "1,000,000,000", holders: 3261 },
    prices: { btcUsd: null, ethUsd: 4321.5 },
    siteUp: true,
    apiUp: false,
    wallet: { address: "0xabc", ethRobinhood: 0.25, ethMainnet: null, usdg: 120.5, obs: 0, rewards: { swaps: 2, volumeUsd: 480, rewardsUsd: 1.2, paidUsd: 0 } },
  });
  assert.match(block, /Obscura \(OBS\), total supply 1,000,000,000, 3,261 holders/);
  assert.match(block, /wallet \(on chain\): 0\.25 ETH on Robinhood Chain, not read ETH on Ethereum, 120\.5 USDG, 0 OBS/);
  assert.match(block, /cashback for this wallet: 2 swaps, \$480 volume, \$1\.2 earned, \$0 paid out/);
  assert.equal(balanceOfData("0xfe242d1da8fd04f6a1f80b6d3d807b02e062ad4e"), "0x70a08231000000000000000000000000fe242d1da8fd04f6a1f80b6d3d807b02e062ad4e");
  assert.equal(fromRaw(1_500_000n, 6), 1.5);
  assert.match(block, /ETH 4,322 USD/);
  assert.ok(!/BTC/.test(block), "an unmeasured price is absent, not zero");
  assert.match(block, /up and answering/);
  assert.match(block, /did not answer/);
  assert.ok(!/—/.test(block));
});
