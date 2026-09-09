import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { fomoOn, maxGiveUpPct, checkCalls, callsFromSteps, valueOf, worthIt, fomoRoute, FOMO_ROUTERS } from "../src/desk/fomo.ts";
import { resolveAsset, type Asset } from "../src/desk/assets.ts";
import type { RelayAnswer, RelayQuote } from "../src/obscura/relay.ts";

const ETH = resolveAsset("ETH@robinhood") as Asset;
const USDG = resolveAsset("USDG@robinhood") as Asset;
const NVDA = resolveAsset("NVDA@robinhood") as Asset;
const [TOKEN_ROUTER, ETH_ROUTER] = FOMO_ROUTERS;
const ERC20 = parseAbi(["function approve(address spender, uint256 amount)", "function transfer(address to, uint256 amount)"]);
const approve = (spender: string) => encodeFunctionData({ abi: ERC20, functionName: "approve", args: [spender as `0x${string}`, 2n ** 200n] });

const quote = (over: Partial<RelayQuote> = {}): RelayQuote => ({
  amountIn: 0.08, amountInUsd: 200, amountOut: 2226, amountOutUsd: 198, rate: null, impactPct: -3.78, feeUsd: 0.67, timeSec: 0,
  steps: [{ id: "swap", kind: "transaction", txs: [{ to: ETH_ROUTER, value: "80000000000000000", chainId: 4663, data: "0xcd6e13f7" }] }],
  raw: {}, ...over,
});
const answer = (q: RelayQuote | null, error: string | null = null): RelayAnswer => ({ status: q ? 200 : 400, quote: q, error });

test("the route is fomo's only when the operator says so, and the give-up has a floor", () => {
  assert.equal(fomoOn({} as NodeJS.ProcessEnv), false);
  assert.equal(fomoOn({ OBS_ROUTE: "pool" } as NodeJS.ProcessEnv), false);
  assert.equal(fomoOn({ OBS_ROUTE: "FOMO" } as NodeJS.ProcessEnv), true);
  assert.equal(maxGiveUpPct({} as NodeJS.ProcessEnv), 6);
  assert.equal(maxGiveUpPct({ OBS_FOMO_MAX_GIVEUP_PCT: "2.5" } as NodeJS.ProcessEnv), 2.5);
  assert.equal(maxGiveUpPct({ OBS_FOMO_MAX_GIVEUP_PCT: "nonsense" } as NodeJS.ProcessEnv), 6);
});

test("a route is taken when it is a few percent worse than the pools, and refused when it is far worse", () => {
  assert.equal(worthIt(2226, 2300, 6).ok, true, "3.2% under: the notification is worth that");
  assert.ok(Math.abs(worthIt(2226, 2300, 6).giveUpPct - 3.217) < 0.01);
  assert.equal(worthIt(2100, 2300, 6).ok, false, "8.7% under: refused");
  assert.match(worthIt(2100, 2300, 6).reason ?? "", /pays 8\.70% less than the pools, over the 6%/);
  assert.equal(worthIt(2400, 2300, 6).ok, true, "better than the pools is never refused");
  assert.equal(worthIt(0, 2300, 6).ok, false);
  assert.equal(worthIt(2226, 0, 6).ok, true, "no pool quote to hold it against: the route stands on its own");
});

test("only fomo's routers, and only an approval of the token going in, are ever signed", () => {
  const swapCall = { to: TOKEN_ROUTER as `0x${string}`, value: 0n, data: "0xf9e4bab4" as `0x${string}` };
  const ok = checkCalls([{ to: NVDA.contract as `0x${string}`, value: 0n, data: approve(TOKEN_ROUTER) as `0x${string}` }, swapCall], { from: NVDA, maxValueRaw: 0n });
  assert.deepEqual(ok, { ok: true }, "approve the token, then the router: what fomo's own trades do");
  assert.equal(checkCalls([], { from: NVDA, maxValueRaw: 0n }).ok, false);
  // A router that is not fomo's is the thing this check exists for.
  const evil = { to: "0x00000000000000000000000000000000deadbeef" as `0x${string}`, value: 0n, data: "0xf9e4bab4" as `0x${string}` };
  assert.match(checkCalls([evil], { from: NVDA, maxValueRaw: 0n }).reason ?? "", /not one of its routers/);
  // An approval to somebody else, hidden behind a legitimate-looking swap, is refused.
  const badSpender = { to: NVDA.contract as `0x${string}`, value: 0n, data: approve("0x00000000000000000000000000000000deadbeef") as `0x${string}` };
  assert.match(checkCalls([badSpender, swapCall], { from: NVDA, maxValueRaw: 0n }).reason ?? "", /would approve 0x0*deadbeef, which is not one of its routers/);
  // Any other call on the token, an outright transfer above all, is refused.
  const transfer = { to: NVDA.contract as `0x${string}`, value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: ["0x00000000000000000000000000000000deadbeef", 1n] }) as `0x${string}` };
  assert.match(checkCalls([transfer, swapCall], { from: NVDA, maxValueRaw: 0n }).reason ?? "", /cannot read/, "an outright transfer does not decode as an approval at all, and is refused on that");
  // The batch may never spend more ETH than the swap itself.
  const rich = { to: ETH_ROUTER as `0x${string}`, value: 10n ** 18n, data: "0xcd6e13f7" as `0x${string}` };
  assert.match(checkCalls([rich], { from: ETH, maxValueRaw: 8n * 10n ** 16n }).reason ?? "", /more than the 80000000000000000 the swap is spending/);
  assert.deepEqual(checkCalls([rich], { from: ETH, maxValueRaw: 10n ** 18n }), { ok: true });
  const payingApproval = { to: NVDA.contract as `0x${string}`, value: 1n, data: approve(TOKEN_ROUTER) as `0x${string}` };
  assert.match(checkCalls([payingApproval, swapCall], { from: NVDA, maxValueRaw: 10n ** 18n }).reason ?? "", /approval that also sends ETH/, "an approval to the right router is still refused if it carries value");
});

test("the steps become the batch in order, and the ETH they spend is what gets unwrapped", () => {
  const q = quote({ steps: [
    { id: "approve", kind: "transaction", txs: [{ to: NVDA.contract as string, value: "0", chainId: 4663, data: approve(TOKEN_ROUTER) }] },
    { id: "swap", kind: "transaction", txs: [{ to: TOKEN_ROUTER, value: "0", chainId: 4663, data: "0xf9e4bab4" }] },
  ] });
  const calls = callsFromSteps(q);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to, NVDA.contract);
  assert.equal(calls[1].to, TOKEN_ROUTER);
  assert.equal(valueOf(calls), 0n);
  assert.equal(valueOf(callsFromSteps(quote())), 80000000000000000n, "an ETH-in route carries its value");
  assert.deepEqual(callsFromSteps(quote({ steps: [{ id: "x", kind: "transaction", txs: [{ to: "not an address", value: "0", chainId: 4663, data: "0x" }] }] })), [], "a step without a real address is dropped");
});

test("the whole route: quoted, held against the pools, checked, and refused with a reason rather than sent", async () => {
  const good = await fomoRoute({ from: ETH, to: NVDA, amount: 0.08, amountInRaw: 8n * 10n ** 16n, poolAmountOut: 2300, user: "0x1C3CAda24a5BEec97E07aefE3673325C07630F82" }, async () => answer(quote()));
  assert.ok(good.ok);
  assert.equal(good.route.amountOut, 2226);
  assert.equal(good.route.valueRaw, 80000000000000000n);
  assert.ok(Math.abs(good.route.giveUpPct - 3.217) < 0.01);
  assert.equal(good.route.feeUsd, 0.67);
  const nope = await fomoRoute({ from: ETH, to: NVDA, amount: 0.08, amountInRaw: 8n * 10n ** 16n, poolAmountOut: 2300, user: "0x1", maxGiveUp: 1 }, async () => answer(quote()));
  assert.ok(!nope.ok && /over the 1%/.test(nope.reason));
  const unquoted = await fomoRoute({ from: ETH, to: NVDA, amount: 0.08, amountInRaw: 8n * 10n ** 16n, poolAmountOut: 2300, user: "0x1" }, async () => answer(null, "UNSUPPORTED_CURRENCY: Unsupported currency"));
  assert.ok(!unquoted.ok && /did not quote ETH to NVDA: UNSUPPORTED_CURRENCY/.test(unquoted.reason));
  // A route that quotes well but asks the wallet to call somewhere else is refused after the quote, before anything is signed.
  const sneaky = await fomoRoute({ from: ETH, to: NVDA, amount: 0.08, amountInRaw: 8n * 10n ** 16n, poolAmountOut: 2300, user: "0x1" }, async () => answer(quote({ steps: [{ id: "swap", kind: "transaction", txs: [{ to: "0x00000000000000000000000000000000deadbeef", value: "0", chainId: 4663, data: "0x" }] }] })));
  assert.ok(!sneaky.ok && /not one of its routers/.test(sneaky.reason));
  // And one that would spend more ETH than the swap.
  const greedy = await fomoRoute({ from: ETH, to: USDG, amount: 0.08, amountInRaw: 8n * 10n ** 16n, poolAmountOut: 200, user: "0x1" }, async () => answer(quote({ amountOut: 199, steps: [{ id: "swap", kind: "transaction", txs: [{ to: ETH_ROUTER, value: String(10n ** 18n), chainId: 4663, data: "0xcd6e13f7" }] }] })));
  assert.ok(!greedy.ok && /more than the 80000000000000000 the swap is spending/.test(greedy.reason));
});
