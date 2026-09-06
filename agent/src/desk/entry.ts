// The entry. Volume puts a token on watch; the price action gives the entry.
// From the desk's own tape over the last half hour: whether volume has
// picked up (the last ten minutes against the twenty before), how far the
// price ran to its peak, how far it sits off it, whether the pullback held a
// higher low and turned up with buyers back, or whether the price has gone
// quiet in a tight range with buyers still present. The top of a run is
// never an entry and a breakdown is never an entry. The rails refuse a
// launch-token buy whose entry read says no, and the reason is public. More
// data points belong here, not in the cycle.
import type { SwapRow } from "./tape.ts";

export interface EntryRules {
  /** Minutes of tape the read looks at. */
  windowMin: number;
  /** The last two 5-minute buckets against the mean of the earlier ones: at or above this is a pickup. */
  pickupRatio: number;
  /** Fewer swaps than this in the window and the read is quiet. */
  minSwaps: number;
  /** Within this much of its peak after a run of at least spikeRunPct, the price is at the top. */
  spikeNearPeakPct: number;
  spikeRunPct: number;
  /** A pullback at least this far off the peak, and no further than the max, can be an entry. */
  pullbackMinPct: number;
  pullbackMaxPct: number;
  /** The last price must sit this far above the post-peak trough: the pullback has turned. */
  bounceMinPct: number;
  /** A range this tight over the last baseMin minutes, with the peak older than that, is a base. */
  baseRangePct: number;
  baseMin: number;
  /** Buy pressure over the last ten minutes must be at least this for any entry. */
  minBuyPressurePct: number;
  /** Whether a held pullback after a run counts as an entry (OBS_ENTRY_PULLBACK). Off, the desk buys bases only. */
  allowPullback: boolean;
  /** How far under where the window started the price may sit before that alone is a breakdown (OBS_ENTRY_BREAKDOWN_PCT). Zero: any tick under it. A token with a day of trading drifts a few percent either way and is not breaking down. */
  breakdownPct: number;
  /**
   * The re-ignition (OBS_ENTRY_REIGNITION): a launch that spiked, was shaken out by at least reignitionShakeoutPct
   * from a peak at least reignitionPeakAgeMin old, and in the last few minutes came back reignitionReclaimPct off
   * the trough on a volume burst of reignitionVolumeRatio times the earlier tape, with buyers still there. The
   * second leg of a coordinated launch, read from the tape rather than guessed. Off, the read calls it a breakdown.
   */
  reignition: boolean;
  reignitionPeakAgeMin: number;
  reignitionShakeoutPct: number;
  reignitionReclaimPct: number;
  reignitionVolumeRatio: number;
  reignitionMin: number;
}

export function entryRulesFromEnv(env: NodeJS.ProcessEnv = process.env): EntryRules {
  const n = (k: string, d: number) => Number(env[k] ?? d);
  return {
    windowMin: n("OBS_ENTRY_WINDOW_MIN", 30),
    pickupRatio: n("OBS_ENTRY_PICKUP_RATIO", 2),
    minSwaps: n("OBS_ENTRY_MIN_SWAPS", 6),
    spikeNearPeakPct: n("OBS_ENTRY_SPIKE_NEAR_PEAK_PCT", 3),
    spikeRunPct: n("OBS_ENTRY_SPIKE_RUN_PCT", 15),
    pullbackMinPct: n("OBS_ENTRY_PULLBACK_MIN_PCT", 8),
    pullbackMaxPct: n("OBS_ENTRY_PULLBACK_MAX_PCT", 35),
    bounceMinPct: n("OBS_ENTRY_BOUNCE_MIN_PCT", 2),
    baseRangePct: n("OBS_ENTRY_BASE_RANGE_PCT", 6),
    baseMin: n("OBS_ENTRY_BASE_MIN", 10),
    minBuyPressurePct: n("OBS_ENTRY_MIN_BUY_PRESSURE_PCT", 50),
    allowPullback: (env.OBS_ENTRY_PULLBACK ?? "on") !== "off",
    breakdownPct: n("OBS_ENTRY_BREAKDOWN_PCT", 0),
    reignition: (env.OBS_ENTRY_REIGNITION ?? "off") === "on",
    reignitionPeakAgeMin: n("OBS_ENTRY_REIGNITION_PEAK_AGE_MIN", 3),
    reignitionShakeoutPct: n("OBS_ENTRY_REIGNITION_SHAKEOUT_PCT", 50),
    reignitionReclaimPct: n("OBS_ENTRY_REIGNITION_RECLAIM_PCT", 50),
    reignitionVolumeRatio: n("OBS_ENTRY_REIGNITION_VOLUME_RATIO", 3),
    reignitionMin: n("OBS_ENTRY_REIGNITION_MIN", 3),
  };
}

export type EntryState = "quiet" | "spike" | "pullback" | "base" | "breakdown" | "waiting" | "reignition";

export interface EntryRead {
  symbol: string;
  windowMin: number;
  swaps: number;
  /** Volume has picked up on the tape, or is established elsewhere (see volumeKnown). */
  pickup: boolean;
  /** The pickup was established by the hourly figures or a held position, not judged from this tape. */
  volumeKnown: boolean;
  /** The last ten minutes of volume against the mean of the earlier tape. Null when the earlier tape is empty. */
  pickupRatio: number | null;
  /** First price of the window to its peak, in percent. */
  runPct: number | null;
  offPeakPct: number | null;
  /** The post-peak trough sat above the window's first price: a higher low. */
  higherLow: boolean | null;
  /** The last price above the post-peak trough, in percent. */
  bouncePct: number | null;
  /** Buy pressure over the last ten minutes, in quote terms. */
  recentBuyPressurePct: number | null;
  /** High over low across the last baseMin minutes, in percent. */
  rangePct: number | null;
  state: EntryState;
  /** Whether a buy is allowed on this read. */
  ok: boolean;
  why: string;
}

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`;

/**
 * PURE: the entry read from the tape. `volumeKnown` says the pickup is
 * established elsewhere (a graded candidate's prior hour, a held token), so
 * only the price action is judged.
 */
export function entryRead(rows: SwapRow[], symbol: string, now: number, r: EntryRules, volumeKnown = false): EntryRead {
  const start = now - r.windowMin * 60e3;
  const w = rows.filter((x) => x.at >= start && x.at <= now && x.price > 0).sort((a, b) => a.at - b.at);
  const nB = Math.max(3, Math.ceil(r.windowMin / 5));
  const buckets = Array.from({ length: nB }, () => 0);
  for (const x of w) buckets[Math.min(nB - 1, Math.floor((x.at - start) / (5 * 60e3)))] += x.quoteAmount;
  const recent = (buckets[nB - 1] + buckets[nB - 2]) / 2;
  const earlier = buckets.slice(0, nB - 2);
  const earlierMean = earlier.reduce((s, v) => s + v, 0) / earlier.length;
  const pickupRatio = earlierMean > 0 ? recent / earlierMean : null;
  const pickup = volumeKnown || (pickupRatio != null ? pickupRatio >= r.pickupRatio : recent > 0);
  const base: EntryRead = { symbol, windowMin: r.windowMin, swaps: w.length, pickup, volumeKnown, pickupRatio, runPct: null, offPeakPct: null, higherLow: null, bouncePct: null, recentBuyPressurePct: null, rangePct: null, state: "quiet", ok: false, why: "" };
  if (w.length < r.minSwaps) return { ...base, why: `${w.length} swaps in ${r.windowMin} min, too few to read` };
  if (!pickup) return { ...base, why: `no volume pickup (the last 10 min ran ${pickupRatio == null ? "flat" : `${pickupRatio.toFixed(1)}x`} the earlier tape, ${r.pickupRatio}x needed)` };
  // Price action.
  const first = w[0].price;
  let peakIdx = 0;
  for (let i = 1; i < w.length; i++) if (w[i].price > w[peakIdx].price) peakIdx = i;
  const peak = w[peakIdx].price;
  const last = w[w.length - 1].price;
  const trough = Math.min(...w.slice(peakIdx).map((x) => x.price));
  const runPct = ((peak - first) / first) * 100;
  const offPeakPct = ((peak - last) / peak) * 100;
  // Where the window started, with the tolerance: a survivor drifting a few percent under it has not broken down.
  const floor = first * (1 - r.breakdownPct / 100);
  const higherLow = trough > floor;
  const bouncePct = ((last - trough) / trough) * 100;
  const rec = w.filter((x) => x.at >= now - 10 * 60e3);
  const buyQ = rec.filter((x) => x.side === "buy").reduce((s, x) => s + x.quoteAmount, 0);
  const sellQ = rec.filter((x) => x.side === "sell").reduce((s, x) => s + x.quoteAmount, 0);
  const pressure = buyQ + sellQ > 0 ? (buyQ / (buyQ + sellQ)) * 100 : null;
  const bp = w.filter((x) => x.at >= now - r.baseMin * 60e3).map((x) => x.price);
  const rangePct = bp.length >= 3 ? ((Math.max(...bp) - Math.min(...bp)) / Math.min(...bp)) * 100 : null;
  const peakAgeMin = (now - w[peakIdx].at) / 60e3;
  const read: EntryRead = { ...base, runPct, offPeakPct, higherLow, bouncePct, recentBuyPressurePct: pressure, rangePct };
  const pressureOk = pressure != null && pressure >= r.minBuyPressurePct;
  const pressureNote = pressure == null ? "no swaps in the last 10 min" : `buy pressure ${pressure.toFixed(0)}% over the last 10 min`;
  // The re-ignition: a shakeout from an old peak, then a reclaim off the trough on a burst of volume, with buyers there.
  if (r.reignition && peakAgeMin >= r.reignitionPeakAgeMin) {
    const post = w.slice(peakIdx);
    let troughIdx = 0;
    for (let i = 1; i < post.length; i++) if (post[i].price < post[troughIdx].price) troughIdx = i;
    const troughAt = post[troughIdx].at;
    const shakeoutPct = ((peak - trough) / peak) * 100;
    const recent = w.filter((x) => x.at >= now - r.reignitionMin * 60e3);
    const earlier = w.filter((x) => x.at < now - r.reignitionMin * 60e3 && x.at >= now - 4 * r.reignitionMin * 60e3);
    const recentVol = recent.reduce((s, x) => s + x.quoteAmount, 0);
    const earlierPerSlice = earlier.reduce((s, x) => s + x.quoteAmount, 0) / 3;
    const burst = earlierPerSlice > 0 ? recentVol / earlierPerSlice : null;
    if (shakeoutPct >= r.reignitionShakeoutPct && bouncePct >= r.reignitionReclaimPct && now - troughAt <= 2 * r.reignitionMin * 60e3 && burst != null && burst >= r.reignitionVolumeRatio && pressureOk) {
      return { ...read, state: "reignition", ok: true, why: `re-ignition: shaken out ${shakeoutPct.toFixed(0)}% from a peak ${peakAgeMin.toFixed(0)} min old, then back ${pct(bouncePct)} off the trough in the last ${r.reignitionMin} min on ${burst.toFixed(1)}x the earlier volume, ${pressureNote}: second leg, entry allowed` };
    }
  }
  if (offPeakPct > r.pullbackMaxPct || last < floor) {
    return { ...read, state: "breakdown", why: `${offPeakPct.toFixed(0)}% off its peak${last < floor ? ` and ${r.breakdownPct > 0 ? `more than ${r.breakdownPct}% ` : ""}below where the window started` : ""}: breakdown, no entry` };
  }
  if (offPeakPct >= r.pullbackMinPct) {
    if (higherLow && bouncePct >= r.bounceMinPct && pressureOk) {
      if (!r.allowPullback) return { ...read, state: "pullback", why: `ran ${pct(runPct)} to its peak, now ${offPeakPct.toFixed(0)}% off it and holding, ${pressureNote}: a pullback after a run, and the desk buys bases only, no entry` };
      return { ...read, state: "pullback", ok: true, why: `ran ${pct(runPct)} to its peak, now ${offPeakPct.toFixed(0)}% off it, held a higher low and turned up ${pct(bouncePct)} off the trough, ${pressureNote}: pullback holding, entry allowed` };
    }
    const miss = !higherLow ? "the pullback went below where the window started" : bouncePct < r.bounceMinPct ? `it has not turned up yet (${pct(bouncePct)} off the trough, ${r.bounceMinPct}% needed)` : `${pressureNote} (${r.minBuyPressurePct}% needed)`;
    return { ...read, state: "pullback", why: `${offPeakPct.toFixed(0)}% off its peak but ${miss}: pullback not held, no entry yet` };
  }
  if (rangePct != null && rangePct <= r.baseRangePct && peakAgeMin >= r.baseMin && pressureOk) {
    return { ...read, state: "base", ok: true, why: `quiet in a ${rangePct.toFixed(1)}% range for ${r.baseMin} min with the peak ${peakAgeMin.toFixed(0)} min old, ${pressureNote}: base, entry allowed` };
  }
  if (runPct >= r.spikeRunPct && offPeakPct <= r.spikeNearPeakPct) {
    return { ...read, state: "spike", why: `ran ${pct(runPct)} and sits ${offPeakPct.toFixed(0)}% off its peak: the top of its run, no entry` };
  }
  return { ...read, state: "waiting", why: `volume is up but the price action has given no entry yet (${offPeakPct.toFixed(0)}% off its peak${rangePct != null ? `, ${rangePct.toFixed(1)}% range over ${r.baseMin} min` : ""}, ${pressureNote})` };
}

/** PURE: the entry read as one observation line the agent can cite. */
export function entryLine(e: EntryRead): string {
  const vol = e.volumeKnown ? "volume established by its hourly figures" : e.pickup ? (e.pickupRatio != null ? `volume pickup ${e.pickupRatio.toFixed(1)}x` : "volume where there was none") : "no volume pickup";
  return `Entry ${e.symbol} (last ${e.windowMin} min, ${e.swaps} swaps): ${vol}; ${e.why}. ${e.state.toUpperCase()}, ${e.ok ? "ENTRY ALLOWED" : "NO ENTRY"}.`;
}
