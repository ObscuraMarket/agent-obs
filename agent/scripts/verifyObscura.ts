// Are Obscura's swaps working? Asks the same three sources a swap can come from, for the same pairs, and compares:
//   the routing backend (api.obscura.market, the partners), the way the app and the desk call it;
//   Relay, the app's "Private route", the door the app uses for ETH and USDG on Robinhood Chain;
//   the pools on Robinhood Chain, quoted by the desk's own router, which is where every such swap settles.
// Read-only. `npm run obscura:verify`. With `--order` (and OBS_TRADING=on) it also creates one real order on the
// backend at the partner's minimum, reads it back and checks the deposit address, and sends nothing to it.
import "../src/config.ts";
import { API_URL, SITE_URL, WALLET_ADDRESS } from "../src/config.ts";
import { currencies, quoteRaw, createOrder, orderStatus, callRaw } from "../src/obscura/orders.ts";
import { relayQuote } from "../src/obscura/relay.ts";
import { quoteOnChain } from "../src/desk/onchain.ts";
import { resolveAsset, type Asset } from "../src/desk/assets.ts";
import { depositAddressLooksRight } from "../src/desk/rails.ts";
import { appRouteFor, tableLines, verdicts, type PairCheck } from "../src/obscura/verify.ts";

const wantOrder = process.argv.includes("--order");
const PAIRS: Array<[string, string, number]> = [
  ["ETH@robinhood", "USDG@robinhood", 0.05],
  ["USDG@robinhood", "ETH@robinhood", 100],
  ["ETH@robinhood", "NVDA@robinhood", 0.05],
  ["USDG@robinhood", "NVDA@robinhood", 100],
  ["NVDA@robinhood", "ETH@robinhood", 0.5],
  ["NVDA@robinhood", "USDG@robinhood", 0.5],
  ["ETH@robinhood", "USDC@erc20", 0.05],
  ["ETH@eth", "NVDA@robinhood", 0.05],
  ["ETH@eth", "USDC@erc20", 0.05],
];
const user = WALLET_ADDRESS || "0x000000000000000000000000000000000000dEaD";

console.log(`backend ${API_URL}`);
const health = await callRaw("/health", { method: "GET" });
console.log(`  health: ${health.status === 200 ? JSON.stringify(health.body) : health.error ?? `HTTP ${health.status}`}`);
const list = await currencies();
const rh = list.filter((c) => c.network === "robinhood");
console.log(`  currencies: ${list.length} listed, on Robinhood Chain: ${rh.map((c) => c.code).join(", ") || "none"}`);
console.log(`  ETH and USDG on Robinhood Chain are ${rh.some((c) => c.code === "eth") ? "listed" : "not listed"}: the app adds them itself and routes them through Relay.`);

const checks: PairCheck[] = [];
for (const [f, t, amount] of PAIRS) {
  const from = resolveAsset(f) as Asset;
  const to = resolveAsset(t) as Asset;
  if (!from || !to) continue;
  const both = from.chain === "robinhood" && to.chain === "robinhood";
  const anyRh = from.chain === "robinhood" || to.chain === "robinhood";
  const [b, r, p] = await Promise.all([
    quoteRaw({ code: from.code, network: from.network }, { code: to.code, network: to.network }, amount),
    anyRh ? relayQuote(from, to, amount, user) : Promise.resolve(null),
    both ? quoteOnChain(from, to, amount).catch(() => null) : Promise.resolve(null),
  ]);
  const best = b.quotes[0];
  checks.push({
    pair: `${f} -> ${t}`,
    from: f,
    to: t,
    amount,
    backend: { status: b.status, count: b.quotes.length, partner: best?.partner ?? null, toAmount: best?.toAmount ?? null, min: best ? Number(best.raw.min) || null : null, max: best ? Number(best.raw.max) || null : null, error: b.error },
    relay: r ? { status: r.status, toAmount: r.quote?.amountOut ?? null, impactPct: r.quote?.impactPct ?? null, feeUsd: r.quote?.feeUsd ?? null, error: r.error } : null,
    pool: p ? { toAmount: p.amountOut, costPct: p.costPct } : null,
    appRoute: appRouteFor(from, to),
  });
}
console.log("\nfor the same pair, what each door pays (the spread is against the pool):");
for (const l of tableLines(checks)) console.log("  " + l);
console.log("\nverdicts:");
for (const l of verdicts(checks)) console.log("  " + l);

if (wantOrder) {
  console.log("\norder check (one real order on the backend, nothing sent to it):");
  const from = resolveAsset("ETH@robinhood") as Asset;
  const to = resolveAsset("NVDA@robinhood") as Asset;
  const c = checks.find((x) => x.from === "ETH@robinhood" && x.to === "NVDA@robinhood");
  if (!c || c.backend.partner == null) {
    console.log("  no backend quote for ETH@robinhood -> NVDA@robinhood to order against");
  } else if (!WALLET_ADDRESS) {
    console.log("  OBS_WALLET_ADDRESS is not set; the order needs a receiving address of ours");
  } else {
    const amount = Math.max(0.001, (c.backend.min ?? 0) * 1.2);
    const q = await quoteRaw({ code: from.code, network: from.network }, { code: to.code, network: to.network }, amount);
    const best = q.quotes[0];
    if (!best) {
      console.log(`  the backend gave no quote at ${amount} ETH (${q.error ?? "empty"})`);
    } else {
      const order = await createOrder({ from: { code: from.code, network: from.network }, to: { code: to.code, network: to.network }, amount, address: WALLET_ADDRESS, partner: best.partner, fixed: best.fixed, cexId: best.cexId });
      if (!order) {
        console.log(`  the backend did not create the order for ${amount} ETH -> NVDA via ${best.partner}`);
      } else {
        const s = await orderStatus(order.id);
        console.log(`  order ${order.id} via ${best.partner}: ${s ? `status ${s.status}` : "created, but its status could not be read"}`);
        if (s) {
          const mask = (a: string | null) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "none");
          console.log(`  expects ${s.from.amount ?? "?"} ${s.from.currency ?? from.symbol} at deposit address ${mask(s.from.address)} (${depositAddressLooksRight(s.from.address, from) ? "looks like a Robinhood Chain address" : "does NOT look like a Robinhood Chain address"})`);
          console.log(`  amount ${s.from.amount != null && Math.abs(s.from.amount - amount) / amount <= 0.001 ? "matches" : "does not match"} the ${amount} asked; quoted ${best.toAmount} ${to.symbol}`);
          console.log(`  track: ${SITE_URL}/exchange/${order.id}`);
          console.log("  nothing was sent to the deposit address; an unfunded order expires on its own.");
        }
      }
    }
  }
}
