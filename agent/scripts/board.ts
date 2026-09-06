// The desk's candidate board as the rules would build it from a feed file,
// at several age floors side by side. Reads the feed directly (no cache), so
// each floor is parsed fresh. For looking at what the desk could trade
// tonight before touching a variable.
//   npm run board -- [feed path]    (defaults to OBS_CANDIDATE_FEED)
import { openSync, readSync, fstatSync, closeSync } from "node:fs";
import { parseFeed, gradeCandidate, gradeRulesFromEnv } from "../src/desk/candidates.ts";
import { stabilityRulesFromEnv } from "../src/desk/stability.ts";

const path = process.argv[2] ?? process.env.OBS_CANDIDATE_FEED ?? "";
if (!path) { console.error("no feed path: pass one or set OBS_CANDIDATE_FEED"); process.exit(1); }
const tailMb = Number(process.env.OBS_FEED_TAIL_MB ?? 24);
const fd = openSync(path, "r");
let text: string;
try {
  const size = fstatSync(fd).size, want = tailMb * 1024 * 1024, start = Math.max(0, size - want);
  const buf = Buffer.alloc(size - start);
  readSync(fd, buf, 0, buf.length, start);
  text = buf.toString("utf8");
  if (start > 0) text = text.slice(text.indexOf("\n") + 1);
} finally { closeSync(fd); }

const now = Date.now();
const env = { ...process.env, OBS_CANDIDATE_REQUIRE_STABLE: "on" } as NodeJS.ProcessEnv;
const r = gradeRulesFromEnv(env);
for (const floorH of [24, 20, 12, 0]) {
  const snap = parseFeed(text, now, { maxAgeMs: 6 * 3600e3, minTokenAgeMs: floorH * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 0, stable: stabilityRulesFromEnv(env) });
  const rows = snap.candidates.map((c) => {
    const g = gradeCandidate(c, snap.hourly[c.poolId.toLowerCase()] ?? [], null, r);
    return { sym: c.symbol, hour: c.hour, rowAgeH: (now - c.at) / 3600e3, vol: c.volUsd, senders: c.senders, stable: c.stable?.stable ?? null, why: c.stable?.why ?? "no stability read", grade: g.grade };
  });
  console.log(`\n== floor ${floorH} h: ${rows.length} candidates, ${rows.filter((x) => x.stable).length} stable, ${rows.filter((x) => x.grade).length} graded`);
  for (const x of rows.filter((x) => x.stable).sort((a, b) => b.vol - a.vol).slice(0, 12)) console.log(`  ${x.sym.padEnd(10)} hour ${String(x.hour).padStart(2)} row ${x.rowAgeH.toFixed(1)}h  $${Math.round(x.vol).toLocaleString("en-US").padStart(9)}/h  ${String(x.senders).padStart(3)} senders  grade ${x.grade ?? "-"}  ${x.why.slice(0, 100)}`);
  if (floorH === 0) {
    console.log("  not stable, top by volume:");
    for (const x of rows.filter((x) => !x.stable).sort((a, b) => b.vol - a.vol).slice(0, 8)) console.log(`  ${x.sym.padEnd(10)} hour ${String(x.hour).padStart(2)} row ${x.rowAgeH.toFixed(1)}h  $${Math.round(x.vol).toLocaleString("en-US").padStart(9)}/h  ${String(x.senders).padStart(3)} senders  ${x.why.slice(0, 110)}`);
  }
}
