// The trigger's place in the cycle it fired. The live watch (live.ts)
// spawns a cycle when a token's tape gives an entry, a held token breaks or
// is due a review, and names the token in OBS_LIVE_TRIGGER_SYMBOL with its
// kind in OBS_LIVE_TRIGGER_KIND. Until 2026-09-08 the cycle built its board
// from the feed's order alone, so the token that fired was off the board in
// 42% of 565 triggered thinks (no entry line for it) and 16 of 48 buys were
// of a different token than the one that fired. These pure rules put the
// trigger's token first, let the auto entry prefer it, and keep the cadence
// floor per symbol for entry triggers.

export type TriggerKind = "exit" | "entry" | "held";
export interface CycleTrigger {
  symbol: string;
  kind: TriggerKind;
}

/**
 * PURE: the watch's trigger from the cycle's environment, or null on a timer cycle or an operator's own run. A kind
 * the cycle does not know is read as a held review, the conservative side: the floor stays global for it.
 */
export function triggerFromEnv(env: NodeJS.ProcessEnv = process.env): CycleTrigger | null {
  const symbol = (env.OBS_LIVE_TRIGGER_SYMBOL ?? "").trim().toUpperCase();
  if (!symbol) return null;
  const k = (env.OBS_LIVE_TRIGGER_KIND ?? "").trim().toLowerCase();
  const kind: TriggerKind = k === "exit" || k === "entry" || k === "held" ? k : "held";
  return { symbol, kind };
}

/**
 * PURE: the first n rows of a feed list, plus the trigger's own row when it sits past them, so the token that fired
 * is graded and readable in the cycle it fired. The watch follows eight launches and the scout's ranking; the cycle
 * graded the first six of each list and never saw a trigger past them (2026-09-08).
 */
export function sliceWithTrigger<T extends { symbol: string }>(rows: T[], n: number, symbol: string | null): T[] {
  const head = rows.slice(0, n);
  if (!symbol || head.some((r) => r.symbol === symbol)) return head;
  const row = rows.find((r) => r.symbol === symbol);
  return row ? [...head, row] : head;
}

export interface BoardInput {
  /** The tokens the desk holds, always on the board and always first. */
  held: string[];
  /** The tradable early launches, in feed order, unsliced. */
  launches: string[];
  /** The graded candidates, in feed order, unsliced. */
  candidates: string[];
  /** The watch's trigger token, or null. */
  trigger: string | null;
  /** How many launches the board takes without a trigger. */
  maxLaunches: number;
  /** How many graded candidates the board takes without a trigger (OBS_CYCLE_READ_CANDIDATES). */
  maxCandidates: number;
}

export interface BoardOrder {
  /** The tokens in play, in read order: held first, then the trigger, then the feed's order. */
  board: string[];
  /** Where the trigger token was found, "unknown" when it is neither held, a tradable launch nor a graded candidate; null without a trigger. */
  trigger: "held" | "launch" | "candidate" | "unknown" | null;
}

/**
 * PURE: the cycle's board with the trigger's token read first. The board is the same size it would be without the
 * trigger: held tokens, then up to maxLaunches launches and maxCandidates candidates in feed order. A trigger that
 * is a tradable launch or a graded candidate goes straight after the held tokens, and when it was not already on
 * the board it displaces the last feed-order token (a candidate before a launch), never a held one. A trigger the
 * cycle does not know leaves the board as it was; the caller logs it.
 */
export function boardOrder(i: BoardInput): BoardOrder {
  const plain: string[] = [];
  const add = (s: string) => {
    if (!plain.includes(s)) plain.push(s);
  };
  for (const s of i.held) add(s);
  for (const s of i.launches.slice(0, Math.max(0, i.maxLaunches))) add(s);
  for (const s of i.candidates.slice(0, Math.max(0, i.maxCandidates))) add(s);
  if (!i.trigger) return { board: plain, trigger: null };
  const t = i.trigger;
  if (i.held.includes(t)) return { board: plain, trigger: "held" };
  const where = i.launches.includes(t) ? "launch" : i.candidates.includes(t) ? "candidate" : "unknown";
  if (where === "unknown") return { board: plain, trigger: "unknown" };
  const heldFirst = plain.filter((s) => i.held.includes(s));
  const rest = plain.filter((s) => !i.held.includes(s) && s !== t);
  return { board: [...heldFirst, t, ...rest].slice(0, plain.length), trigger: where };
}

export interface ThoughtStamp {
  at: number;
  /** The trigger the thought answered; absent on a timer cycle and on rows written before 2026-09-08. */
  trigger?: { symbol: string; kind: string } | null;
}

/**
 * PURE: the thought the cadence floor measures from, when it is inside the gap, or null when the cycle may think.
 *
 * For an entry trigger the floor is per symbol: the last thought about the same token, where a thought with no
 * stamp (a timer cycle's, or one from before the stamp) counts for every token. For a held review or an exit, and
 * on a timer cycle, it is the last thought of any token, as before. The choice, 2026-09-08: live.ts stamps the
 * symbol's lastThinkAt before it spawns, and the cycle's floor was the last thought of any symbol, so an entry that
 * flipped inside three minutes of another token's think printed "Holding" and was then quiet for the fifteen-minute
 * refire (16.5% of entry triggers since 2026-09-06). The other way round, un-stamping the symbol in live.ts when the
 * child left on the floor, either re-spawns a cycle every look until the global floor clears (each one settling and
 * reading the wallet first) or, with the stamp kept, still waits the refire. Keeping the floor in the cycle and
 * making it per symbol leaves one cycle at a time to the lock and the watch's single child, and never silences a
 * fresh flip. A second trigger of the same token inside the gap is still held, as it should be.
 */
export function thoughtFloor(thoughts: ThoughtStamp[], trigger: CycleTrigger | null, now: number, gapMin: number): { agoMin: number; about: string | null } | null {
  const recent = [...thoughts].sort((a, b) => b.at - a.at);
  const last = trigger?.kind === "entry" ? recent.find((t) => !t.trigger?.symbol || t.trigger.symbol === trigger.symbol) : recent[0];
  if (!last) return null;
  const agoMin = (now - last.at) / 60e3;
  if (agoMin >= gapMin) return null;
  return { agoMin, about: last.trigger?.symbol ?? null };
}
