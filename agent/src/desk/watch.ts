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
  /** Buy pressure over the tape window, in quote terms. */
  buyPressurePct?: number | null;
  swaps: number;
  lastSwapAgoMin: number | null;
  why: string;
  /** The last swap's price on the tape, in the quote per token, and the quote's symbol: the page prices a held token from it between wallet reads. */
  lastPrice?: number | null;
  quote?: string;
  /**
   * A held token's exit rail as the watch reads it at the tape's last price: the floor, the trail, the take-profit,
   * the time stop, in the cycle's own words, or null while none trips. The kind fires the trigger once; the cycle
   * then checks the same rails against the chain and sells. Before this the floor was only checked inside a cycle,
   * up to the review cadence plus a queued cycle late: a LUDES floor at 30% filled at 33% (2026-09-08).
   */
  rail?: string | null;
  railKind?: string | null;
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
  /** A held token whose buy pressure falls under this is an exit trigger (the buyers are thinning). */
  thinPressurePct: number;
  /** A held token whose rail still trips this many minutes after its last cycle fires the exit trigger again (OBS_LIVE_RAIL_REFIRE_MIN). */
  railRefireMin: number;
}

export function watchRulesFromEnv(env: NodeJS.ProcessEnv = process.env): WatchRules {
  const n = (k: string, d: number) => Number(env[k] ?? d);
  return {
    heldEveryMin: n("OBS_LIVE_HELD_EVERY_MIN", 5),
    cooldownMin: n("OBS_LIVE_COOLDOWN_MIN", 3),
    entryEveryMin: n("OBS_LIVE_ENTRY_EVERY_MIN", 15),
    giveBackPct: Number(env.OBS_LIVE_GIVEBACK_PCT ?? env.OBS_CANDIDATE_TRAIL_PCT ?? 25),
    thinPressurePct: Number(env.OBS_LIVE_THIN_PRESSURE_PCT ?? env.OBS_CANDIDATE_TAPE_EXIT_PRESSURE_PCT ?? 45),
    railRefireMin: n("OBS_LIVE_RAIL_REFIRE_MIN", 3),
  };
}

export interface Trigger {
  symbol: string;
  kind: "exit" | "entry" | "held";
  reason: string;
  /** The short form: the entry read's sentence, the break on a held token, or how long since its last review. */
  what: string;
}

const PRIORITY: Record<Trigger["kind"], number> = { exit: 0, entry: 1, held: 2 };

/**
 * PURE: whether a trigger that fired while the desk was busy takes the place of the one kept for it: only a higher
 * rank does, an exit over an entry over a held review. Until 2026-09-08 only an exit could displace, so an entry
 * that flipped behind a queued review waited the fifteen minutes for its refire; the review it displaces comes
 * back on its own cadence.
 */
export function displaces(next: Trigger, kept: Trigger | null): boolean {
  return !kept || PRIORITY[next.kind] < PRIORITY[kept.kind];
}

/**
 * PURE: whether a line of the cycle's output says a swap changed what the wallet holds: the settle pass writing a
 * row settled, a forced exit that settled, the recorded line's swap settled, or a paper trade or paper exit (the
 * paper watch holds through the paper book). The watch re-read its held list on its own minute until 2026-09-08,
 * so a fresh buy had no rails for up to a minute and a token just sold could still trip a trigger.
 */
export function swapLanded(line: string): boolean {
  return /^\[desk\] (?:\S+ -> settled\b|forced exit \S+ settled\b|paper exit \S+:|recorded\b.*\b(?:swap \S+ settled\b|paper trade \S+))/.test(line.trim());
}

/**
 * PURE: whether the cycle's lock is held by a live cycle: its pid alive and the lock under fifteen minutes old, the
 * cycle's own rule. The watch does not spawn into a held lock; the cycle it spawned would only read the lock and
 * leave, and the trigger would be lost. Right after a redeploy the runner's own boot cycle held the lock and the
 * watch's first entry trigger was dropped that way (2026-09-08).
 */
export function lockHeld(lock: { pid: number; at: number } | null, now: number, alive: (pid: number) => boolean): boolean {
  if (!lock || typeof lock.pid !== "number" || typeof lock.at !== "number") return false;
  return alive(lock.pid) && now - lock.at < 15 * 60e3;
}

/** PURE: what changed between two looks that is worth a desk cycle, most urgent first. */
export function triggersFor(prev: Record<string, WatchState>, next: WatchState[], lastThinkAt: Record<string, number>, now: number, r: WatchRules): Trigger[] {
  const out: Trigger[] = [];
  for (const s of next) {
    const p = prev[s.symbol];
    const sinceMin = lastThinkAt[s.symbol] != null ? (now - lastThinkAt[s.symbol]) / 60e3 : Infinity;
    if (s.role === "held") {
      // A rail tripping at the tape's price is the most urgent thing the watch can see: fired the look it appears,
      // and again while it still trips once the re-fire gap has passed since the token's last cycle. Fired once per
      // change only, a floor the cycle had dismissed (it priced the position from the feed, the watch from the tape)
      // was never raised again, and the position kept sliding through it (2026-09-08).
      const rail = s.railKind && s.rail ? { kind: s.railKind, text: s.rail } : null;
      if (rail && p?.railKind !== rail.kind) out.push({ symbol: s.symbol, kind: "exit", reason: `held ${s.symbol} tripped its ${rail.kind} rail: ${rail.text}`, what: rail.text });
      else if (rail && sinceMin >= r.railRefireMin) {
        const since = sinceMin === Infinity ? "with no cycle yet" : `${sinceMin.toFixed(0)} min after its last cycle`;
        out.push({ symbol: s.symbol, kind: "exit", reason: `held ${s.symbol} is still through its ${rail.kind} rail ${since}: ${rail.text}`, what: rail.text });
      }
      else if (s.trend === "rolling over" && p?.trend !== "rolling over") out.push({ symbol: s.symbol, kind: "exit", reason: `the tape rolled over on held ${s.symbol}`, what: "the tape rolled over" });
      else if (s.offPeakPct != null && s.offPeakPct >= r.giveBackPct && (p?.offPeakPct == null || p.offPeakPct < r.giveBackPct)) out.push({ symbol: s.symbol, kind: "exit", reason: `held ${s.symbol} is ${s.offPeakPct.toFixed(0)}% off its tape peak`, what: `${s.offPeakPct.toFixed(0)}% off its tape peak` });
      else if (s.buyPressurePct != null && s.buyPressurePct < r.thinPressurePct && (p?.buyPressurePct == null || p.buyPressurePct >= r.thinPressurePct)) out.push({ symbol: s.symbol, kind: "exit", reason: `the buyers are thinning on held ${s.symbol}: buy pressure ${s.buyPressurePct.toFixed(0)}%`, what: "the buyers are thinning" });
      else if (sinceMin >= r.heldEveryMin) {
        const since = sinceMin === Infinity ? "not reviewed yet" : `${sinceMin.toFixed(0)} min since its last review`;
        out.push({ symbol: s.symbol, kind: "held", reason: `held ${s.symbol}, ${since}`, what: since });
      }
      continue;
    }
    if (!s.entryOk || sinceMin < r.cooldownMin) continue;
    if (!p?.entryOk) out.push({ symbol: s.symbol, kind: "entry", reason: `${s.symbol} gave an entry: ${s.why}`, what: s.why });
    else if (sinceMin >= r.entryEveryMin) out.push({ symbol: s.symbol, kind: "entry", reason: `${s.symbol} still has an entry after ${sinceMin.toFixed(0)} min: ${s.why}`, what: s.why });
  }
  return out.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
}

/** PURE: a held token's tape in one clause for the terminal: "tape holding, 12% off its peak, buy pressure 58%, 14 swaps in the last 15 min". */
export function holdingNote(s: WatchState, windowMin = 15): string {
  const bits = [`tape ${s.trend}`];
  if (s.offPeakPct != null) bits.push(s.offPeakPct < 1 ? "at its peak" : `${s.offPeakPct.toFixed(0)}% off its peak`);
  if (s.buyPressurePct != null) bits.push(`buy pressure ${s.buyPressurePct.toFixed(0)}%`);
  bits.push(s.swaps ? `${s.swaps} swap${s.swaps === 1 ? "" : "s"} in the last ${windowMin} min` : `no swaps in the last ${windowMin} min`);
  return bits.join(", ");
}

/** PURE: one line for the log, once a minute. A held token reads by its trend; its entry read is not what the desk watches on it. */
export function heartbeatLine(states: WatchState[], block: number | null, lastTrigger: string | null, lookMs: number | null = null): string {
  const what = states.length ? states.map((s) => (s.role === "held" ? `${s.symbol} held ${s.trend}` : `${s.symbol} ${s.role} ${s.entryOk ? "ENTRY" : s.entryState}`)).join(", ") : "nothing in play";
  return `[live] block ${block ?? "?"}${lookMs != null ? ` (looks ${(lookMs / 1000).toFixed(1)} s)` : ""}: ${what}${lastTrigger ? `; last trigger ${lastTrigger}` : ""}`;
}
