// Simulate the on-chain lane without a key: route, live pool quote, the
// encoded router call, and an eth_call of it from the desk's own wallet.
// `npm run swap:probe -- 0.01 ETH NVDA`. Nothing is signed or sent.
import { resolveAsset } from "../src/desk/assets.ts";
import { quoteOnChain, encodeSwap, ensureAllowancesNeeded } from "../src/desk/onchain.ts";
import { simulateFromWallet } from "../src/desk/signer.ts";
import { WALLET_ADDRESS } from "../src/config.ts";
const [amountArg, fromArg = "ETH", toArg = "NVDA"] = process.argv.slice(2);
const amount = Number(amountArg ?? 0.01);
const from = resolveAsset(`${fromArg}@robinhood`), to = resolveAsset(`${toArg}@robinhood`);
if (!from || !to) { console.error("assets must be on Robinhood Chain: ETH, NVDA, USDG"); process.exit(1); }
const q = await quoteOnChain(from, to, amount);
if (!q) { console.error("no route or the pools did not answer"); process.exit(1); }
console.log(`route: ${q.route.hops.map((h) => h.key).join(" then ")}`);
for (const p of q.pools) console.log(`  ${p.key}: $${p.read.priceUsd.toFixed(4)} per unit, 2% depth $${p.read.depthUsd2pct.toFixed(0)}, fee ${p.read.feePct}%`);
console.log(`quote: ${amount} ${from.symbol} -> ${q.amountOut} ${to.symbol} (floor ${q.minOut}); fees ${q.feePct.toFixed(3)}%, all-in cost vs mark ${q.costPct?.toFixed(3)}%`);
const tx = encodeSwap(q.route, q.amountInRaw, q.minOutRaw, WALLET_ADDRESS as `0x${string}`, BigInt(Math.floor(Date.now() / 1000) + 1200));
console.log(`call: to ${tx.to}, value ${tx.value} wei, data ${tx.data.length / 2 - 1} bytes`);
const need = await ensureAllowancesNeeded(from, q.amountInRaw);
if (need.length) console.log(`before a real send, the wallet would first need: ${need.join("; ")}`);
const sim = await simulateFromWallet(from, tx);
console.log(sim.ok ? "simulation from the wallet: OK (the router accepts this call)" : `simulation from the wallet: REVERT: ${sim.reason}`);
