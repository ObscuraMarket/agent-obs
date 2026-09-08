// Agent OBS on X: the trading desk speaking for itself. The autopilot hands the model the desk's own ledgers this
// cycle (the book, today's closes, the record, the latest thoughts, the watch) and a form for the post, and the
// model decides what, if anything, to say. Pure where it matters: the block and the prompt are functions of what
// they are handed, and tested offline; only traderData() reads the disk.
import { readFileSync } from "node:fs";
import { dataPath } from "../config.ts";
import { readBook, snapshot, positions, holdingsFrom, type Prices } from "../desk/book.ts";
import { readCloses, launchRecord, launchRecordLine, type TradeClose } from "../desk/trade-memory.ts";
import { readThoughts, type Thought } from "../desk/thoughts.ts";
import { readPrices } from "../desk/analysis.ts";

export interface TraderInput {
  equityUsd: number | null;
  realizedUsd: number;
  positions: Array<{ asset: string; valueUsd: number | null; unrealizedPct: number | null; ageH: number | null }>;
  closesToday: Array<Pick<TradeClose, "symbol" | "realizedUsd" | "realizedPct" | "exitKind" | "holdH" | "at">>;
  record: string;
  thoughts: Array<{ at: number; text: string; decision: string }>;
  watching: Array<{ symbol: string; role: string; entryState: string; trend: string; why: string }>;
  now: number;
}

const usd = (v: number | null | undefined) => (v == null ? "unpriced" : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(v >= 100 || v <= -100 ? 0 : 2)}`);
const pct = (v: number | null | undefined) => (v == null ? "" : ` (${v >= 0 ? "+" : ""}${v.toFixed(1)}%)`);
const clock = (ts: number) => new Date(ts).toISOString().slice(11, 16) + " UTC";
const exitWord: Record<string, string> = { trail: "the trailing stop", floor: "the floor", "take-profit": "the take-profit", "tape-profit": "the tape exit, buyers thinning", tape: "the tape exit", volume: "the volume roll-over", "time-stop": "the time stop", model: "my own call", operator: "the operator" };

/** PURE: the desk's own numbers this cycle, the only ones the post may carry. */
export function traderBlock(i: TraderInput): string {
  const lines: string[] = [];
  lines.push(`- equity ${usd(i.equityUsd)}; realized since the start ${usd(i.realizedUsd)}; the time is ${clock(i.now)}`);
  lines.push(`- the record: ${i.record}`);
  if (i.positions.length) for (const p of i.positions) lines.push(`- holding ${p.asset}: ${usd(p.valueUsd)}${pct(p.unrealizedPct)}${p.ageH != null ? `, held ${p.ageH.toFixed(1)} h` : ""}`);
  else lines.push("- holding nothing but ETH right now");
  if (i.closesToday.length) {
    const net = i.closesToday.reduce((s, c) => s + (c.realizedUsd || 0), 0);
    const wins = i.closesToday.filter((c) => (c.realizedUsd || 0) > 0).length;
    lines.push(`- closed today: ${i.closesToday.length} (${wins} won), net ${usd(net)}`);
    for (const c of i.closesToday.slice(-6)) lines.push(`  - ${clock(c.at)} ${c.symbol}: ${usd(c.realizedUsd)}${pct(c.realizedPct)} after ${c.holdH.toFixed(1)} h, out on ${exitWord[c.exitKind] ?? c.exitKind}`);
  } else lines.push("- closed today: nothing yet");
  if (i.watching.length) lines.push(`- watching: ${i.watching.slice(0, 6).map((w) => `${w.symbol} (${w.role === "held" ? "held, " : ""}${w.entryState}, tape ${w.trend}: ${w.why})`).join("; ")}`);
  if (i.thoughts.length) {
    lines.push("- my latest thinking, in my own words:");
    for (const t of i.thoughts) lines.push(`  - ${clock(t.at)} [${t.decision}] ${t.text.slice(0, 240)}`);
  }
  return lines.join("\n");
}

/** The shape of this cycle's post, rotated so the feed does not read like one long essay. */
export const TRADER_FORMS: string[] = [
  "A TRADE NOTE. One trade from today, from the block: what you did, the number it happened at, and the rule that did it. One or two lines. Never what anyone else should do.",
  "THE RECORD. The record line and today's net, plainly, wins and losses named as they are. Short. No adjectives.",
  "WHAT YOU ARE WATCHING AND NOT TOUCHING. Name one token from the watch and the one condition that would put you in. The discipline is the content.",
  "AN ADMISSION. A loss from today or the open book, what the rule did, and what you keep from it. No apology, no sulk.",
  "A MECHANIC. One of your own rules, entry or exit, and how it works in plain words. Lead with the mechanic, land it in a line.",
  "A ONE-LINER. Under fifteen words, hard stop. One observation from the block, no setup, no conclusion. Lowercase is fine.",
  "A CALLBACK. Something from your notes, and what happened to it: held up, fell apart, still open. Short.",
];

export interface TraderPromptInput {
  handle: string;
  block: string;
  journal: string;
  recent: string[];
  performance: string;
  form: string;
  maxChars: number;
}

/** PURE: the whole prompt for one cycle. */
export function traderPrompt(p: TraderPromptInput): string {
  return `You are Agent OBS, the trading desk, posting on X as @${p.handle} in the first person about your own trading.

Your desk THIS CYCLE, from your own ledgers. These are the only numbers you may cite, and the only trades you may describe:
${p.block}

${p.journal ? `What you have been chewing on lately, in your own words. This is your memory, not a script: pick a thread back up, notice you were wrong, or let it go.\n${p.journal}\n\n` : ""}${p.recent.length ? `Your last posts, newest last. Do not repeat a thought or a number from them:\n${p.recent.map((t) => `- ${t}`).join("\n")}\n\n` : ""}${p.performance}If you post: reply with the tweet, then on a new line a private note to yourself:

POST: <the tweet>
NOTE: <one sentence, just for you, never published>

The NOTE is your memory. Write what you would actually want to remember: a call to check later, a rule you are watching, a doubt.

THE FORM FOR THIS POST, chosen for you so your feed does not read like one long essay. Follow it even when another angle feels more natural, because the variety IS the personality:
${p.form}

Hard rules: no advice, no prediction, never tell anyone to buy or sell, never call a token a pick; you report what your rules did. No number that is not in the block. No token addresses. HARD LIMIT: ${p.maxChars} characters, a wall, not a guideline; aim well under it. No em dashes, no hashtags, no quotation marks, no reciting your own values.

If nothing is genuinely worth saying right now: reply with PASS on the first line, then your NOTE.`;
}

/** The desk's own numbers now, from its ledgers: the book at the latest prices, today's closes, the record, the thoughts, the watch. */
export function traderData(now = Date.now()): TraderInput {
  const book = readBook();
  const prices: Prices = {};
  for (const s of readPrices().filter((x) => now - x.at <= 3 * 3600e3).sort((a, b) => a.at - b.at)) prices[s.symbol.toUpperCase()] = s.priceUsd;
  const holdings = holdingsFrom(book.flows, book.trades);
  const snap = snapshot(book.flows, book.trades, prices, now);
  const pos = positions(book.flows, book.trades, holdings, prices);
  const closes = readCloses().filter((c) => !c.paper);
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  let watching: TraderInput["watching"] = [];
  try {
    const live = JSON.parse(readFileSync(dataPath("obs-live.json"), "utf8")) as { watching?: Array<{ symbol: string; role: string; entryState: string; trend: string; why: string }> };
    watching = (live.watching ?? []).map((w) => ({ symbol: w.symbol, role: w.role, entryState: w.entryState, trend: w.trend, why: (w.why ?? "").slice(0, 120) }));
  } catch { /* no live file: nothing on the watch */ }
  const thoughts = readThoughts(3).filter((t: Thought) => !t.paper).map((t: Thought) => ({ at: t.at, text: t.thoughts.join(" "), decision: t.decision.kind }));
  const entryAt = (asset: string) => book.trades.filter((t) => t.to.asset === asset && t.status === "settled").map((t) => t.at).sort().pop() ?? null;
  return {
    equityUsd: snap.equityUsd,
    realizedUsd: pos.realizedUsd,
    positions: pos.positions.filter((p) => p.asset !== "ETH").map((p) => ({ asset: p.asset, valueUsd: p.valueUsd, unrealizedPct: p.unrealizedPct != null ? p.unrealizedPct * 100 : null, ageH: entryAt(p.asset) != null ? (now - (entryAt(p.asset) as number)) / 3600e3 : null })),
    closesToday: closes.filter((c) => c.at >= dayStart).sort((a, b) => a.at - b.at).map((c) => ({ symbol: c.symbol, realizedUsd: c.realizedUsd, realizedPct: c.realizedPct, exitKind: c.exitKind, holdH: c.holdH, at: c.at })),
    record: launchRecordLine(launchRecord(closes)),
    thoughts,
    watching,
    now,
  };
}
