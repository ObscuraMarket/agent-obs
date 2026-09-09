// Close a held token by hand: sell all of it back to ETH through the same
// lane the rails use, with the same records (the trade row, the close in
// the trade memory), and the reason written down. For a position a rule
// change stranded, or one the operator wants out of. Run inside the desk
// (it needs the key) as the desk's own user.
//   npx tsx scripts/closePosition.ts <SYMBOL> "<reason>" [--dry]
//
// The followers leave with the desk. Every agent that holds the token bought it because the desk did, and it sells
// only when the desk sells: an operator close that skipped the mirror left every follower in the token after the
// desk was out (audit, 2026-09-08). So after the desk's own sale this calls mirrorForFollowers the way cycle.ts
// does after a desk trade, the same share for each agent, each failure that agent's note and the operator's alert.
// The mirror runs only where the agent wallet seed is (OBS_AGENT_WALLET_SEED; OBS_FOLLOW_LIVE gates entries alone
// since 2026-09-08, never an exit): from a shell without it the desk would sell and every follower would stay in
// the token with no line printed (review, 2026-09-08), so a follower held by the ledger and no mirror here stops
// the script before anything is sent, unless --no-followers says the operator will sweep them another way.
//   npx tsx scripts/closePosition.ts <SYMBOL> "<reason>" [--dry] [--no-followers]
import { resolveAny, readFeed, isHolding } from "../src/desk/candidates.ts";
import { resolveAsset } from "../src/desk/assets.ts";
import { executeOnChain, rememberClose, quoteOnChain, latestEthUsd } from "../src/desk/onchain.ts";
import { mirrorForFollowers, mirrorLegOn } from "../src/desk/mirror.ts";
import { readFollow, readFollowTrades, liveHoldings } from "../src/desk/follow.ts";
import { ethUsdAt } from "../src/desk/trade-memory.ts";
import { readPrices } from "../src/desk/analysis.ts";
import { railsFromEnv } from "../src/desk/rails.ts";
import { railView } from "../src/desk/aa.ts";
import { liveReads, walletBalances, assetPrices } from "../src/obscura/reads.ts";
import { readBook, recordTrade, positions, boughtSymbols } from "../src/desk/book.ts";

const [symbolArg, reasonArg = "closed by the operator", ...flags] = process.argv.slice(2);
const dry = flags.includes("--dry");
const noFollowers = flags.includes("--no-followers");
if (!symbolArg) { console.error('usage: closePosition.ts <SYMBOL> "<reason>" [--dry] [--no-followers]'); process.exit(1); }
const symbol = symbolArg.toUpperCase();
const now = Date.now();
// The followers first, before a single read of the chain: a follower the ledger says holds the token must leave
// with the desk, and only a shell with the seed can make that happen (see the header).
const followRows = readFollowTrades();
const holders = [...new Set(readFollow().map((r) => r.address))].filter((a) => (liveHoldings(followRows, a)[symbol] ?? 0) > 0);
if (holders.length && !mirrorLegOn("exit")) {
  console.error(`[follow] mirror off here (no agent wallet seed): ${holders.length} follower${holders.length === 1 ? "" : "s"} hold${holders.length === 1 ? "s" : ""} ${symbol} by the ledger and will not be sold`);
  if (!noFollowers) { console.error("nothing sent; run this inside the desk, or pass --no-followers to close the desk's own position alone and sweep the followers another way"); process.exit(1); }
  console.error("--no-followers: closing the desk's own position alone");
} else if (holders.length) {
  console.log(`[follow] ${holders.length} follower${holders.length === 1 ? "" : "s"} hold${holders.length === 1 ? "s" : ""} ${symbol} by the ledger; each is mirrored after the desk's sale`);
}
const feed = readFeed(now);
const from = resolveAny(`${symbol}@robinhood`, feed);
const eth = resolveAsset("ETH@robinhood");
if (!from || !eth) { console.error(`${symbol} is not a token the desk knows`); process.exit(1); }
const reads = await liveReads();
const chain = reads.wallet ? walletBalances(reads.wallet) : null;
if (!chain) { console.error("the wallet did not read"); process.exit(1); }
const held = chain.bySymbol[symbol] ?? 0;
if (!isHolding(held)) { console.error(`the wallet holds ${held} ${symbol}: nothing to close`); process.exit(1); }
const book = readBook();
if (!boughtSymbols(book.trades).has(symbol)) { console.error(`${symbol} was never bought by the desk; an airdrop is never touched`); process.exit(1); }
const prices = await assetPrices([symbol, "ETH"], {});
const px = prices[symbol] ?? null;
const usd = px != null ? held * px : null;
const pos = positions(book.flows, book.trades, chain.bySymbol, prices).positions.find((p) => p.asset === symbol);
console.log(`${symbol}: ${held} held, marked ${usd != null ? `$${usd.toFixed(2)}` : "unpriced"}, cost ${pos?.costUsd != null ? `$${pos.costUsd.toFixed(2)}` : "unknown"}${pos?.unrealizedPct != null ? ` (${(pos.unrealizedPct * 100).toFixed(1)}%)` : ""}`);
const q = await quoteOnChain(from, eth, held);
if (!q) { console.error("no route to ETH, or the pools did not answer"); process.exit(1); }
console.log(`route ${q.route.hops.map((h) => h.key).join(" then ")}: expected ${q.amountOut} ETH, floor ${q.minOut}${q.costPct != null ? `, cost ${q.costPct.toFixed(2)}% against the mark` : ""}`);
if (dry) { console.log("dry: nothing sent"); process.exit(0); }
const ctx = { rails: railsFromEnv(), ...(await railView(chain.byKey)), openOrders: 0 };
const intent = { from, to: eth, amount: held, usd, exit: true };
const r = await executeOnChain(intent, ctx, now);
if (!r.ok) { console.error(`refused: ${r.reason}`); process.exit(1); }
const toUsd = r.trade.to.usd ?? (prices.ETH != null && r.trade.to.amount != null ? r.trade.to.amount * prices.ETH : null);
const row = { ...r.trade, to: { ...r.trade.to, usd: toUsd }, note: `exit (operator), ${reasonArg}; ${r.trade.note ?? ""}` };
recordTrade(row);
// The agents holding the token sell the same share (all of it here) from their own wallets; see the header.
await mirrorForFollowers(intent, row, held, now).catch((e) => console.error(`[follow] mirror: ${e instanceof Error ? e.message : String(e)}`));
const firstBuy = book.trades.filter((t) => t.to.asset === symbol && t.status === "settled").map((t) => t.at).sort()[0] ?? now;
const realized = (pos?.realizedUsd ?? 0) + (toUsd ?? 0) - (pos?.costUsd ?? 0);
if (row.status === "settled") rememberClose(symbol, from.contract ?? "", [...book.trades, row], ethUsdAt(readPrices(), latestEthUsd(now)), pos?.unrealizedPct != null ? pos.unrealizedPct * 100 : null, "operator", false, now);
console.log(`${row.status}: ${row.from.amount} ${symbol} -> ${row.to.amount} ETH${toUsd != null ? ` ($${toUsd.toFixed(2)})` : ""}, realized ${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}${row.settlementTx ? `, tx ${row.settlementTx}` : ""}`);
