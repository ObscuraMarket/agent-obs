// A ledger correction, run inside the desk's container against its own data directory: drop equity snapshots from
// a window of bad marks (on 2026-09-08 a transfer outside the desk's trading put 25 minutes of wrong marks into the
// book and the chart doubled), and record capital that left or arrived outside a trade so the PnL line reads true.
// Every write is a copy first, then a temp file and a rename.
//
//   npx tsx scripts/ledgerFix.ts --drop-snapshots <fromMs> <toMs> --above <equityUsd>
//   npx tsx scripts/ledgerFix.ts --flow withdraw|deposit <asset> <amount> <usd> "<note>" [atMs]
//   both may be given in one call; --dry prints what would change and writes nothing.
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config.ts";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const at = (k: string) => args.indexOf(k);
const bookPath = join(DATA_DIR, "obs-book.jsonl");
const capitalPath = join(DATA_DIR, "obs-capital.jsonl");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let did = false;

const d = at("--drop-snapshots");
if (d >= 0) {
  const from = Number(args[d + 1]); const to = Number(args[d + 2]);
  const a = at("--above"); const above = a >= 0 ? Number(args[a + 1]) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) { console.error("--drop-snapshots needs <fromMs> <toMs>"); process.exit(2); }
  if (!existsSync(bookPath)) { console.error(`no ${bookPath}`); process.exit(2); }
  const lines = readFileSync(bookPath, "utf8").split("\n").filter(Boolean);
  const dropped: string[] = []; const kept: string[] = [];
  for (const l of lines) {
    let r: { at?: number; equityUsd?: number } = {};
    try { r = JSON.parse(l); } catch { kept.push(l); continue; }
    const inWindow = typeof r.at === "number" && r.at >= from && r.at <= to && (r.equityUsd ?? 0) > above;
    (inWindow ? dropped : kept).push(l);
  }
  for (const l of dropped) { const r = JSON.parse(l); console.log(`drop ${new Date(r.at).toISOString()} equity ${Math.round(r.equityUsd)}`); }
  console.log(`${dropped.length} snapshot${dropped.length === 1 ? "" : "s"} to drop of ${lines.length}`);
  if (!dry && dropped.length) {
    copyFileSync(bookPath, `${bookPath}.before-${stamp}`);
    writeFileSync(`${bookPath}.tmp`, kept.join("\n") + "\n");
    renameSync(`${bookPath}.tmp`, bookPath);
    console.log(`obs-book.jsonl rewritten; the original is obs-book.jsonl.before-${stamp}`);
    did = true;
  }
}

const f = at("--flow");
if (f >= 0) {
  const kind = args[f + 1]; const asset = args[f + 2]; const amount = Number(args[f + 3]); const usd = Number(args[f + 4]); const note = args[f + 5] ?? ""; const when = Number(args[f + 6]) || Date.now();
  if ((kind !== "withdraw" && kind !== "deposit") || !asset || !(amount > 0) || !Number.isFinite(usd)) { console.error("--flow needs withdraw|deposit <asset> <amount> <usd> \"<note>\" [atMs]"); process.exit(2); }
  const row = { at: when, kind, asset, amount, usd, note };
  console.log(`flow ${JSON.stringify(row)}`);
  if (!dry) { appendFileSync(capitalPath, JSON.stringify(row) + "\n"); console.log("obs-capital.jsonl appended"); did = true; }
}

if (d < 0 && f < 0) { console.error("nothing asked: --drop-snapshots or --flow"); process.exit(2); }
if (dry) console.log("dry run: nothing written");
else if (!did) console.log("nothing to write");
