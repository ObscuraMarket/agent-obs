// Stability: tokens that have already shown it. The launch watcher tracks a
// token's first day hour by hour, and once a pool goes quiet it repeats the
// last active hour, so the honest hourly series is the cumulative volume
// moving hour to hour. A token is stable when it has traded in most of its
// hours for six hours or more, its price sits within a contained distance of
// its peak, its last hours held a range, its recent hours still carry a fair
// share of its median hour, and real senders stand behind it. Such a token is
// hunted for a swing on price action, not chased on ignition: it joins the
// candidates at grade B and its Entry line times the buy.
import type { HourlyStat } from "./candidates.ts";

export interface StabilityRules {
  /** Active hours (volume at or above minHourUsd) needed. */
  minActiveHours: number;
  minHourUsd: number;
  /** The last price against the peak of the last peakHours active hours (not the launch spike). */
  maxDrawdownPct: number;
  peakHours: number;
  /** High over low across the last six active hours. */
  maxRangePct: number;
  /** The last three active hours' mean against the median active hour. */
  minRecentRatio: number;
  /** Distinct senders so far, from the latest row. */
  minSenders: number;
  /** The latest row must be this fresh. */
  maxAgeH: number;
}

export function stabilityRulesFromEnv(env: NodeJS.ProcessEnv = process.env): StabilityRules {
  const n = (k: string, d: number) => Number(env[k] ?? d);
  return {
    minActiveHours: n("OBS_STABLE_MIN_ACTIVE_HOURS", 6),
    minHourUsd: n("OBS_STABLE_MIN_HOUR_USD", 1000),
    maxDrawdownPct: n("OBS_STABLE_MAX_DRAWDOWN_PCT", 50),
    peakHours: n("OBS_STABLE_PEAK_HOURS", 12),
    maxRangePct: n("OBS_STABLE_MAX_RANGE_PCT", 40),
    minRecentRatio: n("OBS_STABLE_MIN_RECENT_RATIO", 0.5),
    minSenders: n("OBS_STABLE_MIN_SENDERS", 20),
    maxAgeH: n("OBS_STABLE_MAX_AGE_H", 2),
  };
}

export interface StabilityRead {
  symbol: string;
  hoursTracked: number;
  /** Hours whose volume could be read (the first hour of a cut trail cannot be). */
  hoursKnown: number;
  activeHours: number;
  medianHourUsd: number | null;
  recentHourUsd: number | null;
  recentRatio: number | null;
  /** The peak of the last peakHours active hours. */
  peakPx: number | null;
  lastPx: number | null;
  drawdownPct: number | null;
  rangePct: number | null;
  /** The low of the last three active hours at or above the low of the three before. */
  higherLow: boolean | null;
  senders: number;
  ageH: number | null;
  stable: boolean;
  why: string;
}

/** PURE: the latest row per hour, in hour order. */
export function hourlyTrail(rows: HourlyStat[]): HourlyStat[] {
  const byHour = new Map<number, HourlyStat>();
  for (const r of rows) {
    const p = byHour.get(r.hour);
    if (!p || r.at >= p.at) byHour.set(r.hour, r);
  }
  return [...byHour.values()].sort((a, b) => a.hour - b.hour);
}

/**
 * PURE: volume in each hour of a trail. From the cumulative figure when the
 * row carries one (null for the first row of a trail that starts past hour
 * 0, since its cumulative covers hours not in the trail), else the hour's
 * own figure.
 */
export function hourVolumes(trail: HourlyStat[]): Array<number | null> {
  const out: Array<number | null> = [];
  let prev: number | null = null;
  for (const h of trail) {
    if (h.cumUsd != null) {
      out.push(prev == null ? (h.hour === 0 ? h.cumUsd : null) : Math.max(0, h.cumUsd - prev));
      prev = h.cumUsd;
    } else {
      out.push(h.usd);
    }
  }
  return out;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

/** PURE: whether a token has already shown stability, from its hourly rows. */
export function stabilityRead(rows: HourlyStat[], symbol: string, now: number, r: StabilityRules): StabilityRead {
  const trail = hourlyTrail(rows);
  const vols = hourVolumes(trail);
  const known = trail.map((h, i) => ({ h, v: vols[i] })).filter((x): x is { h: HourlyStat; v: number } => x.v != null);
  const active = known.filter((x) => x.v >= r.minHourUsd);
  const last = trail[trail.length - 1];
  const senders = last?.senders ?? 0;
  const out: StabilityRead = { symbol, hoursTracked: trail.length, hoursKnown: known.length, activeHours: active.length, medianHourUsd: null, recentHourUsd: null, recentRatio: null, peakPx: null, lastPx: null, drawdownPct: null, rangePct: null, higherLow: null, senders, ageH: last ? (now - last.at) / 3600e3 : null, stable: false, why: "" };
  if (!last) return { ...out, why: "no hourly rows" };
  const px = active.map((x) => x.h.px).filter((p): p is number => p != null && p > 0);
  if (px.length) {
    out.peakPx = Math.max(...px.slice(-r.peakHours));
    out.lastPx = px[px.length - 1];
    out.drawdownPct = ((out.peakPx - out.lastPx) / out.peakPx) * 100;
    const last6 = px.slice(-6);
    if (last6.length >= 3) out.rangePct = ((Math.max(...last6) - Math.min(...last6)) / Math.min(...last6)) * 100;
    const prior = px.slice(-6, -3);
    const recent3 = px.slice(-3);
    if (prior.length === 3 && recent3.length === 3) out.higherLow = Math.min(...recent3) >= Math.min(...prior);
  }
  const vs = active.map((x) => x.v);
  if (vs.length) {
    out.medianHourUsd = median(vs);
    if (vs.length >= 3) {
      out.recentHourUsd = vs.slice(-3).reduce((s, v) => s + v, 0) / 3;
      out.recentRatio = out.medianHourUsd > 0 ? out.recentHourUsd / out.medianHourUsd : null;
    }
  }
  const fails: string[] = [];
  if (active.length < r.minActiveHours) fails.push(`${active.length} active hours of ${known.length} (${r.minActiveHours} needed)`);
  if (out.ageH != null && out.ageH > r.maxAgeH) fails.push(`last row ${out.ageH.toFixed(1)}h old`);
  if (out.drawdownPct == null) fails.push("no price path");
  else if (out.drawdownPct > r.maxDrawdownPct) fails.push(`${out.drawdownPct.toFixed(0)}% off its ${r.peakHours}-hour peak (${r.maxDrawdownPct}% allowed)`);
  if (out.rangePct != null && out.rangePct > r.maxRangePct) fails.push(`${out.rangePct.toFixed(0)}% range over its last hours (${r.maxRangePct}% allowed)`);
  if (out.recentRatio != null && out.recentRatio < r.minRecentRatio) fails.push(`recent hours at ${(out.recentRatio * 100).toFixed(0)}% of its median hour (${Math.round(r.minRecentRatio * 100)}% needed)`);
  if (senders < r.minSenders) fails.push(`${senders} senders (${r.minSenders} needed)`);
  if (fails.length) return { ...out, why: fails.join(", ") };
  return {
    ...out,
    stable: true,
    why: `${active.length} active hours of ${known.length}, median hour ${usd(out.medianHourUsd ?? 0)}, recent hours ${out.recentRatio != null ? `${(out.recentRatio * 100).toFixed(0)}% of that` : "unread"}, ${out.drawdownPct?.toFixed(0)}% off its ${r.peakHours}-hour peak, ${out.rangePct != null ? `${out.rangePct.toFixed(0)}% range over its last hours` : "range unread"}${out.higherLow ? ", higher lows" : ""}, ${senders} senders`,
  };
}
