// The research log: one plain line for each thing the desk learns about a
// token, as it learns it. A new launch and its gate; an ignition; a token
// taken onto the watch and dropped from it; the tape's entry state changing;
// a holders read; a launch read; a trigger; a decision. The cycles say what
// the agent decided; this says what it was doing in between, in words a
// newcomer follows. Kept in obs-research.jsonl, served by the API, drawn by
// the page's terminal between the cycles.
import { appendLedger, readLedger } from "../ledger.ts";
import { DRY } from "../config.ts";

export const RESEARCH_LEDGER = "obs-research.jsonl";

export type ResearchKind = "launch" | "ignited" | "watch" | "dropped" | "entry" | "holders" | "launch-read" | "trigger" | "decision";

export interface ResearchEvent {
  at: number;
  kind: ResearchKind;
  symbol: string;
  /** true when a gate passed, false when it refused, null when it is not a verdict. */
  ok: boolean | null;
  /** The fact, in the desk's shorthand. */
  note: string;
  /** The sentence the page shows. */
  line: string;
}

export type ResearchInput = Omit<ResearchEvent, "line" | "at"> & { at?: number };

const ENTRY: Record<string, (sym: string, note: string) => string> = {
  spike: (s) => `${s}'s tape: a spike, the top of a run. Not buying a spike.`,
  pullback: (s, n) => `${s}'s tape: a pullback that held a higher low and turned up${n ? ` (${n})` : ""}. Entry allowed, thinking.`,
  base: (s, n) => `${s}'s tape: quiet in a tight range with buyers still there${n ? ` (${n})` : ""}. Entry allowed, thinking.`,
  breakdown: (s) => `${s}'s tape: back below where the window started. No entry.`,
  waiting: (s) => `${s}'s tape: volume is up but the price has given no entry yet. Waiting.`,
  quiet: (s, n) => `${s}'s tape: quiet, ${n || "no volume pickup"}.`,
};

/** PURE: the sentence for an event. */
export function researchLine(e: ResearchInput): string {
  const s = e.symbol;
  switch (e.kind) {
    case "launch":
      return e.ok ? `New launch ${s}: ${e.note}. Gate ok, watching for ignition.` : `New launch ${s}: ${e.note}. Gate failed, never traded.`;
    case "ignited":
      return `${s} ignited ${e.note}: real buyers on its curve. Reading its tape.`;
    case "watch":
      return `Now watching ${s}'s pool block by block${e.note ? ` (${e.note})` : ""}.`;
    case "dropped":
      return `Stopped watching ${s}${e.note ? `: ${e.note}` : ""}.`;
    case "entry": {
      const [state, ...rest] = e.note.split("|");
      const n = rest.join("|").trim();
      if ((state === "pullback" || state === "base") && e.ok === false) return `${s}'s tape: a ${state}, but ${n || "not enough buyers behind it"}. No entry yet.`;
      const f = ENTRY[state] ?? ((sym: string, note: string) => `${sym}'s tape: ${state}${note ? `, ${note}` : ""}.`);
      return f(s, n);
    }
    case "holders":
      return e.ok ? `${s}'s holders: ${e.note}. OK.` : `${s}'s holders: FAIL, ${e.note}. Not buying.`;
    case "launch-read":
      return e.ok == null ? `${s}'s launch: ${e.note}.` : e.ok ? `${s}'s launch: ${e.note}. OK.` : `${s}'s launch: FAIL, ${e.note}. Not buying.`;
    case "trigger":
      return `${s} gave an entry: ${e.note}. Thinking now.`;
    case "decision":
      return `Decided: ${e.note}`;
  }
}

const recent = new Map<string, number>();
/** Append an event unless the same fact was recorded inside the last `windowMin` minutes. Returns the event, or null when it was a repeat. */
export function recordResearch(e: ResearchInput, windowMin = 10): ResearchEvent | null {
  if (DRY) return null;
  const at = e.at ?? Date.now();
  const key = `${e.kind}|${e.symbol.toUpperCase()}|${e.ok}|${e.note}`;
  const last = recent.get(key);
  if (last != null && at - last < windowMin * 60e3) return null;
  recent.set(key, at);
  if (recent.size > 5000) for (const [k, v] of recent) if (at - v > windowMin * 60e3) recent.delete(k);
  const ev: ResearchEvent = { at, kind: e.kind, symbol: e.symbol, ok: e.ok, note: e.note, line: researchLine(e) };
  appendLedger(RESEARCH_LEDGER, ev as unknown as Record<string, unknown>);
  return ev;
}

/** The latest events, newest first. */
export function readResearch(limit = 50): ResearchEvent[] {
  const rows = readLedger<ResearchEvent>(RESEARCH_LEDGER).filter((r) => r && typeof r.line === "string" && Number.isFinite(r.at));
  return rows.slice(-limit).reverse();
}
