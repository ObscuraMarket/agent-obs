import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeString, decodeUint, formatSupply, readsBlock, balanceOfData, fromRaw, marketLine, usdPrice, marketSeries, change24h, walletBalances } from "../src/obscura/reads.ts";

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
    token: { address: "0xabc", name: "Obscura", symbol: "OBS", decimals: 18, totalSupply: "1,000,000,000", holders: 3261 , explorerPriceUsd: null, volume24hUsd: null, marketCapUsd: null },
    prices: { btcUsd: null, ethUsd: 4321.5 },
    siteUp: true,
    apiUp: false,
    wallet: { address: "0xabc", ethRobinhood: 0.25, ethMainnet: null, usdg: 120.5, obs: 0, usdc: null, usdt: null, nvda: null, rewards: { swaps: 2, volumeUsd: 480, rewardsUsd: 1.2, paidUsd: 0 } },
    market: null,
  });
  assert.ok(!/own market/.test(block), "an unread market is absent, not zero");
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

test("the market line carries the pool price and its depth, sized for a small token", () => {
  const line = marketLine({ venue: "ramses-v3", feePct: 2, priceUsd: 0.0004814205, depthUsd2pct: 202.31, liquidity: "1", at: 0 });
  assert.equal(line, "OBS at $0.000481 on its own market (its USDG pool on Ramses, 2% tier); about $202.31 of buying moves the price 2%.");
  assert.equal(usdPrice(2445.5150231686607), "$2,445.52");
  assert.equal(usdPrice(0.5), "$0.5");
  assert.ok(!/—/.test(line));
});

test("the price series is windowed, thinned and keeps its last sample; the day change needs two samples", () => {
  const H = 3600e3;
  const rows = Array.from({ length: 1000 }, (_, i) => ({ at: i * 60e3, priceUsd: 0.0004 + i * 1e-7, depthUsd2pct: 200 }));
  const now = 999 * 60e3;
  const week = marketSeries(rows, 7 * 24 * H, now, 100);
  assert.ok(week.length <= 101 && week.length >= 100, `thinned to about 100, got ${week.length}`);
  assert.equal(week[week.length - 1].at, rows[rows.length - 1].at, "the newest sample survives thinning");
  assert.equal(week[0].at, 0);
  const hour = marketSeries(rows, H, now);
  assert.equal(hour.length, 61);
  assert.equal(change24h([], now), null);
  assert.equal(change24h([rows[0]], now), null);
  const c = change24h(rows, now) as number;
  assert.ok(Math.abs(c - (rows[999].priceUsd - rows[0].priceUsd) / rows[0].priceUsd) < 1e-12);
});

test("wallet balances fold every registered token in, keep unread ones absent, and never double count the named ones", () => {
  const w = { address: "0xabc", ethRobinhood: 0.4, ethMainnet: 0.01, usdg: 12, obs: null, usdc: 5, usdt: null, nvda: 0.5, rewards: null,
    tokens: { "USDC@erc20": 5, "USDT@erc20": null, "NVDA@robinhood": 0.5, "WBTC@erc20": 0.001, "LINK@erc20": null, "DAI@erc20": 20 } };
  const b = walletBalances(w);
  assert.equal(b.byKey["USDC@erc20"], 5);
  assert.equal(b.byKey["WBTC@erc20"], 0.001);
  assert.equal(b.bySymbol.DAI, 20);
  assert.ok(Math.abs(b.bySymbol.ETH - 0.41) < 1e-12, "ETH across both chains is one symbol");
  assert.ok(b.unread.includes("USDT@erc20") && b.unread.includes("LINK@erc20") && b.unread.includes("OBS@robinhood"));
  assert.equal(Object.keys(b.byKey).filter((k) => k === "USDC@erc20").length, 1);
  const own = walletBalances({ ...w, own: { symbol: "AOBS", contract: "0x47", qty: 9_900_000 } });
  assert.equal(own.bySymbol.AOBS, 9_900_000, "the desk's own token is wallet value on the book");
  assert.equal(own.byKey["AOBS@robinhood"], 9_900_000);
  assert.ok(walletBalances({ ...w, own: { symbol: "AOBS", contract: "0x47", qty: null } }).unread.includes("AOBS@robinhood"), "unanswered is unread, not zero");
});
