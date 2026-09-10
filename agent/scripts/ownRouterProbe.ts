// Prove the desk's own router under account abstraction on BOTH legs, at a size that cannot hurt.
//   npm run own:probe -- BYCOCKET 5         quotes the buy, builds and simulates its user operation; nothing is sent
//   npm run own:probe -- BYCOCKET 5 --now   sends the $5 buy through the production lane, waits for it to settle,
//                                           then sells all of it back through the same lane; both rows are real and
//                                           land in the real ledger
// Why (2026-09-10): with OBS_ROUTE=own, the first live exit would have been the first token sell this wallet ever
// made through its own router as a user operation. Every one of its 31 sells had gone through fomo's route, and a
// sell that reverts on the own router is a position the floor cannot close. The lane runs exactly as it is (rails
// as set, the trading switch treated as on for this call the way a paper session does); nothing is hand-built.
import { resolveAny, readFeed, tokenInfo } from "../src/desk/candidates.ts";
import { resolveAsset, assetKey } from "../src/desk/assets.ts";
import { isHolding } from "../src/desk/book.ts";
import { railsFromEnv } from "../src/desk/rails.ts";
import { railView, swapBatch, buildUserOp, simulateUserOp, ethInPlan, spendableEthRaw, formatGasPlan, aaOn } from "../src/desk/aa.ts";
import { executeOnChain, quoteOnChain, encodeSwap } from "../src/desk/onchain.ts";
import { readTokenBalance } from "../src/desk/signer.ts";
import { liveReads, walletBalances, assetPrices } from "../src/obscura/reads.ts";
import { fomoOn } from "../src/desk/fomo.ts";
import { WALLET_ADDRESS } from "../src/config.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const live = process.argv.includes("--now");
const [toArg = "BYCOCKET", usdArg = "5"] = args;
const sizeUsd = Number(usdArg);
const fail = (why: string): never => { console.error(why); process.exit(1); };
if (!aaOn()) fail("OBS_EXEC is not aa: this probe proves the account-abstraction lane only");
if (fomoOn()) fail("OBS_ROUTE is fomo: this probe proves the desk's own router; set OBS_ROUTE=own first");
if (!(sizeUsd > 0 && sizeUsd <= 25)) fail("size must be between $0 and $25: this is a probe, not a trade");
if (!WALLET_ADDRESS) fail("no OBS_WALLET_ADDRESS configured");
const desk = WALLET_ADDRESS as `0x${string}`;

const feed = readFeed();
const eth = resolveAsset("ETH@robinhood");
const tok = resolveAny(`${toArg}@robinhood`, feed);
if (!eth) fail("ETH is not registered");
if (!tok || !tok.contract) fail(`${toArg} is not a token this desk knows on Robinhood Chain`);
const token = tok.contract as `0x${string}`;
const info = tokenInfo(token);
console.log(`${tok.symbol} ${token}: ${info?.proven === true ? "a sell is on record" : "no proven sell on record"}${info?.blacklisted ? ", BLACKLISTED" : ""}`);
if (info?.blacklisted) fail("blacklisted: pick another token");

const reads = await liveReads();
if (!reads.wallet) fail("the wallet could not be read");
const real = walletBalances(reads.wallet);
const prices = await assetPrices([eth.symbol, tok.symbol], { OBS: reads.market?.priceUsd ?? null });
const ethUsd = prices.ETH ?? reads.prices.ethUsd ?? null;
if (!(ethUsd != null && ethUsd > 0)) fail("ETH is unpriced right now");
const amountEth = Number((sizeUsd / ethUsd).toPrecision(6));
// The rails' balance view for a leg, from the wallet as read plus what this script knows landed since. The first run
// (2026-09-10) handed the sell the snapshot taken before the buy, and the rails refused it as "holds 0 BYCOCKET":
// the chain had the tokens, the context did not.
const rails = { ...railsFromEnv(), tradingOn: true };
const ctxWith = async (byKey: Record<string, number>, now: number) => ({ rails, ...(await railView(byKey)), openOrders: 0, lastEntryAt: null, now });
const balanceOf = async () => Number(await readTokenBalance(tok, token, desk)) / 10 ** tok.decimals;
// A balance already in the wallet (an earlier run that bought and could not sell) is sold as it is; no second buy.
const already = await balanceOf();
const skipBuy = isHolding(already);
if (skipBuy) console.log(`wallet already holds ${already} ${tok.symbol} from an earlier run; skipping the buy and selling that`);
else console.log(`wallet: ${real.bySymbol.ETH ?? 0} ETH on the book (native plus WETH); buying $${sizeUsd} = ${amountEth} ETH of ${tok.symbol} at $${ethUsd.toFixed(0)} an ETH`);

let got: number | null = null;
if (!skipBuy) {
  // The buy as the lane would send it: quote, WETH plan, batch, user operation, simulation through the entry point.
  const q = await quoteOnChain(eth, tok, amountEth);
  if (!q) fail("no pool route, or the pools did not answer");
  console.log(`buy quote: ${q.route.hops.map((h) => h.key).join(" then ")}; expected ${q.amountOut} ${tok.symbol}, floor ${q.minOut}; fees ${q.feePct.toFixed(2)}%, all-in cost vs mark ${q.costPct?.toFixed(2) ?? "?"}%`);
  const spend = await spendableEthRaw(desk);
  const plan = ethInPlan(q.amountInRaw, spend.native, spend.weth);
  const tx = encodeSwap(q.route, plan.amountInRaw, q.minOutRaw, desk, BigInt(Math.floor(Date.now() / 1000) + 1200));
  const calls = swapBatch({ tx, withdrawRaw: plan.withdrawRaw });
  const built = await buildUserOp(calls);
  console.log(`buy operation: ${calls.length} call${calls.length === 1 ? "" : "s"} (${plan.withdrawRaw > 0n ? "WETH.withdraw, then " : ""}the router); ${formatGasPlan(built.gas)}`);
  const sim = await simulateUserOp(built);
  console.log(sim.ok ? "buy simulation through the entry point: OK" : `buy simulation through the entry point: ${sim.reason}`);
  if (!sim.ok) fail("the buy would not go; nothing sent");
}
if (!live) {
  console.log(skipBuy ? "\nnothing sent. Add --now to sell what the wallet holds." : "\nnothing sent. Add --now to send the buy and then sell it back.");
  process.exit(0);
}

// The real round trip, through the production lane both ways.
if (!skipBuy) {
  const t0 = Date.now();
  const buy = await executeOnChain({ from: eth, to: tok, amount: amountEth, usd: sizeUsd }, await ctxWith(real.byKey, t0), t0);
  if (!buy.ok) fail(`BUY REFUSED: ${buy.reason}`);
  console.log(`buy ${buy.trade.id}: ${buy.trade.status}${buy.trade.explorerUrl ? ` ${buy.trade.explorerUrl}` : ""}`);
  console.log(`  ${buy.trade.note}`);
  if (buy.trade.status !== "settled") fail("the buy did not settle inside the lane's wait; the sell is not attempted. Read the ledger before running again.");
  got = buy.trade.to.amount;
}

// Sell everything the wallet holds, read from the chain now, and hand the rails a view that knows it is there. The
// lane clamps the exit to the wallet's exact raw balance, so this float is only a float.
const held = await balanceOf();
if (!isHolding(held)) fail(`the wallet holds ${held} ${tok.symbol}, nothing to sell`);
console.log(`wallet now holds ${held} ${tok.symbol}${got != null ? ` (the lane received ${got})` : ""}; selling all of it`);
const px = prices[tok.symbol] ?? null;
const t1 = Date.now();
const sell = await executeOnChain({ from: tok, to: eth, amount: held, usd: px != null ? held * px : sizeUsd, exit: true }, await ctxWith({ ...real.byKey, [assetKey(tok)]: held }, t1), t1);
if (!sell.ok) fail(`SELL REFUSED: ${sell.reason}\nThe wallet still holds ${held} ${tok.symbol}. This is the failure the probe exists to find; do not arm the desk on this route.`);
console.log(`sell ${sell.trade.id}: ${sell.trade.status}${sell.trade.explorerUrl ? ` ${sell.trade.explorerUrl}` : ""}`);
console.log(`  ${sell.trade.note}`);
if (sell.trade.status !== "settled") fail("the sell did not settle inside the lane's wait; read the ledger.");
const back = sell.trade.to.amount;
const left = await balanceOf();
console.log(got != null
  ? `\nround trip: ${amountEth} ETH -> ${got} ${tok.symbol} -> ${back} ETH, ${((back / amountEth - 1) * 100).toFixed(2)}%${left > 0 ? ` (${left} ${tok.symbol} left as dust)` : " (nothing left)"}`
  : `\nsold ${held} ${tok.symbol} -> ${back} ETH${left > 0 ? ` (${left} ${tok.symbol} left as dust)` : " (nothing left)"}`);
console.log("the desk's own router sells under account abstraction: PROVEN on chain");
