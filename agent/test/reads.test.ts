import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeString, decodeUint, formatSupply, readsBlock } from "../src/obscura/reads.ts";

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
  });
  assert.match(block, /Obscura \(OBS\), total supply 1,000,000,000, 3,261 holders/);
  assert.match(block, /ETH 4,322 USD/);
  assert.ok(!/BTC/.test(block), "an unmeasured price is absent, not zero");
  assert.match(block, /up and answering/);
  assert.match(block, /did not answer/);
  assert.ok(!/—/.test(block));
});
