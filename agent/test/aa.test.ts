import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, erc20Abi, parseAbi, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { entryPoint08Abi } from "viem/account-abstraction";
import { aaOn, gasWalletFile, depositMinWei, depositTopUpWei, DESK_NONCE_KEY, ENTRY_POINT, nonceOf, ethInPlan, swapBatch, gasFor, prefundWei, parseHandleOpsReceipt, decodeRevertBytes, receivedRawFromLogs, nativeOutFromSwapLogs, aaRailView, VERIFICATION_GAS_LIMIT, PRE_VERIFICATION_GAS, CALL_GAS_FLOOR, TIP_WEI } from "../src/desk/aa.ts";
import { checkRails, railsFromEnv, type Intent, type RailContext } from "../src/desk/rails.ts";
import { resolveAsset } from "../src/desk/assets.ts";
import { sendSwap, aaFillFromLogs, routeFor, type SendLane, type SendJob } from "../src/desk/onchain.ts";
import type { ReceiptRead } from "../src/desk/signer.ts";
import type { Trade } from "../src/desk/book.ts";

// The account-abstraction lane (aa.ts): the wallet is a 7702 account whose app keeps its ETH wrapped, so a swap
// goes out as one user operation that the gas wallet sends. Nothing here touches a chain: the batch, the gas
// arithmetic, the receipt reading and the rails' view are pure, and the lane's send is a fake.
const ETH = resolveAsset("ETH@robinhood")!;
const NVDA = resolveAsset("NVDA@robinhood")!;
const USDG = resolveAsset("USDG@robinhood")!;
const WALLET = "0x1C3CAda24a5BEec97E07aefE3673325C07630F82" as const;
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as const;
const ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904" as const;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const OP_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const TX_HASH = "0x00000000000000000000000000000000000000000000000000000000000000ab" as const;
const T = Date.UTC(2026, 8, 9, 3, 0);
type Log = ReceiptRead["logs"][number];
// The topics as a receipt carries them: every indexed argument given, so none is null.
const topics = (t: readonly (Hex | Hex[] | null)[]): string[] => t.filter((x): x is Hex => typeof x === "string");

const opEvent = (success: boolean, cost = 5_000_000_000_000n, hash: Hex = OP_HASH, sender: string = WALLET): Log => ({
  address: ENTRY_POINT,
  topics: topics(encodeEventTopics({ abi: entryPoint08Abi, eventName: "UserOperationEvent", args: { userOpHash: hash, sender: sender as `0x${string}`, paymaster: ZERO } })),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [nonceOf(DESK_NONCE_KEY, 3n), success, cost, 210_000n]),
});
const opRevert = (reason: Hex, hash: Hex = OP_HASH): Log => ({
  address: ENTRY_POINT,
  topics: topics(encodeEventTopics({ abi: entryPoint08Abi, eventName: "UserOperationRevertReason", args: { userOpHash: hash, sender: WALLET } })),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [nonceOf(DESK_NONCE_KEY, 3n), reason]),
});
const transfer = (token: string, to: string, amount: bigint): Log => ({
  address: token,
  topics: topics(encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: ROUTER, to: to as `0x${string}` } })),
  data: encodeAbiParameters([{ type: "uint256" }], [amount]),
});
const SWAP_ABI = parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]);
const swap = (poolId: string, amount0: bigint, amount1: bigint, manager = "0x8366a39cc670b4001a1121b8f6a443a643e40951"): Log => ({
  address: manager,
  topics: topics(encodeEventTopics({ abi: SWAP_ABI, eventName: "Swap", args: { id: poolId as Hex, sender: ROUTER } })),
  data: encodeAbiParameters([{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }], [amount0, amount1, 2n ** 96n, 10n ** 20n, 0, 100]),
});
const errorString = (s: string): Hex => encodeErrorResult({ abi: parseAbi(["error Error(string message)"]), errorName: "Error", args: [s] });

test("the lane is on only for OBS_EXEC=aa, and the gas wallet's file sits beside the desk's", () => {
  assert.equal(aaOn({ OBS_EXEC: "aa" } as NodeJS.ProcessEnv), true);
  assert.equal(aaOn({} as NodeJS.ProcessEnv), false);
  assert.equal(aaOn({ OBS_EXEC: "AA" } as NodeJS.ProcessEnv), false, "exactly aa, nothing looser");
  assert.equal(aaOn({ OBS_EXEC: "on" } as NodeJS.ProcessEnv), false);
  assert.equal(gasWalletFile({ OBS_WALLET_DIR: "/wallet" } as NodeJS.ProcessEnv), "/wallet/obs-gas-wallet.json");
  assert.match(gasWalletFile({} as NodeJS.ProcessEnv), /\.obs\/wallet\/obs-gas-wallet\.json$/);
  assert.equal(depositMinWei({} as NodeJS.ProcessEnv), 2n * 10n ** 15n, "0.002 ETH unless set");
  assert.equal(depositTopUpWei({} as NodeJS.ProcessEnv), 5n * 10n ** 15n, "0.005 ETH unless set");
  assert.equal(depositMinWei({ OBS_AA_DEPOSIT_MIN_ETH: "0.01" } as NodeJS.ProcessEnv), 10n ** 16n);
});

test("the desk's nonce key is 24 bytes that spell its name, never the app's key 0, and composes the 2D nonce", () => {
  assert.ok(DESK_NONCE_KEY > 0n, "key 0 is the app's own sequence; a trade on it collides with a sweep");
  assert.ok(DESK_NONCE_KEY < 2n ** 192n, "a uint192");
  assert.equal(Buffer.from((DESK_NONCE_KEY >> 128n).toString(16), "hex").toString(), "obs-desk");
  assert.equal(nonceOf(DESK_NONCE_KEY, 0n) >> 64n, DESK_NONCE_KEY);
  assert.equal(nonceOf(DESK_NONCE_KEY, 7n) & (2n ** 64n - 1n), 7n);
  assert.equal(nonceOf(DESK_NONCE_KEY, 7n), (DESK_NONCE_KEY << 64n) + 7n);
});

test("an ETH-in swap is paid from WETH first and clamped to WETH plus native, since one wei over the WETH reverts the batch", () => {
  assert.deepEqual(ethInPlan(10n, 0n, 10n), { amountInRaw: 10n, withdrawRaw: 10n }, "the whole value from WETH");
  assert.deepEqual(ethInPlan(10n, 0n, 8n), { amountInRaw: 8n, withdrawRaw: 8n }, "clamped to what there is");
  assert.deepEqual(ethInPlan(10n, 3n, 8n), { amountInRaw: 10n, withdrawRaw: 8n }, "native covers the rest, WETH still first");
  assert.deepEqual(ethInPlan(10n, 12n, 0n), { amountInRaw: 10n, withdrawRaw: 0n }, "no WETH, no withdraw call");
  assert.deepEqual(ethInPlan(10n, 4n, 4n), { amountInRaw: 8n, withdrawRaw: 4n });
  assert.deepEqual(ethInPlan(5n, 0n, 0n), { amountInRaw: 0n, withdrawRaw: 0n }, "nothing held, nothing sent");
});

test("the batch: WETH.withdraw then the router call with its value for a buy; the approvals still missing then the router at value 0 for a sell", () => {
  const buyTx = { to: ROUTER, data: "0xabcd" as Hex, value: 10n ** 16n };
  const buy = swapBatch({ tx: buyTx, withdrawRaw: 10n ** 16n, weth: WETH });
  assert.equal(buy.length, 2);
  assert.deepEqual([buy[0].to, buy[0].value], [WETH, 0n]);
  const w = decodeFunctionData({ abi: parseAbi(["function withdraw(uint256 wad)"]), data: buy[0].data });
  assert.deepEqual([w.functionName, w.args[0]], ["withdraw", 10n ** 16n]);
  assert.deepEqual(buy[1], { to: ROUTER, value: 10n ** 16n, data: "0xabcd" }, "the router call rides last with the value the withdraw just freed");
  const sellTx = { to: ROUTER, data: "0xbeef" as Hex, value: 0n };
  const token = { contract: NVDA.contract as `0x${string}`, permit2: PERMIT2, router: ROUTER, needErc20Approve: true, needPermit2Approve: true, expiration: 1_800_000_000 };
  const sell = swapBatch({ tx: sellTx, withdrawRaw: 0n, token });
  assert.equal(sell.length, 3, "two approvals in the batch, no separate transactions");
  const a = decodeFunctionData({ abi: erc20Abi, data: sell[0].data });
  assert.deepEqual([sell[0].to, a.functionName, a.args], [NVDA.contract, "approve", [PERMIT2, 2n ** 256n - 1n]]);
  const p = decodeFunctionData({ abi: parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]), data: sell[1].data });
  assert.deepEqual([sell[1].to, (p.args[0] as string).toLowerCase(), p.args[1], p.args[2], p.args[3]], [PERMIT2, NVDA.contract, ROUTER, 2n ** 160n - 1n, 1_800_000_000]);
  assert.deepEqual(sell[2], { to: ROUTER, value: 0n, data: "0xbeef" });
  assert.deepEqual(swapBatch({ tx: sellTx, withdrawRaw: 0n, token: { ...token, needErc20Approve: false, needPermit2Approve: false } }), [{ to: ROUTER, value: 0n, data: "0xbeef" }], "allowances already there: the router call alone");
  assert.equal(swapBatch({ tx: sellTx, withdrawRaw: 0n, token: { ...token, needErc20Approve: false } }).length, 2, "only the Permit2 side missing");
});

test("gas is filled by hand: the inner estimate plus headroom over a floor, fixed verification numbers, twice the base fee plus the tip", () => {
  const g = gasFor({ innerEstimate: 200_000n, baseFeeWei: 10_000_000n });
  assert.deepEqual(g, { callGasLimit: 260_000n, verificationGasLimit: VERIFICATION_GAS_LIMIT, preVerificationGas: PRE_VERIFICATION_GAS, maxFeePerGas: 30_000_000n, maxPriorityFeePerGas: TIP_WEI });
  assert.equal(gasFor({ innerEstimate: 10_000n, baseFeeWei: 10_000_000n }).callGasLimit, CALL_GAS_FLOOR, "a tiny estimate still gets the floor");
  assert.equal(gasFor({ innerEstimate: 200_000n, baseFeeWei: 10_000_000n, tipWei: 0n }).maxFeePerGas, 20_000_000n);
  assert.equal(prefundWei(g), (260_000n + VERIFICATION_GAS_LIMIT + PRE_VERIFICATION_GAS) * 30_000_000n, "what the deposit must hold: every limit at the max fee");
});

test("a handleOps receipt is read for the operation's own outcome: the event's success flag, its cost, and the batch's revert reason", () => {
  const ok = parseHandleOpsReceipt([transfer(NVDA.contract!, WALLET, 1n), opEvent(true)], OP_HASH);
  assert.deepEqual([ok.found, ok.success, ok.actualGasCost, ok.actualGasUsed, ok.revert, ok.reason], [true, true, 5_000_000_000_000n, 210_000n, null, null]);
  const bad = parseHandleOpsReceipt([opRevert(errorString("TRANSFER_FROM_FAILED")), opEvent(false, 0n)], OP_HASH);
  assert.deepEqual([bad.found, bad.success, bad.reason], [true, false, "TRANSFER_FROM_FAILED"], "the transaction landed; the swap did not");
  assert.equal(bad.revert, errorString("TRANSFER_FROM_FAILED"));
  const none = parseHandleOpsReceipt([transfer(NVDA.contract!, WALLET, 1n)], OP_HASH);
  assert.deepEqual([none.found, none.success], [false, false], "no event for the op: never read as landed");
  const other = parseHandleOpsReceipt([opEvent(true, 1n, "0x2222222222222222222222222222222222222222222222222222222222222222")], OP_HASH);
  assert.equal(other.found, false, "another operation's event is not ours");
  const bySender = parseHandleOpsReceipt([opEvent(false, 0n), opRevert(errorString("slippage"))], null, WALLET);
  assert.deepEqual([bySender.found, bySender.success, bySender.reason], [true, false, "slippage"], "an old row is matched by the wallet when its op hash is not known");
  assert.equal(parseHandleOpsReceipt([opEvent(true)], null, "0x000000000000000000000000000000000000dead").found, false);
});

test("revert bytes read as a person would: Error(string), a panic, hex for anything else", () => {
  assert.equal(decodeRevertBytes(errorString("V4TooLittleReceived")), "V4TooLittleReceived");
  assert.equal(decodeRevertBytes(encodeErrorResult({ abi: parseAbi(["error Panic(uint256 code)"]), errorName: "Panic", args: [17n] })), "panic 17");
  assert.equal(decodeRevertBytes("0x"), "no revert data");
  assert.equal(decodeRevertBytes(null), "no revert data");
  assert.equal(decodeRevertBytes("0x8baa579f"), "0x8baa579f", "a custom error stays hex");
});

test("the fill from the receipt's logs: a token's Transfer to the wallet, native ETH from the last hop's Swap delta", () => {
  const other = "0x000000000000000000000000000000000000dead";
  const logs = [transfer(NVDA.contract!, other, 7n), transfer(NVDA.contract!, WALLET, 3n * 10n ** 17n), transfer(NVDA.contract!, WALLET, 2n * 10n ** 17n), transfer(USDG.contract!, WALLET, 5n)];
  assert.equal(receivedRawFromLogs(logs, NVDA.contract!, WALLET), 5n * 10n ** 17n, "the wallet's own transfers of the token, summed");
  assert.equal(receivedRawFromLogs(logs, NVDA.contract!, "0x1c3cada24a5beec97e07aefe3673325c07630f82"), 5n * 10n ** 17n, "case does not matter");
  assert.equal(receivedRawFromLogs(logs, WETH, WALLET), null, "nothing of that token: null, not zero");
  const sell = routeFor(NVDA, ETH)!;
  const last = sell.hops[sell.hops.length - 1];
  assert.deepEqual([last.key, last.zeroForOne], ["ETH/USDG", false], "the last hop sells USDG (token1) for ETH (token0)");
  const poolId = last.spec.id!;
  const swapLogs = [swap(poolId, 7n * 10n ** 15n, -20_000_000n), swap("0x" + "9".repeat(64), 10n ** 18n, -1n)];
  assert.equal(nativeOutFromSwapLogs(swapLogs, poolId, true), 7n * 10n ** 15n, "the positive delta on the side received is the ETH paid out");
  assert.equal(nativeOutFromSwapLogs(swapLogs, poolId, false), null, "the side paid is negative: nothing received there");
  assert.equal(nativeOutFromSwapLogs(swapLogs, poolId, true, other), null, "a swap logged by another contract is not the pool manager's");
  assert.equal(aaFillFromLogs(swapLogs, ETH, sell, WALLET), 7n * 10n ** 15n, "the lane reads native out from the route's last hop");
  assert.equal(aaFillFromLogs(logs, NVDA, routeFor(ETH, NVDA)!, WALLET), 5n * 10n ** 17n, "and a token from its Transfer");
});

test("the rails under the lane read ETH as native plus WETH and the reserve as the deposit plus the gas wallet, and drop the round-trip reserve on an ETH leg", () => {
  const view = aaRailView({ "ETH@robinhood": 0.0001, "WETH@robinhood": 0.05, "USDG@robinhood": 40 }, 0.01);
  assert.ok(Math.abs(view.balances["ETH@robinhood"] - 0.0501) < 1e-12, `ETH is native plus WETH, got ${view.balances["ETH@robinhood"]}`);
  assert.deepEqual({ ...view, balances: { ...view.balances, "ETH@robinhood": 0 } }, { balances: { "ETH@robinhood": 0, "WETH@robinhood": 0.05, "USDG@robinhood": 40 }, nativeOnFromChain: 0.01, aa: true }, "the other keys stand, WETH under its own key included");
  assert.equal(aaRailView({ "WETH@robinhood": 0.05 }, 0.01).balances["ETH@robinhood"], 0.05, "WETH alone is still ETH the lane can spend");
  assert.equal("ETH@robinhood" in aaRailView({ "USDG@robinhood": 1 }, 0.01).balances, false, "neither read: no ETH key, not zero");
  assert.equal(aaRailView({ "ETH@robinhood": 0.01 }, null).nativeOnFromChain, null, "a reserve that could not be read stays unknown");
  const rails = railsFromEnv({ OBS_TRADING: "on", OBS_BASIS: "on", OBS_MAX_SWAP_USD: "200", OBS_GAS_RESERVE_ETH: "0.002", OBS_TRADE_ASSETS: "ETH@robinhood,USDG@robinhood,NVDA@robinhood" } as NodeJS.ProcessEnv);
  const buy: Intent = { from: ETH, to: NVDA, amount: 0.05, usd: 120 };
  const under: RailContext = { rails, balances: { "ETH@robinhood": 0.0501, "WETH@robinhood": 0.05, "NVDA@robinhood": 0.4 }, nativeOnFromChain: 0.01, openOrders: 0, aa: true };
  assert.deepEqual(checkRails(buy, under), { ok: true }, "nearly the whole balance may go: the wallet pays no gas of its own");
  const no = (i: Intent, c: RailContext) => (checkRails(i, c) as { ok: false; reason: string }).reason;
  assert.match(no(buy, { ...under, nativeOnFromChain: 0.001 }), /gas reserve between the entry point deposit and the gas wallet/, "the lane's reserve is what is checked");
  assert.match(no(buy, { ...under, nativeOnFromChain: null }), /gas reserve between the entry point deposit and the gas wallet/, "unread is refused, never guessed");
  assert.match(no(buy, { ...under, aa: false }), /gas reserve for the round trip/, "the plain lane keeps the round-trip reserve on an ETH leg");
  assert.match(no(buy, { ...under, balances: { "ETH@robinhood": 0.0001, "WETH@robinhood": 0.05 } }), /holds 0\.0001 ETH@robinhood/, "a context built without the view sees the native figure alone, and refuses");
  const sell: Intent = { from: NVDA, to: ETH, amount: 0.4, usd: 80, exit: true };
  assert.deepEqual(checkRails(sell, under), { ok: true });
  assert.match(no(sell, { ...under, nativeOnFromChain: 0.0005 }), /gas reserve between the entry point deposit and the gas wallet/);
});

// The lane's send as sendSwap sees it: a fake that returns the handleOps receipt with its logs.
const account = privateKeyToAccount(generatePrivateKey());
const baseRow = (to: typeof NVDA | typeof ETH): Trade => ({ at: T, id: "pool-aa-1", status: "pending", venue: "pool", from: { asset: to === NVDA ? "ETH" : "NVDA", network: "robinhood", amount: 0.04, usd: 100 }, to: { asset: to.symbol, network: "robinhood", amount: 0.5, usd: 100 }, partner: "pool", note: "one user operation" });
const job = (to: typeof NVDA | typeof ETH, rows: Trade[], aa: boolean): SendJob => ({
  intent: to === NVDA ? { from: ETH, to: NVDA, amount: 0.04, usd: 100 } : { from: NVDA, to: ETH, amount: 0.04, usd: 100, exit: true },
  base: baseRow(to),
  tx: { to: ROUTER, data: "0x", value: to === NVDA ? 4n * 10n ** 16n : 0n },
  quote: { amountOut: 0.5, amountOutRaw: 5n * 10n ** 17n, priceOutUsd: 200 },
  address: WALLET,
  ethUsd: 2500,
  now: T,
  runAs: { wallet: { address: account.address, account }, record: (t) => { rows.push(t); return true; } },
  ...(aa ? { aa: { fill: (logs: ReceiptRead["logs"]) => (to === NVDA ? receivedRawFromLogs(logs, NVDA.contract!, WALLET) : aaFillFromLogs(logs, ETH, routeFor(NVDA, ETH)!, WALLET)) } } : {}),
});
const lane = (receipt: Awaited<ReturnType<SendLane["wait"]>>, balances: bigint[] = [0n, 0n]): SendLane => {
  let reads = 0;
  return { send: async () => TX_HASH, wait: async () => receipt, balance: async () => balances[Math.min(reads++, balances.length - 1)], alert: async () => true, clock: () => T + 60e3 };
};

test("under the lane the fill comes from the receipt's logs when the balance reads say nothing, and no gas of the wallet's is added back", async () => {
  const rows: Trade[] = [];
  const r = await sendSwap(job(NVDA, rows, true), lane({ status: "success", gasCostWei: 1234n, logs: [opEvent(true), transfer(NVDA.contract!, WALLET, 45n * 10n ** 16n)] }));
  assert.ok(r.ok);
  assert.deepEqual([r.trade.status, r.trade.settlementTx, r.trade.to.amount, r.trade.to.usd], ["settled", TX_HASH, 0.45, 90], "the Transfer to the wallet is the fill; the settlement hash is the handleOps transaction");
  // A native leg: the plain lane adds the wallet's gas back to the balance difference; this lane must not, the gas wallet paid it.
  const plain = await sendSwap(job(ETH, [], false), lane({ status: "success", gasCostWei: 999n }));
  assert.ok(plain.ok);
  assert.equal(plain.trade.to.amount, 999e-18, "the plain lane: a zero difference plus the gas paid reads as 999 wei received");
  const sell = routeFor(NVDA, ETH)!;
  const poolId = sell.hops[sell.hops.length - 1].spec.id!;
  const viaLogs = await sendSwap(job(ETH, [], true), lane({ status: "success", gasCostWei: 999n, logs: [opEvent(true), swap(poolId, 7n * 10n ** 15n, -20_000_000n)] }));
  assert.ok(viaLogs.ok);
  assert.equal(viaLogs.trade.to.amount, 0.007, "the ETH paid out is the last hop's Swap delta, not the gas");
  const noLogs = await sendSwap(job(ETH, [], true), lane({ status: "success", gasCostWei: 999n, logs: [] }));
  assert.ok(noLogs.ok);
  assert.equal(noLogs.trade.to.amount, 0.5, "nothing in the logs and nothing in the balances: the estimate stands, never the gas");
  const balances = await sendSwap(job(ETH, [], true), lane({ status: "success", gasCostWei: 999n, logs: [swap(poolId, 7n * 10n ** 15n, -20_000_000n)] }, [10n ** 18n, 10n ** 18n + 6n * 10n ** 15n]));
  assert.ok(balances.ok);
  assert.equal(balances.trade.to.amount, 0.006, "a balance difference that reads (native plus WETH) wins over the Swap delta, which a hooked pool can overstate");
});

test("a batch that reverted inside a landed transaction fails the row with the operation's reason", async () => {
  const rows: Trade[] = [];
  const r = await sendSwap(job(NVDA, rows, true), lane({ status: "reverted", gasCostWei: 500n, reason: "V4TooLittleReceived", logs: [opEvent(false, 0n)] }));
  assert.equal(r.ok, false);
  assert.deepEqual(rows.map((t) => [t.status, t.settlementTx ?? null]), [["pending", null], ["pending", TX_HASH], ["failed", TX_HASH]]);
  assert.equal(rows[2].note, "reverted on chain: V4TooLittleReceived");
  assert.equal("reason" in r ? r.reason : null, `swap ${TX_HASH} reverted: V4TooLittleReceived`);
});

test("under the lane an entry keeps a multiple of the gas reserve back, so buying stops long before selling does", () => {
  const rails = railsFromEnv({ OBS_TRADING: "on", OBS_BASIS: "on", OBS_MAX_SWAP_USD: "200", OBS_GAS_RESERVE_ETH: "0.002", OBS_TRADE_ASSETS: "ETH@robinhood,USDG@robinhood,NVDA@robinhood" } as NodeJS.ProcessEnv);
  assert.equal(rails.gasEntryMultiple, 5, "five times the reserve by default");
  assert.equal(railsFromEnv({ OBS_GAS_ENTRY_MULTIPLE: "0.5" } as NodeJS.ProcessEnv).gasEntryMultiple, 1, "never under the exit's own floor");
  const buy: Intent = { from: ETH, to: NVDA, amount: 0.05, usd: 120 };
  const sell: Intent = { from: NVDA, to: ETH, amount: 0.4, usd: 80, exit: true };
  // The reserve is the lane's pool, not the wallet's own ETH: the EntryPoint deposit plus the gas wallet.
  const at = (reserve: number | null): RailContext => ({ rails, balances: { "ETH@robinhood": 0.0501, "WETH@robinhood": 0.05, "NVDA@robinhood": 0.4 }, nativeOnFromChain: reserve, openOrders: 0, aa: true });
  const no = (i: Intent, c: RailContext) => (checkRails(i, c) as { ok: false; reason: string }).reason;
  assert.deepEqual(checkRails(buy, at(0.02)), { ok: true }, "plenty of gas: the entry passes");
  assert.deepEqual(checkRails(buy, at(0.01)), { ok: true }, "exactly five times the reserve still buys");
  assert.equal(checkRails(buy, at(0.005)).ok, false, "under it, no new entry");
  assert.match(no(buy, at(0.005)), /less than the 0\.01 ETH gas reserve between the entry point deposit and the gas wallet, which an entry keeps back/);
  // The point of the split: the same reserve that stops a buy still sells, so the desk is never stuck holding.
  assert.deepEqual(checkRails(sell, at(0.005)), { ok: true }, "the same reserve still exits");
  assert.deepEqual(checkRails(sell, at(0.002)), { ok: true }, "an exit runs down to the reserve itself");
  assert.equal(checkRails(sell, at(0.0019)).ok, false, "below the reserve nothing can be sent at all");
  assert.equal(checkRails(sell, at(null)).ok, false, "an unread reserve refuses rather than guesses");
});
