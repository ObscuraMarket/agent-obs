// A token's life on its curve pool, minute by minute, with what the entry read
// would have said at each minute under the rules the desk runs. For looking at
// a play after the fact and asking why the desk did or did not take it.
//   npx tsx scripts/tapeProbe.ts <token> [quote=USDG] [minutes=60]
import { createPublicClient, http, parseAbi } from "viem";
import { RPC_URL } from "../src/config.ts";
import { curvePoolIdFor, curveKey } from "../src/desk/candidates.ts";
import { updateTape, tapeStats } from "../src/desk/tape.ts";
import { entryRead, entryRulesFromEnv } from "../src/desk/entry.ts";
import type { PoolSpec } from "../src/obscura/pools.ts";

const [tokenArg, quote = "USDG", minutesArg = "60"] = process.argv.slice(2);
if (!tokenArg) { console.error("usage: tapeProbe.ts <token> [quote] [minutes]"); process.exit(1); }
const token = tokenArg.toLowerCase() as `0x${string}`;
const minutes = Number(minutesArg);
const pub = createPublicClient({ transport: http(RPC_URL) });
const symbol = String(await pub.readContract({ address: token, abi: parseAbi(["function symbol() view returns (string)"]), functionName: "symbol" }).catch(() => "TOKEN"));
const id = curvePoolIdFor(token, quote, null);
if (!id) { console.error("no pool id for that quote"); process.exit(1); }
const key = await curveKey(id);
if (!key) { console.error(`no pool on chain for ${symbol}/${quote} (${id.slice(0, 12)})`); process.exit(1); }
const quoteIs0 = key.currency1.toLowerCase() === token;
const qd = quote === "USDG" ? 6 : 18;
const spec: PoolSpec = { venue: "uniswap-v4", id: key.poolId, token0: quoteIs0 ? quote : symbol, token1: quoteIs0 ? symbol : quote, decimals0: quoteIs0 ? qd : 18, decimals1: quoteIs0 ? 18 : qd, usdToken: quoteIs0 ? 0 : 1, feePct: 1, tickSpacing: key.tickSpacing, hooks: true, hookAddress: key.hooks, feePips: key.fee, quote };
const now = Date.now();
const rows = await updateTape(spec, symbol, now, minutes);
if (!rows.length) { console.log(`${symbol}: no swaps in the last ${minutes} min`); process.exit(0); }
const first = rows[0].at;
console.log(`${symbol}/${quote} pool ${key.poolId.slice(0, 14)}: ${rows.length} swaps from ${new Date(first).toISOString().slice(11, 19)}Z to ${new Date(rows[rows.length - 1].at).toISOString().slice(11, 19)}Z (${((now - first) / 60e3).toFixed(0)} min)`);
const rules = entryRulesFromEnv({ ...process.env, OBS_ENTRY_BREAKDOWN_PCT: process.env.OBS_ENTRY_BREAKDOWN_PCT ?? "5", OBS_ENTRY_BASE_RANGE_PCT: process.env.OBS_ENTRY_BASE_RANGE_PCT ?? "10", OBS_ENTRY_PICKUP_RATIO: process.env.OBS_ENTRY_PICKUP_RATIO ?? "1.5" });
console.log("min   open      high      low       close     chg%   vol$    buy%  swaps | entry read");
const p0 = rows[0].price;
for (let t = first; t < rows[rows.length - 1].at; t += 60e3) {
  const w = rows.filter((r) => r.at >= t && r.at < t + 60e3);
  if (!w.length) continue;
  const px = w.map((r) => r.price);
  const buys = w.filter((r) => r.side === "buy").reduce((s, r) => s + r.quoteAmount, 0);
  const all = w.reduce((s, r) => s + r.quoteAmount, 0);
  const upTo = rows.filter((r) => r.at < t + 60e3);
  const er = entryRead(upTo, symbol, t + 60e3, rules, false);
  const m = Math.round((t - first) / 60e3);
  const e = (v: number) => v.toExponential(2);
  console.log(`${String(m).padStart(3)}  ${e(px[0])}  ${e(Math.max(...px))}  ${e(Math.min(...px))}  ${e(px[px.length - 1])}  ${(((px[px.length - 1] - p0) / p0) * 100).toFixed(0).padStart(5)}%  ${Math.round(all).toString().padStart(6)}  ${all > 0 ? Math.round((buys / all) * 100) : 0}%  ${String(w.length).padStart(4)} | ${er.state}${er.ok ? " ENTRY" : ""}: ${er.why.slice(0, 90)}`);
}
const s = tapeStats(rows, symbol, now, 15);
console.log(`now: ${s.trend}, ${s.swaps} swaps in 15 min, buy pressure ${s.buyPressurePct?.toFixed(0)}%, ${s.offPeakPct?.toFixed(0)}% off its peak`);
