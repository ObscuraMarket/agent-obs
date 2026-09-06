// The reads decide the entry. When a candidate has passed the entry read,
// the holder read and the launch read in the same cycle and the model
// still holds, the desk enters at the rails' size and the model's writing
// is the public reasoning, not a veto. OBS_AUTO_ENTRY=on switches it on.
// Pure: given the cycle's reads, the pick and the argument the rails will
// check, built from the observation's own lines so every figure is real.

export interface AutoEntryReads {
  symbol: string;
  grade: string | null;
  entryOk: boolean;
  entryWhy: string;
  holdersOk: boolean;
  /** Null when the token had no launch read (not a launchpad token). */
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

/** PURE: the first graded, unheld candidate that passed every read, in board order; null when none did. */
export function autoEntryPick(reads: AutoEntryReads[]): AutoEntryReads | null {
  return reads.find((r) => r.grade && !r.held && r.entryOk && r.holdersOk && r.launchOk !== false) ?? null;
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
