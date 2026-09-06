// What the desk learned from its own token trades. Every entry into a
// launch token is recorded with its setup (source, grade, tier, ignition
// minute, hour of day, the argued reason), every close with its result
// (hours held, realized, peak, how it left). When a like setup appears the
// nearest past trades are recalled into the observation, and the launch
// record as a whole rides alongside. Paper trades count, marked as paper,
// so a paper week teaches him too.
import { appendLedger, readLedger } from "../ledger.ts";

export const ENTRIES_LEDGER = "obs-trade-entries.jsonl";
export const CLOSES_LEDGER = "obs-trade-memory.jsonl";

export interface TradeEntry {
  at: number;
  symbol: string;
  token: string;
  source: string;
  grade: "A" | "B" | "C" | null;
  tierPct: number;
  ignitedAfterMin: number | null;
  /** "curve" or "side pool". */
  via: string;
  usd: number;
  reason: string;
  paper: boolean;
}
export interface TradeClose {
  at: number;
  symbol: string;
  token: string;
  source: string;
  grade: "A" | "B" | "C" | null;
  tierPct: number;
  ignitedAfterMin: number | null;
  via: string;
  enteredAt: number;
  holdH: number;
  usdIn: number;
  realizedUsd: number;
  realizedPct: number | null;
  peakPct: number | null;
  /** "time-stop", "floor", "volume", "tape", "trail", "take-profit", "model". */
  exitKind: string;
  paper: boolean;
}

export const readEntries = (): TradeEntry[] => readLedger<TradeEntry>(ENTRIES_LEDGER).filter((e) => e && e.symbol && Number.isFinite(Number(e.at)));
/** PURE: one row per close, the last written wins, so a corrected row for the same entry replaces the first. */
export function dedupeCloses(rows: TradeClose[]): TradeClose[] {
  const byKey = new Map<string, TradeClose>();
  for (const c of rows) if (c && c.symbol && Number.isFinite(Number(c.at))) byKey.set(`${c.symbol}:${c.enteredAt}:${c.paper ? "paper" : "real"}`, c);
  return [...byKey.values()].sort((a, b) => a.at - b.at);
}
export const readCloses = (): TradeClose[] => dedupeCloses(readLedger<TradeClose>(CLOSES_LEDGER));
export const recordEntry = (e: TradeEntry): void => appendLedger(ENTRIES_LEDGER, e as unknown as Record<string, unknown>);
export const recordClose = (c: TradeClose): void => appendLedger(CLOSES_LEDGER, c as unknown as Record<string, unknown>);

export interface Setup {
  source: string;
  grade: "A" | "B" | "C" | null;
  tierPct: number;
  ignitedAfterMin: number | null;
  via: string;
  hourUtc: number;
}

/** PURE: how alike two setups are, 0 to 1. Source and grade weigh most; tier, ignition speed and time of day refine. */
export function similarity(a: Setup, b: Setup): number {
  let s = 0;
  if (a.source === b.source) s += 0.3;
  if (a.grade === b.grade) s += 0.25;
  if (a.via === b.via) s += 0.1;
  s += 0.15 * Math.max(0, 1 - Math.abs(a.tierPct - b.tierPct) / 3);
  if (a.ignitedAfterMin != null && b.ignitedAfterMin != null) s += 0.1 * Math.max(0, 1 - Math.abs(a.ignitedAfterMin - b.ignitedAfterMin) / 15);
  const dh = Math.min(Math.abs(a.hourUtc - b.hourUtc), 24 - Math.abs(a.hourUtc - b.hourUtc));
  s += 0.1 * Math.max(0, 1 - dh / 6);
  return Math.min(1, s);
}

/** PURE: the closest past trades to a setup, best first. */
export function recallLike(setup: Setup, closes: TradeClose[], k = 3): Array<{ close: TradeClose; score: number }> {
  return closes
    .map((close) => ({ close, score: similarity(setup, { source: close.source, grade: close.grade, tierPct: close.tierPct, ignitedAfterMin: close.ignitedAfterMin, via: close.via, hourUtc: new Date(close.enteredAt).getUTCHours() }) }))
    .filter((x) => x.score >= 0.4)
    .sort((a, b) => b.score - a.score || b.close.at - a.close.at)
    .slice(0, k);
}

/** PURE: one recalled trade as a line he can read. */
export function recallLine(c: TradeClose): string {
  const pct = c.realizedPct == null ? "" : ` (${c.realizedPct >= 0 ? "+" : ""}${c.realizedPct.toFixed(0)}%)`;
  return `${c.symbol}${c.paper ? " (paper)" : ""}: ${c.source}, grade ${c.grade ?? "none"}, ${c.tierPct}% tier, ${c.ignitedAfterMin != null ? `ignited at +${c.ignitedAfterMin} min` : "no ignition"}, in via ${c.via} for $${c.usdIn.toFixed(0)}, held ${c.holdH.toFixed(1)}h${c.peakPct != null ? `, peaked ${c.peakPct >= 0 ? "+" : ""}${c.peakPct.toFixed(0)}%` : ""}, left on ${c.exitKind}, ${c.realizedUsd >= 0 ? "+" : "-"}$${Math.abs(c.realizedUsd).toFixed(2)}${pct}`;
}

export interface LaunchRecord {
  trades: number;
  wins: number;
  losses: number;
  realizedUsd: number;
  avgHoldH: number | null;
  byExit: Record<string, number>;
  byGrade: Record<string, { trades: number; realizedUsd: number }>;
  paperTrades: number;
}

/** PURE: the launch record as a whole. */
export function launchRecord(closes: TradeClose[]): LaunchRecord {
  const byExit: Record<string, number> = {};
  const byGrade: Record<string, { trades: number; realizedUsd: number }> = {};
  for (const c of closes) {
    byExit[c.exitKind] = (byExit[c.exitKind] ?? 0) + 1;
    const g = c.grade ?? "none";
    byGrade[g] = { trades: (byGrade[g]?.trades ?? 0) + 1, realizedUsd: (byGrade[g]?.realizedUsd ?? 0) + c.realizedUsd };
  }
  return {
    trades: closes.length,
    wins: closes.filter((c) => c.realizedUsd > 0).length,
    losses: closes.filter((c) => c.realizedUsd < 0).length,
    realizedUsd: closes.reduce((s, c) => s + c.realizedUsd, 0),
    avgHoldH: closes.length ? closes.reduce((s, c) => s + c.holdH, 0) / closes.length : null,
    byExit,
    byGrade,
    paperTrades: closes.filter((c) => c.paper).length,
  };
}

/** PURE: the launch record as one line. */
export function launchRecordLine(r: LaunchRecord): string {
  if (!r.trades) return "Launch record: no closed launch trades yet.";
  const grades = Object.entries(r.byGrade).map(([g, v]) => `grade ${g} ${v.trades} for ${v.realizedUsd >= 0 ? "+" : "-"}$${Math.abs(v.realizedUsd).toFixed(2)}`).join(", ");
  const exits = Object.entries(r.byExit).map(([k, n]) => `${n} on ${k}`).join(", ");
  return `Launch record: ${r.trades} closed (${r.paperTrades} paper), ${r.wins} wins, ${r.losses} losses, ${r.realizedUsd >= 0 ? "+" : "-"}$${Math.abs(r.realizedUsd).toFixed(2)} realized, average hold ${r.avgHoldH?.toFixed(1) ?? "?"}h; ${grades}; exits ${exits}.`;
}
