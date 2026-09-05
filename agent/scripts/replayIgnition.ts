// What the same tapes say about buying at ignition instead of after the run.
// The desk's entry read waits for a launch to run, pull back and hold a
// higher low, which on a spike-and-die population means buying the top. This
// replay enters in the token's first minutes, the first minute its tape shows
// real buying, and scores the same exits over it. Same fee assumption as the
// entry replay: 4% a side.
//   npm run replay:ignition -- <tape dir> [poolmap.json]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SwapRow } from "../src/desk/tape.ts";

const DIR = process.argv[2] ?? "data/tape";
const symbolOf = new Map<string, { symbol: string; launchAt: number }>();
try {
  const map = JSON.parse(readFileSync(process.argv[3] ?? "/dev/null", "utf8")) as Record<string, { symbol: string; launchAt: number | null }>;
  for (const [p, m] of Object.entries(map)) symbolOf.set(p.toLowerCase(), { symbol: m.symbol, launchAt: m.launchAt ?? 0 });
} catch { /* no pool map: tapes are named by their pool id and dated from their first swap */ }

const f1 = (x: number | null) => (x == null ? "   n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(0)}%`.padStart(6));
const priceAt = (rows: SwapRow[], t: number) => { let p: number | null = null; for (const r of rows) { if (r.at > t) break; p = r.price; } return p; };
const ret = (a: number, b: number | null) => (b == null ? null : ((b - a) / a) * 100);

/** The exits over the tape from t at price px: floor, whole-position take-profit or a share of it, trail once armed, time stop. Fee 4% a side. */
function sim(rows: SwapRow[], t: number, px: number, floor: number, arm: number, trail: number, tpAt: number, tpShare: number, timeMin: number): { pct: number; exit: string } {
  const fee = 4;
  let peak = px, taken = 0, realized = 0, remaining = 1;
  for (const r of rows) {
    if (r.at <= t) continue;
    const pct = ((r.price - px) / px) * 100;
    if (r.price > peak) peak = r.price;
    const offPeak = ((peak - r.price) / peak) * 100;
    if (pct <= -floor) return { pct: realized + remaining * (pct - 2 * fee), exit: "floor" };
    if (!taken && tpAt > 0 && pct >= tpAt) { realized += tpShare * (pct - 2 * fee); remaining -= tpShare; taken = 1; if (remaining <= 0) return { pct: realized, exit: "take-profit" }; }
    if (((peak - px) / px) * 100 >= arm && offPeak >= trail) return { pct: realized + remaining * (pct - 2 * fee), exit: taken ? "trail after take-profit" : "trail" };
    if (r.at > t + timeMin * 60e3) return { pct: realized + remaining * (pct - 2 * fee), exit: "time stop" };
  }
  const last = rows[rows.length - 1];
  return { pct: realized + remaining * (((last.price - px) / px) * 100 - 2 * fee), exit: "still open" };
}

interface Entry { symbol: string; rule: string; at: number; ageMin: number; px: number; swaps3: number; buyShare: number; r5: number | null; r15: number | null; r30: number | null; r60: number | null; max60: number; min60: number; rows: SwapRow[] }
const entries: Entry[] = [];
let tapes = 0, fromLaunch = 0;
for (const f of readdirSync(DIR)) {
  if (!f.endsWith(".jsonl")) continue;
  const poolId = f.replace(".jsonl", "").toLowerCase();
  const rows: SwapRow[] = readFileSync(join(DIR, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r): r is SwapRow => !!r && typeof r.price === "number" && r.price > 0).sort((a, b) => a.at - b.at);
  if (rows.length < 20) continue;
  tapes++;
  const meta = symbolOf.get(poolId) ?? { symbol: poolId.slice(0, 8), launchAt: 0 };
  // Only tapes that begin at the launch can say anything about its first minutes.
  const launchAt = meta.launchAt > 0 ? meta.launchAt : rows[0].at;
  if (rows[0].at - launchAt > 3 * 60e3) continue;
  fromLaunch++;
  const last = rows[rows.length - 1].at;
  const window = (t: number, min: number) => rows.filter((r) => r.at > t - min * 60e3 && r.at <= t);
  const add = (rule: string, t: number) => {
    const px = priceAt(rows, t); if (px == null) return;
    const w = window(t, 3);
    const buys = w.filter((r) => r.side === "buy").reduce((s, r) => s + r.quoteAmount, 0);
    const all = w.reduce((s, r) => s + r.quoteAmount, 0);
    const fwd = rows.filter((r) => r.at > t && r.at <= t + 60 * 60e3).map((r) => r.price);
    entries.push({ symbol: meta.symbol, rule, at: t, ageMin: (t - launchAt) / 60e3, px, swaps3: w.length, buyShare: all > 0 ? buys / all : 0, r5: ret(px, priceAt(rows, t + 5 * 60e3)), r15: ret(px, priceAt(rows, t + 15 * 60e3)), r30: ret(px, priceAt(rows, t + 30 * 60e3)), r60: ret(px, priceAt(rows, t + 60 * 60e3)), max60: fwd.length ? ret(px, Math.max(...fwd))! : 0, min60: fwd.length ? ret(px, Math.min(...fwd))! : 0, rows });
  };
  // Rule A, ignition: the first minute inside the first ten where the last three minutes carried 20 or more swaps,
  // buyers were 60% or more of the quote volume, and the price was above where it stood three minutes earlier.
  for (let t = launchAt + 60e3; t <= Math.min(launchAt + 10 * 60e3, last - 60 * 60e3); t += 60e3) {
    const w = window(t, 3);
    if (w.length < 20) continue;
    const buys = w.filter((r) => r.side === "buy").reduce((s, r) => s + r.quoteAmount, 0);
    const all = w.reduce((s, r) => s + r.quoteAmount, 0);
    const p0 = priceAt(rows, t - 3 * 60e3), p1 = priceAt(rows, t);
    if (all > 0 && buys / all >= 0.6 && p0 != null && p1 != null && p1 > p0) { add("ignition", t); break; }
  }
  // Rule B, blind: minute two after launch whatever the tape says, if it has ten swaps by then (the sniper's baseline).
  { const t = launchAt + 2 * 60e3; if (window(t, 2).length >= 10 && t <= last - 60 * 60e3) add("minute two", t); }
  // Rule C, the first pullback in the first fifteen minutes: the price 15% or more off its peak so far, after a run of 50% or more.
  { let peak = 0, start: number | null = null;
    for (const r of rows) { if (r.at < launchAt) continue; if (start == null) start = r.price; if (r.price > peak) peak = r.price; if (r.at > launchAt + 15 * 60e3) break;
      if (start != null && peak >= start * 1.5 && r.price <= peak * 0.85 && r.at <= last - 60 * 60e3) { add("early pullback", r.at); break; } } }
}

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
console.log(`${tapes} tapes, ${fromLaunch} that begin at the launch (the rest started late and cannot say what minute one looked like)`);
const variants: Array<[string, number, number, number, number, number, number]> = [
  ["tight: floor 10, all out at +15", 10, 1e9, 0, 15, 1, 120],
  ["tight: floor 10, all out at +30", 10, 1e9, 0, 30, 1, 120],
  ["floor 15, half at +30, trail 20 after +30", 15, 30, 20, 30, 0.5, 120],
  ["floor 25, half at +50, trail 20 after +30", 25, 30, 20, 50, 0.5, 120],
  ["Railway today: floor 10, all out at +15, tape roll-over ignored", 10, 1e9, 0, 15, 1, 120],
];
for (const rule of ["ignition", "minute two", "early pullback"]) {
  const g = entries.filter((e) => e.rule === rule);
  if (!g.length) { console.log(`\n${rule}: no entries`); continue; }
  console.log(`\n== ${rule}: ${g.length} entries, median age ${med(g.map((e) => e.ageMin)).toFixed(1)} min, median swaps in the 3 min before ${med(g.map((e) => e.swaps3)).toFixed(0)}`);
  const r30 = g.map((e) => e.r30).filter((x): x is number => x != null);
  console.log(`   +30m median ${f1(med(r30))}, up at +30m ${r30.filter((x) => x > 0).length}/${r30.length}; reached +15% within 60m ${g.filter((e) => e.max60 >= 15).length}/${g.length}; reached +50% ${g.filter((e) => e.max60 >= 50).length}/${g.length}; fell 30% within 60m ${g.filter((e) => e.min60 <= -30).length}/${g.length}`);
  for (const [name, floor, arm, trail, tpAt, tpShare, timeMin] of variants) {
    const xs = g.map((e) => sim(e.rows, e.at, e.px, floor, arm, trail, tpAt, tpShare, timeMin));
    const byExit = new Map<string, number>(); for (const x of xs) byExit.set(x.exit, (byExit.get(x.exit) ?? 0) + 1);
    console.log(`   ${name.padEnd(62)} sum ${f1(xs.reduce((s, x) => s + x.pct, 0))} over ${xs.length}, winners ${xs.filter((x) => x.pct > 0).length}, median ${f1(med(xs.map((x) => x.pct)))}  (${[...byExit].map(([k, v]) => `${k} ${v}`).join(", ")})`);
  }
  console.log("   token        age   swaps3 buy%   +5m   +15m   +30m   +60m  max60  min60  | tight floor 10 / out at +15");
  for (const e of g.sort((a, b) => a.at - b.at)) {
    const s = sim(e.rows, e.at, e.px, 10, 1e9, 0, 15, 1, 120);
    console.log(`   ${e.symbol.padEnd(12)} ${e.ageMin.toFixed(0).padStart(3)}m ${String(e.swaps3).padStart(6)} ${(e.buyShare * 100).toFixed(0).padStart(4)}% ${f1(e.r5)} ${f1(e.r15)} ${f1(e.r30)} ${f1(e.r60)} ${f1(e.max60)} ${f1(e.min60)}  | ${f1(s.pct)} ${s.exit}`);
  }
}
