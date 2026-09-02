// The rails: every check that stands between a swap decision and a signed
// transaction. Pure where it can be, so each one is tested offline. The
// model decides WHAT; this file decides WHETHER, and it says no far more
// often than yes.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WALLET_ADDRESS } from "../config.ts";
import { resolveAsset, assetKey, type Asset } from "./assets.ts";
import type { Trade, TradeStatus } from "./book.ts";

export interface Rails {
  tradingOn: boolean;
  maxSwapUsd: number;
  dailySwapUsd: number;
  maxOpenOrders: number;
  gasReserveEth: number;
  /** Lower-cased partner names, or null for any partner Obscura quotes. */
  allowedPartners: Set<string> | null;
  /** SYMBOL@network keys the desk may trade. */
  allowedAssets: Set<string>;
  /** Refuse a route whose output is below this fraction of the best quote seen. */
  minFillRatio: number;
}

// The mandate: high-volume majors, dollar stables, and the tokenized stocks
// Obscura routes. Ethereum legs pay mainnet gas, which the rails price in
// through the gas reserve; the operator narrows this with OBS_TRADE_ASSETS.
// USDG@robinhood stays in the registry but off this list: probed 2026-09-02,
// Obscura quoted no USDG leg in any direction. Put it back when it does.
export const DEFAULT_TRADE_ASSETS = "ETH@eth,WBTC@erc20,USDC@erc20,USDT@erc20,DAI@erc20,LINK@erc20,UNI@erc20,AAVE@erc20,ETH@robinhood,NVDA@robinhood";

export function railsFromEnv(env: NodeJS.ProcessEnv = process.env): Rails {
  const partners = (env.OBS_ALLOWED_PARTNERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    tradingOn: env.OBS_TRADING === "on",
    maxSwapUsd: Number(env.OBS_MAX_SWAP_USD ?? 25),
    dailySwapUsd: Number(env.OBS_DAILY_SWAP_USD ?? 100),
    maxOpenOrders: Number(env.OBS_MAX_OPEN_ORDERS ?? 1),
    gasReserveEth: Number(env.OBS_GAS_RESERVE_ETH ?? 0.002),
    allowedPartners: partners.length ? new Set(partners) : null,
    allowedAssets: new Set((env.OBS_TRADE_ASSETS ?? DEFAULT_TRADE_ASSETS).split(",").map((s) => s.trim()).filter(Boolean)),
    minFillRatio: Number(env.OBS_MIN_FILL_RATIO ?? 0.97),
  };
}

export const walletFile = (env: NodeJS.ProcessEnv = process.env) => join(env.OBS_WALLET_DIR || join(homedir(), ".obs", "wallet"), "obs-wallet.json");

/** Trading is armed only when the operator said so AND the key and address both exist. */
export function tradingArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OBS_TRADING === "on" && Boolean(WALLET_ADDRESS) && existsSync(walletFile(env));
}

export interface Intent {
  from: Asset;
  to: Asset;
  amount: number;
  /** Dollar value of the from-leg at decision time; null means unpriced, which the rails refuse. */
  usd: number | null;
}

export interface RailContext {
  rails: Rails;
  /** Wallet balances by SYMBOL@network, whole units. */
  balances: Record<string, number>;
  /** Native balance on the from-chain, for the gas reserve. */
  nativeOnFromChain: number | null;
  openOrders: number;
  /** Dollar value of swaps already sent in the trailing 24h. */
  sentTodayUsd: number;
}

/** PURE: the whole decision, in order, first failure wins. */
export function checkRails(i: Intent, c: RailContext): { ok: true } | { ok: false; reason: string } {
  const r = c.rails;
  if (!r.tradingOn) return { ok: false, reason: "trading is off (OBS_TRADING)" };
  if (!(i.amount > 0)) return { ok: false, reason: "amount must be positive" };
  if (assetKey(i.from) === assetKey(i.to)) return { ok: false, reason: "from and to are the same asset" };
  if (!r.allowedAssets.has(assetKey(i.from))) return { ok: false, reason: `${assetKey(i.from)} is not on the trade allowlist` };
  if (!r.allowedAssets.has(assetKey(i.to))) return { ok: false, reason: `${assetKey(i.to)} is not on the trade allowlist` };
  if (!i.from.deposit) return { ok: false, reason: `Obscura does not accept ${assetKey(i.from)} as a deposit` };
  if (!i.to.withdrawal) return { ok: false, reason: `Obscura does not pay out ${assetKey(i.to)}` };
  if (i.usd == null) return { ok: false, reason: `${i.from.symbol} is unpriced; refusing to size a swap blind` };
  if (i.usd > r.maxSwapUsd) return { ok: false, reason: `$${i.usd.toFixed(2)} exceeds the per-swap cap of $${r.maxSwapUsd}` };
  if (c.sentTodayUsd + i.usd > r.dailySwapUsd) return { ok: false, reason: `$${(c.sentTodayUsd + i.usd).toFixed(2)} would exceed the daily cap of $${r.dailySwapUsd}` };
  if (c.openOrders >= r.maxOpenOrders) return { ok: false, reason: `${c.openOrders} order(s) already open; the limit is ${r.maxOpenOrders}` };
  const have = c.balances[assetKey(i.from)] ?? 0;
  if (have + 1e-12 < i.amount) return { ok: false, reason: `the wallet holds ${have} ${assetKey(i.from)}, less than ${i.amount}` };
  if (i.from.kind === "native") {
    if (have - i.amount < r.gasReserveEth) return { ok: false, reason: `sending ${i.amount} ${i.from.symbol} would leave less than the ${r.gasReserveEth} gas reserve` };
  } else if (c.nativeOnFromChain == null || c.nativeOnFromChain < r.gasReserveEth) {
    return { ok: false, reason: `less than the ${r.gasReserveEth} ETH gas reserve on ${i.from.chain}` };
  }
  return { ok: true };
}

/** PURE: dollars sent in the trailing 24h, from the trade ledger (pending or settled, not proposals). */
export function sentTodayUsd(trades: Trade[], now: number): number {
  const seen = new Set<string>();
  let usd = 0;
  for (const t of [...trades].sort((a, b) => (b.updatedAt ?? b.at) - (a.updatedAt ?? a.at))) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if ((t.status === "pending" || t.status === "settled") && t.at >= now - 24 * 3600e3) usd += t.from.usd ?? 0;
  }
  return usd;
}

/** PURE: Obscura's order status words -> the ledger's three states. */
export function mapStatus(s: string): TradeStatus {
  const v = (s ?? "").toLowerCase().trim();
  if (["finished", "completed", "complete", "done", "success"].includes(v)) return "settled";
  if (["failed", "refunded", "expired", "cancelled", "canceled", "error", "not found"].includes(v)) return "failed";
  return "pending";
}

/** PURE: a partner Obscura quoted is acceptable if the allowlist is empty or names it. */
export function partnerAllowed(partner: string, rails: Rails): boolean {
  return !rails.allowedPartners || rails.allowedPartners.has(partner.toLowerCase());
}

/** PURE: the deposit address Obscura hands back must look like an address on the from-chain. */
export function depositAddressLooksRight(address: string | null, from: Asset): boolean {
  if (!address) return false;
  return /^0x[0-9a-fA-F]{40}$/.test(address); // every chain in the registry is EVM
}

export { resolveAsset };
