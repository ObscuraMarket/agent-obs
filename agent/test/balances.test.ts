import "./tmpdata.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeFunctionResult, type Hex } from "viem";
import { robinhoodBalances, MULTICALL3, MULTICALL_ABI } from "../src/obscura/reads.ts";

const HOLDER = "0x2dA43C49cE0af0e463CB581202b000E2B8a52b5d";
const A = "0x000000000000000000000000000000000000aaaa";
const B = "0x000000000000000000000000000000000000bbbb";
const C = "0x000000000000000000000000000000000000cccc";
const uint = (v: bigint): Hex => encodeAbiParameters([{ type: "uint256" }], [v]);

test("the wallet's token balances come back in one Multicall3 call, one bad token reading as unread, never zero", async () => {
  // Review 2026-09-10: about 46 paced calls, 19 s on a good day and past the 90 s deadline on a slow RPC, which skipped the forced exits.
  const calls: string[] = [];
  const call = async (to: string) => {
    calls.push(to);
    return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", result: [
      { success: true, returnData: uint(1_500_000_000_000_000_000n) },
      { success: false, returnData: "0x" },
      { success: true, returnData: uint(2_500_000n) },
    ] });
  };
  const got = await robinhoodBalances(HOLDER, [{ contract: A, decimals: 18 }, { contract: B, decimals: 18 }, { contract: C, decimals: 6 }], call);
  assert.deepEqual(got, [1.5, null, 2.5]);
  assert.deepEqual(calls, [MULTICALL3], "one call, to Multicall3");
});

test("when the batch does not answer, each token is read on its own, so it is never worse than before", async () => {
  const calls: string[] = [];
  const call = async (to: string) => {
    calls.push(to);
    if (to === MULTICALL3) return null;
    return to === A ? uint(3n * 10n ** 18n) : null;
  };
  const got = await robinhoodBalances(HOLDER, [{ contract: A, decimals: 18 }, { contract: B, decimals: 18 }], call);
  assert.deepEqual(got, [3, null]);
  assert.deepEqual(calls, [MULTICALL3, A, B]);
  const garbled = await robinhoodBalances(HOLDER, [{ contract: A, decimals: 18 }], async (to) => (to === MULTICALL3 ? "0xdeadbeef" : uint(10n ** 18n)));
  assert.deepEqual(garbled, [1], "an answer that does not decode falls back too");
});

test("a contract that is not an address reads as unread and never spoils the batch", async () => {
  const calls: string[] = [];
  const call = async (to: string) => {
    calls.push(to);
    return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", result: [{ success: true, returnData: uint(10n ** 18n) }] });
  };
  const got = await robinhoodBalances(HOLDER, [{ contract: "", decimals: 18 }, { contract: A, decimals: 18 }], call);
  assert.deepEqual(got, [null, 1]);
  assert.equal(calls.length, 1);
  assert.deepEqual(await robinhoodBalances(HOLDER, [], call), []);
});
