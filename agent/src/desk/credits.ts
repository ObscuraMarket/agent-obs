// Credits: what a person's agent spends when it thinks, and what they pay it with. A wallet's balance is a ledger
// of grants (a little on the house), deposits (a payment the desk read off the chain: ETH, USDG, AOBS or a
// tokenized stock sent to the credits treasury) and charges (each turn, at the chosen model's price plus the
// desk's margin). The treasury is the operator's address, never the desk's trading wallet; the desk holds no key
// for it and only reads what arrived. A payment is priced at its block, from the desk's own price samples, so a
// deposit is worth what it was worth when it landed; only when no sample is near the block do the pools' price
// right now, or the stock's own print, stand in, and the row says so. A payment counts once it has a few blocks on
// top of it, within a day of landing, and only for the wallet that sent it. Until 2026-09-08 any successful
// transaction of any age was priced at verification time, and a hash already counted was answered with the row
// whoever asked, so one wallet could read another's payment and an old transfer could be credited at today's price.
import { createPublicClient, encodeFunctionData, parseAbi, type Hex } from "viem";
import { appendLedger, readLedger } from "../ledger.ts";
import { readPrices, type PriceSample } from "./analysis.ts";
import { ASSETS, resolveAsset, type Asset } from "./assets.ts";
import { viemChain, transport } from "./signer.ts";
import { quoteOnChain } from "./onchain.ts";
import { chainMemory } from "../obscura/pools.ts";
import { lastAgentTokenPrice } from "./agentToken.ts";
import { stockReference } from "../obscura/stockRef.ts";
import { assetPrices } from "../obscura/reads.ts";
import { AGENT_TOKEN, AGENT_TOKEN_SYMBOL, WALLET_ADDRESS } from "../config.ts";
import { recordCapital, type CapitalFlow } from "./book.ts";
import { isAddress, isTxHash } from "./console.ts";

export const CREDITS_LEDGER = "obs-credits.jsonl";
/** The unit: a credit is a cent, so 1,000 credits are $10 of USDG. The ledger keeps dollars; people see credits. */
export const CREDITS_PER_USD = 100;
/** PURE: dollars as credits, to a hundredth of a credit. */
export const toCredits = (usd: number): number => Math.round(usd * CREDITS_PER_USD * 100) / 100;
/** PURE: credits as a person reads them: whole when whole, else two decimals, with thousands separated. */
export const fmtCredits = (credits: number): string => (Number.isInteger(credits) ? credits.toLocaleString("en-US") : credits.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

export interface CreditRow {
  at: number;
  address: string;
  kind: "grant" | "deposit" | "charge";
  /** Dollars: added for a grant or a deposit, taken for a charge. */
  usd: number;
  token?: string;
  amount?: number;
  txHash?: string;
  /** A deposit: when its block was sealed, in ms. */
  blockAt?: number;
  /** A deposit: priced "block" from the desk's own sample nearest its block (a dollar token at face counts as that), or "now" because no sample was within an hour of it. */
  pricedAt?: "block" | "now";
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  note?: string;
}

export const treasury = (env: NodeJS.ProcessEnv = process.env): string | null => (isAddress(env.OBS_CREDITS_TREASURY) ? (env.OBS_CREDITS_TREASURY as string).toLowerCase() : null);
/** Credits can be bought when the operator named a treasury; without one, turns are metered but never refused. */
export const creditsOn = (env: NodeJS.ProcessEnv = process.env): boolean => treasury(env) !== null;
/**
 * The treasury is the desk's own trading wallet: what people pay lands where the agent trades from. A payment is
 * then also capital handed to the desk, and it is written to the capital ledger so the book measures trading
 * against it rather than counting it as profit the desk never made.
 */
export const treasuryIsDesk = (env: NodeJS.ProcessEnv = process.env, wallet: string = WALLET_ADDRESS): boolean => { const t = treasury(env); return !!t && !!wallet && t === wallet.toLowerCase(); };

/** PURE: the capital row for a verified payment: the asset and amount that arrived, at their value before any credits bonus. */
export function capitalRowFor(payer: string, token: string, amount: number, usd: number, txHash: string, at: number): CapitalFlow {
  return { at, kind: "deposit", asset: token.toUpperCase(), amount, usd: Math.round(usd * 100) / 100, note: `credits bought by ${payer.toLowerCase()}`, txHash: txHash.toLowerCase(), from: payer.toLowerCase() };
}
/** Credits on the house for a new wallet (OBS_CREDITS_FREE, in credits), as dollars for the ledger. */
export const freeUsd = (env: NodeJS.ProcessEnv = process.env): number => Math.max(0, Number(env.OBS_CREDITS_FREE ?? 100) || 0) / CREDITS_PER_USD;
export const marginPct = (env: NodeJS.ProcessEnv = process.env): number => Math.max(0, Number(env.OBS_CREDITS_MARGIN_PCT ?? 25) || 0);
/** Paying in the agent's own token earns a little extra. */
export const bonusPct = (symbol: string, env: NodeJS.ProcessEnv = process.env): number => (symbol.toUpperCase() === AGENT_TOKEN_SYMBOL ? Math.max(0, Number(env.OBS_CREDITS_AOBS_BONUS_PCT ?? 10) || 0) : 0);
/**
 * Tokens the gateway sends along with a message that this desk cannot see: its own system prompt, its tool
 * definitions and the conversation so far. Estimated, and metered. Measured on 2026-09-07 against OpenRouter's own
 * counter: a default-model turn cost about three times what a 2,000-token allowance priced, so 8,000 is the floor.
 */
export const contextTokens = (env: NodeJS.ProcessEnv = process.env): number => Math.max(0, Number(env.OBS_CREDITS_CONTEXT_TOKENS ?? 8000) || 0);
/** A payment counts within this many hours of its block (OBS_CREDITS_MAX_AGE_H); blank or broken, a day. */
export const maxAgeH = (env: NodeJS.ProcessEnv = process.env): number => { const h = Number(env.OBS_CREDITS_MAX_AGE_H); return h > 0 ? h : 24; };
/** Blocks a payment needs under it before it is counted, its own included (OBS_CREDITS_CONFIRMATIONS); at least one, blank or broken, three. */
export const confirmationsNeeded = (env: NodeJS.ProcessEnv = process.env): number => { const n = Math.floor(Number(env.OBS_CREDITS_CONFIRMATIONS)); return n >= 1 ? n : 3; };

/**
 * PURE: a transaction the ledger already holds is answered from the ledger, and only to the wallet it was recorded
 * for. Until 2026-09-08 the lookup was by hash alone, so any wallet naming another's payment was told it was
 * counted and handed the row.
 */
export function priorRecord<R extends { address: string; txHash?: string }>(rows: R[], hash: string, address: string): { row: R } | { reason: string } | null {
  const h = hash.toLowerCase();
  const prior = rows.find((r) => (r.txHash ?? "").toLowerCase() === h);
  if (!prior) return null;
  if (prior.address.toLowerCase() !== address.toLowerCase()) return { reason: "that transaction is already counted for the address that sent it" };
  return { row: prior };
}

/** PURE: how many blocks confirm a transaction: its own and every one on top. Zero or less when the node is behind it. */
export const confirmationsOf = (blockNumber: bigint, head: bigint): number => Number(head - blockNumber) + 1;

/**
 * PURE: whether a landed transaction may be counted yet: deep enough that a reorg will not take it back, and, when
 * a window is given, recent enough that the desk still has the price it landed at. Too shallow is a refusal for
 * now; too old is a refusal for good, since an old transfer priced at today's price is not what it was worth.
 */
export function judgeBlock(b: { blockNumber: bigint; head: bigint; blockAt: number }, now: number, rule: { confirmations: number; maxAgeH: number | null }): { ok: true; confirmations: number; ageH: number } | { reason: string } {
  const confirmations = confirmationsOf(b.blockNumber, b.head);
  if (confirmations < rule.confirmations) return { reason: `that transaction has ${Math.max(0, confirmations)} confirmation${confirmations === 1 ? "" : "s"} and ${rule.confirmations} are needed; give it a moment and try again` };
  const ageH = (now - b.blockAt) / 3600e3;
  if (rule.maxAgeH != null && ageH > rule.maxAgeH) return { reason: `that transaction landed ${ageH < 48 ? `${Math.round(ageH)} hours` : `${Math.round(ageH / 24)} days`} ago and only the last ${rule.maxAgeH} hours count` };
  return { ok: true, confirmations, ageH };
}

/** PURE: the desk's own sample of a symbol nearest `at`, within the window, or null when it has none that close. */
export function sampleNear(samples: ReadonlyArray<PriceSample>, symbol: string, at: number, windowMs = 3600e3): PriceSample | null {
  const s = symbol.toUpperCase();
  let best: PriceSample | null = null;
  for (const r of samples) {
    if (r.symbol.toUpperCase() !== s || Math.abs(r.at - at) > windowMs) continue;
    if (best == null || Math.abs(r.at - at) < Math.abs(best.at - at)) best = r;
  }
  return best;
}

/**
 * PURE: what an amount of a token was worth at a moment, from the desk's own samples: a dollar token at face,
 * anything else at the sample nearest that moment within an hour. Null when the desk has nothing that close.
 */
export function valueUsdAt(t: PayToken, amount: number, at: number, samples: ReadonlyArray<PriceSample>): { usd: number; sampleAt: number | null } | null {
  if (!(amount > 0)) return null;
  if (t.group === "dollar") return { usd: amount, sampleAt: null };
  const s = sampleNear(samples, t.symbol, at);
  return s ? { usd: s.priceUsd * amount, sampleAt: s.at } : null;
}

/** PURE: the deposit row's note: the bonus when there is one, and that the price is today's when the desk had no sample near the block. */
export function depositNote(symbol: string, bonus: number, pricedAt: "block" | "now"): string | undefined {
  const parts = [bonus ? `+${bonus}% for paying in ${symbol}` : "", pricedAt === "now" ? "priced now: the desk had no price sample within an hour of the block" : ""].filter(Boolean);
  return parts.length ? parts.join("; ") : undefined;
}

export function readCredits(): CreditRow[] {
  return readLedger<CreditRow>(CREDITS_LEDGER).filter((r) => r && isAddress(r.address) && Number.isFinite(Number(r.usd)));
}

/** PURE: grants and deposits in, charges out, for one wallet. */
export function balanceUsd(address: string, rows: CreditRow[]): number {
  const a = address.toLowerCase();
  let v = 0;
  for (const r of rows) {
    if (r.address.toLowerCase() !== a) continue;
    v += r.kind === "charge" ? -r.usd : r.usd;
  }
  return Math.round(v * 1e6) / 1e6;
}

export interface CreditsSummary {
  balance: number;
  granted: number;
  deposited: number;
  spent: number;
  turns: number;
}

/** PURE: the wallet's credits at a glance. */
export function creditsSummary(address: string, rows: CreditRow[]): CreditsSummary {
  const a = address.toLowerCase();
  const mine = rows.filter((r) => r.address.toLowerCase() === a);
  const sum = (k: CreditRow["kind"]) => Math.round(mine.filter((r) => r.kind === k).reduce((s, r) => s + r.usd, 0) * 1e6) / 1e6;
  return { balance: balanceUsd(address, rows), granted: sum("grant"), deposited: sum("deposit"), spent: sum("charge"), turns: mine.filter((r) => r.kind === "charge").length };
}

/** A little on the house, once per wallet, on first sign-in. */
export function grantFree(address: string, rows: CreditRow[] = readCredits(), now = Date.now()): CreditRow | null {
  const a = address.toLowerCase();
  if (freeUsd() <= 0 || rows.some((r) => r.address.toLowerCase() === a && r.kind === "grant")) return null;
  const row: CreditRow = { at: now, address: a, kind: "grant", usd: freeUsd(), note: "on the house" };
  appendLedger(CREDITS_LEDGER, row as unknown as Record<string, unknown>);
  return row;
}

/** One turn's cost, taken from the wallet's credits. Nothing is written for a free turn. */
export function chargeTurn(address: string, usd: number, meta: { model: string; tokensIn: number; tokensOut: number }, now = Date.now()): CreditRow | null {
  if (!(usd > 0)) return null;
  const row: CreditRow = { at: now, address: address.toLowerCase(), kind: "charge", usd: Math.round(usd * 1e6) / 1e6, ...meta };
  appendLedger(CREDITS_LEDGER, row as unknown as Record<string, unknown>);
  return row;
}

export interface PayToken {
  symbol: string;
  kind: "native" | "erc20";
  contract: string | null;
  decimals: number;
  /** How it is priced: ETH by the pools, a dollar at face, the agent's token by its market, a stock by its pool or its print. */
  group: "eth" | "dollar" | "agent" | "stock";
}

/** What a person can pay with: ETH and USDG on Robinhood Chain, the agent's own token, and every tokenized stock the chain memory names. */
export function payTokens(): PayToken[] {
  const out: PayToken[] = [
    { symbol: "ETH", kind: "native", contract: null, decimals: 18, group: "eth" },
    { symbol: "USDG", kind: "erc20", contract: ASSETS["USDG@robinhood"].contract, decimals: 6, group: "dollar" },
    { symbol: AGENT_TOKEN_SYMBOL, kind: "erc20", contract: AGENT_TOKEN, decimals: 18, group: "agent" },
  ];
  const stocks = (chainMemory().tokens as { stocks?: Record<string, string> }).stocks ?? {};
  for (const [symbol, contract] of Object.entries(stocks)) if (isAddress(contract)) out.push({ symbol: symbol.toUpperCase(), kind: "erc20", contract: contract.toLowerCase(), decimals: 18, group: "stock" });
  return out;
}

/** PURE: "usdg", "RH ETH", "aobs", "nvda" to the token, or null. */
export function resolvePayToken(spec: string, tokens: PayToken[] = payTokens()): PayToken | null {
  const s = String(spec ?? "").trim().toUpperCase().replace(/^RH\s+/, "").replace(/@.*$/, "");
  if (!s) return null;
  return tokens.find((t) => t.symbol === s) ?? null;
}

const stockAsset = (t: PayToken): Asset => resolveAsset(`${t.symbol}@robinhood`) ?? { symbol: t.symbol, code: t.symbol.toLowerCase(), network: "robinhood", chain: "robinhood", kind: "erc20", contract: t.contract, decimals: t.decimals, deposit: false, withdrawal: false };

/** What an amount of a token is worth in dollars right now, or null when nothing can price it. */
export async function valueUsd(t: PayToken, amount: number): Promise<number | null> {
  if (!(amount > 0)) return null;
  if (t.group === "dollar") return amount;
  if (t.group === "agent") { const p = lastAgentTokenPrice(); return p != null && p > 0 ? p * amount : null; }
  const usdg = ASSETS["USDG@robinhood"];
  const from = t.group === "eth" ? ASSETS["ETH@robinhood"] : stockAsset(t);
  try {
    const q = await quoteOnChain(from, usdg, amount);
    if (q && q.amountOut > 0) return q.amountOut;
  } catch { /* no route or the pools did not answer: fall through */ }
  if (t.group === "eth") { const p = (await assetPrices(["ETH"])).ETH; return p != null && p > 0 ? p * amount : null; }
  try {
    const ref = await stockReference(t.symbol);
    const px = ref.printUsd ?? ref.perpUsd ?? null;
    return px != null && px > 0 ? px * amount : null;
  } catch { return null; }
}

export interface PaymentTx {
  to: string;
  data: string;
  /** Wei, as a decimal string. */
  value: string;
  chainId: number;
  note: string;
  token: string;
  amount: number;
  /** What the payment is worth, the bonus included, at prices right now: in dollars, and in credits. */
  creditsUsd: number;
  credits: number;
  bonusPct: number;
}

const toRaw = (amount: number, decimals: number): bigint => BigInt(Math.round(amount * 10 ** Math.min(decimals, 8))) * BigInt(10) ** BigInt(Math.max(0, decimals - 8));

/** The one transaction a wallet signs to add credits: a transfer to the treasury, priced before it is signed. */
export async function paymentTx(t: PayToken, amount: number): Promise<PaymentTx | { error: string }> {
  const to = treasury();
  if (!to) return { error: "Buying credits isn't switched on here yet." };
  if (!(amount > 0)) return { error: "The amount must be more than zero." };
  const usd = await valueUsd(t, amount);
  if (usd == null) return { error: `${t.symbol} can't be priced right now, so it can't be turned into credits yet.` };
  const bonus = bonusPct(t.symbol);
  const creditsUsd = Math.round(usd * (1 + bonus / 100) * 100) / 100;
  const raw = toRaw(amount, t.decimals);
  const chainId = ASSETS["ETH@robinhood"] ? 4663 : 4663;
  if (t.kind === "native") return { to, data: "0x", value: raw.toString(), chainId, note: `send ${amount} ETH to the credits treasury`, token: t.symbol, amount, creditsUsd, credits: toCredits(creditsUsd), bonusPct: bonus };
  return { to: t.contract as string, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to as `0x${string}`, raw] }), value: "0", chainId, note: `send ${amount} ${t.symbol} to the credits treasury`, token: t.symbol, amount, creditsUsd, credits: toCredits(creditsUsd), bonusPct: bonus };
}

/**
 * PURE: what a landed transaction paid the treasury: ETH carried in the call itself, or one accepted token moved
 * from the payer to the treasury in its logs. Anything else is not a payment.
 */
export function judgePayment(tx: { from: string; to: string | null; value: bigint }, logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>, payer: string, to: string, tokens: PayToken[]): { token: PayToken; amount: number } | { reason: string } {
  if (tx.from.toLowerCase() !== payer.toLowerCase()) return { reason: "that transaction was not sent by this wallet" };
  if ((tx.to ?? "").toLowerCase() === to.toLowerCase() && tx.value > 0n) {
    const eth = tokens.find((t) => t.kind === "native");
    if (eth) return { token: eth, amount: Number(tx.value) / 1e18 };
  }
  const fromTopic = "0x" + payer.toLowerCase().slice(2).padStart(64, "0");
  const toTopic = "0x" + to.toLowerCase().slice(2).padStart(64, "0");
  for (const t of tokens) {
    if (t.kind !== "erc20" || !t.contract) continue;
    let total = 0n;
    for (const l of logs) {
      if (l.address.toLowerCase() !== t.contract.toLowerCase()) continue;
      if ((l.topics[0] ?? "").toLowerCase() !== TRANSFER || (l.topics[1] ?? "").toLowerCase() !== fromTopic || (l.topics[2] ?? "").toLowerCase() !== toTopic) continue;
      total += BigInt(l.data);
    }
    if (total > 0n) return { token: t, amount: Number(total) / 10 ** t.decimals };
  }
  return { reason: "nothing in that transaction reached the credits treasury" };
}

/**
 * Read a payment off the chain and credit it once, to the wallet that sent it: landed, confirmed, within the window,
 * and priced at its block from the desk's own samples, or at today's price when no sample is near enough.
 */
export async function verifyPayment(hash: string, address: string, now = Date.now()): Promise<{ ok: true; row: CreditRow; already: boolean } | { ok: false; reason: string }> {
  const to = treasury();
  if (!to) return { ok: false, reason: "Buying credits isn't switched on here yet." };
  if (!isTxHash(hash) || !isAddress(address)) return { ok: false, reason: "a transaction hash and a wallet are required" };
  const prior = priorRecord(readCredits().filter((r) => r.kind === "deposit"), hash, address);
  if (prior) return "reason" in prior ? { ok: false, reason: prior.reason } : { ok: true, row: prior.row, already: true };
  const eth = ASSETS["ETH@robinhood"];
  const pub = createPublicClient({ chain: viemChain(eth), transport: transport(eth) });
  let receipt: Awaited<ReturnType<typeof pub.getTransactionReceipt>>;
  try { receipt = await pub.getTransactionReceipt({ hash: hash as Hex }); } catch { return { ok: false, reason: "that transaction is not on Robinhood Chain yet; give it a moment and try again" }; }
  if (receipt.status !== "success") return { ok: false, reason: "that transaction did not succeed" };
  const tx = await pub.getTransaction({ hash: hash as Hex });
  const j = judgePayment({ from: tx.from, to: tx.to ?? null, value: tx.value }, receipt.logs, address, to, payTokens());
  if ("reason" in j) return { ok: false, reason: j.reason };
  const [head, block] = await Promise.all([pub.getBlockNumber(), pub.getBlock({ blockNumber: receipt.blockNumber })]);
  const blockAt = Number(block.timestamp) * 1000;
  const depth = judgeBlock({ blockNumber: receipt.blockNumber, head, blockAt }, now, { confirmations: confirmationsNeeded(), maxAgeH: maxAgeH() });
  if ("reason" in depth) return { ok: false, reason: depth.reason };
  const sampled = valueUsdAt(j.token, j.amount, blockAt, readPrices());
  const usd = sampled ? sampled.usd : await valueUsd(j.token, j.amount);
  if (usd == null) return { ok: false, reason: `${j.token.symbol} arrived but can't be priced right now; it will be credited when it can.` };
  const pricedAt: CreditRow["pricedAt"] = sampled ? "block" : "now";
  const bonus = bonusPct(j.token.symbol);
  const row: CreditRow = { at: now, address: address.toLowerCase(), kind: "deposit", usd: Math.round(usd * (1 + bonus / 100) * 100) / 100, token: j.token.symbol, amount: j.amount, txHash: hash.toLowerCase(), blockAt, pricedAt, note: depositNote(j.token.symbol, bonus, pricedAt) };
  appendLedger(CREDITS_LEDGER, row as unknown as Record<string, unknown>);
  if (treasuryIsDesk()) recordCapital(capitalRowFor(address, j.token.symbol, j.amount, usd, hash, now));
  return { ok: true, row, already: false };
}
