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
  /** Chain keys both legs of a swap must sit on. The mandate: Robinhood Chain only. */
  allowedChains: Set<string>;
  /** Refuse a route whose output is below this fraction of the best quote seen. */
  minFillRatio: number;
  /** Launch candidates from the watcher's feed may be traded in the pool lane. */
  candidatesOn: boolean;
  /** The first buy of any launch token is capped here until a sell is proven to work. */
  probeUsd: number;
  /** Launch positions held at once. */
  maxCandidates: number;
  candidateMaxHoldH: number;
  candidateFloorPct: number;
  candidateVolumeDropPct: number;
  /** The trader's exits on a launch token: take part off at a gain, trail the rest off its peak once armed. */
  candidateTakeProfitPct: number;
  candidateTakeProfitShare: number;
  candidateTrailArmPct: number;
  candidateTrailPct: number;
  /** The whole-book brake: once the day's drawdown from its opening mark passes either limit, no new entries until the next UTC day. Exits still run. */
  dailyLossUsd: number;
  dailyLossPct: number;
  /** Selectivity: entries are spaced and counted. Exits are neither. */
  minHoursBetweenEntries: number;
  maxEntriesPerDay: number;
  /** A swap must be argued for: this many evidence lines quoting observed figures, and this conviction. */
  minEvidence: number;
  minConviction: number;
}

// The mandate: this desk trades on Robinhood Chain only, in the majors,
// the dollar stables and the tokenized stocks. ETH, USDG and NVDA: the pool
// lane routes all three (USDG is the dollar leg of the basis trade; Obscura
// itself quotes no USDG leg, which only matters for the Obscura lane). The
// Ethereum entries in the registry are read and marked, never traded: the
// chain rail refuses them.
export const DEFAULT_TRADE_ASSETS = "ETH@robinhood,USDG@robinhood,NVDA@robinhood";
export const DEFAULT_TRADE_CHAINS = "robinhood";

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
    allowedChains: new Set((env.OBS_TRADE_CHAINS ?? DEFAULT_TRADE_CHAINS).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
    minFillRatio: Number(env.OBS_MIN_FILL_RATIO ?? 0.97),
    candidatesOn: (env.OBS_CANDIDATES ?? "on") !== "off",
    probeUsd: Number(env.OBS_PROBE_USD ?? 5),
    maxCandidates: Number(env.OBS_MAX_CANDIDATES ?? 1),
    candidateMaxHoldH: Number(env.OBS_CANDIDATE_MAX_HOLD_H ?? 8),
    candidateFloorPct: Number(env.OBS_CANDIDATE_FLOOR_PCT ?? 40),
    candidateVolumeDropPct: Number(env.OBS_CANDIDATE_VOLUME_DROP_PCT ?? 30),
    candidateTakeProfitPct: Number(env.OBS_CANDIDATE_TAKE_PROFIT_PCT ?? 60),
    candidateTakeProfitShare: Number(env.OBS_CANDIDATE_TAKE_PROFIT_SHARE ?? 0.5),
    candidateTrailArmPct: Number(env.OBS_CANDIDATE_TRAIL_ARM_PCT ?? 30),
    candidateTrailPct: Number(env.OBS_CANDIDATE_TRAIL_PCT ?? 25),
    dailyLossUsd: Number(env.OBS_DAILY_LOSS_USD ?? 50),
    dailyLossPct: Number(env.OBS_DAILY_LOSS_PCT ?? 5),
    minHoursBetweenEntries: Number(env.OBS_MIN_HOURS_BETWEEN_ENTRIES ?? 2),
    maxEntriesPerDay: Number(env.OBS_MAX_ENTRIES_PER_DAY ?? 3),
    minEvidence: Number(env.OBS_MIN_EVIDENCE ?? 3),
    minConviction: Number(env.OBS_MIN_CONVICTION ?? 4),
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
  /** An exit from a held position: the caps and the open-order limit do not apply, because an exit is never blocked. */
  exit?: boolean;
  /** A per-position ceiling that replaces the per-swap cap for this intent, set from a launch token's grade. */
  capUsd?: number;
  /** Adding to a held, proven token: a continuation, not a new entry, so the spacing rule does not apply. */
  addOn?: boolean;
}

export interface RailContext {
  rails: Rails;
  /** Wallet balances by SYMBOL@network, whole units. */
  balances: Record<string, number>;
  /** Native balance on the from-chain, for the gas reserve. */
  nativeOnFromChain: number | null;
  openOrders: number;
  /** The book's equity at the start of the UTC day and now, for the whole-book brake. Null when unknown: the brake stays off rather than guessing. */
  dayStartEquityUsd?: number | null;
  equityUsd?: number | null;
  /** When the last entry (a non-exit swap) was sent, and how many were sent in the last 24h. */
  lastEntryAt?: number | null;
  entriesToday?: number;
  now?: number;
  /** Dollar value of swaps already sent in the trailing 24h. */
  sentTodayUsd: number;
}

/** PURE: the whole decision, in order, first failure wins. */
export function checkRails(i: Intent, c: RailContext): { ok: true } | { ok: false; reason: string } {
  const r = c.rails;
  if (!r.tradingOn) return { ok: false, reason: "trading is off (OBS_TRADING)" };
  if (!(i.amount > 0)) return { ok: false, reason: "amount must be positive" };
  if (assetKey(i.from) === assetKey(i.to)) return { ok: false, reason: "from and to are the same asset" };
  for (const leg of [i.from, i.to]) if (!r.allowedChains.has(leg.chain)) return { ok: false, reason: `${assetKey(leg)} is on ${leg.chain}; this desk trades on Robinhood Chain only` };
  if (!i.exit) {
    const halt = dailyLossHalt(c.dayStartEquityUsd ?? null, c.equityUsd ?? null, r);
    if (halt) return { ok: false, reason: halt };
    const now = c.now ?? Date.now();
    if (!i.addOn && c.lastEntryAt != null && now - c.lastEntryAt < r.minHoursBetweenEntries * 3600e3) return { ok: false, reason: `the last entry was ${((now - c.lastEntryAt) / 3600e3).toFixed(1)}h ago; entries are at least ${r.minHoursBetweenEntries}h apart` };
    if ((c.entriesToday ?? 0) >= r.maxEntriesPerDay) return { ok: false, reason: `${c.entriesToday} entries in the last 24h; the limit is ${r.maxEntriesPerDay}` };
  }
  const allowed = (a: Asset) => r.allowedAssets.has(assetKey(a)) || (r.candidatesOn && !!a.candidate);
  if (!allowed(i.from)) return { ok: false, reason: `${assetKey(i.from)} is not on the trade allowlist` };
  if (!allowed(i.to)) return { ok: false, reason: `${assetKey(i.to)} is not on the trade allowlist` };
  if (!i.from.candidate && !i.from.deposit) return { ok: false, reason: `Obscura does not accept ${assetKey(i.from)} as a deposit` };
  if (!i.to.candidate && !i.to.withdrawal) return { ok: false, reason: `Obscura does not pay out ${assetKey(i.to)}` };
  if (i.usd == null) return { ok: false, reason: `${i.from.symbol} is unpriced; refusing to size a swap blind` };
  if (!i.exit) {
    const cap = i.capUsd ?? r.maxSwapUsd;
    if (i.usd > cap) return { ok: false, reason: `$${i.usd.toFixed(2)} exceeds the ${i.capUsd != null ? "grade" : "per-swap"} cap of $${cap}` };
    if (c.sentTodayUsd + i.usd > r.dailySwapUsd) return { ok: false, reason: `$${(c.sentTodayUsd + i.usd).toFixed(2)} would exceed the daily cap of $${r.dailySwapUsd}` };
    if (c.openOrders >= r.maxOpenOrders) return { ok: false, reason: `${c.openOrders} order(s) already open; the limit is ${r.maxOpenOrders}` };
  }
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

export interface CandidateKnowledge {
  proven: boolean | null;
  blacklisted: boolean;
}
/**
 * PURE: the launch-token rules on top of the rails. A buy of a launch token
 * is refused when the token could not be sold before, when another launch
 * position is already held, or when candidates are off; until a sell has been
 * proven the buy is capped at the probe size. Sells (exits) always pass.
 */
export function checkCandidate(i: Intent, known: CandidateKnowledge | null, heldCandidates: string[], r: Rails, graded?: { grade: "A" | "B" | "C" | null; capUsd: number; why: string } | null, heldUsd = 0): { ok: true; maxUsd?: number; addOn?: boolean } | { ok: false; reason: string } {
  if (!i.to.candidate) return { ok: true };
  if (!r.candidatesOn) return { ok: false, reason: "launch candidates are switched off" };
  if (known?.blacklisted) return { ok: false, reason: `${i.to.symbol} could not be sold when probed; it is blacklisted` };
  if (graded && !graded.grade) return { ok: false, reason: `${i.to.symbol} is ${graded.why}` };
  const others = heldCandidates.filter((s) => s !== i.to.symbol);
  if (others.length >= r.maxCandidates) return { ok: false, reason: `already holding ${others.join(", ")}; ${r.maxCandidates === 1 ? "one" : r.maxCandidates} launch position${r.maxCandidates === 1 ? "" : "s"} at a time` };
  if (known?.proven !== true) return { ok: true, maxUsd: r.probeUsd };
  const cap = graded ? graded.capUsd : r.probeUsd;
  const room = Math.max(0, cap - heldUsd);
  if (room <= 0) return { ok: false, reason: `${i.to.symbol} is at its grade ${graded?.grade ?? "C"} ceiling of $${cap}` };
  return { ok: true, maxUsd: room, addOn: heldUsd > 0 };
}

/**
 * PURE: an amount the model named against the balance the wallet holds. The
 * observation prints balances rounded, so "sell all of it" comes back a hair
 * above the true balance; anything within a hundredth of a percent over is
 * the whole balance, anything further over is still a refusal downstream.
 */
export function clampToBalance(amount: number, have: number): number {
  return amount > have && amount <= have * (1 + 1e-4) ? have : amount;
}

/**
 * PURE: the whole-book brake. The per-position rails bound each loss; this
 * bounds how many can stack in a day. Measured against the book's first mark
 * of the UTC day, it halts entries (never exits) once the drawdown passes the
 * dollar or the percent limit, and says so in public.
 */
export function dailyLossHalt(dayStartEquityUsd: number | null, equityUsd: number | null, r: Rails): string | null {
  if (dayStartEquityUsd == null || equityUsd == null || !(dayStartEquityUsd > 0)) return null;
  const down = dayStartEquityUsd - equityUsd;
  const pct = (down / dayStartEquityUsd) * 100;
  if (down >= r.dailyLossUsd) return `daily loss brake: down $${down.toFixed(2)} since 00:00 UTC, the limit is $${r.dailyLossUsd}; no new entries until tomorrow`;
  if (pct >= r.dailyLossPct) return `daily loss brake: down ${pct.toFixed(1)}% since 00:00 UTC, the limit is ${r.dailyLossPct}%; no new entries until tomorrow`;
  return null;
}

/** PURE: the book's first mark of the UTC day that `now` falls in, from stored snapshots; null when the day has no mark yet. */
export function dayStartEquity(snapshots: Array<{ at: number; equityUsd: number | null }>, now: number): number | null {
  const start = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const today = snapshots.filter((s) => s.at >= start && s.at <= now && s.equityUsd != null).sort((a, b) => a.at - b.at);
  return today.length ? (today[0].equityUsd as number) : null;
}

/** PURE: entries (swaps that were not exits) in the last 24h, and when the last one went out. From the latest row per id. */
export function entryStats(trades: Trade[], now: number): { entriesToday: number; lastEntryAt: number | null } {
  const seen = new Set<string>();
  let entriesToday = 0;
  let lastEntryAt: number | null = null;
  for (const t of [...trades].sort((a, b) => (b.updatedAt ?? b.at) - (a.updatedAt ?? a.at))) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (t.exit || (t.status !== "pending" && t.status !== "settled")) continue;
    if (t.at >= now - 24 * 3600e3) entriesToday++;
    if (lastEntryAt == null || t.at > lastEntryAt) lastEntryAt = t.at;
  }
  return { entriesToday, lastEntryAt };
}

