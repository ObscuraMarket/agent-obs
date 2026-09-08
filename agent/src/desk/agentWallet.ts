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
//
// A token is the person's to take out as much as the ETH is. Only ETH could leave the wallet at first, so a token
// the desk never sold for the agent (its exit refused, or the desk out of the token before the agent was) sat there
// with no way out (2026-09-08). /withdraw SYMBOL sends the whole balance to the signed-in wallet; /sell SYMBOL sells
// it for ETH through the same lane the mirror's exits run, on the person's word rather than the desk's.
import { createHmac } from "node:crypto";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatEther, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { appendLedger, readLedger } from "../ledger.ts";
import { ASSETS, assetKey, type Asset } from "./assets.ts";
import { viemChain, transport, readNativeBalance, readTokenBalance, type Wallet } from "./signer.ts";
import { resolvePayToken, valueUsd, priorRecord, judgeBlock } from "./credits.ts";
import { raiseAlert, type AlertKind } from "./alerts.ts";
import { acquire } from "./walletLock.ts";
import { resolveAny } from "./candidates.ts";
import { executeOnChain, quoteOnChain, latestEthUsd } from "./onchain.ts";
import { railsFromEnv, type Intent, type RailContext } from "./rails.ts";
import { recordFollowTrade } from "./follow.ts";
import type { Trade } from "./book.ts";
import { EXPLORER_URL, NEVER_TRADE } from "../config.ts";

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
/** Blocks a funding needs under it before it is recorded, its own included (OBS_FUND_CONFIRMATIONS); at least one, blank or broken, two. */
export const fundConfirmations = (env: NodeJS.ProcessEnv = process.env): number => { const n = Math.floor(Number(env.OBS_FUND_CONFIRMATIONS)); return n >= 1 ? n : 2; };
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
  // Every derivation that passes is remembered, once: until 2026-09-08 only the /wallet command wrote the row, so a
  // wallet shown by ensure, funded through the page or trading live had nothing for the seed guard to hold against.
  rememberWallet(address, account.address, rows, now);
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
  /** ETH in, ETH out, or a token sent out whole to the signed-in wallet (withdraw-token). */
  kind: "deposit" | "withdraw" | "withdraw-token";
  /** ETH, or the token's symbol on a withdraw-token row. */
  asset: string;
  /** The token's contract on a withdraw-token row, so the row still names it past a symbol change. */
  contract?: string;
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
    else if (r.kind === "withdraw") { b.withdrawnEth += r.amount; b.withdrawals++; b.netUsd -= r.usd ?? 0; }
    // A token sent out whole is value out of the wallet where the pools priced it; it is not ETH, so the ETH tallies stand.
    else b.netUsd -= r.usd ?? 0;
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

const pubClient = (a: Asset) => createPublicClient({ chain: viemChain(a), transport: transport(a) });
type Pub = ReturnType<typeof pubClient>;
const shortReason = (e: unknown): string => ((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e instanceof Error ? e.message : String(e))).split("\n")[0].slice(0, 160);

/** The fee cap the chain quotes for the next block, with the tip when it quotes one; the plain gas price when it quotes neither. */
async function feesNow(pub: Pub): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint }> {
  try {
    const f = await pub.estimateFeesPerGas();
    return { maxFeePerGas: f.maxFeePerGas ?? (await pub.getGasPrice()), maxPriorityFeePerGas: f.maxPriorityFeePerGas };
  } catch {
    return { maxFeePerGas: await pub.getGasPrice() };
  }
}

/**
 * A funding the person sent: read off the chain, recorded once, for the wallet that sent it, once a couple of
 * blocks sit on top of it. A hash another wallet already had recorded is refused rather than shown (the lookup was
 * by hash alone until 2026-09-08), and a funding in the newest block waits, so a reorg cannot leave a row for ETH
 * that never arrived.
 */
export async function verifyFunding(hash: string, address: string, now = Date.now()): Promise<{ ok: true; row: AgentCapitalRow; already: boolean } | { ok: false; reason: string }> {
  if (!walletsOn()) return { ok: false, reason: "Agent wallets aren't switched on here yet." };
  if (!isTxHash(hash) || !isAddress(address)) return { ok: false, reason: "a transaction hash and a wallet are required" };
  const prior = priorRecord(readAgentCapital().filter((r) => r.kind === "deposit"), hash, address);
  if (prior) return "reason" in prior ? { ok: false, reason: prior.reason } : { ok: true, row: prior.row, already: true };
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
  // A funding of any age is still ETH in the agent's wallet, so only the depth is judged here, never the age.
  const [head, block] = await Promise.all([pub.getBlockNumber(), pub.getBlock({ blockNumber: receipt.blockNumber })]);
  const depth = judgeBlock({ blockNumber: receipt.blockNumber, head, blockAt: Number(block.timestamp) * 1000 }, now, { confirmations: fundConfirmations(), maxAgeH: null });
  if ("reason" in depth) return { ok: false, reason: depth.reason };
  const row: AgentCapitalRow = { address: address.toLowerCase(), at: now, kind: "deposit", asset: "ETH", amount: j.amount, usd: await ethUsd(j.amount), txHash: hash.toLowerCase() };
  appendLedger(CAPITAL_LEDGER, row as unknown as Record<string, unknown>);
  return { ok: true, row, already: false };
}

/** The ETH the agent's wallet holds right now, read on chain. */
export async function agentBalanceEth(address: string): Promise<number> {
  return Number(await readNativeBalance(ASSETS["ETH@robinhood"], agentWalletAddress(address))) / 1e18;
}

export type WithdrawResult = { ok: true; hash: `0x${string}`; amount: number; explorerUrl: string } | { ok: false; reason: string };

/**
 * Send ETH from the agent's wallet back to the wallet that signed in, and nowhere else: the destination is the
 * signed-in address by construction. "all" keeps back the gas of the transfer itself. Waits for the receipt.
 */
export async function withdrawEth(address: string, amount: number | "all", now = Date.now(), keepEth = 0): Promise<WithdrawResult> {
  if (!walletsOn()) return { ok: false, reason: "Agent wallets aren't switched on here yet." };
  if (!isAddress(address)) return { ok: false, reason: "no wallet to send to" };
  // A dust amount is a typo, and sending it would only spend gas (a 0.0000001 ETH withdrawal went out on 2026-09-08).
  if (amount !== "all" && !(amount >= MIN_WITHDRAW_ETH)) return { ok: false, reason: `The smallest withdrawal is ${MIN_WITHDRAW_ETH} ETH; /withdraw all sends everything it can.` };
  // The wallet's lock, from the balance read to the receipt: the cycle's mirror signs from this same wallet in
  // another process, and a withdrawal priced against a balance an entry was spending would collide on the nonce
  // or sweep the entry's ETH (2026-09-08). A trade in flight is a short wait, never a fight for the wallet.
  const release = acquire(address, "withdraw");
  if (!release) return { ok: false, reason: "your agent is in the middle of a trade; try again in a moment" };
  try {
    return await sendWithdrawal(address, amount, now, keepEth);
  } finally {
    release();
  }
}

/** The withdrawal itself, under the wallet's lock: read the balance, price the transfer, send it, wait for the receipt, record it. */
async function sendWithdrawal(address: `0x${string}`, amount: number | "all", now: number, keepEth: number): Promise<WithdrawResult> {
  const eth = ASSETS["ETH@robinhood"];
  const chain = viemChain(eth);
  const pub = pubClient(eth);
  const account = agentAccount(address);
  const balance = await pub.getBalance({ address: account.address });
  // The gas is reserved the way the transfer will be priced, and the transfer is sent under that same cap: the fee
  // cap the chain quotes for the next block, times the gas the chain says a transfer to this address takes, with a
  // quarter kept in hand. Reserving at "twice the gas price" sent "all" over the balance once the library priced
  // the transfer under its own, higher cap, and the person read the library's error (2026-09-07).
  const { maxFeePerGas, maxPriorityFeePerGas } = await feesNow(pub);
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
    return { ok: false, reason: `The transfer was not sent: ${shortReason(e)}. Try /withdraw all again in a moment, or a smaller amount.` };
  }
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") return { ok: false, reason: `the transfer ${hash} reverted` };
  const sent = Number(value) / 1e18;
  const row: AgentCapitalRow = { address: address.toLowerCase(), at: now, kind: "withdraw", asset: "ETH", amount: sent, usd: await ethUsd(sent), txHash: hash.toLowerCase() };
  appendLedger(CAPITAL_LEDGER, row as unknown as Record<string, unknown>);
  return { ok: true, hash, amount: sent, explorerUrl: `${EXPLORER_URL}/tx/${hash}` };
}

/**
 * PURE: the token a person names for /withdraw or /sell, as the desk knows it, or why nothing will move. Only a
 * token the desk itself resolves (its registry, the launch feed, the tokens it has traded) has a contract and
 * decimals the desk can trust, and the never-trade list holds in a wallet the desk signs for as it does in its own.
 */
export function pickToken(symbol: string, resolve: (spec: string) => Asset | null = resolveAny, neverTrade: ReadonlySet<string> = NEVER_TRADE): { ok: true; token: Asset } | { ok: false; reason: string } {
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) return { ok: false, reason: "Say which token: /withdraw LENNY sends it to your wallet, /sell LENNY sells it for ETH." };
  if (sym === "ETH") return { ok: false, reason: "ETH goes by amount: /withdraw 0.02 or /withdraw all." };
  // Named with the chain, so a symbol the registry knows elsewhere (USDC on Ethereum) is never taken for a token here.
  const token = resolve(`${sym}@robinhood`);
  if (!token) return { ok: false, reason: `The desk doesn't know a token called ${sym} on Robinhood Chain, so it can't move it. /agent shows what your agent holds.` };
  if (token.kind !== "erc20" || !token.contract) return { ok: false, reason: `${sym} is not a token the desk can transfer.` };
  if (neverTrade.has(token.contract.toLowerCase())) return { ok: false, reason: `${sym} is on the desk's never-trade list; nothing the desk signs for moves it.` };
  return { ok: true, token };
}

/** PURE: the ERC-20 transfer of a whole balance to the signed-in wallet: the token's own transfer, no approval, no route. */
export function withdrawTokenTx(token: Asset, to: `0x${string}`, raw: bigint): { to: `0x${string}`; data: Hex } {
  return { to: token.contract as `0x${string}`, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, raw] }) };
}

/** PURE: what a token leg is worth by the pools' quote: its own pool price, else the ETH it fetches at the desk's ETH price, else unpriced. */
export function quoteUsd(q: { priceInUsd: number | null; amountOut: number } | null, amount: number, ethUsd: number | null): number | null {
  if (!q) return null;
  if (q.priceInUsd != null) return amount * q.priceInUsd;
  return ethUsd != null ? q.amountOut * ethUsd : null;
}

/** A token's dollar value by the pools right now, for the ledger row; null when no pool prices it. Best effort, never a gate. */
async function tokenUsd(token: Asset, amount: number, now: number): Promise<number | null> {
  try { return quoteUsd(await quoteOnChain(token, ASSETS["ETH@robinhood"], amount), amount, latestEthUsd(now)); } catch { return null; }
}

/**
 * Send the agent wallet's whole balance of a token to the wallet that signed in, and nowhere else: the destination
 * is the signed-in address by construction, as with ETH. The transfer's gas is the wallet's ETH. Waits for the receipt.
 */
export async function withdrawToken(address: string, symbol: string, now = Date.now()): Promise<{ ok: true; hash: `0x${string}`; amount: number; symbol: string; explorerUrl: string } | { ok: false; reason: string }> {
  if (!walletsOn()) return { ok: false, reason: "Agent wallets aren't switched on here yet." };
  if (!isAddress(address)) return { ok: false, reason: "no wallet to send to" };
  // Under the wallet's lock like the ETH withdrawal: this signs from the wallet the mirror's exit signs from, and the
  // two raced on the nonce until 2026-09-08.
  const release = acquire(address, "withdraw-token");
  if (!release) return { ok: false, reason: "your agent is in the middle of a trade; try again in a moment" };
  try {
    return await sendTokenWithdrawal(address, symbol, now);
  } finally {
    release();
  }
}

async function sendTokenWithdrawal(address: `0x${string}`, symbol: string, now: number): Promise<{ ok: true; hash: `0x${string}`; amount: number; symbol: string; explorerUrl: string } | { ok: false; reason: string }> {
  const pick = pickToken(symbol);
  if (!pick.ok) return pick;
  const token = pick.token;
  const eth = ASSETS["ETH@robinhood"];
  const pub = pubClient(eth);
  const account = agentAccount(address);
  const raw = await readTokenBalance(token, token.contract as `0x${string}`, account.address);
  if (raw <= 0n) return { ok: false, reason: `Your agent's wallet holds no ${token.symbol}.` };
  const amount = Number(raw) / 10 ** token.decimals;
  const tx = withdrawTokenTx(token, address, raw);
  const { maxFeePerGas, maxPriorityFeePerGas } = await feesNow(pub);
  let gasUnits: bigint;
  try { gasUnits = await pub.estimateGas({ account: account.address, to: tx.to, data: tx.data }); } catch (e) { return { ok: false, reason: `The transfer of ${token.symbol} would not go through: ${shortReason(e)}.` }; }
  // Priced the way the transfer is sent, a quarter in hand, as the ETH withdrawal reserves its own gas.
  const gasCost = (gasUnits * maxFeePerGas * 5n) / 4n;
  const balance = await pub.getBalance({ address: account.address });
  if (balance < gasCost) return { ok: false, reason: `Your agent's wallet holds ${formatEther(balance)} ETH, not enough for the transfer's gas (about ${formatEther(gasCost)} ETH). /fund 0.001 ETH first.` };
  const wallet = createWalletClient({ account, chain: viemChain(eth), transport: transport(eth) });
  let hash: `0x${string}`;
  try {
    hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, gas: gasUnits, maxFeePerGas, ...(maxPriorityFeePerGas != null ? { maxPriorityFeePerGas } : {}) });
  } catch (e) {
    return { ok: false, reason: `The transfer was not sent: ${shortReason(e)}. Try /withdraw ${token.symbol} again in a moment.` };
  }
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") return { ok: false, reason: `the transfer ${hash} reverted` };
  const row: AgentCapitalRow = { address: address.toLowerCase(), at: now, kind: "withdraw-token", asset: token.symbol, contract: (token.contract as string).toLowerCase(), amount, usd: await tokenUsd(token, amount, now), txHash: hash.toLowerCase() };
  appendLedger(CAPITAL_LEDGER, row as unknown as Record<string, unknown>);
  return { ok: true, hash, amount, symbol: token.symbol, explorerUrl: `${EXPLORER_URL}/tx/${hash}` };
}

/**
 * Sell the agent wallet's whole balance of a token for ETH on the person's word: the lane the mirror's exit runs
 * (rails, route, quote, floor, simulate, approvals, send, receipt), signed by the agent's wallet, the row in the
 * agent's own ledger under a manual id so /agent and the events feed show it like any exit. The rails hold: a
 * never-trade contract, trading switched off, or a wallet under the gas reserve is refused in the rail's own words.
 */
export async function sellToken(address: string, symbol: string, now = Date.now()): Promise<{ ok: true; trade: Trade } | { ok: false; reason: string }> {
  if (!walletsOn()) return { ok: false, reason: "Agent wallets aren't switched on here yet." };
  if (!isAddress(address)) return { ok: false, reason: "no wallet signed in" };
  // Under the wallet's lock like a withdrawal: a manual sale and the mirror's exit signed from one wallet at once until 2026-09-08.
  const release = acquire(address, "sell");
  if (!release) return { ok: false, reason: "your agent is in the middle of a trade; try again in a moment" };
  try {
    return await sellTokenNow(address, symbol, now);
  } finally {
    release();
  }
}

async function sellTokenNow(address: `0x${string}`, symbol: string, now: number): Promise<{ ok: true; trade: Trade } | { ok: false; reason: string }> {
  const pick = pickToken(symbol);
  if (!pick.ok) return pick;
  const token = pick.token;
  const eth = ASSETS["ETH@robinhood"];
  const w = agentWallet(address);
  const raw = await readTokenBalance(token, token.contract as `0x${string}`, w.address);
  const tokenBal = Number(raw) / 10 ** token.decimals;
  if (!(tokenBal > 0)) return { ok: false, reason: `Your agent's wallet holds no ${token.symbol}.` };
  const ethBal = Number(await readNativeBalance(eth, w.address)) / 1e18;
  // The rails refuse an unpriced leg, and a manual sale has no desk fill to price it by: the pools price it now.
  const q = await quoteOnChain(token, eth, tokenBal);
  if (!q) return { ok: false, reason: `No pool route from ${token.symbol} to ETH right now, or the pools did not answer. Try again in a moment.` };
  const intent: Intent = { from: token, to: eth, amount: tokenBal, usd: quoteUsd(q, tokenBal, latestEthUsd(now)), exit: true };
  const ctx: RailContext = { rails: railsFromEnv(), balances: { [assetKey(token)]: tokenBal, "ETH@robinhood": ethBal }, nativeOnFromChain: ethBal, openOrders: 0, now };
  const r = await executeOnChain(intent, ctx, now, { wallet: w, record: (t) => recordFollowTrade(address, `manual-${now}`, t) });
  return r.ok ? { ok: true, trade: r.trade } : { ok: false, reason: r.reason };
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
    "  Fund it from your wallet: /fund 0.05 ETH (you sign the transfer). Take it back any time: /withdraw 0.02 or /withdraw all; it can only ever go to the wallet you signed in with. A token it holds goes the same way: /withdraw LENNY sends all of it, /sell LENNY sells all of it for ETH.",
    "  Your agent trades from this wallet when it trades live. On paper it does not touch it.",
  );
  return lines;
}
