// Per-agent continuity.
//
// Without this, decisions are written and never read back, and every cycle
// composes a stranger who happens to share a voice doc. This is the journal an
// agent keeps for itself. It is NEVER published: it is the
// private half of thinking out loud, fed back next cycle so he can build on a
// thought instead of restarting it.
//
// One journal per persona. The X voice and the operator are different agents
// with different jobs, so they must not share a memory.
import { existsSync, readFileSync } from "node:fs";
import { appendLedger } from "./ledger.ts";
import { dataPath } from "./config.ts";

const journalFile = (agent: string) => `${agent}-journal.jsonl`;

export interface JournalEntry {
  at: number;
  /** What he chose to do that cycle, useful context for the next one. */
  decision: "post" | "hold";
  /** His own private note: what he is tracking, what he thinks, what he got wrong. */
  note: string;
}

/** Append one cycle's note. Silent on failure: a journal write must never cost a post. */
export function remember(agent: string, entry: Omit<JournalEntry, "at">): void {
  const note = entry.note.trim().slice(0, 400);
  if (!note) return;
  appendLedger(journalFile(agent), { at: Date.now(), decision: entry.decision, note });
}

/** The last `limit` notes, oldest first, so the prompt reads as a timeline. */
export function recall(agent: string, limit = 8): JournalEntry[] {
  const path = dataPath(journalFile(agent));
  if (!existsSync(path)) return [];
  const rows: JournalEntry[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as JournalEntry;
        if (r?.note) rows.push(r);
      } catch {
        /* skip a malformed line rather than lose the journal */
      }
    }
  } catch {
    return [];
  }
  return rows.slice(-limit);
}

/** The journal rendered for a prompt: a timeline with rough ages. */
export function recallForPrompt(agent: string, limit = 8, now = Date.now()): string {
  const rows = recall(agent, limit);
  if (!rows.length) return "";
  const ago = (ts: number) => {
    const h = (now - ts) / 3600_000;
    if (h < 1) return "just now";
    if (h < 24) return `${Math.round(h)}h ago`;
    return `${Math.round(h / 24)}d ago`;
  };
  return rows.map((r) => `- (${ago(r.at)}) ${r.note}`).join("\n");
}

/**
 * A model reply that may carry a private note alongside the public text.
 *
 * Asking for a second model call per cycle just to journal would double the
 * cost of every post, so the note rides along in one response. Parsing is
 * deliberately forgiving: an unlabelled reply is treated as pure public text,
 * so a model that ignores the format still posts normally rather than
 * emitting "POST:" onto the timeline.
 */
export function splitNote(raw: string): { text: string; note: string } {
  const s = (raw ?? "").trim();
  const noteMatch = s.match(/^[\s>*-]*NOTE\s*:\s*([\s\S]*)$/im);
  const note = noteMatch ? noteMatch[1].trim() : "";
  let text = note && noteMatch?.index != null ? s.slice(0, noteMatch.index).trim() : s;

  // The POST: marker shows up in two shapes. Leading, "POST: <tweet>", is the
  // template being followed and the label is noise. Mid-text is the shape that
  // actually ships: the model writes the tweet as prose,
  // then repeats a labelled version of its first sentence underneath, so
  // everything from the marker on is the echo and the tweet is what came before.
  const leading = text.match(/^[\s>*-]*POST\s*:\s*/i);
  if (leading) {
    text = text.slice(leading[0].length).trim();
  } else {
    const echo = text.search(/(?:^|\s)POST\s*:/i);
    if (echo >= 0) text = text.slice(0, echo).trim();
  }
  return { text, note };
}
