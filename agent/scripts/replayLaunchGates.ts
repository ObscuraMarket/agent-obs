// Do the launch read's gates predict the winners? Every launch the desk read
// (the launch ledger) joined to what its tape did in the hour after the read:
// the peak, the trough, the price at 30 and 60 minutes, and a $25 ticket
// under the desk's exits. Grouped by the gate that would have refused it. For
// the claim that on this launchpad the bundled, heavy-dev launches are the
// ones that run.
//   npx tsx scripts/replayLaunchGates.ts <data dir> [research.json]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SwapRow } from "../src/desk/tape.ts";
import { curvePoolIdFor } from "../src/desk/candidates.ts";
import { pairSymbolOf } from "../src/desk/chainlaunch.ts";

const DIR = process.argv[2] ?? "../data-railway";
const RESEARCH = process.argv[3] ?? "";
interface LaunchRow { token: string; symbol: string; at: number; pairToken: string | null; devSharePct: number | null; exemptions: string[] | null; earlyBuyers: number | null; earlyBuys: number | null; score: { total: number } | null; verdict: { ok: boolean; why: string }; creatorTaxBps: number | null; deployerPrior: number | null }
const launches = readFileSync(join(DIR, "obs-launches.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LaunchRow);
// One read per token: the first, which is when the desk first saw it.
const firstRead = new Map<string, LaunchRow>();
for (const l of launches.sort((a, b) => a.at - b.at)) if (!firstRead.has(l.token.toLowerCase())) firstRead.set(l.token.toLowerCase(), l);
// The holder read's bundle verdict, from the research log, by symbol (the first one).
const bundled = new Map<string, boolean>();
if (RESEARCH && existsSync(RESEARCH)) {
  const items = (JSON.parse(readFileSync(RESEARCH, "utf8")) as { items: Array<{ kind: string; symbol: string; ok: boolean | null; line: string; at: number }> }).items.sort((a, b) => a.at - b.at);
  for (const r of items) if (r.kind === "holders" && !bundled.has(r.symbol)) bundled.set(r.symbol, r.ok === false && /bundled/.test(r.line));
}
const tapes = new Map<string, SwapRow[]>();
for (const f of readdirSync(join(DIR, "tape"))) {
  if (!f.endsWith(".jsonl")) continue;
  const rows = readFileSync(join(DIR, "tape", f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as SwapRow; } catch { return null; } }).filter((r): r is SwapRow => !!r && r.price > 0).sort((a, b) => a.at - b.at);
  if (rows.length) tapes.set(f.replace(".jsonl", "").toLowerCase(), rows);
}
const priceAt = (rows: SwapRow[], t: number) => { let p: number | null = null; for (const r of rows) { if (r.at > t) break; p = r.price; } return p; };
const ret = (a: number, b: number | null) => (b == null ? null : ((b - a) / a) * 100);
/** A $25 ticket under the desk's exits: floor 10, all out at +15, two hours; 4% a side. */
function ticket(rows: SwapRow[], t: number, px: number): { pct: number; exit: string } {
  const fee = 4;
  for (const r of rows) {
    if (r.at <= t) continue;
    const pct = ((r.price - px) / px) * 100;
    if (pct <= -10) return { pct: pct - 2 * fee, exit: "floor" };
    if (pct >= 15) return { pct: pct - 2 * fee, exit: "take-profit" };
    if (r.at > t + 120 * 60e3) return { pct: pct - 2 * fee, exit: "time stop" };
  }
  const last = rows[rows.length - 1];
  return { pct: ((last.price - px) / px) * 100 - 2 * fee, exit: "open" };
}
interface Out { symbol: string; dev: number | null; exempt: number; score: number | null; ok: boolean; bundled: boolean | null; ageMin: number | null; r30: number | null; r60: number | null; max60: number; min60: number; ticket: number; exit: string }
const out: Out[] = [];
for (const l of firstRead.values()) {
  const sym = pairSymbolOf(l.pairToken ?? "");
  const id = curvePoolIdFor(l.token.toLowerCase() as `0x${string}`, sym, sym ? null : (l.pairToken as `0x${string}` | null));
  const rows = id ? tapes.get(id.toLowerCase()) : undefined;
  if (!rows || rows.length < 10) continue;
  const t = l.at;
  const px = priceAt(rows, t);
  if (px == null) continue;
  const fwd = rows.filter((r) => r.at > t && r.at <= t + 60 * 60e3).map((r) => r.price);
  if (fwd.length < 5) continue;
  const tk = ticket(rows, t, px);
  out.push({ symbol: l.symbol, dev: l.devSharePct, exempt: l.exemptions?.length ?? 0, score: l.score?.total ?? null, ok: l.verdict.ok, bundled: bundled.get(l.symbol) ?? null, ageMin: rows[0].at ? (t - rows[0].at) / 60e3 : null, r30: ret(px, priceAt(rows, t + 30 * 60e3)), r60: ret(px, priceAt(rows, t + 60 * 60e3)), max60: ret(px, Math.max(...fwd))!, min60: ret(px, Math.min(...fwd))!, ticket: tk.pct, exit: tk.exit });
}
const f = (x: number | null) => (x == null ? "  n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(0)}%`.padStart(6));
console.log(`${firstRead.size} launches read, ${out.length} with a tape from the read onward`);
console.log("symbol        dev%  exempt score gate bundled age   +30m   +60m  max60  min60 | $25 ticket");
for (const o of out.sort((a, b) => (b.max60 ?? 0) - (a.max60 ?? 0))) console.log(`${o.symbol.padEnd(12)} ${o.dev == null ? " n/a" : o.dev.toFixed(1).padStart(4)}  ${String(o.exempt).padStart(6)} ${String(o.score ?? "n/a").padStart(5)} ${o.ok ? "ok  " : "FAIL"} ${o.bundled == null ? "  ?    " : o.bundled ? "yes    " : "no     "} ${o.ageMin == null ? " n/a" : `${o.ageMin.toFixed(0)}m`.padStart(4)} ${f(o.r30)} ${f(o.r60)} ${f(o.max60)} ${f(o.min60)} | ${f(o.ticket)} ${o.exit}`);
const group = (name: string, g: Out[]) => {
  if (!g.length) return;
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  console.log(`  ${name.padEnd(34)} n=${String(g.length).padStart(2)}  reached +50% in 60m ${g.filter((o) => o.max60 >= 50).length}/${g.length}  fell 50% ${g.filter((o) => o.min60 <= -50).length}/${g.length}  median +60m ${f(med(g.map((o) => o.r60 ?? 0)))}  $25 ticket sum ${f(g.reduce((s, o) => s + o.ticket, 0))} winners ${g.filter((o) => o.ticket > 0).length}`);
};
console.log("\nby the gate:");
group("launch read ok", out.filter((o) => o.ok));
group("launch read FAIL", out.filter((o) => !o.ok));
group("dev buy <= 12%", out.filter((o) => o.dev != null && o.dev <= 12));
group("dev buy > 12%", out.filter((o) => o.dev != null && o.dev > 12));
group("no exempt wallets", out.filter((o) => o.exempt === 0));
group("exempt wallets (a declared bundle)", out.filter((o) => o.exempt > 0));
group("holders: bundled", out.filter((o) => o.bundled === true));
group("holders: not bundled", out.filter((o) => o.bundled === false));
group("score >= 60", out.filter((o) => (o.score ?? 0) >= 60));
group("score < 60", out.filter((o) => o.score != null && o.score < 60));
