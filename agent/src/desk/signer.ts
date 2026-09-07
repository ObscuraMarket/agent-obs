// The only file that ever touches the private key. It is read from the
// wallet file at call time, used to sign one transaction, and never logged,
// returned, or kept on a module-level variable. The address derived from it
// must match OBS_WALLET_ADDRESS, or nothing is sent.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, http, parseAbi, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WALLET_ADDRESS } from "../config.ts";
import { walletFile } from "./rails.ts";
import { chainOf, type Asset } from "./assets.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export function viemChain(a: Asset) {
  const c = chainOf(a);
  return defineChain({ id: c.id, name: c.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } });
}
export function transport(a: Asset) {
  const c = chainOf(a);
  return http(c.rpc, c.browserUa ? { fetchOptions: { headers: { "User-Agent": UA } } } : undefined);
}

/**
 * Can the from-chain be reached right now? A balance read for the desk's own
 * address, through the same transport a send would use. If this fails the
 * order must not be created, because the deposit could never follow it.
 */
export async function fromChainReady(asset: Asset): Promise<boolean> {
  if (!WALLET_ADDRESS) return false;
  try {
    const pub = createPublicClient({ chain: viemChain(asset), transport: transport(asset) });
    await pub.getBalance({ address: WALLET_ADDRESS as `0x${string}` });
    return true;
  } catch {
    return false;
  }
}

function loadAccount() {
  const w = JSON.parse(readFileSync(walletFile(), "utf8")) as { address?: string; privateKey?: string };
  if (!w.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(w.privateKey)) throw new Error("wallet file has no usable key");
  const account = privateKeyToAccount(w.privateKey as Hex);
  if (!WALLET_ADDRESS || account.address.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
    throw new Error("the wallet file's key does not derive to OBS_WALLET_ADDRESS; refusing to sign");
  }
  return account;
}

/**
 * Send exactly `amount` of `asset` to `to` from the desk's wallet and wait
 * for the receipt. Returns the transaction hash. Throws on any doubt.
 */
export async function sendDeposit(asset: Asset, to: `0x${string}`, amount: number): Promise<`0x${string}`> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("deposit address is not an EVM address");
  if (!(amount > 0)) throw new Error("amount must be positive");
  const account = loadAccount();
  const chain = viemChain(asset);
  const wallet = createWalletClient({ account, chain, transport: transport(asset) });
  const pub = createPublicClient({ chain, transport: transport(asset) });
  const value = parseUnits(amount.toFixed(asset.decimals), asset.decimals);
  const hash =
    asset.kind === "native"
      ? await wallet.sendTransaction({ to, value })
      : await wallet.sendTransaction({ to: asset.contract as `0x${string}`, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, value] }) });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`deposit transaction ${hash} reverted`);
  return hash;
}

// ---- The on-chain lane's needs: reads without a key, one raw send with it. ----

export interface RawTx {
  to: `0x${string}`;
  data: Hex;
  value: bigint;
}

const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

const shortError = (e: unknown): string => {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e instanceof Error ? e.message : String(e));
  return m.split("\n")[0].slice(0, 220);
};

/** eth_call of the exact transaction, from the desk's address, with its value. No key involved. */
export async function simulateFromWallet(asset: Asset, tx: RawTx): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!WALLET_ADDRESS) return { ok: false, reason: "no wallet address configured" };
  try {
    const pub = createPublicClient({ chain: viemChain(asset), transport: transport(asset) });
    await pub.call({ account: WALLET_ADDRESS as `0x${string}`, to: tx.to, data: tx.data, value: tx.value });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: shortError(e) };
  }
}

export async function readNativeBalance(asset: Asset, holder = WALLET_ADDRESS): Promise<bigint> {
  const pub = createPublicClient({ chain: viemChain(asset), transport: transport(asset) });
  return pub.getBalance({ address: holder as `0x${string}` });
}
export async function readTokenBalance(asset: Asset, token: `0x${string}`, holder = WALLET_ADDRESS): Promise<bigint> {
  const pub = createPublicClient({ chain: viemChain(asset), transport: transport(asset) });
  return pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder as `0x${string}`] });
}
export async function readErc20Allowance(asset: Asset, token: `0x${string}`, spender: `0x${string}`, owner = WALLET_ADDRESS): Promise<bigint> {
  const pub = createPublicClient({ chain: viemChain(asset), transport: transport(asset) });
  return pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner as `0x${string}`, spender] });
}
export async function readPermit2Allowance(asset: Asset, permit2: `0x${string}`, token: `0x${string}`, spender: `0x${string}`, owner = WALLET_ADDRESS): Promise<{ amount: bigint; expiration: number }> {
  const pub = createPublicClient({ chain: viemChain(asset), transport: transport(asset) });
  const [amount, expiration] = await pub.readContract({ address: permit2, abi: PERMIT2_ABI, functionName: "allowance", args: [owner as `0x${string}`, token, spender] });
  return { amount, expiration: Number(expiration) };
}

/** Calldata for the two one-time approvals the sell leg needs. Pure. */
export function approveErc20Data(spender: `0x${string}`): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 2n ** 256n - 1n] });
}
export function approvePermit2Data(token: `0x${string}`, spender: `0x${string}`, expiration: number): Hex {
  return encodeFunctionData({ abi: PERMIT2_ABI, functionName: "approve", args: [token, spender, 2n ** 160n - 1n, expiration] });
}

/** Sign and send one raw transaction from the desk's wallet; the hash, immediately. */
export async function sendTx(asset: Asset, tx: RawTx): Promise<`0x${string}`> {
  const account = loadAccount();
  const wallet = createWalletClient({ account, chain: viemChain(asset), transport: transport(asset) });
  return wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
}

/** The receipt, or null if it has not landed within the timeout. */
export async function waitReceipt(asset: Asset, hash: `0x${string}`, timeoutMs = 120_000): Promise<{ status: "success" | "reverted"; gasCostWei: bigint } | null> {
  try {
    const pub = createPublicClient({ chain: viemChain(asset), transport: transport(asset) });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: timeoutMs });
    return { status: r.status, gasCostWei: r.gasUsed * r.effectiveGasPrice };
  } catch {
    return null;
  }
}

