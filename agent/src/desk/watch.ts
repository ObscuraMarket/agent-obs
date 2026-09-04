// The live watch's rules: the desk in real time. The watch follows the pool
// of every token in play a few seconds apart and keeps its tape and entry
// read current; these pure rules say when that is worth a desk cycle. A held
// token whose tape rolls over or gives back too much from its peak is an
// exit trigger, fired the moment it happens. A token whose entry read flips
// to allowed is an entry trigger, fired once, with a fresh look every so
// often while it lasts. A held token is reviewed on a short cadence
// regardless. The cycle keeps every rail; the watch only decides when it runs.

export type Role = "held" | "launch" | "stable";

export interface WatchState {
  symbol: string;
  role: Role;
  entryState: string;
  entryOk: boolean;
  trend: "rising" | "holding" | "rolling over" | "thin";
  offPeakPct: number | null;
  swaps: number;
  lastSwapAgoMin: number | null;
  why: string;
}

export interface WatchRules {
  /** A held token is reviewed at least this often, in minutes. */
  heldEveryMin: number;
  /** The least time between two cycles for the same token, in minutes. */
  cooldownMin: number;
  /** A persistent entry gets a fresh look this often, in minutes. */
  entryEveryMin: number;
  /** A held token this far off its tape peak is an exit trigger. */
  giveBackPct: number;
}

export function watchRulesFromEnv(env: NodeJS.ProcessEnv = process.env): WatchRules {
  const n = (k: string, d: number) => Number(env[k] ?? d);
  return {
    heldEveryMin: n("OBS_LIVE_HELD_EVERY_MIN", 5),
    cooldownMin: n("OBS_LIVE_COOLDOWN_MIN", 3),
    entryEveryMin: n("OBS_LIVE_ENTRY_EVERY_MIN", 15),
    giveBackPct: Number(env.OBS_LIVE_GIVEBACK_PCT ?? env.OBS_CANDIDATE_TRAIL_PCT ?? 25),
  };
}

export interface Trigger {
  symbol: string;
  kind: "exit" | "entry" | "held";
  reason: string;
}

const PRIORITY: Record<Trigger["kind"], number> = { exit: 0, entry: 1, held: 2 };

/** PURE: what changed between two looks that is worth a desk cycle, most urgent first. */
export function triggersFor(prev: Record<string, WatchState>, next: WatchState[], lastThinkAt: Record<string, number>, now: number, r: WatchRules): Trigger[] {
  const out: Trigger[] = [];
  for (const s of next) {
    const p = prev[s.symbol];
    const sinceMin = lastThinkAt[s.symbol] != null ? (now - lastThinkAt[s.symbol]) / 60e3 : Infinity;
    if (s.role === "held") {
      if (s.trend === "rolling over" && p?.trend !== "rolling over") out.push({ symbol: s.symbol, kind: "exit", reason: `the tape rolled over on held ${s.symbol}` });
      else if (s.offPeakPct != null && s.offPeakPct >= r.giveBackPct && (p?.offPeakPct == null || p.offPeakPct < r.giveBackPct)) out.push({ symbol: s.symbol, kind: "exit", reason: `held ${s.symbol} is ${s.offPeakPct.toFixed(0)}% off its tape peak` });
      else if (sinceMin >= r.heldEveryMin) out.push({ symbol: s.symbol, kind: "held", reason: `held ${s.symbol}, ${sinceMin === Infinity ? "not reviewed yet" : `${sinceMin.toFixed(0)} min since its last review`}` });
      continue;
    }
    if (!s.entryOk || sinceMin < r.cooldownMin) continue;
    if (!p?.entryOk) out.push({ symbol: s.symbol, kind: "entry", reason: `${s.symbol} gave an entry: ${s.why}` });
    else if (sinceMin >= r.entryEveryMin) out.push({ symbol: s.symbol, kind: "entry", reason: `${s.symbol} still has an entry after ${sinceMin.toFixed(0)} min: ${s.why}` });
  }
  return out.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
}

/** PURE: one line for the log, once a minute. */
export function heartbeatLine(states: WatchState[], block: number | null, lastTrigger: string | null, lookMs: number | null = null): string {
  const what = states.length ? states.map((s) => `${s.symbol} ${s.role} ${s.entryOk ? "ENTRY" : s.entryState}${s.role === "held" ? `/${s.trend}` : ""}`).join(", ") : "nothing in play";
  return `[live] block ${block ?? "?"}${lookMs != null ? ` (looks ${(lookMs / 1000).toFixed(1)} s)` : ""}: ${what}${lastTrigger ? `; last trigger ${lastTrigger}` : ""}`;
}
