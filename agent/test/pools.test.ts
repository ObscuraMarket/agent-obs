import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toFunctionSelector } from "viem";
import { chainMemory, priceFromSqrtPriceX96, depthToken0At2pct, depthToken1At2pct, decodeSlot0, decodeWord, SEL } from "../src/obscura/pools.ts";
import { OBS_CONTRACT, USDG_CONTRACT } from "../src/config.ts";

// The Ramses V3 USDG/OBS pool as read on 2026-09-01: the number the memory file carries.
const RAMSES_SQRT_P = 3610914961881416418765601521652359028n;
const RAMSES_L = 926641070858788185n;

test("a Q64.96 square-root price decodes to the price the pool means", () => {
  assert.equal(priceFromSqrtPriceX96(2n ** 96n, 18, 18), 1);
  // USDG (6) against OBS (18): token1 per token0 is OBS per dollar, so the dollar price is its inverse.
  const obsPerUsdg = priceFromSqrtPriceX96(RAMSES_SQRT_P, 6, 18);
  const usd = 1 / obsPerUsdg;
  assert.ok(usd > 0.00048 && usd < 0.000483, `OBS at ${usd}`);
});

test("depth is the dollars that move the active tick 2%, and nothing when nothing is in range", () => {
  const d = depthToken0At2pct(RAMSES_L, RAMSES_SQRT_P, 6);
  assert.ok(d > 195 && d < 210, `depth ${d}`);
  assert.equal(depthToken0At2pct(0n, RAMSES_SQRT_P, 6), 0);
  assert.equal(depthToken0At2pct(RAMSES_L, 0n, 6), 0);
  // The other side: at price 1 with L = 1e18, a 2% move takes sqrt(1.02) - 1 of token1.
  const d1 = depthToken1At2pct(10n ** 18n, 2n ** 96n, 18);
  assert.ok(Math.abs(d1 - (Math.sqrt(1.02) - 1)) < 1e-12, `depth1 ${d1}`);
  assert.equal(depthToken1At2pct(0n, 2n ** 96n, 18), 0);
});

test("slot0 decodes the same from StateView (four words) and a v3-style pool (seven words)", () => {
  const sqrt = RAMSES_SQRT_P.toString(16).padStart(64, "0");
  const negTick = ((1n << 256n) - 5n).toString(16); // tick -5, two's complement
  const four = "0x" + sqrt + negTick + "0".repeat(128);
  const seven = "0x" + sqrt + negTick + "0".repeat(320);
  assert.deepEqual(decodeSlot0(four), { sqrtPriceX96: RAMSES_SQRT_P, tick: -5 });
  assert.deepEqual(decodeSlot0(seven), { sqrtPriceX96: RAMSES_SQRT_P, tick: -5 });
  assert.equal(decodeSlot0("0x1234"), null);
  assert.equal(decodeWord("0x" + "0".repeat(63) + "a"), 10n);
  assert.equal(decodeWord("0x12"), null);
});

test("the selectors are the real ones", () => {
  assert.equal(SEL.getSlot0, toFunctionSelector("getSlot0(bytes32)"));
  assert.equal(SEL.slot0, toFunctionSelector("slot0()"));
  assert.equal(SEL.getLiquidity, toFunctionSelector("getLiquidity(bytes32)"));
  assert.equal(SEL.liquidity, toFunctionSelector("liquidity()"));
});

test("the chain memory is well formed and names the market OBS actually has", () => {
  const raw = readFileSync(join(import.meta.dirname, "..", "obs-chain.json"), "utf8");
  assert.ok(!raw.includes("—"), "no em dashes in the memory file");
  for (const hex of raw.match(/0x[0-9a-fA-F]+/g) ?? []) {
    assert.ok(hex === hex.toLowerCase(), `${hex} is lowercase`);
    assert.ok(hex.length === 42 || hex.length === 66, `${hex} is an address or a pool id`);
  }
  const m = chainMemory();
  assert.equal(m.chain.id, 4663);
  const p = m.obsMarket.primary;
  assert.equal(p.venue, "ramses-v3");
  assert.equal(p.token0, "USDG");
  assert.equal(p.token1, "OBS");
  assert.equal(p.usdToken, 0);
  assert.deepEqual([p.decimals0, p.decimals1], [6, 18]);
  assert.equal((m.tokens.OBS as { address: string }).address, OBS_CONTRACT);
  assert.equal((m.tokens.USDG as { address: string }).address, USDG_CONTRACT.toLowerCase());
  assert.ok(p.measured.priceUsd > 0 && p.measured.usdgDepth2pct > 0);
  assert.equal(m.obsMarket.uniswapV4Dust.pools.length, 10);
  assert.ok(m.obsMarket.uniswapV4Dust.pools.every((d) => d.usdgDepth2pct < 1), "the v4 pools are dust");
  for (const [label, spec] of Object.entries(m.referencePools)) {
    assert.equal(spec.venue, "uniswap-v4", label);
    assert.match(spec.id ?? "", /^0x[0-9a-f]{64}$/, label);
    assert.ok(spec.usdToken === 0 || spec.usdToken === 1, `${label} names its dollar side`);
    assert.ok(Number.isInteger(spec.decimals0) && Number.isInteger(spec.decimals1), `${label} carries both decimals`);
    assert.equal([spec.token0, spec.token1][spec.usdToken], "USDG", `${label}: the dollar side is USDG`);
  }
});
