// The account-abstraction lane for the desk's own wallet (OBS_EXEC=aa).
//
// The trading wallet is an EOA delegated by EIP-7702 to the canonical Simple7702Account, whose entry point is
// EntryPoint v0.8. The app the wallet lives in sweeps every wei of native ETH into WETH within about twenty
// seconds, so the wallet holds WETH and never native ETH, and a plain transaction from its key cannot pay gas or
// carry value. This lane sends the swap as ONE user operation instead: executeBatch of [WETH.withdraw, the router
// call with value] for an ETH-in buy, or [the approvals still missing, the router call] for a token sell, signed
// by the wallet's own key over the EntryPoint's typed hash. No bundler service: a second plain EOA, the gas
// wallet, calls EntryPoint.handleOps([op], gasWallet) itself and pays the outer transaction; the op's own fees are
// drawn from the wallet's EntryPoint deposit, which the gas wallet keeps topped up (ensureDeposit) and which the
// EntryPoint refunds to the gas wallet as the beneficiary.
//
// Two keys, two files, both read at call time and never logged: the desk's key (signer.ts loadAccount) signs the
// user operation, the gas wallet's key (loadGasAccount, obs-gas-wallet.json beside the first) signs the outer
// transaction. The nonce is the desk's own 2D key at the EntryPoint, never key 0, so the app's own sweep ops on
// the same account (they run about twenty seconds after every exit lands ETH) never collide with a trade.
//
// Pure where it can be: the batch, the gas arithmetic, the receipt reading and the rails view are tested offline.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, decodeErrorResult, decodeEventLog, encodeEventTopics, encodeFunctionData, formatEther, parseAbi, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { entryPoint08Abi, entryPoint08Address, getUserOperationHash, toPackedUserOperation, toSimple7702SmartAccount, type PackedUserOperation, type UserOperation } from "viem/account-abstraction";
import { WALLET_ADDRESS, WETH_CONTRACT } from "../config.ts";
import { ASSETS, type Asset } from "./assets.ts";
import { loadAccount, viemChain, transport, readNativeBalance, readTokenBalance, approveErc20Data, approvePermit2Data, type RawTx, type ReceiptRead } from "./signer.ts";
import { acquire } from "./walletLock.ts";

/** EntryPoint v0.8, the one the wallet's delegate answers entryPoint() with. */
export const ENTRY_POINT: Address = entryPoint08Address;
/** The canonical Simple7702Account implementation the wallet is delegated to; viem's default for toSimple7702SmartAccount. */
export const SIMPLE_7702_IMPLEMENTATION: Address = "0xe6Cae83BdE06E4c305530e199D7217f42808555B";
/**
 * The desk's nonce key at the EntryPoint: a uint192 (24 bytes), the ASCII "obs-desk" in its top eight bytes and
 * zeros below. EntryPoint v0.8 nonces are two-dimensional (key << 64 | sequence), one sequence per key; the app
 * that sweeps the wallet signs ops on its own key, and a desk op on the same key would collide with a sweep
 * (AA25 invalid account nonce). Never key 0.
 */
export const DESK_NONCE_KEY = 0x6f62732d6465736b00000000000000000000000000000000n;
/** A fixed small tip on top of twice the base fee; the chain has no priority auction, this only keeps the op from sitting at the base fee's edge. */
export const TIP_WEI = 10_000_000n;
/** The gas plan's fixed parts: ECDSA validation on a 7702 account needs well under 200k; preVerificationGas is the bundle's own overhead, ours, so it is not tuned against any bundler. */
export const VERIFICATION_GAS_LIMIT = 200_000n;
export const PRE_VERIFICATION_GAS = 60_000n;
export const CALL_GAS_FLOOR = 150_000n;
const CALL_GAS_HEADROOM_PCT = 30n;

const WETH_ABI = parseAbi(["function withdraw(uint256 wad)", "function deposit() payable"]);
const SWAP_ABI = parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]);
const REVERT_ABI = parseAbi(["error Error(string message)", "error Panic(uint256 code)"]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SWAP_TOPIC = encodeEventTopics({ abi: SWAP_ABI, eventName: "Swap" })[0].toLowerCase();
const OP_EVENT_TOPIC = encodeEventTopics({ abi: entryPoint08Abi, eventName: "UserOperationEvent" })[0].toLowerCase();
const OP_REVERT_TOPIC = encodeEventTopics({ abi: entryPoint08Abi, eventName: "UserOperationRevertReason" })[0].toLowerCase();

// ---- Switches and files ----

/** PURE: the lane is on only when the operator says OBS_EXEC=aa. Anything else keeps the plain send. */
export function aaOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OBS_EXEC === "aa";
}

/** PURE: where the gas wallet's key file lives: beside the desk's own, in OBS_WALLET_DIR. */
export const gasWalletFile = (env: NodeJS.ProcessEnv = process.env): string => join(env.OBS_WALLET_DIR || join(homedir(), ".obs", "wallet"), "obs-gas-wallet.json");

/** PURE: the deposit the lane keeps at the EntryPoint for the wallet, and the top-up it sends when under it. */
export function depositMinWei(env: NodeJS.ProcessEnv = process.env): bigint {
  return parseEther(env.OBS_AA_DEPOSIT_MIN_ETH || "0.002");
}
export function depositTopUpWei(env: NodeJS.ProcessEnv = process.env): bigint {
  return parseEther(env.OBS_AA_DEPOSIT_TOPUP_ETH || "0.005");
}

/**
 * The gas wallet's account, from its file, at call time: the key is used to sign one transaction and is never
 * logged, returned past the account object, or kept on a module variable. The derived address must match the
 * file's own address field and OBS_GAS_WALLET_ADDRESS when that is set, or nothing is sent.
 */
export function loadGasAccount(env: NodeJS.ProcessEnv = process.env): PrivateKeyAccount {
  const path = gasWalletFile(env);
  if (!existsSync(path)) throw new Error(`no gas wallet file at ${path} (OBS_GAS_WALLET_JSON writes one at boot)`);
  const w = JSON.parse(readFileSync(path, "utf8")) as { address?: string; privateKey?: string };
  if (!w.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(w.privateKey)) throw new Error("the gas wallet file has no usable key");
  const account = privateKeyToAccount(w.privateKey as Hex);
  if (w.address && w.address.toLowerCase() !== account.address.toLowerCase()) throw new Error("the gas wallet file's key does not derive to its own address field; refusing to sign");
  const expected = env.OBS_GAS_WALLET_ADDRESS ?? "";
  if (expected && expected.toLowerCase() !== account.address.toLowerCase()) throw new Error("the gas wallet file's key does not derive to OBS_GAS_WALLET_ADDRESS; refusing to sign");
  return account;
}

const eth = (): Asset => ASSETS["ETH@robinhood"];
const publicClient = () => createPublicClient({ chain: viemChain(eth()), transport: transport(eth()) });
const desk = (): Address => {
  if (!WALLET_ADDRESS) throw new Error("no OBS_WALLET_ADDRESS configured");
  return WALLET_ADDRESS as Address;
};

// ---- The account ----

/** The wallet as a smart account: the desk's key as the owner, the canonical delegate, EntryPoint v0.8. The address must be the desk's, or the wrong key is in the file. */
export async function fomoAccount() {
  const owner = loadAccount();
  const account = await toSimple7702SmartAccount({ client: publicClient(), owner, implementation: SIMPLE_7702_IMPLEMENTATION });
  if (account.address.toLowerCase() !== desk().toLowerCase()) throw new Error("the smart account's address is not OBS_WALLET_ADDRESS; refusing to sign");
  return account;
}

// ---- The batch (pure) ----

export interface AaCall {
  to: Address;
  value: bigint;
  data: Hex;
}

/** PURE: calldata for WETH.withdraw(amount) and WETH.deposit(). */
export function wethWithdrawData(amount: bigint): Hex {
  return encodeFunctionData({ abi: WETH_ABI, functionName: "withdraw", args: [amount] });
}
export function wethDepositData(): Hex {
  return encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" });
}

/** PURE: the 2D nonce as the EntryPoint composes it: key in the top 192 bits, the sequence below. */
export function nonceOf(key: bigint, seq: bigint): bigint {
  return (key << 64n) | seq;
}

/**
 * PURE: how an ETH-in swap is funded. The value comes from the wallet's WETH first (the app wraps whatever native
 * ETH sits there within seconds, so native is never counted on), native ETH only for what WETH cannot cover, and
 * the amount is clamped to the two together: WETH.withdraw of one wei over the balance reverts the whole batch.
 */
export function ethInPlan(amountInRaw: bigint, nativeRaw: bigint, wethRaw: bigint): { amountInRaw: bigint; withdrawRaw: bigint } {
  const have = (nativeRaw > 0n ? nativeRaw : 0n) + (wethRaw > 0n ? wethRaw : 0n);
  const amount = amountInRaw > have ? have : amountInRaw;
  if (amount <= 0n) return { amountInRaw: 0n, withdrawRaw: 0n };
  const withdrawRaw = amount > wethRaw ? (wethRaw > 0n ? wethRaw : 0n) : amount;
  return { amountInRaw: amount, withdrawRaw };
}

export interface SwapBatchToken {
  contract: Address;
  permit2: Address;
  router: Address;
  needErc20Approve: boolean;
  needPermit2Approve: boolean;
  /** Unix seconds the Permit2 allowance runs to. */
  expiration: number;
}

/**
 * PURE: the calls of one swap, in order: WETH.withdraw for the value an ETH-in leg needs, the two approvals a
 * token sell still lacks (token to Permit2, Permit2 to the router; each only when its allowance is short), then
 * the router call itself with its value. The lane the plain send used made the approvals separate transactions.
 */
export function swapBatch(p: { tx: RawTx; withdrawRaw: bigint; token?: SwapBatchToken; weth?: Address }): AaCall[] {
  const calls: AaCall[] = [];
  const weth = (p.weth ?? WETH_CONTRACT) as Address;
  if (p.withdrawRaw > 0n) calls.push({ to: weth, value: 0n, data: wethWithdrawData(p.withdrawRaw) });
  if (p.token?.needErc20Approve) calls.push({ to: p.token.contract, value: 0n, data: approveErc20Data(p.token.permit2) });
  if (p.token?.needPermit2Approve) calls.push({ to: p.token.permit2, value: 0n, data: approvePermit2Data(p.token.contract, p.token.router, p.token.expiration) });
  calls.push({ to: p.tx.to, value: p.tx.value, data: p.tx.data });
  return calls;
}

// ---- Gas (pure) ----

export interface GasPlan {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** PURE: the five gas numbers from the inner call's estimate and the chain's base fee: the estimate plus headroom over a floor, fixed verification and pre-verification, twice the base fee plus the tip. */
export function gasFor(p: { innerEstimate: bigint; baseFeeWei: bigint; tipWei?: bigint; floor?: bigint }): GasPlan {
  const tip = p.tipWei ?? TIP_WEI;
  const floor = p.floor ?? CALL_GAS_FLOOR;
  const withHeadroom = (p.innerEstimate * (100n + CALL_GAS_HEADROOM_PCT)) / 100n;
  return {
    callGasLimit: withHeadroom > floor ? withHeadroom : floor,
    verificationGasLimit: VERIFICATION_GAS_LIMIT,
    preVerificationGas: PRE_VERIFICATION_GAS,
    maxFeePerGas: p.baseFeeWei * 2n + tip,
    maxPriorityFeePerGas: tip,
  };
}

/** PURE: what the EntryPoint takes from the wallet's deposit up front for a plan: every gas limit at the max fee. Refunded less what was used. */
export function prefundWei(g: GasPlan): bigint {
  return (g.callGasLimit + g.verificationGasLimit + g.preVerificationGas) * g.maxFeePerGas;
}

export const formatGasPlan = (g: GasPlan): string => `call ${g.callGasLimit}, verification ${g.verificationGasLimit}, pre-verification ${g.preVerificationGas}, max fee ${g.maxFeePerGas} wei (tip ${g.maxPriorityFeePerGas}); prefund ${formatEther(prefundWei(g))} ETH`;

// ---- Building, simulating, sending ----

export interface PreparedOp {
  op: UserOperation<"0.8">;
  packed: PackedUserOperation;
  userOpHash: Hex;
  calls: AaCall[];
  gas: GasPlan;
  sender: Address;
}

const shortReason = (e: unknown): string => {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e instanceof Error ? e.message : String(e));
  return m.split("\n")[0].slice(0, 220);
};

/** The calldata the wallet would run: execute for one call, executeBatch for more. */
async function encodeCalls(calls: AaCall[]): Promise<Hex> {
  const account = await fomoAccount();
  return account.encodeCalls(calls.map((c) => ({ to: c.to, value: c.value, data: c.data })));
}

/**
 * eth_call of the batch as a self-call: from the wallet, to the wallet, executeBatch(calls). The account's execute
 * admits only itself and the EntryPoint as callers, and a value call from a wallet with no native ETH cannot be
 * simulated the plain way; this runs the batch as the EntryPoint would, WETH.withdraw included.
 */
export async function simulateBatch(calls: AaCall[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const data = await encodeCalls(calls);
    await publicClient().call({ account: desk(), to: desk(), data });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: shortReason(e) };
  }
}

/** The chain's base fee now, from the latest block; the gas price when the block carries none. */
async function baseFeeWei(): Promise<bigint> {
  const pub = publicClient();
  const block = await pub.getBlock();
  if (block.baseFeePerGas != null && block.baseFeePerGas > 0n) return block.baseFeePerGas;
  return pub.getGasPrice();
}

/**
 * One user operation for the calls: executeBatch encoded, the nonce from the desk's own key, gas filled by hand
 * (no bundler RPC to ask): the inner batch estimated as a self-call plus headroom, fixed verification numbers,
 * fees from the base fee. Signed with the wallet's key over the EntryPoint's typed hash, then packed. Throws with
 * the chain's reason when the batch would revert, since the estimate is that call.
 */
export async function buildUserOp(calls: AaCall[]): Promise<PreparedOp> {
  if (!calls.length) throw new Error("a user operation needs at least one call");
  const account = await fomoAccount();
  const pub = publicClient();
  const chain = viemChain(eth());
  const callData = await account.encodeCalls(calls.map((c) => ({ to: c.to, value: c.value, data: c.data })));
  const nonce = await account.getNonce({ key: DESK_NONCE_KEY });
  const innerEstimate = await pub.estimateGas({ account: account.address, to: account.address, data: callData });
  const gas = gasFor({ innerEstimate, baseFeeWei: await baseFeeWei() });
  const unsigned: UserOperation<"0.8"> = { sender: account.address, nonce, callData, ...gas, signature: "0x" };
  const signature = await account.signUserOperation({ ...unsigned, chainId: chain.id });
  const op: UserOperation<"0.8"> = { ...unsigned, signature };
  const userOpHash = getUserOperationHash({ chainId: chain.id, entryPointAddress: ENTRY_POINT, entryPointVersion: "0.8", userOperation: op });
  return { op, packed: toPackedUserOperation(op), userOpHash, calls, gas, sender: account.address };
}

/** PURE: the EntryPoint's own revert (FailedOp, FailedOpWithRevert) or a plain one, as one line. */
export function decodeEntryPointError(e: unknown): string {
  const walk = (e as { walk?: (fn: (x: unknown) => boolean) => unknown })?.walk;
  const found = typeof walk === "function" ? walk.call(e, (x) => (x as { name?: string })?.name === "ContractFunctionRevertedError") : null;
  const data = (found as { data?: { errorName?: string; args?: readonly unknown[] } } | null)?.data;
  if (data?.errorName) {
    const args = data.args ?? [];
    if (data.errorName === "FailedOp") return `${data.errorName}: ${String(args[1])}`;
    if (data.errorName === "FailedOpWithRevert") return `${data.errorName}: ${String(args[1])} (${decodeRevertBytes(args[2] as Hex)})`;
    return `${data.errorName}${args.length ? ` ${args.map(String).join(", ")}` : ""}`;
  }
  const raw = (found as { raw?: Hex } | null)?.raw ?? (e as { data?: Hex })?.data;
  if (typeof raw === "string" && raw.startsWith("0x") && raw.length > 10) {
    try {
      const d = decodeErrorResult({ abi: entryPoint08Abi, data: raw });
      return `${d.errorName}: ${(d.args ?? []).map(String).join(", ")}`;
    } catch { /* not an EntryPoint error */ }
  }
  return shortReason(e);
}

/** PURE: revert bytes as a person reads them: Error(string) and Panic(uint256) decoded, anything else as hex. */
export function decodeRevertBytes(data: Hex | undefined | null): string {
  if (!data || data === "0x") return "no revert data";
  try {
    const d = decodeErrorResult({ abi: REVERT_ABI, data });
    if (d.errorName === "Error") return String(d.args[0]);
    if (d.errorName === "Panic") return `panic ${d.args[0]}`;
  } catch { /* raw */ }
  return data.length > 74 ? `${data.slice(0, 74)}...` : data;
}

/**
 * The whole operation as the EntryPoint would run it, from the gas wallet, without sending: validation (the
 * signature, the nonce, the prefund from the deposit) reverts here with an AA code and is decoded; the batch
 * itself is simulated as a self-call, since handleOps does not revert when the inner call does.
 */
export async function simulateUserOp(p: PreparedOp): Promise<{ ok: true } | { ok: false; reason: string }> {
  const inner = await simulateBatch(p.calls);
  if (!inner.ok) return { ok: false, reason: `the batch would revert: ${inner.reason}` };
  try {
    const gas = loadGasAccount();
    await publicClient().simulateContract({ account: gas, address: ENTRY_POINT, abi: entryPoint08Abi, functionName: "handleOps", args: [[p.packed], gas.address] });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: decodeEntryPointError(e) };
  }
}

/** One gas wallet, one transaction at a time, across processes (the cycle, closePosition.ts, the probe): the same per-address file lock the agent wallets use. */
async function withGasWalletLock<T>(address: string, what: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 60_000;
  let release = acquire(address, what);
  while (!release) {
    if (Date.now() > deadline) throw new Error("the gas wallet is busy with another send");
    await new Promise((r) => setTimeout(r, 1500));
    release = acquire(address, what);
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/** handleOps([op], gasWallet) from the gas wallet; the transaction hash the moment it is sent. */
export async function submitUserOp(p: PreparedOp): Promise<Hex> {
  const gas = loadGasAccount();
  const chain = viemChain(eth());
  const pub = publicClient();
  const wallet = createWalletClient({ account: gas, chain, transport: transport(eth()) });
  return withGasWalletLock(gas.address, `handleOps for ${p.userOpHash.slice(0, 10)}`, async () => {
    const { request } = await pub.simulateContract({ account: gas, address: ENTRY_POINT, abi: entryPoint08Abi, functionName: "handleOps", args: [[p.packed], gas.address] });
    const estimate = await pub.estimateContractGas({ account: gas, address: ENTRY_POINT, abi: entryPoint08Abi, functionName: "handleOps", args: [[p.packed], gas.address] });
    return wallet.writeContract({ ...request, gas: (estimate * 120n) / 100n });
  });
}

// ---- The receipt (pure) ----

export interface OpOutcome {
  /** Whether the EntryPoint logged the operation at all. */
  found: boolean;
  /** UserOperationEvent.success: the batch ran, or reverted inside a transaction that still landed. */
  success: boolean;
  actualGasCost: bigint;
  actualGasUsed: bigint;
  /** The inner revert bytes, from UserOperationRevertReason, when the batch reverted. */
  revert: Hex | null;
  /** Those bytes read: an Error(string), a panic, or hex. */
  reason: string | null;
}

/**
 * PURE: what the EntryPoint said about one operation, from a handleOps receipt's logs. The outer transaction
 * lands as "success" whether or not the batch ran; only UserOperationEvent.success says which, and
 * UserOperationRevertReason carries the batch's revert. Matched by the op's hash, or by its sender when no hash is
 * known (a settle pass reading an old row).
 */
export function parseHandleOpsReceipt(logs: ReceiptRead["logs"], userOpHash: Hex | null, sender?: string): OpOutcome {
  // The EntryPoint's two events, matched by their selectors and decoded one by one (the receipt's logs carry no block fields here).
  const mine = (hash: string, from: string) => (userOpHash ? hash.toLowerCase() === userOpHash.toLowerCase() : !!sender && from.toLowerCase() === sender.toLowerCase());
  let event: { success: boolean; actualGasCost: bigint; actualGasUsed: bigint } | null = null;
  let revert: Hex | null = null;
  for (const l of logs) {
    if (l.address.toLowerCase() !== ENTRY_POINT.toLowerCase() || l.topics.length < 3) continue;
    const topic0 = l.topics[0].toLowerCase();
    if (topic0 !== OP_EVENT_TOPIC && topic0 !== OP_REVERT_TOPIC) continue;
    try {
      const d = decodeEventLog({ abi: entryPoint08Abi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName === "UserOperationEvent" && !event && mine(d.args.userOpHash, d.args.sender)) event = { success: d.args.success, actualGasCost: d.args.actualGasCost, actualGasUsed: d.args.actualGasUsed };
      if (d.eventName === "UserOperationRevertReason" && revert == null && mine(d.args.userOpHash, d.args.sender)) revert = d.args.revertReason;
    } catch { /* not an EntryPoint event this can read */ }
  }
  if (!event) return { found: false, success: false, actualGasCost: 0n, actualGasUsed: 0n, revert: null, reason: null };
  return { found: true, success: event.success, actualGasCost: event.actualGasCost, actualGasUsed: event.actualGasUsed, revert, reason: event.success ? null : decodeRevertBytes(revert) };
}

/** PURE: what a wallet received of a token in a receipt, raw, from the ERC-20 Transfer logs to it; null when there is none. */
export function receivedRawFromLogs(logs: ReceiptRead["logs"], token: string, recipient: string): bigint | null {
  const t = token.toLowerCase();
  const r = recipient.toLowerCase();
  let sum: bigint | null = null;
  for (const l of logs) {
    if (l.address.toLowerCase() !== t || l.topics.length < 3 || l.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    if (`0x${l.topics[2].slice(-40)}`.toLowerCase() !== r) continue;
    try { sum = (sum ?? 0n) + BigInt(l.data); } catch { /* not a transfer this can read */ }
  }
  return sum;
}

/**
 * PURE: the native ETH a route paid out, from the last hop's v4 Swap event: the swapper's delta on the side it
 * received (positive means received, tape.ts). A native leg leaves no Transfer log, and the wallet's own balance
 * read is unreliable under the app's sweep. Null when the pool logged no swap in this receipt.
 */
export function nativeOutFromSwapLogs(logs: ReceiptRead["logs"], poolId: string, receivedIs0: boolean, poolManager?: string): bigint | null {
  const id = poolId.toLowerCase();
  let sum: bigint | null = null;
  for (const l of logs) {
    if (l.topics.length < 2 || l.topics[0].toLowerCase() !== SWAP_TOPIC || l.topics[1].toLowerCase() !== id) continue;
    if (poolManager && l.address.toLowerCase() !== poolManager.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: SWAP_ABI, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
      const delta = receivedIs0 ? d.args.amount0 : d.args.amount1;
      if (delta > 0n) sum = (sum ?? 0n) + delta;
    } catch { /* not a swap this can read */ }
  }
  return sum;
}

export interface UserOpReceipt {
  status: "success" | "reverted";
  /** What the gas wallet paid for the outer transaction; refunded to it from the wallet's deposit as the beneficiary. */
  gasCostWei: bigint;
  logs: ReceiptRead["logs"];
  op: OpOutcome;
}

/** The handleOps receipt, or null if it has not landed within the timeout; reverted when the batch itself reverted, whatever the outer status says. */
export async function waitUserOp(hash: Hex, userOpHash: Hex, timeoutMs = 120_000): Promise<UserOpReceipt | null> {
  try {
    const r = await publicClient().waitForTransactionReceipt({ hash, timeout: timeoutMs });
    const logs = r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data }));
    const op = parseHandleOpsReceipt(logs, userOpHash, desk());
    return { status: r.status === "success" && op.found && op.success ? "success" : "reverted", gasCostWei: r.gasUsed * r.effectiveGasPrice, logs, op };
  } catch {
    return null;
  }
}

/** The op's outcome from a mined handleOps hash, read once with no wait: for the settle pass over old rows. Null when the chain has no receipt for it yet, or it is not a handleOps transaction. */
export async function opOutcomeOf(hash: Hex): Promise<OpOutcome | null> {
  try {
    const r = await publicClient().getTransactionReceipt({ hash });
    const op = parseHandleOpsReceipt(r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })), null, desk());
    return op.found ? op : null;
  } catch {
    return null;
  }
}

/** Build, simulate, send, wait: the whole lane for a batch, for the probe and any one-off; the desk's swaps go through the lane in onchain.ts so their rows are written between the steps. */
export async function sendUserOp(p: PreparedOp): Promise<{ hash: Hex; success: boolean; gasCostWei: bigint; actualGasCost: bigint; revert?: string }> {
  const hash = await submitUserOp(p);
  const r = await waitUserOp(hash, p.userOpHash);
  if (!r) throw new Error(`the user operation's transaction ${hash} did not land within the wait`);
  return { hash, success: r.status === "success", gasCostWei: r.gasCostWei, actualGasCost: r.op.actualGasCost, ...(r.op.reason ? { revert: r.op.reason } : {}) };
}

// ---- The deposit and the reserve ----

/** The wallet's deposit at the EntryPoint: what its operations' fees are drawn from. */
export async function entryPointDeposit(account: Address = desk()): Promise<bigint> {
  return publicClient().readContract({ address: ENTRY_POINT, abi: entryPoint08Abi, functionName: "balanceOf", args: [account] });
}

/**
 * Keep the wallet's deposit above the minimum: when it is under, the gas wallet calls EntryPoint.depositTo(wallet)
 * with the top-up and waits for it. The app's own sweep operations draw on the same deposit once it exists, so it
 * drains outside the desk's trades; this is read before every operation.
 */
export async function ensureDeposit(minWei: bigint = depositMinWei(), topUpWei: bigint = depositTopUpWei()): Promise<{ before: bigint; after: bigint; hash?: Hex }> {
  const before = await entryPointDeposit();
  if (before >= minWei) return { before, after: before };
  const gas = loadGasAccount();
  const chain = viemChain(eth());
  const pub = publicClient();
  const wallet = createWalletClient({ account: gas, chain, transport: transport(eth()) });
  const hash = await withGasWalletLock(gas.address, "depositTo", async () => {
    const { request } = await pub.simulateContract({ account: gas, address: ENTRY_POINT, abi: entryPoint08Abi, functionName: "depositTo", args: [desk()], value: topUpWei });
    return wallet.writeContract(request);
  });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`the deposit top-up ${hash} reverted`);
  return { before, after: await entryPointDeposit(), hash };
}

/** The lane's gas reserve in ETH: the wallet's EntryPoint deposit plus the gas wallet's native balance. Throws when the gas wallet file is missing, which the rails read as no reserve. */
export async function gasReserveAa(): Promise<number> {
  const gas = loadGasAccount();
  const [deposit, native] = await Promise.all([entryPointDeposit(), readNativeBalance(eth(), gas.address)]);
  return Number(formatEther(deposit + native));
}

/** The wallet's ETH as this lane can spend it: native and WETH, raw. */
export async function spendableEthRaw(holder: string = desk()): Promise<{ native: bigint; weth: bigint; total: bigint }> {
  const [native, weth] = await Promise.all([readNativeBalance(eth(), holder), readTokenBalance(eth(), WETH_CONTRACT as Address, holder)]);
  return { native, weth, total: native + weth };
}

// ---- The rails' view ----

/**
 * PURE: the balances and the reserve as the rails read them under this lane: ETH@robinhood is native plus WETH
 * (walletBalances keeps WETH under its own key and the rails read the native key alone), and the figure the gas
 * reserve is checked against is the deposit plus the gas wallet, not the wallet's own native ETH, which is nil.
 */
export function aaRailView(byKey: Record<string, number>, reserveEth: number | null): { balances: Record<string, number>; nativeOnFromChain: number | null; aa: true } {
  const balances = { ...byKey };
  const native = byKey["ETH@robinhood"];
  const weth = byKey["WETH@robinhood"];
  if (native != null || weth != null) balances["ETH@robinhood"] = (native ?? 0) + (weth ?? 0);
  return { balances, nativeOnFromChain: reserveEth, aa: true };
}

/**
 * The rails' balance view for a context built from a wallet read: the plain one unless the lane is on, when it is
 * aaRailView with the reserve read on chain (null when it cannot be, so the rails refuse rather than guess).
 */
export async function railView(byKey: Record<string, number>, nativeKey = "ETH@robinhood"): Promise<{ balances: Record<string, number>; nativeOnFromChain: number | null; aa?: true }> {
  if (!aaOn()) return { balances: byKey, nativeOnFromChain: byKey[nativeKey] ?? null };
  let reserve: number | null = null;
  try {
    reserve = await gasReserveAa();
  } catch (e) {
    console.error(`[aa] the gas reserve was not read: ${e instanceof Error ? e.message : String(e)}`);
  }
  return aaRailView(byKey, reserve);
}
