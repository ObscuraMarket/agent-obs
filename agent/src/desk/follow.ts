// A wallet's own trading agent, controlled from the console: /start, /stop, /size, /agent. It never decides a trade
// of its own. It follows Agent OBS: every entry and every exit the house desk makes after the moment it was turned
// on is mirrored on the wallet's own book at the wallet's size, at the desk's fill price. On paper for now: the
// book is real, the trades are the desk's real trades, and no money moves until the money path can sign for a
// second wallet. The same commands run the live version when it exists; the console says which it is.
//
// Pure where it matters: the state is a replay of the wallet's rows, the mirrored book is a pure function of the
// desk's trades, so both are tested offline. One ledger row per command, appended, never rewritten.
import { appendLedger, readLedger } from "../ledger.ts";
import { latestTrades, positions, type Trade, type Prices, type Positions } from "./book.ts";

const FILE = "obs-follow.jsonl";
/** What a wallet's agent trades per entry when it says nothing else, in dollars. */
export const DEFAULT_SIZE_USD = 100;
export const MIN_SIZE_USD = 10;

export interface FollowRow {
  address: string;
  at: number;
  action: "start" | "stop" | "size";
  sizeUsd?: number;
}

export interface FollowState {
  on: boolean;
  sizeUsd: number;
  /** When the agent was last turned on; entries before it are not its business. */
  since: number | null;
  /** When it was last turned off; no entries after it, but the exits of what it still holds keep mirroring. */
  stoppedAt: number | null;
  /** How it trades today. */
  mode: "paper";
}

/** PURE: the wallet's agent as its rows leave it: on or off, its size, when it was turned on or off. */
export function followState(rows: FollowRow[], address: string): FollowState {
  const a = address.toLowerCase();
  const s: FollowState = { on: false, sizeUsd: DEFAULT_SIZE_USD, since: null, stoppedAt: null, mode: "paper" };
  for (const r of rows.filter((x) => x && x.address === a).sort((x, y) => x.at - y.at)) {
    if (r.action === "start") {
      if (!s.on) { s.on = true; s.since = r.at; s.stoppedAt = null; }
      if (r.sizeUsd != null && r.sizeUsd >= MIN_SIZE_USD) s.sizeUsd = r.sizeUsd;
    } else if (r.action === "stop") {
      if (s.on) { s.on = false; s.stoppedAt = r.at; }
    } else if (r.action === "size" && r.sizeUsd != null && r.sizeUsd >= MIN_SIZE_USD) {
      s.sizeUsd = r.sizeUsd;
    }
  }
  return s;
}

/** PURE: a size the console will accept: whole dollars from the floor up to what the desk itself trades, or the reason. */
export function checkSize(raw: unknown, deskMaxUsd: number): { sizeUsd: number } | { error: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) return { error: `Say a size in dollars: /size 100 (from $${MIN_SIZE_USD} up to $${deskMaxUsd}, what the desk itself trades).` };
  if (n < MIN_SIZE_USD) return { error: `The smallest size is $${MIN_SIZE_USD} a trade.` };
  if (n > deskMaxUsd) return { error: `The largest size is $${deskMaxUsd} a trade, what the desk itself trades: a bigger paper fill at the desk's price would not be honest.` };
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
}

/** PURE: the agent's book at these prices: the desk's own accounting on the mirrored trades. */
export function followBook(deskTrades: Trade[], state: FollowState, prices: Prices): FollowBook {
  const trades = mirrorTrades(deskTrades, state);
  return { state, trades, positions: positions([], trades, mirrorHoldings(trades), prices) };
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
      `/start turns it on: from that moment it follows every trade Agent OBS makes, at your size ($${s.sizeUsd} a trade), on paper for now. /start 150 sets the size as it starts.`,
    ];
  }
  const head = s.on
    ? `Your agent is on, paper, following Agent OBS since ${clock(s.since as number)}, $${s.sizeUsd} a trade.`
    : `Your agent is off since ${clock(s.stoppedAt as number)}; it still sells what it holds when the desk does. $${s.sizeUsd} a trade when it is on.`;
  const lines = [head];
  const pos = b.positions.positions;
  if (pos.length) {
    for (const p of pos) lines.push(`  holding ${p.asset} ${p.valueUsd != null ? usd(p.valueUsd) : "unpriced"}${p.unrealizedPct != null ? ` (${pct(p.unrealizedPct)})` : ""}`);
  } else if (s.on) {
    const mins = Math.max(0, Math.round((now - (s.since as number)) / 60000));
    lines.push(`  no position yet: the desk has made no entry in the ${mins} min since you started. Its next one is yours too.`);
  }
  const exits = b.trades.filter((t) => t.exit).length;
  if (b.trades.length) lines.push(`  ${b.trades.length - exits} entr${b.trades.length - exits === 1 ? "y" : "ies"}, ${exits} exit${exits === 1 ? "" : "s"}, realized ${usd(b.positions.realizedUsd)} since you started.`);
  lines.push(s.on ? "  /stop turns it off. /size changes what it trades. /status shows the desk it follows." : "  /start turns it back on.");
  return lines;
}

export function readFollow(): FollowRow[] {
  return readLedger<FollowRow>(FILE);
}

export function recordFollow(address: string, action: FollowRow["action"], sizeUsd?: number, now = Date.now()): FollowState {
  appendLedger(FILE, { address: address.toLowerCase(), at: now, action, ...(sizeUsd != null ? { sizeUsd } : {}) });
  return followState(readFollow(), address);
}
