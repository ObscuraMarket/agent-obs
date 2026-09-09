import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { directOn, gasTopUpWei, needsTopUp, WETH } from "../src/desk/direct.ts";
import { checkCalls, callsFromSteps, FOMO_ROUTERS } from "../src/desk/fomo.ts";
import { relayBody } from "../src/obscura/relay.ts";
import { resolveAsset, type Asset } from "../src/desk/assets.ts";

const ETH = resolveAsset("ETH@robinhood") as Asset;
const NVDA = resolveAsset("NVDA@robinhood") as Asset;
const W = "0x1C3CAda24a5BEec97E07aefE3673325C07630F82";
const [TOKEN_ROUTER] = FOMO_ROUTERS;
const ERC20 = parseAbi(["function approve(address spender, uint256 amount)"]);
const approve = (spender: string) => encodeFunctionData({ abi: ERC20, functionName: "approve", args: [spender as `0x${string}`, 2n ** 200n] });

test("the lane is off unless the operator asks, and the top-up is small on purpose", () => {
  assert.equal(directOn({} as NodeJS.ProcessEnv), false);
  assert.equal(directOn({ OBS_SEND: "aa" } as NodeJS.ProcessEnv), false);
  assert.equal(directOn({ OBS_SEND: "DIRECT" } as NodeJS.ProcessEnv), true);
  assert.equal(gasTopUpWei({} as NodeJS.ProcessEnv), 1_500_000_000_000_000n, "0.0015 ETH by default");
  assert.equal(gasTopUpWei({ OBS_DIRECT_GAS_ETH: "0.003" } as NodeJS.ProcessEnv), 3_000_000_000_000_000n);
  assert.equal(gasTopUpWei({ OBS_DIRECT_GAS_ETH: "nonsense" } as NodeJS.ProcessEnv), 1_500_000_000_000_000n);
  // Topped up only when it is genuinely short, so a wallet the sweep has not yet emptied is left alone.
  assert.equal(needsTopUp(0n), true);
  assert.equal(needsTopUp(1_500_000_000_000_000n), false);
  assert.equal(needsTopUp(100_000_000_000_000n), true, "under half the top-up counts as short");
});

test("an ETH leg goes in as WETH, which is what makes an ordinary transaction possible", () => {
  // Native in: the router is called WITH value, so the wallet would need native ETH it does not keep.
  const native = relayBody(ETH, NVDA, 40_000_000_000_000_000n, W);
  assert.equal(native?.originCurrency, "0x0000000000000000000000000000000000000000");
  // Wrapped in: the same route, and the wallet spends a token the app's sweep never touches.
  const wrapped = relayBody(ETH, NVDA, 40_000_000_000_000_000n, W, { wethIn: WETH() });
  assert.equal(wrapped?.originCurrency, WETH());
  assert.equal(wrapped?.amount, native?.amount, "the same amount either way");
  // A token leg is unaffected by the option.
  assert.equal(relayBody(NVDA, ETH, 5n, W, { wethIn: WETH() })?.originCurrency, NVDA.contract);
});

test("the WETH approval a wrapped leg needs is allowed, and nothing else is", () => {
  const swap = { to: TOKEN_ROUTER as `0x${string}`, value: 0n, data: "0xf9e4bab4" as `0x${string}` };
  const wethApprove = { to: WETH() as `0x${string}`, value: 0n, data: approve(TOKEN_ROUTER) as `0x${string}` };
  // Without the option WETH is a stranger, since the from-asset is native ETH and approves nothing.
  assert.match(checkCalls([wethApprove, swap], { from: ETH, maxValueRaw: 0n }).reason ?? "", /not one of its routers/);
  // With it, exactly that approval is expected.
  assert.deepEqual(checkCalls([wethApprove, swap], { from: ETH, maxValueRaw: 0n, approvable: [WETH()] }), { ok: true });
  // And still nothing else: an approval to somewhere that is not a router stays refused.
  const bad = { to: WETH() as `0x${string}`, value: 0n, data: approve("0x00000000000000000000000000000000deadbeef") as `0x${string}` };
  assert.match(checkCalls([bad, swap], { from: ETH, maxValueRaw: 0n, approvable: [WETH()] }).reason ?? "", /not one of its routers/);
  // A wrapped leg carries no value at all, so any value in the batch is refused.
  const rich = { to: TOKEN_ROUTER as `0x${string}`, value: 1n, data: "0xf9e4bab4" as `0x${string}` };
  assert.match(checkCalls([rich], { from: ETH, maxValueRaw: 0n, approvable: [WETH()] }).reason ?? "", /more than the 0 the swap is spending/);
});

test("the route's steps become the transactions to send, in order, the swap last", () => {
  const calls = callsFromSteps({
    amountIn: 0.04, amountInUsd: null, amountOut: 1355719, amountOutUsd: null, rate: null, impactPct: null, feeUsd: null, timeSec: null, raw: {},
    steps: [
      { id: "approve", kind: "transaction", txs: [{ to: WETH(), value: "0", chainId: 4663, data: approve(TOKEN_ROUTER) }] },
      { id: "swap", kind: "transaction", txs: [{ to: TOKEN_ROUTER, value: "0", chainId: 4663, data: "0xf9e4bab4" }] },
    ],
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to.toLowerCase(), WETH().toLowerCase(), "the approval first");
  assert.equal(calls[calls.length - 1].to, TOKEN_ROUTER, "the swap last, and its hash is the one the app reads");
  assert.equal(calls.reduce((n, c) => n + c.value, 0n), 0n, "no value, so the sweep cannot touch the trade");
});
