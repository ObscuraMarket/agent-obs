// Replay the desk's entry read over its own tapes, minute by minute: every
// time the tape would have allowed an entry, what the price did afterwards,
// and what a $5 probe under the exit rules would have made. The tapes come
// from the desk that watched them (scripts/railway-pull-data.sh copies the
// Railway volume into a local directory). Usage:
//   npm run replay:entries -- <tape dir> [pool map json]
// The pool map (pool id to symbol and launch time) is built from the feed by
// the pull script; without it, pools are named by their id.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { entryRead, entryRulesFromEnv } from "../src/desk/entry.ts";
import { readFeed } from "../src/desk/candidates.ts";
import type { SwapRow } from "../src/desk/tape.ts";

const DIR = process.argv[2];
const rules = entryRulesFromEnv();
const feed = readFeed(Date.now());
const symbolOf = new Map<string, { symbol: string; stable: boolean; launchAt: number }>();
try {
  const map = JSON.parse(readFileSync(process.argv[3] ?? "/dev/null", "utf8")) as Record<string, { symbol: string; launchAt: number | null }>;
  for (const [p, m] of Object.entries(map)) symbolOf.set(p.toLowerCase(), { symbol: m.symbol, stable: false, launchAt: m.launchAt ?? 0 });
} catch {}
for (const c of feed.candidates) symbolOf.set(c.poolId.toLowerCase(), { symbol: c.symbol, stable: !!c.stable?.stable, launchAt: c.at });
for (const e of feed.early) {
  for (const p of e.sidePools) if (!symbolOf.has(p.poolId.toLowerCase())) symbolOf.set(p.poolId.toLowerCase(), { symbol: e.symbol, stable: false, launchAt: e.at });
  if (e.curvePoolId && !symbolOf.has(e.curvePoolId.toLowerCase())) symbolOf.set(e.curvePoolId.toLowerCase(), { symbol: e.symbol, stable: false, launchAt: e.at });
}

interface Hit { symbol: string; at: number; state: string; px: number; ageMin: number; r5: number | null; r15: number | null; r30: number | null; r60: number | null; max60: number; min60: number; why: string; volumeKnown: boolean; probe: number; probeExit: string }
/** A $5 probe under the desk's exit rules, simplified: floor at -40%, a 25% trail off the peak once the trade is up 30%, half taken at +60%, and a two-hour time stop; a 4% fee each way. */
function probeOutcome(rows: SwapRow[], t: number, px: number): { pct: number; exit: string } {
  const fee = 4;
  let peak = px, taken = 0, realized = 0, remaining = 1;
  for (const r of rows) {
    if (r.at <= t) continue;
    const pct = ((r.price - px) / px) * 100;
    if (r.price > peak) peak = r.price;
    const offPeak = ((peak - r.price) / peak) * 100;
    if (pct <= -40) return { pct: realized + remaining * (pct - 2 * fee), exit: "floor" };
    if (!taken && pct >= 60) { realized += 0.5 * (pct - 2 * fee); remaining = 0.5; taken = 1; }
    if (((peak - px) / px) * 100 >= 30 && offPeak >= 25) return { pct: realized + remaining * (pct - 2 * fee), exit: taken ? "trail after take-profit" : "trail" };
    if (r.at > t + 120 * 60e3) return { pct: realized + remaining * (pct - 2 * fee), exit: "time stop" };
  }
  const last = rows[rows.length - 1];
  const pct = ((last.price - px) / px) * 100;
  return { pct: realized + remaining * (pct - 2 * fee), exit: "still open" };
}
const hits: Hit[] = [];
const priceAt = (rows: SwapRow[], t: number) => { let p: number | null = null; for (const r of rows) { if (r.at > t) break; p = r.price; } return p; };
const ret = (a: number, b: number | null) => (b == null ? null : ((b - a) / a) * 100);

for (const f of readdirSync(DIR)) {
  if (!f.endsWith(".jsonl")) continue;
  const poolId = f.replace(".jsonl", "").toLowerCase();
  const rows: SwapRow[] = readFileSync(join(DIR, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r): r is SwapRow => !!r && typeof r.price === "number" && r.price > 0).sort((a, b) => a.at - b.at);
  if (rows.length < 20) continue;
  const meta = symbolOf.get(poolId) ?? { symbol: poolId.slice(0, 8), stable: false, launchAt: rows[0].at };
  const first = rows[0].at, last = rows[rows.length - 1].at;
  let prevOk = false;
  for (let t = first + 5 * 60e3; t <= last - 20 * 60e3; t += 60e3) {
    const upTo = rows.filter((r) => r.at <= t);
    const ageMin0 = (t - meta.launchAt) / 60e3;
    const er = entryRead(upTo, meta.symbol, t, rules, meta.stable || (meta.launchAt > 0 && ageMin0 >= 360));
    if (er.ok && !prevOk) {
      const px = priceAt(rows, t)!;
      const fwd = rows.filter((r) => r.at > t && r.at <= t + 60 * 60e3).map((r) => r.price);
      hits.push({ symbol: meta.symbol, at: t, state: er.state, px, ageMin: (t - meta.launchAt) / 60e3, r5: ret(px, priceAt(rows, t + 5 * 60e3)), r15: ret(px, priceAt(rows, t + 15 * 60e3)), r30: ret(px, priceAt(rows, t + 30 * 60e3)), r60: ret(px, priceAt(rows, t + 60 * 60e3)), max60: fwd.length ? ret(px, Math.max(...fwd))! : 0, min60: fwd.length ? ret(px, Math.min(...fwd))! : 0, why: er.why, volumeKnown: meta.stable, probe: probeOutcome(rows, t, px).pct, probeExit: probeOutcome(rows, t, px).exit });
    }
    prevOk = er.ok;
  }
}
hits.sort((a, b) => a.at - b.at);
const f1 = (x: number | null) => (x == null ? "   n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(0)}%`.padStart(6));
console.log(`entries allowed on ${hits.length} minutes-of-first-signal across ${new Set(hits.map((h) => h.symbol)).size} tokens (each is the first minute a fresh signal appeared)`);
console.log("time   symbol      state      age    +5m   +15m   +30m   +60m   max60  min60   probe  exit");
for (const h of hits) console.log(`${new Date(h.at).toISOString().slice(11, 16)}Z ${h.symbol.padEnd(11)} ${h.state.padEnd(10)} ${String(Math.round(h.ageMin)).padStart(4)}m ${f1(h.r5)} ${f1(h.r15)} ${f1(h.r30)} ${f1(h.r60)} ${f1(h.max60)} ${f1(h.min60)} ${f1(h.probe)}  ${h.probeExit}`);
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
for (const state of ["spike", "pullback", "base", "reignition", "dip"]) {
  const g = hits.filter((h) => h.state === state);
  if (!g.length) continue;
  const r30 = g.map((h) => h.r30).filter((x): x is number => x != null);
  const r60 = g.map((h) => h.r60).filter((x): x is number => x != null);
  console.log(`${state.padEnd(9)} n=${g.length}  median +30m ${f1(med(r30))}  median +60m ${f1(med(r60))}  up at +30m ${r30.filter((x) => x > 0).length}/${r30.length}  reached +15% within 60m ${g.filter((h) => h.max60 >= 15).length}/${g.length}  fell 30% within 60m ${g.filter((h) => h.min60 <= -30).length}/${g.length}  probe: median ${f1(med(g.map((h) => h.probe)))}, sum ${f1(g.reduce((s, h) => s + h.probe, 0))}, winners ${g.filter((h) => h.probe > 0).length}/${g.length}`);
}

console.log("");
console.log("first signal per token (the desk probes once, then needs a proven sell before size):");
const firsts = new Map<string, Hit>();
for (const h of hits) if (!firsts.has(h.symbol)) firsts.set(h.symbol, h);
const F = [...firsts.values()];
for (const h of F) console.log(`  ${h.symbol.padEnd(12)} ${h.state.padEnd(9)} age ${String(Math.round(h.ageMin)).padStart(4)}m  +30m ${f1(h.r30)}  +60m ${f1(h.r60)}  max60 ${f1(h.max60)}  probe ${f1(h.probe)} (${h.probeExit})`);
console.log(`  n=${F.length}  probe sum ${f1(F.reduce((s, h) => s + h.probe, 0))}  winners ${F.filter((h) => h.probe > 0).length}/${F.length}  median probe ${f1(med(F.map((h) => h.probe)))}`);
console.log("");
console.log("by age at the signal (all signals):");
for (const [label, lo, hi] of [["0-15 min", 0, 15], ["15-45 min", 15, 45], ["45 min-3 h", 45, 180], ["over 3 h", 180, 1e9]] as const) {
  const g = hits.filter((h) => h.ageMin >= lo && h.ageMin < hi);
  if (!g.length) continue;
  console.log(`  ${label.padEnd(11)} n=${g.length}  probe sum ${f1(g.reduce((s, h) => s + h.probe, 0))}  winners ${g.filter((h) => h.probe > 0).length}/${g.length}  median +30m ${f1(med(g.map((h) => h.r30).filter((x): x is number => x != null)))}  hit +50% within 60m ${g.filter((h) => h.max60 >= 50).length}/${g.length}  fell 40% within 60m ${g.filter((h) => h.min60 <= -40).length}/${g.length}`);
}

// A small grid of exit and entry variants over the same signals, first signal per token and all signals.
function sim(rows: SwapRow[], t: number, px: number, floor: number, arm: number, trail: number, tpAt: number, tpShare: number, timeMin: number): number {
  const fee = 4;
  let peak = px, taken = 0, realized = 0, remaining = 1;
  for (const r of rows) {
    if (r.at <= t) continue;
    const pct = ((r.price - px) / px) * 100;
    if (r.price > peak) peak = r.price;
    const offPeak = ((peak - r.price) / peak) * 100;
    if (pct <= -floor) return realized + remaining * (pct - 2 * fee);
    if (!taken && tpAt > 0 && pct >= tpAt) { realized += tpShare * (pct - 2 * fee); remaining -= tpShare; taken = 1; }
    if (((peak - px) / px) * 100 >= arm && offPeak >= trail) return realized + remaining * (pct - 2 * fee);
    if (r.at > t + timeMin * 60e3) return realized + remaining * (pct - 2 * fee);
  }
  const last = rows[rows.length - 1];
  return realized + remaining * (((last.price - px) / px) * 100 - 2 * fee);
}
const tapesBySymbol = new Map<string, SwapRow[]>();
for (const f of readdirSync(DIR)) {
  if (!f.endsWith(".jsonl")) continue;
  const poolId = f.replace(".jsonl", "").toLowerCase();
  const meta = symbolOf.get(poolId); if (!meta) continue;
  const rows: SwapRow[] = readFileSync(join(DIR, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r): r is SwapRow => !!r && typeof r.price === "number" && r.price > 0).sort((a, b) => a.at - b.at);
  if (rows.length >= 20) tapesBySymbol.set(meta.symbol, rows);
}
console.log("");
console.log("exit and entry variants (sum of probe results in % of probe size; first signal per token | all signals):");
const variants: Array<[string, number, number, number, number, number, number, number]> = [
  ["Railway today: floor 40, trail 20 after +20, half at +40, 2h", 40, 20, 20, 40, 0.5, 120, 1e9],
  ["Railway today, only tokens under 15 min old", 40, 20, 20, 40, 0.5, 120, 15],
  ["Railway today, only under 30 min", 40, 20, 20, 40, 0.5, 120, 30],
  ["floor 25, rest as Railway", 25, 20, 20, 40, 0.5, 120, 1e9],
  ["floor 25, rest as Railway, only under 15 min", 25, 20, 20, 40, 0.5, 120, 15],
  ["floor 25, half at +80, trail 20 after +30, under 15 min", 25, 30, 20, 80, 0.5, 120, 15],
  ["floor 25, no take-profit, trail 20 after +30, under 15 min", 25, 30, 20, 0, 0, 120, 15],
  // The tight rule asked for on 2026-09-05: a hard stop close under the entry and the whole position out at a small gain.
  ["tight: floor 10, all out at +15, no trail, 2h", 10, 1e9, 0, 15, 1, 120, 1e9],
  ["tight: floor 10, all out at +15, under 15 min", 10, 1e9, 0, 15, 1, 120, 15],
  ["tight: floor 10, all out at +20, no trail, 2h", 10, 1e9, 0, 20, 1, 120, 1e9],
  ["tight: floor 10, all out at +20, under 15 min", 10, 1e9, 0, 20, 1, 120, 15],
  ["tight: floor 15, all out at +20, no trail, 2h", 15, 1e9, 0, 20, 1, 120, 1e9],
  ["tight: floor 15, all out at +20, under 15 min", 15, 1e9, 0, 20, 1, 120, 15],
  ["tight: floor 20, all out at +20, no trail, 2h", 20, 1e9, 0, 20, 1, 120, 1e9],
];
for (const [name, floor, arm, trail, tpAt, tpShare, timeMin, maxAge] of variants) {
  const use = hits.filter((h) => h.ageMin >= 0 && h.ageMin <= maxAge && tapesBySymbol.has(h.symbol));
  const firstsV = new Map<string, Hit>(); for (const h of use) if (!firstsV.has(h.symbol)) firstsV.set(h.symbol, h);
  const res = (g: Hit[]) => { const xs = g.map((h) => sim(tapesBySymbol.get(h.symbol)!, h.at, h.px, floor, arm, trail, tpAt, tpShare, timeMin)); return `${xs.length ? f1(xs.reduce((s, x) => s + x, 0)) : "  none"} over ${xs.length} (${xs.filter((x) => x > 0).length} winners)`; };
  console.log(`  ${name.padEnd(52)} ${res([...firstsV.values()])} | ${res(use)}`);
}
