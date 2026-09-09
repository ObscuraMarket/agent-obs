// Sending a swap as an ORDINARY transaction from the trading wallet, so that fomo reads it as a buy.
//
// The app decides what a transaction is by what it was sent TO. A plain call to the router it decodes and shows as
// a Buy; a user operation goes to the EntryPoint with the router call buried inside it, and all the app sees is a
// token arriving, which it labels Received. Same router, same pool, same fill, and the wrong label (2026-09-09:
// the desk's $201.72 of MANTA showed as Received four minutes before an identical $99.37 buy from the app showed
// as Buy).
//
// The wallet holds no native ETH because the app wraps every wei of it into WETH within about twenty seconds, and
// that is why the desk uses user operations at all. Two things make an ordinary transaction possible anyway. The
// wallet is still an EOA with delegated code, so it can sign one. And the route will take WETH as the input for an
// ETH leg, giving the identical output, so the swap spends a token the sweep does not touch. The only thing the
// sweep can take is the gas, so the gas wallet tops the wallet up immediately before, and the race is a second
// against twenty. A lost race costs the gas of a reverted transaction and nothing else: the ETH is not gone, it is
// wrapped, and the lane falls back to the user operation that has always worked.
import { createPublicClient, createWalletClient, formatEther, type Address, type Hex } from "viem";
import { WETH_CONTRACT } from "../config.ts";
import { ASSETS, type Asset } from "./assets.ts";
import { loadAccount, viemChain, transport, readNativeBalance, type RawTx } from "./signer.ts";
import { loadGasAccount } from "./aa.ts";
import type { AaCall } from "./aa.ts";

const eth = (): Asset => ASSETS["ETH@robinhood"];
const pubClient = () => createPublicClient({ chain: viemChain(eth()), transport: transport(eth()) });

/** PURE: the lane is on only when the operator asks for it. */
export function directOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OBS_SEND ?? "").toLowerCase() === "direct";
}

/** PURE: the native ETH the wallet is topped up to before a direct send, and the floor under which it is topped up. */
export function gasTopUpWei(env: NodeJS.ProcessEnv = process.env): bigint {
  const n = Number(env.OBS_DIRECT_GAS_ETH ?? 0.0015);
  return BigInt(Math.round((Number.isFinite(n) && n > 0 ? n : 0.0015) * 1e9)) * 10n ** 9n;
}

/** PURE: what one direct send needs in the wallet, gas only, since the swap spends WETH and carries no value. */
export function needsTopUp(nativeRaw: bigint, want: bigint = gasTopUpWei()): boolean {
  return nativeRaw < want / 2n;
}

export const WETH = (): Address => WETH_CONTRACT as Address;

/**
 * Put gas in the trading wallet from the gas wallet, and wait for it. Returns the hash when it sent, null when the
 * wallet already had enough. The amount is small on purpose: whatever the sweep takes is a rounding error, and
 * leaving a large balance there would simply be wrapped.
 */
export async function fundGas(want: bigint = gasTopUpWei()): Promise<{ hash?: Hex; before: bigint; after: bigint }> {
  const wallet = loadAccount();
  const pub = pubClient();
  const before = await readNativeBalance(eth(), wallet.address);
  if (!needsTopUp(before, want)) return { before, after: before };
  const gas = loadGasAccount();
  const client = createWalletClient({ account: gas, chain: viemChain(eth()), transport: transport(eth()) });
  const hash = await client.sendTransaction({ to: wallet.address, value: want });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (r.status !== "success") throw new Error(`the gas top-up ${hash} reverted`);
  return { hash, before, after: await readNativeBalance(eth(), wallet.address) };
}

export interface DirectResult {
  /** The swap's own hash, which is the one the app reads. */
  hash: Hex;
  /** Everything sent, the approvals included, oldest first. */
  sent: Hex[];
}

/**
 * Send the route's calls as ordinary transactions from the trading wallet, in order, each waited for. The last call
 * is the swap and its hash is what the book records. A call that reverts throws, and nothing after it is sent.
 */
export async function sendDirect(calls: AaCall[]): Promise<DirectResult> {
  if (!calls.length) throw new Error("nothing to send");
  const wallet = loadAccount();
  const chain = viemChain(eth());
  const client = createWalletClient({ account: wallet, chain, transport: transport(eth()) });
  const pub = pubClient();
  const sent: Hex[] = [];
  for (const [i, c] of calls.entries()) {
    const tx: RawTx = { to: c.to as Address, data: c.data as Hex, value: c.value };
    const hash = await client.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
    sent.push(hash);
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`call ${i + 1} of ${calls.length} to ${c.to} reverted (${hash})`);
  }
  return { hash: sent[sent.length - 1], sent };
}

/** What the lane can say for itself, for the log: the wallet's gas and what a top-up would send. */
export async function gasLine(): Promise<string> {
  const wallet = loadAccount();
  const have = await readNativeBalance(eth(), wallet.address);
  return `the trading wallet holds ${formatEther(have)} ETH of gas; a top-up sends ${formatEther(gasTopUpWei())}`;
}
