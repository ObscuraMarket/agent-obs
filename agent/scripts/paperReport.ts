// The paper session marked to market: every paper trade, the paper book
// against the real one at current prices, what the trades changed, and the
// route cost they paid. `npm run paper:report`.
import { readPaper, paperReport } from "../src/desk/paper.ts";
import { readBook } from "../src/desk/book.ts";
import { liveReads, walletBalances, assetPrices } from "../src/obscura/reads.ts";
const reads = await liveReads();
const chain = reads.wallet ? walletBalances(reads.wallet).bySymbol : {};
const paper = readPaper();
const book = readBook();
const symbols = [...new Set([...Object.keys(chain), ...paper.flatMap((t) => [t.from.asset, t.to.asset])])];
const prices = await assetPrices(symbols, { OBS: reads.market?.priceUsd ?? null });
const r = paperReport(chain, prices, paper, book.flows, book.trades);
const usd = (v: number | null | undefined) => (v == null ? "n/a" : Math.abs(v) >= 1 || v === 0 ? `$${v.toFixed(2)}` : `$${v.toPrecision(3)}`);
const when = (ts: number) => new Date(ts).toISOString().slice(5, 16).replace("T", " ");
console.log(`paper session: ${r.trades.length} trade${r.trades.length === 1 ? "" : "s"}`);
for (const t of r.trades) console.log(`  ${when(t.at)}  ${t.from.amount} ${t.from.asset} -> ${t.to.amount} ${t.to.asset}  ${t.from.usd != null ? `(${usd(t.from.usd)} in${t.to.usd != null ? `, ${usd(t.to.usd)} out` : ""})` : ""}  ${t.note ?? ""}`);
console.log(`\nreal book now:   ${usd(r.realEquityUsd)}`);
console.log(`paper book now:  ${usd(r.paperEquityUsd)}  (${Object.entries(r.holdings).map(([s, q]) => `${q.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${s}`).join(", ") || "empty"})`);
console.log(`effect of the paper trades: ${r.effectUsd == null ? "n/a" : (r.effectUsd >= 0 ? "+" : "") + usd(r.effectUsd)}  (route cost paid ${usd(r.feesUsd)})`);
if (r.unpriced.length) console.log(`unpriced: ${r.unpriced.join(", ")}`);
if (r.positions.length) {
  console.log("\npaper positions:");
  for (const p of r.positions) console.log(`  ${p.asset.padEnd(8)} ${p.qty.toLocaleString("en-US", { maximumFractionDigits: 6 }).padStart(16)}  value ${usd(p.valueUsd).padStart(10)}  avg cost ${p.avgCostUsd == null ? "n/a" : usd(p.avgCostUsd)}  unrealized ${p.unrealizedUsd == null ? "n/a" : (p.unrealizedUsd >= 0 ? "+" : "") + usd(p.unrealizedUsd)}${p.unrealizedPct != null ? ` (${(p.unrealizedPct * 100).toFixed(2)}%)` : ""}`);
}
