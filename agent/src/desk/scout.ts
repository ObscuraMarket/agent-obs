// The scout: which survivors deserve the watch's slots. Every OBS_SCOUT_EVERY_SEC
// it takes the board (the screener's survivors inside the range, a day old,
// with a record), reads each one's last hour of tape, scores the setup, and
// writes data/obs-scout.json: the ranked list with a reason each. The live
// watch fills its survivor slots from that list; the API serves it; the
// research log carries one line per round so the terminal shows the funnel.
// The score is deterministic and explained; nothing here trades or thinks.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dataPath } from "../config.ts";
import { readFeed, candidateAsset, dynamicPoolSpec, type Candidate } from "./candidates.ts";
import { updateTape, tapeStats, type SwapRow, type TapeStats } from "./tape.ts";
import { entryRead, entryRulesFromEnv, type EntryRead } from "./entry.ts";
import { recordResearch } from "./research.ts";

export const SCOUT_FILE = "obs-scout.json";

export interface ScoutRow {
  symbol: string;
  token: string;
  poolId: string;
  score: number;
  reasons: string[];
  /** The record line the board carried, and the tape's last hour in a few figures. */
  record: string;
  capUsd: number | null;
  vol24: number;
  vol1: number;
  liqUsd: number | null;
  tape: { swaps: number; buyPressurePct: number | null; movePct: number | null; offPeakPct: number | null; trend: TapeStats["trend"]; lastSwapAgoMin: number | null };
  entry: { state: EntryRead["state"]; ok: boolean; why: string };
}
export interface ScoutFile { at: number; slots: number; ranked: ScoutRow[] }

/**
 * PURE: the setup score, 0 to 100, from what the record and the last hour of tape say. Higher is a better place
 * to be watching right now: buyers present, a tape that is not rolling over, a price off its peak but not broken,
 * liquidity the ticket can leave, and enough trade to read. Each point carries its reason.
 */
export function scoutScore(c: Candidate, s: TapeStats, e: EntryRead, long?: TapeStats): { score: number; reasons: string[] } {
  const r: string[] = [];
  let score = 0;
  const add = (pts: number, why: string) => { score += pts; r.push(`${pts >= 0 ? "+" : ""}${pts} ${why}`); };
  // The setup the desk hunts: a pump inside the last three hours, now pulling back with buyers still there. A run of
  // 50% or more from the window's start to its peak, the price 15 to 60% off that peak, and buy pressure over the hour
  // still at 45% or more. The pullback entry forms out of exactly this, and the scout puts it on the watch first.
  if (long && long.first != null && long.peak != null && long.last != null && long.first > 0) {
    const runPct = ((long.peak - long.first) / long.first) * 100;
    const offPct = long.offPeakPct ?? 0;
    if (runPct >= 50 && offPct >= 15 && offPct <= 60 && (s.buyPressurePct ?? 0) >= 45) add(20, `pulling back ${offPct.toFixed(0)}% from a +${runPct.toFixed(0)}% pump inside three hours, buyers still ${(s.buyPressurePct ?? 0).toFixed(0)}%`);
    else if (runPct >= 50 && offPct > 60) add(-10, `the pump inside three hours gave back ${offPct.toFixed(0)}%`);
  }
  // Read at all: a tape with no trade cannot give an entry.
  if (s.swaps >= 30) add(20, `${s.swaps} swaps in the last hour`);
  else if (s.swaps >= 10) add(10, `${s.swaps} swaps in the last hour`);
  else add(-10, `${s.swaps} swaps in the last hour, too few to read`);
  if (s.lastSwapAgoMin != null && s.lastSwapAgoMin <= 5) add(10, `last swap ${s.lastSwapAgoMin.toFixed(0)} min ago`);
  else if (s.lastSwapAgoMin != null && s.lastSwapAgoMin > 30) add(-10, `last swap ${s.lastSwapAgoMin.toFixed(0)} min ago`);
  // Buyers.
  if (s.buyPressurePct != null) {
    if (s.buyPressurePct >= 60) add(20, `buy pressure ${s.buyPressurePct.toFixed(0)}%`);
    else if (s.buyPressurePct >= 50) add(10, `buy pressure ${s.buyPressurePct.toFixed(0)}%`);
    else if (s.buyPressurePct < 40) add(-15, `buy pressure ${s.buyPressurePct.toFixed(0)}%, sellers in charge`);
  }
  // The shape: off the peak but not broken is where a base or a held pullback forms.
  if (s.trend === "rising") add(15, "5-minute volume rising");
  else if (s.trend === "rolling over") add(-15, "5-minute volume rolling over");
  if (s.offPeakPct != null) {
    if (s.offPeakPct >= 5 && s.offPeakPct <= 35) add(10, `${s.offPeakPct.toFixed(0)}% off its hour's peak`);
    else if (s.offPeakPct > 60) add(-10, `${s.offPeakPct.toFixed(0)}% off its hour's peak`);
  }
  // The entry read now.
  if (e.ok) add(25, `entry allowed now: ${e.state}`);
  else if (e.state === "base" || e.state === "pullback") add(10, `a ${e.state} forming`);
  else if (e.state === "breakdown") add(-10, "breakdown");
  // The record: liquidity the ticket can leave, and a day still alive.
  const liq = c.record?.liqUsd ?? null;
  if (liq != null && liq >= 25_000) add(10, `liquidity $${Math.round(liq / 1000)}k`);
  else if (liq != null && liq < 10_000) add(-10, `liquidity $${Math.round(liq / 1000)}k, thin`);
  if (c.record && c.record.vol24 > 0 && c.record.vol1 / (c.record.vol24 / 24) >= 1.5) add(10, "the last hour above the day's pace");
  return { score: Math.max(0, Math.min(100, score)), reasons: r };
}

/** PURE: rank rows by score, then by the last hour's volume; the top `slots` are the watch. */
export function rankScout(rows: ScoutRow[], slots: number): ScoutRow[] {
  return [...rows].sort((a, b) => b.score - a.score || b.vol1 - a.vol1).slice(0, Math.max(0, slots));
}

export function readScout(): ScoutFile {
  const p = dataPath(SCOUT_FILE);
  if (!existsSync(p)) return { at: 0, slots: 0, ranked: [] };
  try {
    const f = JSON.parse(readFileSync(p, "utf8")) as ScoutFile;
    return Array.isArray(f.ranked) ? f : { at: 0, slots: 0, ranked: [] };
  } catch {
    return { at: 0, slots: 0, ranked: [] };
  }
}

export function writeScout(f: ScoutFile): void {
  const p = dataPath(SCOUT_FILE);
  writeFileSync(p + ".tmp", JSON.stringify(f));
  renameSync(p + ".tmp", p);
}

/** One scouting round over the board: read each survivor's last hour, score, rank, write, and say so. */
export async function scoutRound(now = Date.now(), slots = Number(process.env.OBS_SCOUT_SLOTS ?? 6), maxRead = Number(process.env.OBS_SCOUT_MAX_READ ?? 24)): Promise<ScoutFile> {
  const feed = readFeed(now);
  const board = feed.candidates.filter((c) => c.record || c.stable?.stable).slice(0, maxRead);
  const rules = entryRulesFromEnv();
  const rows: ScoutRow[] = [];
  for (const c of board) {
    const spec = dynamicPoolSpec(candidateAsset(c));
    if (!spec) continue;
    let tape: SwapRow[] = [];
    try { tape = await updateTape(spec, c.symbol, now, 180); } catch { /* an unread tape scores as no trade */ }
    const s = tapeStats(tape, c.symbol, now, 60);
    const long = tapeStats(tape, c.symbol, now, 180);
    const e = entryRead(tape, c.symbol, now, rules, true);
    const { score, reasons } = scoutScore(c, s, e, long);
    rows.push({ symbol: c.symbol, token: c.token, poolId: c.poolId, score, reasons, record: c.record?.line ?? c.stable?.why ?? "", capUsd: c.record?.capUsd ?? null, vol24: c.record?.vol24 ?? c.volUsd, vol1: c.record?.vol1 ?? c.volUsd, liqUsd: c.record?.liqUsd ?? null, tape: { swaps: s.swaps, buyPressurePct: s.buyPressurePct, movePct: s.movePct, offPeakPct: s.offPeakPct, trend: s.trend, lastSwapAgoMin: s.lastSwapAgoMin }, entry: { state: e.state, ok: e.ok, why: e.why } });
  }
  const ranked = rankScout(rows, slots);
  const file: ScoutFile = { at: now, slots, ranked };
  writeScout(file);
  if (ranked.length) {
    const top = ranked.slice(0, 3).map((r) => `${r.symbol} ${r.score} (${r.reasons.filter((x) => x.startsWith("+")).slice(0, 2).map((x) => x.replace(/^\+\d+ /, "")).join(", ") || "little to say"})`).join("; ");
    recordResearch({ kind: "scout", symbol: ranked[0].symbol, ok: null, note: `${rows.length} survivors read, ${ranked.length} on the watch. Leading: ${top}.` });
  } else {
    recordResearch({ kind: "scout", symbol: "", ok: null, note: `${rows.length} survivors read, none with a tape worth a slot.` });
  }
  return file;
}
