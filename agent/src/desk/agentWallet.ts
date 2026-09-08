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
//
// The wallets ledger remembers each wallet the first time it was shown, and every derivation after that is held
// against the row: a rotated or mistyped seed derives a different, empty wallet for everyone, and until 2026-09-08
// nothing noticed, so every /wallet would have shown a fresh address with the funded one gone quiet behind it. Now
// that is an error the console names and a page to the operator, never a fresh address.
import { createHmac } from "node:crypto";
import { createPublicClient, createWalletClient, formatEther, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { appendLedger, readLedger } from "../ledger.ts";
import { ASSETS } from "./assets.ts";
import { viemChain, transport, readNativeBalance, type Wallet } from "./signer.ts";
import { resolvePayToken, valueUsd } from "./credits.ts";
import { raiseAlert, type AlertKind } from "./alerts.ts";
import { EXPLORER_URL } from "../config.ts";

export const WALLETS_LEDGER = "obs-agent-wallets.jsonl";
export const CAPITAL_LEDGER = "obs-agent-capital.jsonl";
/** Gas kept back on a withdrawal of everything: a plain transfer at twice the price the chain quotes, so it lands. */
const TRANSFER_GAS = 21_000n;
export const MIN_FUND_ETH = 0.001;
/** The smallest withdrawal by amount; "all" has no floor. */
export const MIN_WITHDRAW_ETH = 0.0001;

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

export interface WalletRow { address: string; wallet: string; at: number }
export const readAgentWallets = (): WalletRow[] => readLedger<WalletRow>(WALLETS_LEDGER);

/** What the console says when the seed no longer derives the wallet the desk remembers. Never the seed, never a fresh address. */
export const WALLET_DERIVATION_LINE = "Your agent's wallet cannot be derived right now; the operator has been paged.";

/** A derivation the ledger contradicts. Its message is the console's line; the detail is in the page, not here. */
export class WalletDerivationError extends Error {
  constructor(public readonly address: string) {
    super(WALLET_DERIVATION_LINE);
    this.name = "WalletDerivationError";
  }
}

/** The alarm this module raises; injectable so a test sees the page without a ledger or a webhook. */
export type Pager = (kind: AlertKind, text: string, now?: number) => Promise<boolean>;

/**
 * PURE: today's derivation against the wallet the ledger remembers for this person. Null when they agree, or when
 * nothing is remembered yet (the first showing is what writes the row). The row is what rememberWallet wrote, so
 * both sides are compared in lower case.
 */
export function walletMismatch(address: string, derived: string, rows: WalletRow[]): { remembered: string; derived: string } | null {
  const a = address.toLowerCase();
  const row = rows.find((r) => r.address === a && typeof r.wallet === "string");
  if (!row) return null;
  const d = derived.toLowerCase();
  if (row.wallet.toLowerCase() === d) return null;
  return { remembered: row.wallet.toLowerCase(), derived: d };
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

/** PURE: the page's words. Addresses only; the seed's value is the one thing this module never lets out. */
export function seedAlertText(address: string, m: { remembered: string; derived: string }): string {
  return `an agent wallet cannot be derived: the desk remembers ${short(m.remembered)} for ${short(address)} and today's OBS_AGENT_WALLET_SEED derives ${short(m.derived)}; the seed was rotated or mistyped, and every agent wallet is orphaned until the seed that made them is back`;
}

/**
 * The account that signs for a person's agent wallet. Only withdraw and live trades hold one, briefly. Every
 * derivation passes here, so every one of them is held against the ledger: a wallet the desk remembers that today's
 * seed does not derive is a page to the operator (once per cooldown, the alarm's own rule) and an error, and no
 * caller ever sees, funds, or trades from the wrong one.
 */
function agentAccount(address: string, env: NodeJS.ProcessEnv = process.env, rows: WalletRow[] = readAgentWallets(), page: Pager = raiseAlert, now = Date.now()) {
  if (!walletsOn(env)) throw new Error("agent wallets are not switched on: OBS_AGENT_WALLET_SEED is not set");
  const account = privateKeyToAccount(deriveKey(seedOf(env), address));
  const bad = walletMismatch(address, account.address, rows);
  if (bad) {
    // The page goes out before the throw and is not awaited: the alarm never fails or delays the caller, and logs its own trouble.
    void page("cycle", seedAlertText(address, bad), now).catch(() => { /* raiseAlert never throws; a stand-in might */ });
    throw new WalletDerivationError(address);
  }
  return account;
}

/** The agent wallet's address for this person: the same every time, and nothing secret about it. */
export function agentWalletAddress(address: string, env: NodeJS.ProcessEnv = process.env, rows: WalletRow[] = readAgentWallets(), page: Pager = raiseAlert, now = Date.now()): `0x${string}` {
  return agentAccount(address, env, rows, page, now).address;
}

/**
 * The address, or null: wallets off, or a wallet today's seed does not derive (paged inside). For the persona and
 * the public list of agents, which say nothing about a wallet rather than fail whole on one, and must never show a
 * fresh address in its place.
 */
export function agentWalletAddressOrNull(address: string, env: NodeJS.ProcessEnv = process.env, rows: WalletRow[] = readAgentWallets(), page: Pager = raiseAlert, now = Date.now()): `0x${string}` | null {
  if (!walletsOn(env)) return null;
  try { return agentWalletAddress(address, env, rows, page, now); } catch (e) {
    if (e instanceof WalletDerivationError) return null;
    throw e;
  }
}

/** The agent wallet as a signer, for the lane: made at call time, held only for the trade, and held against the ledger like every derivation. */
export function agentWallet(address: string, env: NodeJS.ProcessEnv = process.env, rows: WalletRow[] = readAgentWallets(), page: Pager = raiseAlert, now = Date.now()): Wallet {
  const account = agentAccount(address, env, rows, page, now);
  return { address: account.address, account };
}
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
export function rememberWallet(address: string, wallet: string, rows: WalletRow[] = readAgentWallets(), now = Date.now()): void {
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
  let wallet: `0x${string}`;
  try { wallet = agentWalletAddress(address); } catch (e) {
    // A funding is never judged against a wallet the seed no longer derives; the person hears the console's line.
    if (e instanceof WalletDerivationError) return { ok: false, reason: e.message };
    throw e;
  }
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
export async function withdrawEth(address: string, amount: number | "all", now = Date.now(), keepEth = 0): Promise<{ ok: true; hash: `0x${string}`; amount: number; explorerUrl: string } | { ok: false; reason: string }> {
  if (!walletsOn()) return { ok: false, reason: "Agent wallets aren't switched on here yet." };
  if (!isAddress(address)) return { ok: false, reason: "no wallet to send to" };
  // A dust amount is a typo, and sending it would only spend gas (a 0.0000001 ETH withdrawal went out on 2026-09-08).
  if (amount !== "all" && !(amount >= MIN_WITHDRAW_ETH)) return { ok: false, reason: `The smallest withdrawal is ${MIN_WITHDRAW_ETH} ETH; /withdraw all sends everything it can.` };
  const eth = ASSETS["ETH@robinhood"];
  const chain = viemChain(eth);
  const pub = createPublicClient({ chain, transport: transport(eth) });
  const account = agentAccount(address);
  const balance = await pub.getBalance({ address: account.address });
  // The gas is reserved the way the transfer will be priced, and the transfer is sent under that same cap: the fee
  // cap the chain quotes for the next block, times the gas the chain says a transfer to this address takes, with a
  // quarter kept in hand. Reserving at "twice the gas price" sent "all" over the balance once the library priced
  // the transfer under its own, higher cap, and the person read the library's error (2026-09-07).
  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint | undefined;
  try {
    const f = await pub.estimateFeesPerGas();
    maxFeePerGas = f.maxFeePerGas ?? (await pub.getGasPrice());
    maxPriorityFeePerGas = f.maxPriorityFeePerGas;
  } catch {
    maxFeePerGas = await pub.getGasPrice();
  }
  let gasUnits = TRANSFER_GAS;
  try { gasUnits = await pub.estimateGas({ account: account.address, to: address, value: 1n }); } catch { /* a plain transfer's gas stands */ }
  const gasCost = (gasUnits * maxFeePerGas * 5n) / 4n;
  let value: bigint;
  // What the caller asks to keep back: the exit's gas while the agent still holds a token, so no withdrawal, whole
  // or by amount, leaves a position the desk cannot sell (2026-09-08).
  const keep = keepEth > 0 ? parseEther(keepEth.toFixed(8)) : 0n;
  if (amount === "all") {
    value = balance - gasCost - keep;
    if (value <= 0n) return { ok: false, reason: keep > 0n ? `Your agent's wallet holds ${formatEther(balance)} ETH and still holds a token; ${keepEth} ETH stays for the sale's gas, which leaves nothing to send.` : `Your agent's wallet holds ${formatEther(balance)} ETH, not enough to cover the transfer's gas.` };
  } else {
    if (!(amount > 0)) return { ok: false, reason: "Say how much: /withdraw 0.02 or /withdraw all." };
    value = parseEther(amount.toFixed(8));
    if (value + gasCost + keep > balance) return { ok: false, reason: keep > 0n ? `Your agent's wallet holds ${Number(formatEther(balance)).toFixed(5)} ETH and still holds a token; ${keepEth} ETH stays for the sale's gas, so ${amount} ETH plus gas is more than it can send. /withdraw all sends what it can.` : `Your agent's wallet holds ${Number(formatEther(balance)).toFixed(5)} ETH; ${amount} ETH plus gas is more than that. /withdraw all sends everything it can.` };
  }
  const wallet = createWalletClient({ account, chain, transport: transport(eth) });
  let hash: `0x${string}`;
  try {
    hash = await wallet.sendTransaction({ to: address, value, gas: gasUnits, maxFeePerGas, ...(maxPriorityFeePerGas != null ? { maxPriorityFeePerGas } : {}) });
  } catch (e) {
    const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e instanceof Error ? e.message : String(e));
    return { ok: false, reason: `The transfer was not sent: ${m.split("\n")[0].slice(0, 160)}. Try /withdraw all again in a moment, or a smaller amount.` };
  }
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
