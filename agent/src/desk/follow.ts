// A wallet's own trading agent, controlled from the console: /start, /stop, /size, /agent. It never decides a trade
// of its own. It follows Agent OBS: every entry and every exit the house desk makes after the moment it was turned
// on is mirrored at the wallet's size. Live, it trades real ETH from the agent's own derived wallet (mirror.ts);
// on paper, the book is real and the trades are the desk's real trades at the desk's fill price, and no money
// moves. The same commands run both; the console says which it is.
//
// Pure where it matters: the state is a replay of the wallet's rows, the mirrored book is a pure function of the
// desk's trades, so both are tested offline. One ledger row per command, appended, never rewritten.
import { appendLedger, readLedger } from "../ledger.ts";
import { latestTrades, positions, type Trade, type Prices, type Positions } from "./book.ts";

const FILE = "obs-follow.jsonl";
/** What a wallet's agent trades per entry when it says nothing else, in dollars. */
export const DEFAULT_SIZE_USD = 100;
export const MIN_SIZE_USD = 10;

export type FollowMode = "paper" | "live";

export interface FollowRow {
  address: string;
  at: number;
  action: "start" | "stop" | "size";
  sizeUsd?: number;
  /** On a start row: paper (the default) or live, real ETH from the agent's own wallet. */
  mode?: FollowMode;
}

export interface FollowState {
  on: boolean;
  sizeUsd: number;
  /** When the agent was last turned on; entries before it are not its business. */
  since: number | null;
  /** When it was last turned off; no entries after it, but the exits of what it still holds keep mirroring. */
  stoppedAt: number | null;
  /** How it trades: on paper, or live from its own wallet. Set when it is turned on. */
  mode: FollowMode;
}

/** PURE: the wallet's agent as its rows leave it: on or off, its size, its mode, when it was turned on or off. */
export function followState(rows: FollowRow[], address: string): FollowState {
  const a = address.toLowerCase();
  const s: FollowState = { on: false, sizeUsd: DEFAULT_SIZE_USD, since: null, stoppedAt: null, mode: "paper" };
  for (const r of rows.filter((x) => x && x.address === a).sort((x, y) => x.at - y.at)) {
    if (r.action === "start") {
      const mode: FollowMode = r.mode === "live" ? "live" : "paper";
      // A start in the other mode is a fresh start: what a paper agent held is not what a live one holds.
      if (!s.on || s.mode !== mode) { s.on = true; s.since = r.at; s.stoppedAt = null; s.mode = mode; }
      if (r.sizeUsd != null && r.sizeUsd >= MIN_SIZE_USD) s.sizeUsd = r.sizeUsd;
    } else if (r.action === "stop") {
      if (s.on) { s.on = false; s.stoppedAt = r.at; }
    } else if (r.action === "size" && r.sizeUsd != null && r.sizeUsd >= MIN_SIZE_USD) {
      s.sizeUsd = r.sizeUsd;
    }
  }
  return s;
}

/**
 * PURE: the most an agent may put into one entry: OBS_FOLLOW_MAX_USD when the operator set one, else what the desk
 * itself trades. Its own switch because a person's size is theirs to choose, and the desk's ticket is a rail on the
 * house book, not on theirs; the pools are still the pools, so the operator raises it with the depth in mind.
 */
export function followMaxUsd(deskMaxUsd: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.OBS_FOLLOW_MAX_USD);
  return Number.isFinite(v) && v >= MIN_SIZE_USD ? Math.round(v) : deskMaxUsd;
}

/** PURE: a size the console will accept: whole dollars from the floor up to the cap, or the reason. */
export function checkSize(raw: unknown, maxUsd: number): { sizeUsd: number } | { error: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) return { error: `Say a size in dollars: /size 100 (from $${MIN_SIZE_USD} up to $${maxUsd} a trade).` };
  if (n < MIN_SIZE_USD) return { error: `The smallest size is $${MIN_SIZE_USD} a trade.` };
  if (n > maxUsd) return { error: `The largest size here is $${maxUsd} a trade.` };
  return { sizeUsd: Math.round(n) };
}

const isBase = (asset: string) => /^(ETH|USDG|USDC|USDT|DAI)$/i.test(asset);

/**
 * PURE: the desk's trades mirrored at the wallet's size. An entry the desk made while the agent was on becomes the
 * same entry scaled to the size; an exit the desk made of a token the agent holds sells the same share of the
 * agent's holding, whenever it comes, so a stopped agent is never left holding what the desk sold. The desk's fill
 * price is the agent's, which is what a paper book can honestly claim.
 */
export function mirrorTrades(deskTrades: Trade[], state: FollowState): Trade[] {
  if (state.since == null) return [];
  const rows = latestTrades(deskTrades).filter((t) => t.status === "settled").sort((a, b) => a.at - b.at);
  const deskHeld: Record<string, number> = {};
  const mine: Record<string, number> = {};
  const out: Trade[] = [];
  for (const t of rows) {
    const from = t.from.asset.toUpperCase();
    const to = t.to.asset.toUpperCase();
    const isEntry = !t.exit && isBase(from) && !isBase(to);
    const isExit = !!t.exit || (!isBase(from) && isBase(to));
    const before = deskHeld[from] ?? 0;
    if (isEntry) deskHeld[to] = (deskHeld[to] ?? 0) + t.to.amount;
    if (isExit) deskHeld[from] = Math.max(0, before - t.from.amount);
    if (t.at < state.since) continue;
    if (isEntry) {
      const inWindow = state.on || (state.stoppedAt != null && t.at <= state.stoppedAt);
      const deskUsd = t.from.usd ?? t.to.usd;
      if (!inWindow || deskUsd == null || deskUsd <= 0) continue;
      const scale = state.sizeUsd / deskUsd;
      mine[to] = (mine[to] ?? 0) + t.to.amount * scale;
      out.push({ ...t, id: `f-${t.id}`, from: { ...t.from, amount: t.from.amount * scale, usd: state.sizeUsd }, to: { ...t.to, amount: t.to.amount * scale, usd: t.to.usd == null ? null : t.to.usd * scale }, note: `your agent followed the desk's entry (${t.id})` });
    } else if (isExit) {
      const held = mine[from] ?? 0;
      if (!(held > 0) || !(before > 0)) continue;
      const share = Math.min(1, t.from.amount / before);
      const sold = held * share;
      const ratio = sold / t.from.amount;
      mine[from] = held - sold;
      out.push({ ...t, id: `f-${t.id}`, exit: true, from: { ...t.from, amount: sold, usd: t.from.usd == null ? null : t.from.usd * ratio }, to: { ...t.to, amount: t.to.amount * ratio, usd: t.to.usd == null ? null : t.to.usd * ratio }, note: `your agent followed the desk's exit (${t.id})` });
    }
  }
  return out;
}

/** PURE: what the agent holds after its mirrored trades, tokens only; the base leg is not a position on a paper book. */
export function mirrorHoldings(mirrored: Trade[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const t of mirrored) {
    const from = t.from.asset.toUpperCase();
    const to = t.to.asset.toUpperCase();
    if (!isBase(to)) h[to] = (h[to] ?? 0) + t.to.amount;
    if (!isBase(from)) h[from] = (h[from] ?? 0) - t.from.amount;
  }
  for (const k of Object.keys(h)) if (!(h[k] > 1e-9)) delete h[k];
  return h;
}

export interface FollowBook {
  state: FollowState;
  trades: Trade[];
  positions: Positions;
  /** What the agent could not do, latest last: an entry skipped for want of ETH, a refused rail, a revert. Live only. */
  notes?: string[];
  /** The ETH the agent's own wallet holds, read on chain. Live only. */
  walletEth?: number | null;
}

/** PURE: the agent's paper book at these prices: the desk's own accounting on the mirrored trades. */
export function followBook(deskTrades: Trade[], state: FollowState, prices: Prices): FollowBook {
  const trades = mirrorTrades(deskTrades, state);
  return { state, trades, positions: positions([], trades, mirrorHoldings(trades), prices) };
}

// ---- Live: the agent's real rows, from its own wallet, one ledger for every agent. ----

export interface FollowTradeRow extends Trade { address: string; deskId: string }
export interface FollowNote { address: string; at: number; deskId: string; note: string }
const TRADES_FILE = "obs-follow-trades.jsonl";
const NOTES_FILE = "obs-follow-notes.jsonl";

export const readFollowTrades = (): FollowTradeRow[] => readLedger<FollowTradeRow>(TRADES_FILE);
export const readFollowNotes = (): FollowNote[] => readLedger<FollowNote>(NOTES_FILE);
/** An agent's trade row into its ledger; false when the ledger did not take it, which the pool lane raises as an alarm. */
export function recordFollowTrade(address: string, deskId: string, t: Trade): boolean {
  return appendLedger(TRADES_FILE, { ...t, address: address.toLowerCase(), deskId } as unknown as Record<string, unknown>);
}
export function recordFollowNote(address: string, deskId: string, note: string, now = Date.now()): void {
  appendLedger(NOTES_FILE, { address: address.toLowerCase(), at: now, deskId, note });
}

/** PURE: this agent's real trades, the latest row per id, settled or in flight, oldest first. */
export function liveTrades(rows: FollowTradeRow[], address: string): Trade[] {
  const a = address.toLowerCase();
  return latestTrades(rows.filter((r) => r && r.address === a)).filter((t) => t.status === "settled" || t.status === "pending").sort((x, y) => x.at - y.at);
}

/**
 * PURE: what this agent holds from its real trades, tokens only. A buy whose receipt had not landed when its row
 * was written still counts: the token is on its way, and the desk's exit must find it, so the chain balance decides
 * the amount and this only decides who is asked.
 */
export function liveHoldings(rows: FollowTradeRow[], address: string): Record<string, number> {
  return mirrorHoldings(liveTrades(rows, address));
}

/** PURE: the agent's live book at these prices: the desk's own accounting on the agent's real rows. */
export function liveBook(address: string, state: FollowState, rows: FollowTradeRow[], notes: FollowNote[], prices: Prices, walletEth: number | null): FollowBook {
  const trades = liveTrades(rows, address);
  const a = address.toLowerCase();
  const mine = notes.filter((n) => n.address === a && (state.since == null || n.at >= state.since)).sort((x, y) => x.at - y.at).slice(-3).map((n) => n.note);
  return { state, trades, positions: positions([], trades, liveHoldings(rows, address), prices), notes: mine, walletEth };
}

const usd = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
const clock = (ts: number) => new Date(ts).toISOString().slice(11, 16) + "Z";

/** PURE: the agent's standing, for the console: on or off, size, what it holds, what it has made. */
export function followLines(b: FollowBook, now: number): string[] {
  const s = b.state;
  if (!s.on && !b.trades.length) {
    return [
      "Your agent is off.",
      `/start turns it on: from that moment it follows every trade Agent OBS makes, at your size ($${s.sizeUsd} a trade), live from its own wallet once you fund it. /start 150 sets the size as it starts.`,
    ];
  }
  const live = s.mode === "live";
  const head = s.on
    ? (live
      ? `Your agent is on, LIVE: real ETH from its own wallet, following Agent OBS since ${clock(s.since as number)}, $${s.sizeUsd} a trade.`
      : `Your agent is on, paper, following Agent OBS since ${clock(s.since as number)}, $${s.sizeUsd} a trade.`)
    : `Your agent is off since ${clock(s.stoppedAt as number)}; it still sells what it holds${live ? ", live," : ""} when the desk does. $${s.sizeUsd} a trade when it is on.`;
  const lines = [head];
  if (live && b.walletEth != null) lines.push(`  its wallet holds ${b.walletEth.toFixed(5)} ETH. /wallet shows it; /fund adds to it; /withdraw takes it back.`);
  const pos = b.positions.positions;
  if (pos.length) {
    for (const p of pos) lines.push(`  holding ${p.asset} ${p.valueUsd != null ? usd(p.valueUsd) : "unpriced"}${p.unrealizedPct != null ? ` (${pct(p.unrealizedPct)})` : ""}`);
  } else if (s.on && !b.trades.length) {
    const mins = Math.max(0, Math.round((now - (s.since as number)) / 60000));
    lines.push(`  no position yet: the desk has made no entry in the ${mins} min since you started. Its next one is yours too.`);
  } else if (s.on) {
    lines.push("  no open position right now. The desk's next entry is yours too.");
  }
  const exits = b.trades.filter((t) => t.exit).length;
  if (b.trades.length) lines.push(`  ${b.trades.length - exits} entr${b.trades.length - exits === 1 ? "y" : "ies"}, ${exits} exit${exits === 1 ? "" : "s"}, realized ${usd(b.positions.realizedUsd)} since you started.`);
  for (const n of b.notes ?? []) lines.push(`  note: ${n}`);
  lines.push(s.on ? "  /stop turns it off. /size changes what it trades. /desk shows the desk it follows." : "  /start turns it back on.");
  return lines;
}

// ---- The agent speaking: what it did and why, in the console, as it happens. ----

export interface FollowEvent { at: number; kind: "entry" | "exit" | "note"; text: string }

/** PURE: the desk's reason for a row of its own: an entry's thesis from the entry ledger, an exit's rule from its note. */
export function deskReason(deskTrade: Trade | undefined, entries: Array<{ at: number; symbol: string; reason: string }>): string | null {
  if (!deskTrade) return null;
  if (deskTrade.exit) {
    const m = /^exit \(([^)]+)\), ([^;]+)/.exec(deskTrade.note ?? "");
    return m ? m[2].trim() : null;
  }
  const sym = deskTrade.to.asset.toUpperCase();
  const e = entries.filter((x) => x.symbol.toUpperCase() === sym && Math.abs(x.at - deskTrade.at) < 15 * 60_000).sort((x, y) => Math.abs(x.at - deskTrade.at) - Math.abs(y.at - deskTrade.at))[0];
  return e?.reason?.trim() || null;
}

/**
 * PURE: the agent's own account of itself since a moment: each trade it made (or mirrored on paper), each one it
 * sat out or was refused, in the first person, with the desk's reason beside it when there is one. Newest last.
 */
export function followEvents(state: FollowState, trades: Trade[], notes: FollowNote[], deskById: (id: string) => Trade | undefined, entries: Array<{ at: number; symbol: string; reason: string }>, since: number): FollowEvent[] {
  const live = state.mode === "live";
  const out: FollowEvent[] = [];
  const eth = (n: number | null | undefined) => (n == null ? "?" : n.toFixed(4));
  const dollars = (n: number | null | undefined) => (n == null ? "" : ` ($${n.toFixed(2)})`);
  for (const t of trades) {
    const at = t.updatedAt ?? t.at;
    if (at <= since) continue;
    const deskId = (t as Partial<FollowTradeRow>).deskId ?? t.id.replace(/^f-/, "");
    const why = deskReason(deskById(deskId), entries);
    if (!t.exit) {
      const how = live ? `${eth(t.from.amount)} ETH${dollars(t.from.usd)} from my wallet, ${t.status === "settled" ? "landed" : "sent, waiting for the chain"}` : `$${(t.from.usd ?? 0).toFixed(0)} on paper at the desk's price`;
      out.push({ at, kind: "entry", text: `Followed Agent OBS into ${t.to.asset}: ${how}.${why ? ` The desk's reason: ${why}` : ""}` });
    } else {
      const how = live ? `${eth(t.to.amount)} ETH${dollars(t.to.usd)} back to my wallet, ${t.status === "settled" ? "landed" : "sent"}` : `$${(t.to.usd ?? 0).toFixed(2)} back on paper`;
      out.push({ at, kind: "exit", text: `Sold my ${t.from.asset} with the desk: ${how}.${why ? ` The desk's reason: ${why}` : ""}` });
    }
  }
  for (const n of notes) {
    if (n.at <= since) continue;
    const skipped = /skipped/.test(n.note);
    out.push({ at: n.at, kind: "note", text: skipped ? `Sat this one out. ${n.note.replace(/^entry of (\S+) skipped: /, (_, s) => `The desk entered ${s}; `)}` : `Couldn't follow the desk: ${n.note}` });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function readFollow(): FollowRow[] {
  return readLedger<FollowRow>(FILE);
}

export function recordFollow(address: string, action: FollowRow["action"], sizeUsd?: number, now = Date.now(), mode?: FollowMode): FollowState {
  appendLedger(FILE, { address: address.toLowerCase(), at: now, action, ...(sizeUsd != null ? { sizeUsd } : {}), ...(mode ? { mode } : {}) });
  return followState(readFollow(), address);
}
