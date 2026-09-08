// The rails: every check that stands between a swap decision and a signed
// transaction. Pure where it can be, so each one is tested offline. The
// model decides WHAT; this file decides WHETHER, and it says no far more
// often than yes.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WALLET_ADDRESS, NEVER_TRADE } from "../config.ts";
import { resolveAsset, assetKey, type Asset } from "./assets.ts";
import type { Trade, TradeStatus } from "./book.ts";

/** How far over a cap a priced swap may land before it is refused: the width of a price tick between the model's read and this one. */
const CAP_SLACK = 0.01;

export interface Rails {
  tradingOn: boolean;
  maxSwapUsd: number;
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
  /** Contracts the desk never trades, whatever the feed says: its own token first. */
  neverTrade: ReadonlySet<string>;
  /** The first buy of any launch token is capped here until a sell is proven to work. */
  probeUsd: number;
  /** The first buy of a token still inside its launch window (OBS_PROBE_LAUNCH_USD): a fresh launch moves 50% between blocks, so it gets the small ticket while a token with a record gets the full one. Defaults to probeUsd. */
  launchProbeUsd: number;
  /** Launch positions held at once. */
  maxCandidates: number;
  candidateMaxHoldH: number;
  candidateFloorPct: number;
  /** After a scale-out banked profit, the rest leaves this far under its cost; zero disables. */
  candidateRemainderFloorPct: number;
  candidateVolumeDropPct: number;
  /** The trader's exits on a launch token: take part off at a gain, trail the rest off its peak once armed. */
  candidateTakeProfitPct: number;
  candidateTakeProfitShare: number;
  candidateTrailArmPct: number;
  candidateTrailPct: number;
  /** The tape exit: once up this much, sell this share when buy pressure falls under the bar or 5-minute volume rolls over. */
  candidateTapeExitMinPct: number;
  candidateTapeExitPressurePct: number;
  candidateTapeExitShare: number;
  /** Whether three falling five-minute buckets sell an unpaid trade (OBS_CANDIDATE_TAPE_ROLLOVER_EXIT). Off for a hunt for a multiple in a thin pool. */
  tapeRolloverExit: boolean;
  /** The whole-book brake: once the day's drawdown from its opening mark passes either limit, no new entries until the next UTC day. Exits still run. */
  dailyLossUsd: number;
  dailyLossPct: number;
  /** Selectivity: entries are spaced. Exits are not. Nothing is counted by the day: the desk enters whenever the reads say so, under the loss brake. */
  minHoursBetweenEntries: number;
  /** A swap must be argued for: this many evidence lines quoting observed figures, and this conviction. */
  minEvidence: number;
  minConviction: number;
  /** ETH is the base: parking the book in USDG is refused and a launch-token exit comes back to ETH, unless the basis trade needs the dollar leg. */
  ethBase: boolean;
  basisOn: boolean;
}

// The mandate: this desk trades tokens on Robinhood Chain. ETH is the base
// and USDG the dollar leg; launch tokens join the allowlist by their grade.
// The tokenized stock in the registry is read and marked if held and only
// traded when the operator turns the basis on (OBS_BASIS=on adds it). The
// Ethereum entries are read and marked, never traded: the chain rail
// refuses them.
export const DEFAULT_TRADE_ASSETS = "ETH@robinhood,USDG@robinhood";
export const DEFAULT_TRADE_CHAINS = "robinhood";

export function railsFromEnv(env: NodeJS.ProcessEnv = process.env): Rails {
  const partners = (env.OBS_ALLOWED_PARTNERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    tradingOn: env.OBS_TRADING === "on",
    maxSwapUsd: Number(env.OBS_MAX_SWAP_USD ?? 25),
    maxOpenOrders: Number(env.OBS_MAX_OPEN_ORDERS ?? 1),
    gasReserveEth: Number(env.OBS_GAS_RESERVE_ETH ?? 0.002),
    allowedPartners: partners.length ? new Set(partners) : null,
    allowedAssets: new Set(((env.OBS_TRADE_ASSETS ?? DEFAULT_TRADE_ASSETS) + ((env.OBS_BASIS ?? "off") === "on" ? ",NVDA@robinhood" : "")).split(",").map((s) => s.trim()).filter(Boolean)),
    allowedChains: new Set((env.OBS_TRADE_CHAINS ?? DEFAULT_TRADE_CHAINS).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
    minFillRatio: Number(env.OBS_MIN_FILL_RATIO ?? 0.97),
    candidatesOn: (env.OBS_CANDIDATES ?? "on") !== "off",
    neverTrade: NEVER_TRADE,
    probeUsd: Number(env.OBS_PROBE_USD ?? 5),
    launchProbeUsd: Number(env.OBS_PROBE_LAUNCH_USD ?? env.OBS_PROBE_USD ?? 5),
    maxCandidates: Number(env.OBS_MAX_CANDIDATES ?? 1),
    candidateMaxHoldH: Number(env.OBS_CANDIDATE_MAX_HOLD_H ?? 8),
    candidateFloorPct: Number(env.OBS_CANDIDATE_FLOOR_PCT ?? 40),
    candidateRemainderFloorPct: Number(env.OBS_CANDIDATE_REMAINDER_FLOOR_PCT ?? 5),
    candidateVolumeDropPct: Number(env.OBS_CANDIDATE_VOLUME_DROP_PCT ?? 30),
    candidateTakeProfitPct: Number(env.OBS_CANDIDATE_TAKE_PROFIT_PCT ?? 60),
    candidateTakeProfitShare: Number(env.OBS_CANDIDATE_TAKE_PROFIT_SHARE ?? 0.5),
    candidateTrailArmPct: Number(env.OBS_CANDIDATE_TRAIL_ARM_PCT ?? 30),
    candidateTrailPct: Number(env.OBS_CANDIDATE_TRAIL_PCT ?? 25),
    candidateTapeExitMinPct: Number(env.OBS_CANDIDATE_TAPE_EXIT_MIN_PCT ?? 15),
    candidateTapeExitPressurePct: Number(env.OBS_CANDIDATE_TAPE_EXIT_PRESSURE_PCT ?? 45),
    candidateTapeExitShare: Number(env.OBS_CANDIDATE_TAPE_EXIT_SHARE ?? 0.6),
    tapeRolloverExit: (env.OBS_CANDIDATE_TAPE_ROLLOVER_EXIT ?? "on") !== "off",
    dailyLossUsd: Number(env.OBS_DAILY_LOSS_USD ?? 50),
    dailyLossPct: Number(env.OBS_DAILY_LOSS_PCT ?? 5),
    minHoursBetweenEntries: Number(env.OBS_MIN_HOURS_BETWEEN_ENTRIES ?? 2),
    minEvidence: Number(env.OBS_MIN_EVIDENCE ?? 3),
    minConviction: Number(env.OBS_MIN_CONVICTION ?? 4),
    ethBase: (env.OBS_BASE ?? "eth").toLowerCase() === "eth",
    basisOn: (env.OBS_BASIS ?? "off") === "on",
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
  /** When the last entry (a non-exit swap) was sent, for the spacing rule. */
  lastEntryAt?: number | null;
  now?: number;
}

/** PURE: the whole decision, in order, first failure wins. */
/** PURE: with ETH as the base, a sell of a launch token comes back to ETH whatever leg was named. The leg to use, and a note when it changed. */
export function baseLeg(from: Asset, to: Asset, r: Rails): { to: Asset; note: string | null } {
  if (r.ethBase && !r.basisOn && from.candidate && !to.candidate && to.symbol === "USDG") {
    const eth = resolveAsset("ETH@robinhood");
    if (eth) return { to: eth, note: "sold back to ETH, the book's base, rather than USDG" };
  }
  return { to, note: null };
}

export function checkRails(i: Intent, c: RailContext): { ok: true } | { ok: false; reason: string } {
  const r = c.rails;
  if (!r.tradingOn) return { ok: false, reason: "trading is off (OBS_TRADING)" };
  if (!(i.amount > 0)) return { ok: false, reason: "amount must be positive" };
  if (assetKey(i.from) === assetKey(i.to)) return { ok: false, reason: "from and to are the same asset" };
  // Neither leg, entry or exit: the desk's own token sits in its wallet and is never sold, bought, or approved.
  for (const leg of [i.from, i.to]) if (leg.contract && r.neverTrade.has(leg.contract.toLowerCase())) return { ok: false, reason: `${leg.symbol} is on the never-trade list (the desk's own token, or ${"$"}OBS); neither leg of a swap may be it` };
  if (r.ethBase && !r.basisOn && !i.exit && i.to.symbol === "USDG") return { ok: false, reason: "the book's base is ETH; USDG is a hop on the way to a pool, not a place to park (OBS_BASE)" };
  for (const leg of [i.from, i.to]) if (!r.allowedChains.has(leg.chain)) return { ok: false, reason: `${assetKey(leg)} is on ${leg.chain}; this desk trades on Robinhood Chain only` };
  if (!i.exit) {
    const halt = dailyLossHalt(c.dayStartEquityUsd ?? null, c.equityUsd ?? null, r);
    if (halt) return { ok: false, reason: halt };
    const now = c.now ?? Date.now();
    if (!i.addOn && c.lastEntryAt != null && now - c.lastEntryAt < r.minHoursBetweenEntries * 3600e3) return { ok: false, reason: `the last entry was ${((now - c.lastEntryAt) / 3600e3).toFixed(1)}h ago; entries are at least ${r.minHoursBetweenEntries}h apart` };
  }
  const allowed = (a: Asset) => r.allowedAssets.has(assetKey(a)) || (r.candidatesOn && !!a.candidate);
  if (!allowed(i.from)) return { ok: false, reason: `${assetKey(i.from)} is not on the trade allowlist` };
  if (!allowed(i.to)) return { ok: false, reason: `${assetKey(i.to)} is not on the trade allowlist` };
  if (!i.from.candidate && !i.from.deposit) return { ok: false, reason: `Obscura does not accept ${assetKey(i.from)} as a deposit` };
  if (!i.to.candidate && !i.to.withdrawal) return { ok: false, reason: `Obscura does not pay out ${assetKey(i.to)}` };
  if (i.usd == null) return { ok: false, reason: `${i.from.symbol} is unpriced; refusing to size a swap blind` };
  if (!i.exit) {
    const cap = i.capUsd ?? r.maxSwapUsd;
    // The model sizes an entry off the price in its observation and this check reads a fresh one, so a cent over the
    // cap is the price having moved, not the model oversizing: one percent of slack, and the cap still means the cap.
    if (i.usd > cap * (1 + CAP_SLACK)) return { ok: false, reason: `$${i.usd.toFixed(2)} exceeds the ${i.capUsd != null ? "grade" : "per-swap"} cap of $${cap}` };
    if (c.openOrders >= r.maxOpenOrders) return { ok: false, reason: `${c.openOrders} order(s) already open; the limit is ${r.maxOpenOrders}` };
  }
  const have = c.balances[assetKey(i.from)] ?? 0;
  if (have + 1e-12 < i.amount) return { ok: false, reason: `the wallet holds ${have} ${assetKey(i.from)}, less than ${i.amount}` };
  if (i.from.kind === "native") {
    // An entry keeps the reserve twice: its own gas and the exit's, since a wallet left under the reserve by the
    // entry's gas is refused every token exit at the check below (2026-09-08).
    if (have - i.amount < r.gasReserveEth * 2) return { ok: false, reason: `sending ${i.amount} ${i.from.symbol} would leave less than ${r.gasReserveEth * 2} ETH, the gas reserve for the round trip` };
  } else if (c.nativeOnFromChain == null || c.nativeOnFromChain < r.gasReserveEth) {
    return { ok: false, reason: `less than the ${r.gasReserveEth} ETH gas reserve on ${i.from.chain}` };
  }
  return { ok: true };
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
export function checkCandidate(i: Intent, known: CandidateKnowledge | null, heldCandidates: string[], r: Rails, graded?: { grade: "A" | "B" | "C" | null; capUsd: number; why: string } | null, heldUsd = 0, lane: "launch" | "record" = "record"): { ok: true; maxUsd?: number; addOn?: boolean } | { ok: false; reason: string } {
  if (!i.to.candidate) return { ok: true };
  if (!r.candidatesOn) return { ok: false, reason: "launch candidates are switched off" };
  if (i.to.contract && r.neverTrade.has(i.to.contract.toLowerCase())) return { ok: false, reason: `${i.to.symbol} is the desk's own token; it is never traded` };
  if (known?.blacklisted) return { ok: false, reason: `${i.to.symbol} could not be sold when probed; it is blacklisted` };
  if (graded && !graded.grade) return { ok: false, reason: `${i.to.symbol} is ${graded.why}` };
  const others = heldCandidates.filter((s) => s !== i.to.symbol);
  if (others.length >= r.maxCandidates) return { ok: false, reason: `already holding ${others.join(", ")}; ${r.maxCandidates === 1 ? "one" : r.maxCandidates} launch position${r.maxCandidates === 1 ? "" : "s"} at a time` };
  const probe = lane === "launch" ? r.launchProbeUsd : r.probeUsd;
  if (known?.proven !== true) return { ok: true, maxUsd: probe };
  const cap = graded ? Math.min(graded.capUsd, lane === "launch" ? r.launchProbeUsd : Infinity) : probe;
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

/** PURE: when the last entry (a sent swap that was not an exit) went out, for the spacing rule; null when none has. From the latest row per id. */
export function lastEntryAt(trades: Trade[]): number | null {
  const seen = new Set<string>();
  let last: number | null = null;
  for (const t of [...trades].sort((a, b) => (b.updatedAt ?? b.at) - (a.updatedAt ?? a.at))) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (t.exit || (t.status !== "pending" && t.status !== "settled")) continue;
    if (last == null || t.at > last) last = t.at;
  }
  return last;
}

