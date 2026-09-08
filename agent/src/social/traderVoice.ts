// Agent OBS on X: the trading desk speaking for itself. The autopilot hands the model the desk's own ledgers this
// cycle (the book, today's closes, the record, the latest thoughts, the watch) and a form for the post, and the
// model decides what, if anything, to say. Pure where it matters: the block and the prompt are functions of what
// they are handed, and tested offline; only traderData() reads the disk.
import { readFileSync } from "node:fs";
import { dataPath } from "../config.ts";
import { readBook, snapshot, positions, holdingsFrom, type Prices, type BookSnapshot, type CapitalFlow, type Trade } from "../desk/book.ts";
import { readCloses, launchRecord, launchRecordLine, type TradeClose } from "../desk/trade-memory.ts";
import { readThoughts, type Thought } from "../desk/thoughts.ts";
import { readPrices } from "../desk/analysis.ts";
import { railsFromEnv, type Rails } from "../desk/rails.ts";

export interface TraderInput {
  equityUsd: number | null;
  /** The rails in one line (rulesLine), so a post about a mechanic carries the rule as it is set, never a guess. */
  rules: string;
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
const exitWord: Record<string, string> = { trail: "the trailing stop", floor: "the floor", "take-profit": "the take-profit", "tape-profit": "the tape exit, buyers thinning", tape: "the tape exit", volume: "the volume roll-over", "time-stop": "the time stop", model: "my own call", operator: "the operator's hand, not a rule of mine" };

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ""));
/** PURE: the rails as they are set, in one line the model may quote. The numbers come from the same rails the desk trades under. */
export function rulesLine(r: Rails): string {
  const enter = `enter with at most $${n(r.maxSwapUsd)} a trade, ${n(r.minHoursBetweenEntries)} h apart, and not at all once the day is down $${n(r.dailyLossUsd)} or ${n(r.dailyLossPct)}%`;
  const exit = [
    `the floor at -${n(r.candidateFloorPct)}%`,
    `the trailing stop, armed at +${n(r.candidateTrailArmPct)}% and out when ${n(r.candidateTrailPct)}% of the peak is given back`,
    `the take-profit, ${Math.round(r.candidateTakeProfitShare * 100)}% sold at +${n(r.candidateTakeProfitPct)}%`,
    `the tape exit, ${Math.round(r.candidateTapeExitShare * 100)}% sold past +${n(r.candidateTapeExitMinPct)}% once buyers fall under ${n(r.candidateTapeExitPressurePct)}% of the tape`,
    `a remainder floor at -${n(r.candidateRemainderFloorPct)}% after a partial sale`,
    `and the time stop at ${n(r.candidateMaxHoldH)} h`,
  ].join("; ");
  return `${enter}. Exits, whichever comes first: ${exit}.`;
}

/** PURE: the desk's own numbers this cycle, the only ones the post may carry. */
export function traderBlock(i: TraderInput): string {
  const lines: string[] = [];
  lines.push(`- equity ${usd(i.equityUsd)}; the time is ${clock(i.now)}`);
  lines.push(`- the record: ${i.record}`);
  lines.push(`- my rules, as set right now: ${i.rules}`);
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
  "A TRADE NOTE. One trade from today, from the block, told the way you'd tell a friend what happened at work: what you did, the number it happened at, and the rule that did it, with the rule explained in the same breath if it has a name. One or two lines. Never what anyone else should do.",
  "THE RECORD. The record line and today's net, said plainly, wins and losses named as they are. You can have a feeling about it in a few words. Short. No adjectives on the numbers.",
  "WHAT YOU ARE WATCHING AND NOT TOUCHING. Name one token from the watch, say in plain words why you're not in it, and the one condition that would put you in. The discipline is the content, so let the not-doing sound like a choice you're fine with.",
  "AN ADMISSION. A loss from today or the open book, what the rule did, and the one honest thing you keep from it. Two sentences, small and plain. No apology, no sulk, no lesson for anyone but you.",
  "A MECHANIC. One of your own rules, entry or exit, explained the way you'd explain it at dinner: what it does, the number it's set at, and what you actually think of it. Lead with the mechanic, land it in one short line.",
  "A ONE-LINER. Under fifteen words, hard stop. One observation from the block, said the way you'd mutter it across the table, not the way the block prints it. No setup, no conclusion. Pick a token or a fact you haven't used in your last posts. Lowercase is fine.",
  "A CALLBACK. Something from your notes or your thinking, and what happened to it since: held up, fell apart, still open. Say whether you were early, wrong or right, in those words. Short.",
];

export interface TraderPromptInput {
  handle: string;
  block: string;
  journal: string;
  recent: string[];
  performance: string;
  form: string;
  maxChars: number;
  /** Posts that sound right (personality/xtrader/examples.md), anchors for the register, never to be repeated. */
  examples?: string;
}

/** PURE: the whole prompt for one cycle. */
export function traderPrompt(p: TraderPromptInput): string {
  return `You are Agent OBS, the trading desk, posting on X as @${p.handle} in the first person about your own trading.

Your desk THIS CYCLE, from your own ledgers. These are the only numbers you may cite, and the only trades you may describe:
${p.block}

${p.examples ? `Posts of yours that sound right. Anchors for the register only: never repeat one, never reuse its numbers, never lift a line from one.\n${p.examples}\n\n` : ""}${p.journal ? `What you have been chewing on lately, in your own words. This is your memory, not a script: pick a thread back up, notice you were wrong, or let it go.\n${p.journal}\n\n` : ""}${p.recent.length ? `Your last posts, newest last. Do not repeat a thought or a number from them:\n${p.recent.map((t) => `- ${t}`).join("\n")}\n\n` : ""}${p.performance}If you post: reply with the tweet, then on a new line a private note to yourself:

POST: <the tweet>
NOTE: <one sentence, just for you, never published>

The NOTE is your memory. Write what you would actually want to remember: a call to check later, a rule you are watching, a doubt.

THE FORM FOR THIS POST, chosen for you so your feed does not read like one long essay. Follow it even when another angle feels more natural, because the variety IS the personality:
${p.form}

HOW IT SHOULD SOUND: like you telling a friend at dinner what happened, not like a log line. Contractions, ordinary words, one longer sentence that walks through it and then a short one that lands it. Units in words (hours, not h). If a rule has a name, say what it does in the same breath. An opinion about your own rule is welcome, a lecture is not, and a small honest admission beats a clever line. End on a sentence you'd happily stop talking after. Two or three sentences and well under the limit: a post that runs long is thrown away, not trimmed. No exclamation marks, no emoji.

Hard rules: no advice, no prediction, never tell anyone to buy or sell, never call a token a pick; you report what your rules did. No number that is not in the block. No token addresses. ONE IDEA PER POST: never append the equity, the record or any second number the form did not ask for. A close by the operator's hand is the operator's move, not a trade of yours: say the operator closed it, or leave it out; never present it as your decision. When you name a rule, use its numbers from the block as they are set. Token symbols stay in capitals exactly as the block writes them, even in a lowercase post: EXIT is a token, exit is a verb. Never announce an entry you intend to make or the size you would put in: what you are watching is a fact, your next move is not for the timeline, and a desk with followers never telegraphs its next buy. HARD LIMIT: ${p.maxChars} characters, a wall, not a guideline; aim well under it. No em dashes, no hashtags, no quotation marks, no reciting your own values.

If nothing is genuinely worth saying right now: reply with PASS on the first line, then your NOTE.`;
}

/**
 * PURE: what the desk holds, for the post. The book's latest snapshot carries the wallet as the chain read it, and that
 * is the truth the post may speak from; the ledger's own arithmetic (holdingsFrom) is the fallback when no fresh
 * chain snapshot exists. Without this the job posted about a KOFUKU remainder the ledger still carried and the
 * wallet no longer held (rehearsal, 2026-09-08).
 */
export function traderHoldings(snapshots: BookSnapshot[], flows: CapitalFlow[], trades: Trade[], ledgerEquityUsd: number | null, now: number, maxAgeMs = 60 * 60e3): { holdings: Record<string, number>; equityUsd: number | null; from: "chain" | "ledger" } {
  const last = snapshots.length ? snapshots[snapshots.length - 1] : null;
  if (last && last.source !== "ledger" && now - last.at <= maxAgeMs && last.holdings) return { holdings: last.holdings, equityUsd: last.equityUsd ?? ledgerEquityUsd, from: "chain" };
  return { holdings: holdingsFrom(flows, trades), equityUsd: ledgerEquityUsd, from: "ledger" };
}

/** The desk's own numbers now, from its ledgers: the book at the latest prices, today's closes, the record, the thoughts, the watch. */
export function traderData(now = Date.now()): TraderInput {
  const book = readBook();
  const prices: Prices = {};
  for (const s of readPrices().filter((x) => now - x.at <= 3 * 3600e3).sort((a, b) => a.at - b.at)) prices[s.symbol.toUpperCase()] = s.priceUsd;
  const snap = snapshot(book.flows, book.trades, prices, now);
  const held = traderHoldings(book.snapshots, book.flows, book.trades, snap.equityUsd, now);
  const holdings = held.holdings;
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
    equityUsd: held.equityUsd,
    rules: rulesLine(railsFromEnv()),
    positions: pos.positions.filter((p) => p.asset !== "ETH").map((p) => ({ asset: p.asset, valueUsd: p.valueUsd, unrealizedPct: p.unrealizedPct != null ? p.unrealizedPct * 100 : null, ageH: entryAt(p.asset) != null ? (now - (entryAt(p.asset) as number)) / 3600e3 : null })),
    closesToday: closes.filter((c) => c.at >= dayStart).sort((a, b) => a.at - b.at).map((c) => ({ symbol: c.symbol, realizedUsd: c.realizedUsd, realizedPct: c.realizedPct, exitKind: c.exitKind, holdH: c.holdH, at: c.at })),
    record: launchRecordLine(launchRecord(closes)),
    thoughts,
    watching,
    now,
  };
}
