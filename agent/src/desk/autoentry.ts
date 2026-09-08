// The reads decide the entry. When a candidate has passed the entry read,
// the holder read and the launch read in the same cycle and the model
// still holds, the desk enters at the rails' size and the model's writing
// is the public reasoning, not a veto. OBS_AUTO_ENTRY=on switches it on.
// Pure: given the cycle's reads, the pick and the argument the rails will
// check, built from the observation's own lines so every figure is real.
// Passed means completed and passed: a read the cycle does not have is not
// a pass (readgate.ts says which reads count as complete, 2026-09-08).

export interface AutoEntryReads {
  symbol: string;
  grade: string | null;
  entryOk: boolean;
  entryWhy: string;
  /** The holder read completed this cycle (holderReadComplete in readgate.ts). */
  holdersRead: boolean;
  holdersOk: boolean;
  /** The launch read completed this cycle (launchReadComplete in readgate.ts). */
  launchRead: boolean;
  /** Null when the completed launch read had nothing to read (not a launchpad token). */
  launchOk: boolean | null;
  held: boolean;
}

export interface AutoEntry {
  symbol: string;
  amountEth: number;
  reason: string;
  analysis: { thesis: string; evidence: string[]; invalidation: string; conviction: number };
  line: string;
}

/** What a fast tick knows before it spends a think: what is held, when the last entry went, what is open. */
export interface VetoInput {
  symbol: string;
  held: string[];
  maxCandidates: number;
  lastEntryAt: number | null;
  minHoursBetweenEntries: number;
  openOrders: number;
  maxOpenOrders: number;
  now: number;
}

/**
 * PURE: why the rails would refuse a new entry in this token right now, or null. A fast tick that has an entry on
 * the tape asks this before it thinks: a think the rails would veto anyway is a model call for nothing. Adding to
 * a token already held is a continuation the rails may allow, so it is never vetoed here.
 */
export function entryVeto(i: VetoInput): string | null {
  if (i.held.includes(i.symbol)) return null;
  if (i.held.length >= i.maxCandidates) return `already holding ${i.held.join(", ")}; ${i.maxCandidates} launch position${i.maxCandidates === 1 ? "" : "s"} at a time`;
  if (i.lastEntryAt != null && i.now - i.lastEntryAt < i.minHoursBetweenEntries * 3600e3) return `the last entry was ${((i.now - i.lastEntryAt) / 60e3).toFixed(0)} min ago; entries are at least ${i.minHoursBetweenEntries}h apart`;
  if (i.openOrders >= i.maxOpenOrders) return `${i.openOrders} order(s) already open; the limit is ${i.maxOpenOrders}`;
  return null;
}

/** PURE: the first graded, unheld candidate that passed every read, in board order; null when none did. A read that did not complete is not passed. */
export function autoEntryPick(reads: AutoEntryReads[]): AutoEntryReads | null {
  return reads.find((r) => r.grade && !r.held && r.entryOk && r.holdersRead && r.holdersOk && r.launchRead && r.launchOk !== false) ?? null;
}

/** PURE: the entry at the rails' size, argued from the observation's own lines for that token. */
export function autoEntryFor(pick: AutoEntryReads, observation: string[], entryUsd: number, ethUsd: number, floorPct: number): AutoEntry {
  const lines = observation.filter((l) => new RegExp(`^(Entry|Holders|Launch|Tape) ${pick.symbol}\\b`).test(l) || (l.startsWith("Launch candidates") && l.includes(`${pick.symbol}@robinhood`)));
  const evidence = lines.slice(0, 4).map((l) => l.slice(0, 400));
  const amountEth = Number((entryUsd / ethUsd).toPrecision(4));
  return {
    symbol: pick.symbol,
    amountEth,
    reason: `the reads made this entry: ${pick.symbol} passed the entry read (${pick.entryWhy}), the holder read and the launch read in the same cycle, so the desk buys $${entryUsd} of it`,
    analysis: {
      thesis: `buy $${entryUsd} of ${pick.symbol} from ETH: every read the desk has passed it this cycle`,
      evidence,
      invalidation: `the floor at -${floorPct}%, or the tape rolling over before the trade has paid`,
      conviction: 4,
    },
    line: `The reads made this entry: ${pick.symbol} passed the entry read, the holder read and the launch read in the same cycle, and the desk buys $${entryUsd} of it from ETH.`,
  };
}
