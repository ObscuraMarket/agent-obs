// The swap console. A person swaps from their own wallet on the Agent page: the desk quotes the pair through its
// own router (the pools, where every Robinhood Chain swap settles), hands back the transactions their wallet has
// to sign, and afterwards reads the swap off the chain and records it as one of that wallet's swaps through the
// console. The desk never holds a key of theirs, never sends for them and never takes custody: the swap pays its
// output to their address inside the same transaction. Nothing is gated on the count: it is a record, shown back.
import { createPublicClient, type Hex } from "viem";
import { resolveAny } from "./candidates.ts";
import { quoteOnChain, encodeSwap } from "./onchain.ts";
import { readErc20Allowance, readPermit2Allowance, approveErc20Data, approvePermit2Data, viemChain, transport } from "./signer.ts";
import { chainMemory } from "../obscura/pools.ts";
import { relayQuote, toSmallest } from "../obscura/relay.ts";
import { appendLedger, readLedger } from "../ledger.ts";
import type { Asset } from "./assets.ts";

const LEDGER = "obs-console-swaps.jsonl";
const DEADLINE_MIN = 20;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type Command =
  | { kind: "help" }
  | { kind: "connect" }
  | { kind: "balance" }
  | { kind: "status" }
  | { kind: "quote" | "swap"; amount: number; from: string; to: string }
  | { kind: "unknown"; text: string }
  | { kind: "empty" };

/** PURE: one typed line as a command. "swap 0.05 ETH USDG", "quote 100 usdg to eth" and "swap 1,000 USDG -> NVDA" all read. */
export function parseCommand(line: string): Command {
  const t = (line ?? "").trim();
  if (!t) return { kind: "empty" };
  const [head, ...rest] = t.split(/\s+/);
  const w = head.toLowerCase();
  if (w === "help" || w === "?") return { kind: "help" };
  if (w === "connect") return { kind: "connect" };
  if (w === "balance" || w === "balances" || w === "bal") return { kind: "balance" };
  if (w === "status" || w === "progress" || w === "eligible") return { kind: "status" };
  if (w === "quote" || w === "swap") {
    const m = rest.join(" ").match(/^([\d,]*\d(?:\.\d+)?)\s+([A-Za-z0-9]+)\s*(?:->|to|for)?\s+([A-Za-z0-9]+)$/i);
    const amount = m ? Number(m[1].replace(/,/g, "")) : NaN;
    if (m && amount > 0) return { kind: w, amount, from: m[2].toUpperCase(), to: m[3].toUpperCase() };
  }
  return { kind: "unknown", text: t };
}

export function isAddress(s: unknown): s is `0x${string}` {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function isTxHash(s: unknown): s is `0x${string}` {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

/** The pair as the console reads it: both legs on Robinhood Chain, both known to the desk. */
export function consoleAssets(fromSpec: string, toSpec: string): { from: Asset; to: Asset } | { error: string } {
  const sym = (s: string) => String(s ?? "").trim().toUpperCase().replace(/@.*$/, "");
  const from = sym(fromSpec) ? resolveAny(`${sym(fromSpec)}@robinhood`) : null;
  const to = sym(toSpec) ? resolveAny(`${sym(toSpec)}@robinhood`) : null;
  if (!from) return { error: `${sym(fromSpec) || "the from token"} is not a token the desk knows on Robinhood Chain` };
  if (!to) return { error: `${sym(toSpec) || "the to token"} is not a token the desk knows on Robinhood Chain` };
  if (from.symbol === to.symbol) return { error: "from and to are the same token" };
  return { from, to };
}

export interface ConsoleStep {
  id: "approve-token" | "approve-permit2" | "swap";
  to: `0x${string}`;
  data: Hex;
  /** Wei, as a decimal string: JSON has no bigint. */
  value: string;
  chainId: number;
  note: string;
}

export interface ConsoleQuote {
  from: string;
  to: string;
  amountIn: number;
  pool: { amountOut: number; minOut: number; costPct: number | null; feePct: number; route: string[]; priceInUsd: number | null; priceOutUsd: number | null };
  /** The app's Private route for the same pair, for comparison; null when Relay is not the app's door for it. */
  relay: { amountOut: number | null; feeUsd: number | null; error: string | null } | null;
  /** What the user's wallet signs, in order: the one-time approvals a token input needs, then the swap. */
  steps: ConsoleStep[];
  /** Unix seconds after which the swap transaction is refused by the router. */
  deadline: number;
}

/** The quote and the transactions for one swap from `user`'s wallet. Reads the chain; sends nothing. */
export async function consoleQuote(fromSpec: string, toSpec: string, amount: number, user: `0x${string}`, now = Date.now()): Promise<ConsoleQuote | { error: string }> {
  const pair = consoleAssets(fromSpec, toSpec);
  if ("error" in pair) return pair;
  const { from, to } = pair;
  if (!(amount > 0)) return { error: "the amount must be positive" };
  const q = await quoteOnChain(from, to, amount);
  if (!q) return { error: `no pool route from ${from.symbol} to ${to.symbol}, or the pools did not answer` };
  const mem = chainMemory();
  const c = mem.contracts.uniswapV4;
  const chainId = mem.chain.id;
  const nowSec = Math.floor(now / 1000);
  const steps: ConsoleStep[] = [];
  if (from.kind === "erc20" && from.contract) {
    const token = from.contract as `0x${string}`;
    const permit2 = c.permit2 as `0x${string}`;
    const router = c.universalRouter as `0x${string}`;
    if ((await readErc20Allowance(from, token, permit2, user)) < q.amountInRaw) steps.push({ id: "approve-token", to: token, data: approveErc20Data(permit2), value: "0", chainId, note: `let Permit2 move your ${from.symbol}, once` });
    const p = await readPermit2Allowance(from, permit2, token, router, user);
    if (p.amount < q.amountInRaw || p.expiration <= nowSec) steps.push({ id: "approve-permit2", to: permit2, data: approvePermit2Data(token, router, nowSec + 365 * 86400), value: "0", chainId, note: `let the router draw ${from.symbol} through Permit2, once a year` });
  }
  const deadline = nowSec + DEADLINE_MIN * 60;
  const tx = encodeSwap(q.route, q.amountInRaw, q.minOutRaw, user, BigInt(deadline));
  steps.push({ id: "swap", to: tx.to, data: tx.data, value: tx.value.toString(), chainId, note: `swap ${amount} ${from.symbol} for at least ${q.minOut} ${to.symbol}, paid to your address` });
  const bridged = (a: Asset) => a.symbol === "ETH" || a.symbol === "USDG";
  const relay = bridged(from) && bridged(to) ? await relayQuote(from, to, amount, user) : null;
  return {
    from: from.symbol,
    to: to.symbol,
    amountIn: amount,
    pool: { amountOut: q.amountOut, minOut: q.minOut, costPct: q.costPct, feePct: q.feePct, route: q.route.hops.map((h) => h.key), priceInUsd: q.priceInUsd, priceOutUsd: q.priceOutUsd },
    relay: relay ? { amountOut: relay.quote?.amountOut ?? null, feeUsd: relay.quote?.feeUsd ?? null, error: relay.error } : null,
    steps,
    deadline,
  };
}

export interface ConsoleSwap {
  at: number;
  address: string;
  txHash: string;
  from: string;
  to: string;
  amountIn: number;
  amountOut: number | null;
  block: number;
}

/** PURE: does this transaction count as this person's swap? Sent by them, to the swap router, succeeded, and for ETH in, carrying the ETH they said. */
export function judgeSwap(tx: { from: string; to: string | null; value: bigint }, receipt: { status: string }, address: string, router: string, from: Asset, amountIn: number): { ok: true } | { ok: false; reason: string } {
  if (receipt.status !== "success") return { ok: false, reason: "the transaction reverted" };
  if (tx.from.toLowerCase() !== address.toLowerCase()) return { ok: false, reason: "the transaction was not sent by this address" };
  if ((tx.to ?? "").toLowerCase() !== router.toLowerCase()) return { ok: false, reason: "the transaction did not go to the swap router" };
  if (from.kind === "native") {
    const want = BigInt(toSmallest(amountIn, 18));
    const diff = tx.value > want ? tx.value - want : want - tx.value;
    if (want <= 0n || diff * 1000n > want) return { ok: false, reason: "the ETH sent does not match the amount reported" };
  }
  return { ok: true };
}

/** PURE: what the swap paid the user in the to-token, from the receipt's Transfer logs; null for ETH out or when nothing arrived. */
export function amountOutFromLogs(logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>, to: Asset, user: string): number | null {
  if (to.kind !== "erc20" || !to.contract) return null;
  const want = "0x" + user.toLowerCase().slice(2).padStart(64, "0");
  let total = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() !== to.contract.toLowerCase()) continue;
    if ((l.topics[0] ?? "").toLowerCase() !== TRANSFER || (l.topics[2] ?? "").toLowerCase() !== want) continue;
    total += BigInt(l.data);
  }
  return total > 0n ? Number(total) / 10 ** to.decimals : null;
}

export function readSwaps(): ConsoleSwap[] {
  return readLedger<ConsoleSwap>(LEDGER).filter((s) => s && isAddress(s.address) && isTxHash(s.txHash) && Number.isFinite(Number(s.at)));
}

/** Read the swap off the chain and, when it is this person's and it succeeded, count it. Never counts a hash twice. */
export async function verifySwap(hash: string, address: string, fromSpec: string, toSpec: string, amountIn: number): Promise<{ ok: true; swap: ConsoleSwap; already: boolean } | { ok: false; reason: string }> {
  if (!isTxHash(hash)) return { ok: false, reason: "that is not a transaction hash" };
  if (!isAddress(address)) return { ok: false, reason: "that is not an address" };
  const pair = consoleAssets(fromSpec, toSpec);
  if ("error" in pair) return { ok: false, reason: pair.error };
  if (!(amountIn > 0)) return { ok: false, reason: "the amount must be positive" };
  const seen = readSwaps().find((s) => s.txHash.toLowerCase() === hash.toLowerCase());
  if (seen) return seen.address === address.toLowerCase() ? { ok: true, swap: seen, already: true } : { ok: false, reason: "that transaction is already counted for the address that sent it" };
  const pub = createPublicClient({ chain: viemChain(pair.from), transport: transport(pair.from) });
  let receipt: Awaited<ReturnType<typeof pub.waitForTransactionReceipt>>;
  try {
    receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  } catch {
    return { ok: false, reason: "the transaction has not landed yet; ask for status again in a minute" };
  }
  const tx = await pub.getTransaction({ hash });
  const j = judgeSwap({ from: tx.from, to: tx.to ?? null, value: tx.value }, { status: receipt.status }, address, chainMemory().contracts.uniswapV4.universalRouter, pair.from, amountIn);
  if (!j.ok) return j;
  const swap: ConsoleSwap = { at: Date.now(), address: address.toLowerCase(), txHash: hash.toLowerCase(), from: pair.from.symbol, to: pair.to.symbol, amountIn, amountOut: amountOutFromLogs(receipt.logs, pair.to, address), block: Number(receipt.blockNumber) };
  appendLedger(LEDGER, swap as unknown as Record<string, unknown>);
  return { ok: true, swap, already: false };
}

export interface ConsoleStanding {
  address: string;
  /** Swaps this wallet made through the console that the desk read off the chain. A record, never a gate. */
  swaps: number;
  recent: Array<{ at: number; txHash: string; from: string; to: string; amountIn: number; amountOut: number | null }>;
}

/** PURE: this wallet's swaps through the console, newest first. */
export function consoleStanding(address: string, swaps: ConsoleSwap[] = readSwaps()): ConsoleStanding {
  const mine = swaps.filter((s) => s.address.toLowerCase() === address.toLowerCase()).sort((a, b) => b.at - a.at);
  return { address: address.toLowerCase(), swaps: mine.length, recent: mine.slice(0, 10).map(({ at, txHash, from, to, amountIn, amountOut }) => ({ at, txHash, from, to, amountIn, amountOut })) };
}
