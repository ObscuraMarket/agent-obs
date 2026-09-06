import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, decodeFunctionData, parseAbi } from "viem";
import { routeFor, exactInWithinTick, encodeSwap, NATIVE, currencyOf, clampToBalanceRaw } from "../src/desk/onchain.ts";

test("a sell never asks for more than the wallet holds: the book's float of the balance is clamped to the raw balance", () => {
  // ZZZ on 2026-09-06: the book said 3214.471565954562, the wallet held 409,069 wei less, and the sell reverted with TRANSFER_FROM_FAILED.
  const balance = 3214471565954561590931n;
  const asked = 3214471565954562000000n;
  assert.equal(clampToBalanceRaw(asked, balance), balance);
  assert.equal(clampToBalanceRaw(1000n, balance), 1000n, "a partial sell is untouched");
  assert.equal(clampToBalanceRaw(asked, 0n), 0n, "nothing held, nothing sent");
});
import { resolveAsset } from "../src/desk/assets.ts";

const ETH = resolveAsset("ETH@robinhood")!;
const NVDA = resolveAsset("NVDA@robinhood")!;
const USDG = resolveAsset("USDG@robinhood")!;
const Q96 = 2n ** 96n;

test("routes go through USDG: two hops between ETH and NVDA, one when USDG is a side, none off the chain", () => {
  const buy = routeFor(ETH, NVDA)!;
  assert.deepEqual(buy.hops.map((h) => [h.key, h.zeroForOne, h.fee, h.tickSpacing]), [["ETH/USDG", true, 100, 1], ["NVDA/USDG", true, 3000, 60]]);
  assert.equal(buy.currencyIn, NATIVE);
  assert.equal(buy.hops[1].currencyOut, currencyOf(NVDA));
  const sell = routeFor(NVDA, ETH)!;
  assert.deepEqual(sell.hops.map((h) => [h.key, h.zeroForOne]), [["NVDA/USDG", false], ["ETH/USDG", false]]);
  assert.equal(sell.hops[1].currencyOut, NATIVE);
  assert.equal(routeFor(USDG, NVDA)!.hops.length, 1);
  assert.equal(routeFor(ETH, resolveAsset("USDC@erc20")!), null, "not on Robinhood Chain");
  assert.equal(routeFor(ETH, ETH), null);
});

test("exact-in within the tick: fee comes off first, output bends with size, both directions agree with the closed form", () => {
  const L = 10n ** 30n;
  const tiny = 10n ** 18n;
  const { out } = exactInWithinTick(tiny, Q96, L, 3000, true);
  const expected = Number(tiny) * 0.997 * (1 - Number(tiny) * 0.997 / Number(L));
  assert.ok(Math.abs(Number(out) - expected) / expected < 1e-9, `got ${out}, expected about ${expected}`);
  const { out: other } = exactInWithinTick(tiny, Q96, L, 3000, false);
  assert.ok(Math.abs(Number(other) - expected) / expected < 1e-9, "the other direction at price 1 gives the same");
  const big = exactInWithinTick(L / 2n, Q96, L, 0, true).out;
  assert.ok(Number(big) < Number(L) / 2, "a large trade gets less than the mid price would give");
  assert.deepEqual(exactInWithinTick(tiny, Q96, 0n, 0, true), { out: 0n, sqrtPAfter: Q96 }, "no liquidity, no output");
});

test("the router call has the fork's shape: V4_SWAP, three actions, a tuple-wrapped five-field swap, settle open delta, take to the wallet", () => {
  const route = routeFor(ETH, NVDA)!;
  const wallet = "0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38" as const;
  const tx = encodeSwap(route, 10n ** 16n, 5n * 10n ** 16n, wallet, 1_800_000_000n, "0x8876789976dEcBfCbBbe364623C63652db8C0904");
  assert.equal(tx.value, 10n ** 16n, "native in rides as value");
  const call = decodeFunctionData({ abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]), data: tx.data });
  assert.equal(call.functionName, "execute");
  const [commands, inputs, deadline] = call.args as [`0x${string}`, `0x${string}`[], bigint];
  assert.equal(commands, "0x10");
  assert.equal(deadline, 1_800_000_000n);
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]) as [`0x${string}`, `0x${string}`[]];
  assert.equal(actions, "0x070b0e");
  assert.equal(params.length, 3);
  assert.equal(params[0].slice(2, 66), "20".padStart(64, "0"), "the swap params are tuple-wrapped: a leading offset word");
  const [swap] = decodeAbiParameters(
    [{ type: "tuple", components: [{ name: "currencyIn", type: "address" }, { name: "path", type: "tuple[]", components: [{ name: "intermediateCurrency", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }, { name: "hookData", type: "bytes" }] }, { name: "extra", type: "bytes" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }] }],
    params[0],
  ) as [{ currencyIn: string; path: Array<{ intermediateCurrency: string; fee: number; tickSpacing: number; hooks: string; hookData: string }>; extra: string; amountIn: bigint; amountOutMinimum: bigint }];
  assert.equal(swap.currencyIn, NATIVE);
  assert.equal(swap.path.length, 2);
  assert.equal(swap.path[0].intermediateCurrency.toLowerCase(), USDG.contract!.toLowerCase());
  assert.equal(swap.path[1].intermediateCurrency.toLowerCase(), NVDA.contract!.toLowerCase());
  assert.deepEqual(swap.path.map((p) => [p.fee, p.tickSpacing, p.hooks, p.hookData]), [[100, 1, NATIVE, "0x"], [3000, 60, NATIVE, "0x"]]);
  assert.equal(swap.extra, "0x", "the fork's extra empty bytes field sits before the amounts");
  assert.equal(swap.amountIn, 10n ** 16n);
  assert.equal(swap.amountOutMinimum, 5n * 10n ** 16n);
  const [sc, sa, payer] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], params[1]) as [string, bigint, boolean];
  assert.deepEqual([sc, sa, payer], [NATIVE, 0n, true], "settle the open delta, the user pays");
  const [tc, tr, ta] = decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], params[2]) as [string, string, bigint];
  assert.deepEqual([tc.toLowerCase(), tr, ta], [NVDA.contract!.toLowerCase(), wallet, 0n], "take the whole credit to the wallet");
  const sell = encodeSwap(routeFor(NVDA, ETH)!, 10n ** 17n, 1n, wallet, 1n, "0x8876789976dEcBfCbBbe364623C63652db8C0904");
  assert.equal(sell.value, 0n, "an ERC-20 in rides through Permit2, no value");
});
