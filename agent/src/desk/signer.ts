// The only file that ever touches the private key. It is read from the
// wallet file at call time, used to sign one transaction, and never logged,
// returned, or kept on a module-level variable. The address derived from it
// must match OBS_WALLET_ADDRESS, or nothing is sent.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WALLET_ADDRESS } from "../config.ts";
import { walletFile } from "./rails.ts";
import { chainOf, type Asset } from "./assets.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function viemChain(a: Asset) {
  const c = chainOf(a);
  return defineChain({ id: c.id, name: c.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } });
}
function transport(a: Asset) {
  const c = chainOf(a);
  return http(c.rpc, c.browserUa ? { fetchOptions: { headers: { "User-Agent": UA } } } : undefined);
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
