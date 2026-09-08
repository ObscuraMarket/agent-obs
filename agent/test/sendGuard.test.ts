// The console page's own guard on what it signs, run here because it is pure and the desk's tests are where the
// chain's addresses live. Until 2026-09-08 the page signed whatever the desk handed back, on any chain, to any address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, parseAbi, parseEther } from "viem";
import { judgePay, judgeStep, tokenCall, sendLine, weiOf, ROBINHOOD_CHAIN_ID, UNIVERSAL_ROUTER, PERMIT2, type PayRequest } from "../../dashboard/angular/src/app/service/send-guard.ts";
import { approveErc20Data, approvePermit2Data } from "../src/desk/signer.ts";
import { fundTx } from "../src/desk/agentWallet.ts";

const TREASURY = "0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const AGENT = "0x3333333333333333333333333333333333333333";
const OTHER = "0x000000000000000000000000000000000000dEaD";
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const transfer = (to: string, amount: bigint) => encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to as `0x${string}`, amount] });
const reason = (v: ReturnType<typeof judgePay>): string => (v.ok ? "" : v.reason);

test("the page's chain and contracts are the ones the desk verified on the chain", () => {
  const mem = JSON.parse(readFileSync(join(import.meta.dirname, "..", "obs-chain.json"), "utf8")) as { chain: { id: number }; contracts: { uniswapV4: { universalRouter: string; permit2: string } } };
  assert.equal(ROBINHOOD_CHAIN_ID, mem.chain.id);
  assert.equal(UNIVERSAL_ROUTER, mem.contracts.uniswapV4.universalRouter.toLowerCase());
  assert.equal(PERMIT2, mem.contracts.uniswapV4.permit2.toLowerCase());
});

test("a funding is bare ETH, the amount stated, to the agent's wallet the page already knows", () => {
  const tx = fundTx(AGENT, 0.05);
  assert.ok(!("error" in tx));
  if ("error" in tx) return;
  assert.deepEqual(judgePay(tx, AGENT), { ok: true, label: "your agent's wallet" });
  assert.deepEqual(judgePay(tx, AGENT.toUpperCase().replace("0X", "0x")), { ok: true, label: "your agent's wallet" }, "case does not matter");
  assert.match(reason(judgePay(tx, null)), /does not know your agent's wallet yet; type \/wallet first/);
  assert.match(reason(judgePay(tx, OTHER)), /is not your agent's wallet/);
  assert.match(reason(judgePay({ ...tx, to: OTHER }, AGENT)), /is not your agent's wallet/);
  assert.match(reason(judgePay({ ...tx, data: "0x1234" }, AGENT)), /carries no calldata/);
  assert.match(reason(judgePay({ ...tx, value: parseEther("0.5").toString() }, AGENT)), /0\.5 ETH is not the 0\.05 ETH stated/);
  assert.match(reason(judgePay({ ...tx, chainId: 1 }, AGENT)), /chain 1, not Robinhood Chain \(4663\)/);
  assert.match(reason(judgePay({ ...tx, value: "-1" }, AGENT)), /not a number of wei/);
  assert.match(reason(judgePay({ ...tx, value: "0x10" }, AGENT)), /not a number of wei/);
  assert.match(reason(judgePay({ ...tx, to: "0x1234" }, AGENT)), /not an address/);
  assert.deepEqual(judgePay({ ...tx, value: (BigInt(tx.value) + 10n ** 10n).toString() }, AGENT).ok, true, "the desk's own eight-decimal rounding is not a mismatch");
  assert.equal(judgePay({ ...tx, value: (BigInt(tx.value) + 10n ** 10n + 1n).toString() }, AGENT).ok, false, "past it is");
});

test("credits in ETH go straight to the treasury the reply names, the amount stated", () => {
  const pay: PayRequest = { to: TREASURY, data: "0x", value: weiOf(0.005).toString(), chainId: 4663, token: "ETH", amount: 0.005, treasury: TREASURY };
  assert.deepEqual(judgePay(pay, null), { ok: true, label: "the credits treasury" });
  assert.deepEqual(judgePay({ ...pay, treasury: TREASURY.toLowerCase() }, null), { ok: true, label: "the credits treasury" });
  assert.match(reason(judgePay({ ...pay, treasury: undefined }, null)), /names no treasury/);
  assert.match(reason(judgePay({ ...pay, to: OTHER }, null)), /is not the credits treasury/);
  assert.match(reason(judgePay({ ...pay, data: transfer(TREASURY, 1n) }, null)), /carries no calldata/);
  assert.match(reason(judgePay({ ...pay, value: weiOf(0.05).toString() }, null)), /0\.05 ETH is not the 0\.005 ETH stated/);
  assert.match(reason(judgePay({ ...pay, chainId: 4662 }, null)), /chain 4662/);
});

test("credits in a token are that token's transfer to the treasury, with no ETH attached", () => {
  const pay: PayRequest = { to: USDG, data: transfer(TREASURY, 10_000_000n), value: "0", chainId: 4663, token: "USDG", amount: 10, treasury: TREASURY };
  assert.deepEqual(judgePay(pay, null), { ok: true, label: `the USDG contract, paying the credits treasury ${TREASURY}` });
  assert.match(reason(judgePay({ ...pay, data: transfer(OTHER, 10_000_000n) }, null)), /pays 0x000000000000000000000000000000000000dead, not the credits treasury/);
  assert.match(reason(judgePay({ ...pay, data: approveErc20Data(TREASURY) }, null)), /not a token transfer/);
  assert.match(reason(judgePay({ ...pay, data: "0x" }, null)), /not a token transfer/);
  assert.match(reason(judgePay({ ...pay, value: "1" }, null)), /carries no ETH, and this one carries/);
  assert.match(reason(judgePay({ ...pay, treasury: "" }, null)), /names no treasury/);
});

test("a swap's steps: the swap to the router, a Permit2 approval naming the router, a token approval naming Permit2", () => {
  const swap = { id: "swap", to: UNIVERSAL_ROUTER, data: "0x3593564c" + "00".repeat(96), value: parseEther("0.05").toString(), chainId: 4663 };
  assert.deepEqual(judgeStep(swap), { ok: true, label: "the swap router" });
  assert.deepEqual(judgeStep({ ...swap, to: UNIVERSAL_ROUTER.toUpperCase().replace("0X", "0x") }).ok, true);
  assert.match(reason(judgeStep({ ...swap, to: USDG })), /is not the swap router/);
  assert.match(reason(judgeStep({ ...swap, to: PERMIT2 })), /is not the swap router/);
  assert.match(reason(judgeStep({ ...swap, chainId: 1 })), /chain 1/);

  const permit2 = { id: "approve-permit2", to: PERMIT2, data: approvePermit2Data(USDG, UNIVERSAL_ROUTER, 1_790_000_000), value: "0", chainId: 4663 };
  assert.deepEqual(judgeStep(permit2), { ok: true, label: "Permit2, letting the swap router draw the token" });
  assert.match(reason(judgeStep({ ...permit2, data: approvePermit2Data(USDG, OTHER, 1_790_000_000) })), /would let 0x000000000000000000000000000000000000dead draw the token, not the swap router/);
  assert.match(reason(judgeStep({ ...permit2, to: USDG })), /is not Permit2/);
  assert.match(reason(judgeStep({ ...permit2, data: approveErc20Data(UNIVERSAL_ROUTER) })), /not a Permit2 approval/);
  assert.match(reason(judgeStep({ ...permit2, value: "1" })), /an approval carries no ETH/);

  const token = { id: "approve-token", to: USDG, data: approveErc20Data(PERMIT2), value: "0", chainId: 4663 };
  assert.deepEqual(judgeStep(token), { ok: true, label: "the token's contract, letting Permit2 move it" });
  assert.match(reason(judgeStep({ ...token, data: approveErc20Data(OTHER) })), /would let 0x000000000000000000000000000000000000dead move the token, not Permit2/);
  assert.match(reason(judgeStep({ ...token, data: transfer(PERMIT2, 1n) })), /not a token approval/);
  assert.match(reason(judgeStep({ ...token, value: "5" })), /an approval carries no ETH/);
  assert.match(reason(judgeStep({ ...token, id: "drain" })), /"drain" is not a step the console knows/);
});

test("calldata is read for what it is: a transfer, an approval, a Permit2 approval, or nothing", () => {
  assert.deepEqual(tokenCall(transfer(TREASURY, 42n)), { fn: "transfer", address: TREASURY.toLowerCase(), amount: 42n });
  assert.deepEqual(tokenCall(approveErc20Data(PERMIT2)), { fn: "approve", address: PERMIT2, amount: 2n ** 256n - 1n });
  assert.deepEqual(tokenCall(approvePermit2Data(USDG, UNIVERSAL_ROUTER, 1)), { fn: "permit2Approve", token: USDG, spender: UNIVERSAL_ROUTER });
  assert.equal(tokenCall("0x"), null);
  assert.equal(tokenCall("0xa9059cbb"), null, "a selector with no arguments");
  assert.equal(tokenCall(transfer(TREASURY, 42n) + "00"), null, "trailing bytes are not a transfer");
  assert.equal(tokenCall("0xa9059cbb" + "ff".repeat(32) + "00".repeat(32)), null, "a first word that is not an address");
  assert.equal(tokenCall(42), null);
  assert.equal(tokenCall("zz"), null);
});

test("the line before the wallet opens says where, how much ETH, and on which chain", () => {
  assert.equal(sendLine({ to: UNIVERSAL_ROUTER, data: "0x", value: parseEther("0.05").toString(), chainId: 4663 }, "the swap router"), `To ${UNIVERSAL_ROUTER} (the swap router), 0.05 ETH, on Robinhood Chain.`);
  assert.equal(sendLine({ to: USDG, data: "0x", value: "0", chainId: 4663 }, "the USDG contract"), `To ${USDG} (the USDG contract), no ETH attached, on Robinhood Chain.`);
  assert.equal(sendLine({ to: USDG, data: "0x", value: "abc", chainId: 1 }, "not somewhere the console sends"), `To ${USDG} (not somewhere the console sends), no ETH attached, on chain 1.`, "a value that is not wei prints as none; the chain is named as it is");
  assert.equal(weiOf(0.05), parseEther("0.05"));
  assert.equal(weiOf(0.123456789), parseEther("0.12345679"), "eight decimals, the desk's own rounding");
});
