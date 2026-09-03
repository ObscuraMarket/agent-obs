// One paper trade, chosen by the operator, through the same rails, quote,
// cost floor and wallet simulation as a paper session, recorded in the paper
// ledger. `npm run paper:trade -- 0.05 ETH NVDA`. Nothing is sent.
import { resolveAny, readFeed, tokenInfo } from "../src/desk/candidates.ts";
import { railsFromEnv, checkCandidate, sentTodayUsd } from "../src/desk/rails.ts";
import { readPaper, paperBalances, paperByKey, paperExecute } from "../src/desk/paper.ts";
import { liveReads, walletBalances, assetPrices } from "../src/obscura/reads.ts";
import { readBook } from "../src/desk/book.ts";
const [amountArg, fromArg = "ETH", toArg = "NVDA"] = process.argv.slice(2);
const feed = readFeed();
// Bare symbols mean Robinhood Chain here; that is the only chain the desk trades on.
const onChain = (spec: string) => (spec.includes("@") ? spec : `${spec}@robinhood`);
const from = resolveAny(onChain(fromArg), feed);
const to = resolveAny(onChain(toArg), feed);
if (!from || !to) { console.error(`unknown asset: ${!from ? fromArg : toArg}`); process.exit(1); }
const reads = await liveReads();
if (!reads.wallet) { console.error("no wallet configured"); process.exit(1); }
const real = walletBalances(reads.wallet);
const paper = readPaper();
const bySymbol = paperBalances(real.bySymbol, paper);
const byKey = paperByKey(real.byKey, bySymbol);
const prices = await assetPrices([from.symbol, to.symbol], { OBS: reads.market?.priceUsd ?? null });
let amount = Number(amountArg);
const px = prices[from.symbol] ?? null;
let usd = px != null ? amount * px : null;
const rails = railsFromEnv();
const heldCandidates = Object.keys(bySymbol).filter((s) => !!resolveAny(`${s}@robinhood`, feed)?.candidate);
const gate = checkCandidate({ from, to, amount, usd }, to.contract ? tokenInfo(to.contract) : null, heldCandidates, rails);
if (!gate.ok) { console.log(`refused before the rails: ${gate.reason}`); process.exit(0); }
if (gate.maxUsd != null && usd != null && usd > gate.maxUsd) {
  amount = Number(((amount * gate.maxUsd) / usd).toPrecision(6));
  usd = gate.maxUsd;
  console.log(`sized down to a $${gate.maxUsd} probe: ${to.symbol} has no proven sell yet -> ${amount} ${from.symbol}`);
}
const now = Date.now();
const ctx = { rails, balances: byKey, nativeOnFromChain: byKey["ETH@robinhood"] ?? null, openOrders: 0, sentTodayUsd: sentTodayUsd([...readBook().trades, ...paper], now) };
const r = await paperExecute({ from, to, amount, usd, exit: !!from.candidate }, ctx, real.bySymbol, now);
if (!r.ok) { console.log(`refused: ${r.reason}`); process.exit(0); }
console.log(`paper trade ${r.trade.id}: ${r.trade.from.amount} ${r.trade.from.asset} (${usd == null ? "unpriced" : `$${usd.toFixed(2)}`}) -> ${r.trade.to.amount} ${r.trade.to.asset}${r.trade.to.usd != null ? ` ($${r.trade.to.usd.toFixed(2)})` : ""}`);
console.log(`  ${r.trade.note}`);
