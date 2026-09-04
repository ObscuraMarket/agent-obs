// The analytical layer: more data points for the desk to reason from, and
// the rule that a swap must be argued from them. Price samples the desk takes
// itself each cycle (obs-prices.jsonl) become 24-hour moves, 7-day ranges,
// the typical 30-minute move and ETH-against-NVDA relative value; the US
// equity session says whether the Nasdaq print behind NVDA is live or
// paused (the token itself trades around the clock on chain). None of it is
// a signal on its own. It is the
// material the model must cite: a swap decision needs a thesis, at least a
// few evidence lines that each quote an observed figure, an invalidation,
// and high conviction, or it is a hold with the shortfall stated in public.
import { appendLedger, readLedger } from "../ledger.ts";

export const PRICES_LEDGER = "obs-prices.jsonl";

export interface PriceSample {
  at: number;
  symbol: string;
  priceUsd: number;
}
export function recordPrices(prices: Record<string, number | null>, at: number): void {
  for (const [symbol, p] of Object.entries(prices)) if (p != null && p > 0) appendLedger(PRICES_LEDGER, { at, symbol, priceUsd: p });
}
export function readPrices(): PriceSample[] {
  return readLedger<PriceSample>(PRICES_LEDGER).filter((r) => r && Number.isFinite(Number(r.at)) && typeof r.symbol === "string" && Number(r.priceUsd) > 0);
}

export interface PriceStats {
  symbol: string;
  samples: number;
  priceUsd: number | null;
  change24hPct: number | null;
  low7d: number | null;
  high7d: number | null;
  /** Where the price sits in its 7-day range, 0 at the low, 100 at the high. */
  rangePosPct: number | null;
  /** The typical absolute move between samples about 30 minutes apart over the last day, in percent. */
  move30mPct: number | null;
  /** Hours of history behind these figures. */
  historyH: number;
}

const H = 3600e3;

/** PURE: what one asset has done, from the desk's own samples. Nulls where the history is too short. */
export function priceStats(rows: PriceSample[], symbol: string, now: number): PriceStats {
  const s = rows.filter((r) => r.symbol === symbol && r.at <= now && r.at >= now - 7 * 24 * H).sort((a, b) => a.at - b.at);
  const last = s.length ? s[s.length - 1] : null;
  const out: PriceStats = { symbol, samples: s.length, priceUsd: last?.priceUsd ?? null, change24hPct: null, low7d: null, high7d: null, rangePosPct: null, move30mPct: null, historyH: s.length ? (now - s[0].at) / H : 0 };
  if (!last) return out;
  const dayAgo = s.filter((r) => r.at <= now - 24 * H);
  if (dayAgo.length) {
    const ref = dayAgo[dayAgo.length - 1];
    if (now - ref.at <= 26 * H) out.change24hPct = ((last.priceUsd - ref.priceUsd) / ref.priceUsd) * 100;
  }
  if (out.historyH >= 24 && s.length >= 12) {
    const ps = s.map((r) => r.priceUsd);
    out.low7d = Math.min(...ps);
    out.high7d = Math.max(...ps);
    out.rangePosPct = out.high7d > out.low7d ? ((last.priceUsd - out.low7d) / (out.high7d - out.low7d)) * 100 : 50;
  }
  const day = s.filter((r) => r.at >= now - 24 * H);
  const moves: number[] = [];
  for (let i = 1; i < day.length; i++) {
    const dt = day[i].at - day[i - 1].at;
    if (dt >= 20 * 60e3 && dt <= 90 * 60e3) moves.push(Math.abs(Math.log(day[i].priceUsd / day[i - 1].priceUsd)) * 100);
  }
  if (moves.length >= 6) {
    const mean = moves.reduce((a, b) => a + b, 0) / moves.length;
    const sd = Math.sqrt(moves.reduce((a, b) => a + (b - mean) ** 2, 0) / moves.length);
    out.move30mPct = mean + sd;
  }
  return out;
}

export interface RatioStats {
  /** Units of `quote` one unit of `base` buys, now. */
  ratioNow: number | null;
  avg7d: number | null;
  /** Now against the 7-day average, in percent; positive means `base` is rich against `quote`. */
  deviationPct: number | null;
}

/** PURE: relative value of two assets from paired samples (same cycle, within 5 minutes). */
export function ratioStats(rows: PriceSample[], base: string, quote: string, now: number): RatioStats {
  const a = rows.filter((r) => r.symbol === base && r.at >= now - 7 * 24 * H).sort((x, y) => x.at - y.at);
  const b = rows.filter((r) => r.symbol === quote && r.at >= now - 7 * 24 * H).sort((x, y) => x.at - y.at);
  const ratios: Array<{ at: number; r: number }> = [];
  let j = 0;
  for (const x of a) {
    while (j < b.length && b[j].at < x.at - 5 * 60e3) j++;
    const y = b[j];
    if (y && Math.abs(y.at - x.at) <= 5 * 60e3) ratios.push({ at: x.at, r: x.priceUsd / y.priceUsd });
  }
  if (ratios.length < 2) return { ratioNow: ratios[0]?.r ?? null, avg7d: null, deviationPct: null };
  const avg = ratios.reduce((s, x) => s + x.r, 0) / ratios.length;
  const nowR = ratios[ratios.length - 1].r;
  return { ratioNow: nowR, avg7d: avg, deviationPct: ((nowR - avg) / avg) * 100 };
}

export interface Session {
  open: boolean;
  /** "open", "pre-market", "after-hours", "weekend". Holidays are not tracked. */
  label: string;
  /** Minutes until the session state flips, best effort. */
  minutesToChange: number | null;
}

/** PURE: the US equity session at `now`, New York time. Tokenized stocks trade around the clock on chain; this says whether the print behind them is live or paused. */
export function usSession(now: number): Session {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  const hh = Number(get("hour")) % 24;
  const mm = Number(get("minute"));
  const mins = hh * 60 + mm;
  const OPEN = 9 * 60 + 30;
  const CLOSE = 16 * 60;
  if (wd === "Sat" || wd === "Sun") return { open: false, label: "weekend", minutesToChange: null };
  if (mins >= OPEN && mins < CLOSE) return { open: true, label: "open", minutesToChange: CLOSE - mins };
  if (mins < OPEN) return { open: false, label: "pre-market", minutesToChange: OPEN - mins };
  return { open: false, label: "after-hours", minutesToChange: null };
}

export interface Analysis {
  thesis: string;
  evidence: string[];
  invalidation: string;
  /** 1 to 5; null when not stated. */
  conviction: number | null;
}

/** PURE: the numeric tokens in a text, normalized: "1,027.10" -> "1027.10", "3.74%" -> "3.74". */
export function figures(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const v = m[0].replace(/,/g, "");
    if (v.length >= 2 || v.includes(".")) out.add(v.replace(/\.0+$/, ""));
  }
  return out;
}

export interface EvidenceRule {
  minEvidence: number;
  minConviction: number;
}

/**
 * PURE: whether a swap has been argued for. Each evidence line must quote a
 * figure that appears in the observation; there must be at least
 * `minEvidence` such lines citing at least two distinct figures, a thesis,
 * an invalidation, and conviction at or above `minConviction`.
 */
export function evidenceCheck(a: Analysis | null, observation: string[], rule: EvidenceRule): { ok: true; cited: number } | { ok: false; reason: string } {
  if (!a) return { ok: false, reason: "no thesis, evidence, invalidation or conviction was stated" };
  const observed = figures(observation.join("\n"));
  const citedFigures = new Set<string>();
  let cited = 0;
  for (const line of a.evidence) {
    const f = [...figures(line)].filter((x) => observed.has(x));
    if (f.length) {
      cited++;
      for (const x of f) citedFigures.add(x);
    }
  }
  const missing: string[] = [];
  if (!a.thesis.trim()) missing.push("a thesis");
  if (cited < rule.minEvidence || citedFigures.size < 2) missing.push(`${rule.minEvidence} evidence lines each quoting an observed figure (${cited} did, ${citedFigures.size} distinct figures)`);
  if (!a.invalidation.trim()) missing.push("an invalidation");
  if (a.conviction == null || a.conviction < rule.minConviction) missing.push(`conviction of at least ${rule.minConviction} (stated ${a.conviction ?? "none"})`);
  return missing.length ? { ok: false, reason: `not argued for: needs ${missing.join("; ")}` } : { ok: true, cited };
}
