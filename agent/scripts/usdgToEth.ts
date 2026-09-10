// Swap every USDG in the desk's wallet back to ETH, the book's base, through the desk's own router as one user
// operation, the way an exit goes. For the operator: on 2026-09-10 the fomo app sold the desk's MGARD together
// with the operator's own and paid USDG to the app's cash contract, which only the app can move; once the operator
// withdraws that cash into the wallet, this puts it back into the ETH stake (profits stay in ETH, operator's rule).
//   npm run usdg:sweep            reads the balance, quotes, checks the rails; nothing sent
//   npm run usdg:sweep -- --now   sends it
// The trading switch is treated as on for this one call, as paper and the probe do; every other rail applies as
// written except the per-swap cap, lifted to the balance, since this is the whole balance leaving a parking asset.
import { resolveAsset, assetKey } from "../src/desk/assets.ts";
import { railsFromEnv, checkRails } from "../src/desk/rails.ts";
import { railView } from "../src/desk/aa.ts";
import { executeOnChain, quoteOnChain } from "../src/desk/onchain.ts";
import { readTokenBalance } from "../src/desk/signer.ts";
import { liveReads, walletBalances } from "../src/obscura/reads.ts";
import { WALLET_ADDRESS, USDG_CONTRACT } from "../src/config.ts";

const live = process.argv.includes("--now");
const fail = (why: string): never => { console.error(why); process.exit(1); };
const usdg = resolveAsset("USDG@robinhood") ?? fail("USDG is not registered");
const eth = resolveAsset("ETH@robinhood") ?? fail("ETH is not registered");
const desk = WALLET_ADDRESS as `0x${string}`;
if (!desk) fail("no OBS_WALLET_ADDRESS configured");

const raw = await readTokenBalance(usdg, USDG_CONTRACT as `0x${string}`, desk);
const amount = Number(raw) / 10 ** usdg.decimals;
console.log(`USDG in the wallet: ${amount.toFixed(2)}`);
if (!(amount >= 1)) { console.log("under $1 of USDG here; nothing to swap"); process.exit(0); }

const q = await quoteOnChain(usdg, eth, amount);
if (!q) fail("no pool route from USDG to ETH, or the pools did not answer");
console.log(`quote: ${q.route.hops.map((h) => h.key).join(" then ")}; ${amount.toFixed(2)} USDG -> ${q.amountOut} ETH (floor ${q.minOut}); fees ${q.feePct.toFixed(2)}%, all-in cost vs mark ${q.costPct?.toFixed(2) ?? "?"}%`);

const reads = await liveReads();
if (!reads.wallet) fail("the wallet could not be read");
const real = walletBalances(reads.wallet);
const base = railsFromEnv();
const rails = { ...base, tradingOn: true, maxSwapUsd: Math.max(base.maxSwapUsd, Math.ceil(amount) + 1) };
const now = Date.now();
const ctx = { rails, ...(await railView({ ...real.byKey, [assetKey(usdg)]: amount })), openOrders: 0, lastEntryAt: null, now };
const intent = { from: usdg, to: eth, amount, usd: amount };
const gate = checkRails(intent, ctx);
console.log(gate.ok ? "rails: pass" : `rails: REFUSED: ${gate.reason}`);
if (!gate.ok) process.exit(1);
if (!live) { console.log("\nnothing sent. Add --now to send it."); process.exit(0); }

const r = await executeOnChain(intent, ctx, now);
if (!r.ok) fail(`SWAP REFUSED: ${r.reason}`);
console.log(`swap ${r.trade.id}: ${r.trade.status}${r.trade.explorerUrl ? ` ${r.trade.explorerUrl}` : ""}`);
console.log(`  ${r.trade.note}`);
if (r.trade.status !== "settled") fail("the swap did not settle inside the lane's wait; read the ledger before running again");
// The ETH comes back native and the app wallet keeps its ETH as WETH: it sweeps native into WETH on its own within
// about twenty seconds, so the WETH figure a moment later is the one the book reads.
await new Promise((res) => setTimeout(res, 30_000));
const after = await liveReads();
console.log(`received ${r.trade.to.amount} ETH; wallet now ${after.wallet?.wethRobinhood ?? "?"} WETH plus ${after.wallet?.ethRobinhood ?? "?"} native ETH`);
