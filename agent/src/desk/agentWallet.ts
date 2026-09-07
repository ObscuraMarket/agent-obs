// The agent's own wallet. A person's wallet is the key to the door and stays theirs; the agent they set up in the
// console gets a wallet of its own, made here and held by the desk, that they fund from their wallet and can empty
// back into their wallet at any moment. Nothing else can ever be a withdrawal's destination: the wallet that signed
// in is the only one the money goes back to. When the agent trades live it trades from this wallet; on paper it
// never touches it.
//
// Keys are derived, not stored: HMAC-SHA256 of the person's address under the operator's seed
// (OBS_AGENT_WALLET_SEED). The desk keeps no key file per person, and the same seed gives the same wallet again.
// The seed is the whole custody: whoever holds it holds every agent wallet, and losing it loses them all, so it
// lives only in the desk's environment and is never logged, returned, or written to disk.
import { createHmac } from "node:crypto";
import { createPublicClient, createWalletClient, formatEther, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { appendLedger, readLedger } from "../ledger.ts";
import { ASSETS } from "./assets.ts";
import { viemChain, transport, readNativeBalance, type Wallet } from "./signer.ts";
import { resolvePayToken, valueUsd } from "./credits.ts";
import { EXPLORER_URL } from "../config.ts";

export const WALLETS_LEDGER = "obs-agent-wallets.jsonl";
export const CAPITAL_LEDGER = "obs-agent-capital.jsonl";
/** Gas kept back on a withdrawal of everything: a plain transfer at twice the price the chain quotes, so it lands. */
const TRANSFER_GAS = 21_000n;
export const MIN_FUND_ETH = 0.001;

export const seedOf = (env: NodeJS.ProcessEnv = process.env): string => (env.OBS_AGENT_WALLET_SEED ?? "").trim();
/** Agent wallets exist when the operator set a seed of some length; there is no other switch. */
export const walletsOn = (env: NodeJS.ProcessEnv = process.env): boolean => seedOf(env).length >= 32;
export const isAddress = (a: unknown): a is `0x${string}` => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isTxHash = (h: unknown): h is `0x${string}` => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);

/**
 * PURE: the private key of a person's agent wallet, from the seed and their address. The key is never the point
 * of this function's callers; only the account made from it leaves, and only the address of that leaves the desk.
 */
export function deriveKey(seed: string, address: string): Hex {
  const a = address.toLowerCase();
  for (let i = 0; i < 16; i++) {
    const key = ("0x" + createHmac("sha256", seed).update(`obs-agent-wallet:${a}:${i}`).digest("hex")) as Hex;
    try { privateKeyToAccount(key); return key; } catch { /* out of the curve's range, next */ }
  }
  throw new Error("could not derive a key");
}

/** The account that signs for a person's agent wallet. Only withdraw and, later, live trades hold one, briefly. */
function agentAccount(address: string, env: NodeJS.ProcessEnv = process.env) {
  if (!walletsOn(env)) throw new Error("agent wallets are not switched on: OBS_AGENT_WALLET_SEED is not set");
  return privateKeyToAccount(deriveKey(seedOf(env), address));
}

/** The agent wallet's address for this person: the same every time, and nothing secret about it. */
export function agentWalletAddress(address: string, env: NodeJS.ProcessEnv = process.env): `0x${string}` {
  return agentAccount(address, env).address;
}

/** The agent wallet as a signer, for the lane: made at call time, held only for the trade. */
export function agentWallet(address: string, env: NodeJS.ProcessEnv = process.env): Wallet {
  const account = agentAccount(address, env);
  return { address: account.address, account };
}

export interface WalletRow { address: string; wallet: string; at: number }
export interface AgentCapitalRow {
  address: string;
  at: number;
  kind: "deposit" | "withdraw";
  asset: "ETH";
  amount: number;
  usd: number | null;
  txHash: string;
}

/** The wallet as recorded the first time it was shown, so the operator can list every agent wallet that exists. */
export function rememberWallet(address: string, wallet: string, rows: WalletRow[] = readLedger<WalletRow>(WALLETS_LEDGER), now = Date.now()): void {
  const a = address.toLowerCase();
  if (rows.some((r) => r.address === a)) return;
  appendLedger(WALLETS_LEDGER, { address: a, wallet: wallet.toLowerCase(), at: now });
}

export const readAgentCapital = (): AgentCapitalRow[] => readLedger<AgentCapitalRow>(CAPITAL_LEDGER);

export interface WalletBook { depositedEth: number; withdrawnEth: number; deposits: number; withdrawals: number; netUsd: number }

/** PURE: what went in and what came out of this person's agent wallet, from the desk's own rows. */
export function walletBook(address: string, rows: AgentCapitalRow[]): WalletBook {
  const a = address.toLowerCase();
  const b: WalletBook = { depositedEth: 0, withdrawnEth: 0, deposits: 0, withdrawals: 0, netUsd: 0 };
  for (const r of rows) {
    if (r.address !== a) continue;
    if (r.kind === "deposit") { b.depositedEth += r.amount; b.deposits++; b.netUsd += r.usd ?? 0; }
    else { b.withdrawnEth += r.amount; b.withdrawals++; b.netUsd -= r.usd ?? 0; }
  }
  return b;
}

export interface FundTx {
  to: string;
  data: "0x";
  /** Wei, as a decimal string. */
  value: string;
  chainId: number;
  note: string;
  token: "ETH";
  amount: number;
  purpose: "fund";
  creditsUsd: 0;
  credits: 0;
  bonusPct: 0;
}

/** PURE: the transfer the person's wallet signs to fund the agent's wallet: ETH, to that address, nothing else. */
export function fundTx(wallet: `0x${string}`, amountEth: number): FundTx | { error: string } {
  if (!(amountEth >= MIN_FUND_ETH)) return { error: `The smallest funding is ${MIN_FUND_ETH} ETH.` };
  // Eight decimals of ETH: a hundred-millionth, past which a float's own noise would put a stray wei in the value.
  return { to: wallet, data: "0x", value: parseEther(amountEth.toFixed(8)).toString(), chainId: 4663, note: `send ${amountEth} ETH to your agent's wallet`, token: "ETH", amount: amountEth, purpose: "fund", creditsUsd: 0, credits: 0, bonusPct: 0 };
}

/** PURE: a landed transaction is a funding when the person's wallet sent ETH to the agent's wallet in the call itself. */
export function judgeFunding(tx: { from: string; to: string | null; value: bigint }, payer: string, wallet: string): { amount: number } | { reason: string } {
  if (tx.from.toLowerCase() !== payer.toLowerCase()) return { reason: "that transaction was not sent by this wallet" };
  if ((tx.to ?? "").toLowerCase() !== wallet.toLowerCase()) return { reason: "that transaction did not go to your agent's wallet" };
  if (!(tx.value > 0n)) return { reason: "that transaction carried no ETH" };
  return { amount: Number(tx.value) / 1e18 };
}

const ethUsd = async (amount: number): Promise<number | null> => {
  const t = resolvePayToken("ETH");
  return t ? valueUsd(t, amount) : null;
};

/** A funding the person sent: read off the chain, recorded once. */
export async function verifyFunding(hash: string, address: string, now = Date.now()): Promise<{ ok: true; row: AgentCapitalRow; already: boolean } | { ok: false; reason: string }> {
  if (!walletsOn()) return { ok: false, reason: "Agent wallets aren't switched on here yet." };
  if (!isTxHash(hash) || !isAddress(address)) return { ok: false, reason: "a transaction hash and a wallet are required" };
  const prior = readAgentCapital().find((r) => r.kind === "deposit" && r.txHash.toLowerCase() === hash.toLowerCase());
  if (prior) return { ok: true, row: prior, already: true };
  const wallet = agentWalletAddress(address);
  const eth = ASSETS["ETH@robinhood"];
  const pub = createPublicClient({ chain: viemChain(eth), transport: transport(eth) });
  let receipt: Awaited<ReturnType<typeof pub.getTransactionReceipt>>;
  try { receipt = await pub.getTransactionReceipt({ hash: hash as Hex }); } catch { return { ok: false, reason: "that transaction is not on Robinhood Chain yet; give it a moment and try /wallet again" }; }
  if (receipt.status !== "success") return { ok: false, reason: "that transaction did not succeed" };
  const tx = await pub.getTransaction({ hash: hash as Hex });
  const j = judgeFunding({ from: tx.from, to: tx.to ?? null, value: tx.value }, address, wallet);
  if ("reason" in j) return { ok: false, reason: j.reason };
  const row: AgentCapitalRow = { address: address.toLowerCase(), at: now, kind: "deposit", asset: "ETH", amount: j.amount, usd: await ethUsd(j.amount), txHash: hash.toLowerCase() };
  appendLedger(CAPITAL_LEDGER, row as unknown as Record<string, unknown>);
  return { ok: true, row, already: false };
}

/** The ETH the agent's wallet holds right now, read on chain. */
export async function agentBalanceEth(address: string): Promise<number> {
  return Number(await readNativeBalance(ASSETS["ETH@robinhood"], agentWalletAddress(address))) / 1e18;
}

/**
 * Send ETH from the agent's wallet back to the wallet that signed in, and nowhere else: the destination is the
 * signed-in address by construction. "all" keeps back the gas of the transfer itself. Waits for the receipt.
 */
export async function withdrawEth(address: string, amount: number | "all", now = Date.now()): Promise<{ ok: true; hash: `0x${string}`; amount: number; explorerUrl: string } | { ok: false; reason: string }> {
  if (!walletsOn()) return { ok: false, reason: "Agent wallets aren't switched on here yet." };
  if (!isAddress(address)) return { ok: false, reason: "no wallet to send to" };
  const eth = ASSETS["ETH@robinhood"];
  const chain = viemChain(eth);
  const pub = createPublicClient({ chain, transport: transport(eth) });
  const account = agentAccount(address);
  const balance = await pub.getBalance({ address: account.address });
  const gasPrice = await pub.getGasPrice();
  const gasCost = TRANSFER_GAS * gasPrice * 2n;
  let value: bigint;
  if (amount === "all") {
    value = balance - gasCost;
    if (value <= 0n) return { ok: false, reason: `Your agent's wallet holds ${formatEther(balance)} ETH, not enough to cover the transfer's gas.` };
  } else {
    if (!(amount > 0)) return { ok: false, reason: "Say how much: /withdraw 0.02 or /withdraw all." };
    value = parseEther(amount.toFixed(8));
    if (value + gasCost > balance) return { ok: false, reason: `Your agent's wallet holds ${Number(formatEther(balance)).toFixed(5)} ETH; ${amount} ETH plus gas is more than that. /withdraw all sends everything it can.` };
  }
  const wallet = createWalletClient({ account, chain, transport: transport(eth) });
  const hash = await wallet.sendTransaction({ to: address, value, gas: TRANSFER_GAS });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") return { ok: false, reason: `the transfer ${hash} reverted` };
  const sent = Number(value) / 1e18;
  const row: AgentCapitalRow = { address: address.toLowerCase(), at: now, kind: "withdraw", asset: "ETH", amount: sent, usd: await ethUsd(sent), txHash: hash.toLowerCase() };
  appendLedger(CAPITAL_LEDGER, row as unknown as Record<string, unknown>);
  return { ok: true, hash, amount: sent, explorerUrl: `${EXPLORER_URL}/tx/${hash}` };
}

const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** PURE: the agent's wallet for the console: where it is, what it holds, what went in and out, and what to do with it. */
export function walletLines(wallet: string, balanceEth: number, ethPriceUsd: number | null, book: WalletBook, explorerBase: string = EXPLORER_URL): string[] {
  const value = ethPriceUsd != null ? ` (${usd(balanceEth * ethPriceUsd)})` : "";
  const lines = [
    `Your agent's wallet: ${wallet}`,
    `  holds ${balanceEth.toFixed(5)} ETH${value}. ${explorerBase}/address/${wallet}`,
  ];
  if (book.deposits || book.withdrawals) lines.push(`  ${book.depositedEth.toFixed(5)} ETH in over ${book.deposits} funding${book.deposits === 1 ? "" : "s"}, ${book.withdrawnEth.toFixed(5)} ETH out over ${book.withdrawals} withdrawal${book.withdrawals === 1 ? "" : "s"}.`);
  lines.push(
    "  Fund it from your wallet: /fund 0.05 ETH (you sign the transfer). Take it back any time: /withdraw 0.02 or /withdraw all; it can only ever go to the wallet you signed in with.",
    "  Your agent trades from this wallet when it trades live. On paper it does not touch it.",
  );
  return lines;
}
