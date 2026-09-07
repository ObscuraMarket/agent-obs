// What the desk learned from its own token trades. Every entry into a
// launch token is recorded with its setup (source, grade, tier, ignition
// minute, hour of day, the argued reason), every close with its result
// (hours held, realized, peak, how it left). When a like setup appears the
// nearest past trades are recalled into the observation, and the launch
// record as a whole rides alongside. Paper trades count, marked as paper,
// so a paper week teaches him too.
import { appendLedger, readLedger } from "../ledger.ts";
import { latestTrades, isHolding, type Trade } from "./book.ts";

export const ENTRIES_LEDGER = "obs-trade-entries.jsonl";
export const CLOSES_LEDGER = "obs-trade-memory.jsonl";

export interface TradeEntry {
  at: number;
  symbol: string;
  token: string;
  source: string;
  grade: "A" | "B" | "C" | null;
  tierPct: number;
  ignitedAfterMin: number | null;
  /** "curve" or "side pool". */
  via: string;
  usd: number;
  reason: string;
  paper: boolean;
}
export interface TradeClose {
  at: number;
  symbol: string;
  token: string;
  source: string;
  grade: "A" | "B" | "C" | null;
  tierPct: number;
  ignitedAfterMin: number | null;
  via: string;
  enteredAt: number;
  holdH: number;
  usdIn: number;
  realizedUsd: number;
  realizedPct: number | null;
  peakPct: number | null;
  /** "time-stop", "floor", "volume", "tape", "trail", "take-profit", "model". */
  exitKind: string;
  paper: boolean;
  /** On a row that replaces an earlier one: what was recomputed, and what the first row said. */
  corrected?: string;
  /** The key (symbol:enteredAt:real|paper) of the row this one replaces, so a recomputation that moved the entry time still retires the old row. */
  replaces?: string;
}

export const readEntries = (): TradeEntry[] => readLedger<TradeEntry>(ENTRIES_LEDGER).filter((e) => e && e.symbol && Number.isFinite(Number(e.at)));
/** PURE: the key a close is known by: one position, real or paper. */
export const closeKey = (c: Pick<TradeClose, "symbol" | "enteredAt" | "paper">): string => `${c.symbol}:${c.enteredAt}:${c.paper ? "paper" : "real"}`;

/** PURE: one row per close, the last written wins, so a corrected row for the same entry replaces the first; a row that names the row it replaces retires that one too. */
export function dedupeCloses(rows: TradeClose[]): TradeClose[] {
  const byKey = new Map<string, TradeClose>();
  for (const c of rows) {
    if (!(c && c.symbol && Number.isFinite(Number(c.at)))) continue;
    if (c.replaces) byKey.delete(c.replaces);
    byKey.set(closeKey(c), c);
  }
  return [...byKey.values()].sort((a, b) => a.at - b.at);
}
export const readCloses = (): TradeClose[] => dedupeCloses(readLedger<TradeClose>(CLOSES_LEDGER));
export const recordEntry = (e: TradeEntry): void => appendLedger(ENTRIES_LEDGER, e as unknown as Record<string, unknown>);
export const recordClose = (c: TradeClose): void => appendLedger(CLOSES_LEDGER, c as unknown as Record<string, unknown>);

export interface Setup {
  source: string;
  grade: "A" | "B" | "C" | null;
  tierPct: number;
  ignitedAfterMin: number | null;
  via: string;
  hourUtc: number;
}

/** PURE: how alike two setups are, 0 to 1. Source and grade weigh most; tier, ignition speed and time of day refine. */
export function similarity(a: Setup, b: Setup): number {
  let s = 0;
  if (a.source === b.source) s += 0.3;
  if (a.grade === b.grade) s += 0.25;
  if (a.via === b.via) s += 0.1;
  s += 0.15 * Math.max(0, 1 - Math.abs(a.tierPct - b.tierPct) / 3);
  if (a.ignitedAfterMin != null && b.ignitedAfterMin != null) s += 0.1 * Math.max(0, 1 - Math.abs(a.ignitedAfterMin - b.ignitedAfterMin) / 15);
  const dh = Math.min(Math.abs(a.hourUtc - b.hourUtc), 24 - Math.abs(a.hourUtc - b.hourUtc));
  s += 0.1 * Math.max(0, 1 - dh / 6);
  return Math.min(1, s);
}

/** PURE: the closest past trades to a setup, best first. */
export function recallLike(setup: Setup, closes: TradeClose[], k = 3): Array<{ close: TradeClose; score: number }> {
  return closes
    .map((close) => ({ close, score: similarity(setup, { source: close.source, grade: close.grade, tierPct: close.tierPct, ignitedAfterMin: close.ignitedAfterMin, via: close.via, hourUtc: new Date(close.enteredAt).getUTCHours() }) }))
    .filter((x) => x.score >= 0.4)
    .sort((a, b) => b.score - a.score || b.close.at - a.close.at)
    .slice(0, k);
}

/** PURE: one recalled trade as a line he can read. */
export function recallLine(c: TradeClose): string {
  const pct = c.realizedPct == null ? "" : ` (${c.realizedPct >= 0 ? "+" : ""}${c.realizedPct.toFixed(0)}%)`;
  return `${c.symbol}${c.paper ? " (paper)" : ""}: ${c.source}, grade ${c.grade ?? "none"}, ${c.tierPct}% tier, ${c.ignitedAfterMin != null ? `ignited at +${c.ignitedAfterMin} min` : "no ignition"}, in via ${c.via} for $${c.usdIn.toFixed(0)}, held ${c.holdH.toFixed(1)}h${c.peakPct != null ? `, peaked ${c.peakPct >= 0 ? "+" : ""}${c.peakPct.toFixed(0)}%` : ""}, left on ${c.exitKind}, ${c.realizedUsd >= 0 ? "+" : "-"}$${Math.abs(c.realizedUsd).toFixed(2)}${pct}`;
}

export interface LaunchRecord {
  trades: number;
  wins: number;
  losses: number;
  realizedUsd: number;
  avgHoldH: number | null;
  byExit: Record<string, number>;
  byGrade: Record<string, { trades: number; realizedUsd: number }>;
  paperTrades: number;
}

/** PURE: the launch record as a whole. */
export function launchRecord(closes: TradeClose[]): LaunchRecord {
  const byExit: Record<string, number> = {};
  const byGrade: Record<string, { trades: number; realizedUsd: number }> = {};
  for (const c of closes) {
    byExit[c.exitKind] = (byExit[c.exitKind] ?? 0) + 1;
    const g = c.grade ?? "none";
    byGrade[g] = { trades: (byGrade[g]?.trades ?? 0) + 1, realizedUsd: (byGrade[g]?.realizedUsd ?? 0) + c.realizedUsd };
  }
  return {
    trades: closes.length,
    wins: closes.filter((c) => c.realizedUsd > 0).length,
    losses: closes.filter((c) => c.realizedUsd < 0).length,
    realizedUsd: closes.reduce((s, c) => s + c.realizedUsd, 0),
    avgHoldH: closes.length ? closes.reduce((s, c) => s + c.holdH, 0) / closes.length : null,
    byExit,
    byGrade,
    paperTrades: closes.filter((c) => c.paper).length,
  };
}

/** PURE: the launch record as one line. */
export function launchRecordLine(r: LaunchRecord): string {
  if (!r.trades) return "Launch record: no closed launch trades yet.";
  const grades = Object.entries(r.byGrade).map(([g, v]) => `grade ${g} ${v.trades} for ${v.realizedUsd >= 0 ? "+" : "-"}$${Math.abs(v.realizedUsd).toFixed(2)}`).join(", ");
  const exits = Object.entries(r.byExit).map(([k, n]) => `${n} on ${k}`).join(", ");
  return `Launch record: ${r.trades} closed (${r.paperTrades} paper), ${r.wins} wins, ${r.losses} losses, ${r.realizedUsd >= 0 ? "+" : "-"}$${Math.abs(r.realizedUsd).toFixed(2)} realized, average hold ${r.avgHoldH?.toFixed(1) ?? "?"}h; ${grades}; exits ${exits}.`;
}

// ---- A close, computed from the position's own trades ----
//
// A close was once written as the book's running realized on the token plus the exit's dollar value, and an exit
// the model ordered came back with no dollar value on its ETH leg (the route never passed the ETH/USDG pool, so
// the quote could not price ETH). A sell that brought back more ETH than went out then read as a full loss, and a
// second round trip in the same token inherited the first one's result. Here the result is what the ledger says:
// the ETH spent on the span's buys against the ETH its sells brought back, each leg priced at ETH's price at that
// moment.

const STABLES = new Set(["USDG", "USDC", "USDT", "DAI"]);

export interface PositionSpan {
  symbol: string;
  /** The first buy into an empty wallet. */
  enteredAt: number;
  /** When the sell that emptied it settled; null while the token is still held. */
  exitedAt: number | null;
  entries: Trade[];
  exits: Trade[];
}

/**
 * PURE: when the position held right now was opened: the first buy of the span still open, or null when the token is
 * not held. The exits' peak, age and take-profit memory start here, never at a round trip closed earlier: measured
 * from an old position's peak, a fresh entry trailed out twenty seconds after it was made (2026-09-07, PENGUIN).
 */
export function openSpanStart(trades: Trade[], symbol: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const spans = positionSpans(trades, symbol, env);
  const last = spans[spans.length - 1];
  return last && last.exitedAt == null ? last.enteredAt : null;
}

/**
 * PURE: a token's round trips from the trade ledger, oldest first: each span runs from the first settled buy into an
 * empty wallet to the settled sell that emptied it again (dust aside). The last span may still be open.
 */
export function positionSpans(trades: Trade[], symbol: string, env: NodeJS.ProcessEnv = process.env): PositionSpan[] {
  const rows = latestTrades(trades).filter((t) => t.status === "settled" && (t.to.asset === symbol || (t.from.asset === symbol && t.exit))).sort((a, b) => a.at - b.at);
  const out: PositionSpan[] = [];
  let cur: PositionSpan | null = null;
  let qty = 0;
  let bought = 0;
  for (const t of rows) {
    if (t.to.asset === symbol) {
      if (!cur) cur = { symbol, enteredAt: t.at, exitedAt: null, entries: [], exits: [] };
      cur.entries.push(t);
      qty += t.to.amount;
      bought += t.to.amount;
    } else {
      if (!cur) continue; // a sell of something the ledger never saw bought is not a round trip
      cur.exits.push(t);
      qty -= t.from.amount;
      // Emptied: below the dust line, or within float error of everything bought (a sell names the wallet's balance as a float).
      if (!isHolding(qty, env) || qty <= bought * 1e-8) {
        cur.exitedAt = t.updatedAt ?? t.at;
        out.push(cur);
        cur = null;
        qty = 0;
        bought = 0;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** PURE: ETH's dollar price at a moment, from the desk's own samples: the nearest one within three hours, else the fallback. */
export function ethUsdAt(samples: Array<{ at: number; symbol: string; priceUsd: number }>, fallback: number | null = null): (at: number) => number | null {
  const eth = samples.filter((s) => s.symbol === "ETH" && s.priceUsd > 0);
  return (at) => {
    let best: { at: number; priceUsd: number } | null = null;
    for (const s of eth) if (best == null || Math.abs(s.at - at) < Math.abs(best.at - at)) best = s;
    return best && Math.abs(best.at - at) <= 3 * 3600e3 ? best.priceUsd : fallback;
  };
}

export interface CloseResult {
  usdIn: number;
  usdOut: number;
  realizedUsd: number;
  realizedPct: number | null;
  holdH: number;
  /** Sells whose return could not be priced at all; they count as nothing back. */
  unpricedLegs: number;
}

/**
 * PURE: what a span made, in dollars: the ETH spent on its buys against what its sells brought back. A sell's return
 * is its priced ETH leg; failing that its ETH at ETH's price at the time; failing that the token's marked value on
 * the way out. Dollars in fall back to the entry the desk recorded when a buy carries no dollar value.
 */
export function closeFromSpan(span: PositionSpan, ethAt: (at: number) => number | null, now = Date.now(), fallbackUsdIn: number | null = null): CloseResult {
  const value = (asset: string, amount: number, at: number): number | null => {
    if (asset === "ETH") { const p = ethAt(at); return p != null ? amount * p : null; }
    return STABLES.has(asset) ? amount : null;
  };
  let usdIn = 0;
  for (const t of span.entries) usdIn += t.from.usd ?? value(t.from.asset, t.from.amount, t.at) ?? 0;
  if (!(usdIn > 0) && fallbackUsdIn != null && fallbackUsdIn > 0) usdIn = fallbackUsdIn;
  let usdOut = 0;
  let unpricedLegs = 0;
  for (const t of span.exits) {
    const v = t.to.usd ?? value(t.to.asset, t.to.amount, t.updatedAt ?? t.at) ?? t.from.usd;
    if (v == null) unpricedLegs++;
    else usdOut += v;
  }
  const realizedUsd = usdOut - usdIn;
  return { usdIn, usdOut, realizedUsd, realizedPct: usdIn > 0 ? (realizedUsd / usdIn) * 100 : null, holdH: ((span.exitedAt ?? now) - span.enteredAt) / 3600e3, unpricedLegs };
}

/** PURE: the entry the desk recorded for a span: the latest one for the symbol that landed between its first buy and its last sell; failing that, the latest for the symbol. */
export function entryForSpan(entries: TradeEntry[], span: PositionSpan, paper: boolean, now = Date.now()): TradeEntry | undefined {
  const mine = entries.filter((e) => e.symbol === span.symbol && e.paper === paper).sort((a, b) => b.at - a.at);
  const end = (span.exitedAt ?? now) + 60e3;
  return mine.find((e) => e.at >= span.enteredAt - 5 * 60e3 && e.at <= end) ?? mine[0];
}

/** PURE: the close row for a span: its setup from the entry, its result from the ledger. */
export function closeRow(span: PositionSpan, entry: TradeEntry | undefined, r: CloseResult, token: string, peakPct: number | null, exitKind: string, paper: boolean, at: number): TradeClose {
  return {
    at,
    symbol: span.symbol,
    token,
    source: entry?.source ?? "unknown",
    grade: entry?.grade ?? null,
    tierPct: entry?.tierPct ?? 0,
    ignitedAfterMin: entry?.ignitedAfterMin ?? null,
    via: entry?.via ?? "unknown",
    enteredAt: span.enteredAt,
    holdH: r.holdH,
    usdIn: r.usdIn,
    realizedUsd: r.realizedUsd,
    realizedPct: r.realizedPct,
    peakPct,
    exitKind,
    paper,
  };
}

/**
 * PURE: the real closes the trade ledger contradicts, each as a row that replaces it: the span whose last sell
 * landed at or just before the row was written is recomputed, and a row is returned only when the entry time,
 * the dollars in or the result moved by a cent or more. Idempotent: once the rows agree, nothing is returned.
 */
export function reconcileCloses(closes: TradeClose[], trades: Trade[], entries: TradeEntry[], ethAt: (at: number) => number | null, now = Date.now(), env: NodeJS.ProcessEnv = process.env): TradeClose[] {
  const real = trades.filter((t) => !String(t.id).startsWith("paper-"));
  const spans = new Map<string, PositionSpan[]>();
  const out: TradeClose[] = [];
  for (const c of dedupeCloses(closes)) {
    if (c.paper) continue;
    if (!spans.has(c.symbol)) spans.set(c.symbol, positionSpans(real, c.symbol, env));
    const span = (spans.get(c.symbol) ?? []).filter((s) => s.exitedAt != null && s.exitedAt <= c.at + 5 * 60e3).sort((a, b) => (b.exitedAt as number) - (a.exitedAt as number))[0];
    if (!span) continue;
    const r = closeFromSpan(span, ethAt, now, c.usdIn);
    if (span.enteredAt === c.enteredAt && Math.abs(r.realizedUsd - c.realizedUsd) < 0.01 && Math.abs(r.usdIn - c.usdIn) < 0.01) continue;
    const sells = `${span.exits.length} sell${span.exits.length === 1 ? "" : "s"}`;
    out.push({
      ...c,
      enteredAt: span.enteredAt,
      holdH: r.holdH,
      usdIn: r.usdIn,
      realizedUsd: r.realizedUsd,
      realizedPct: r.realizedPct,
      corrected: `recomputed from the trade ledger: $${r.usdIn.toFixed(2)} in, $${r.usdOut.toFixed(2)} back over ${sells}${r.unpricedLegs ? ` (${r.unpricedLegs} unpriced)` : ""}; the first row said ${c.realizedUsd >= 0 ? "+" : "-"}$${Math.abs(c.realizedUsd).toFixed(2)}`,
      replaces: closeKey(c),
    });
  }
  return out;
}
