// The on-chain lane: a swap in the Uniswap v4 pools on Robinhood Chain from
// the desk's own wallet, through the chain's UniversalRouter. Every leg goes
// through USDG, because that is where the depth is: ETH/USDG at 0.01% and
// NVDA/USDG at 0.3%, both hookless, both in the chain memory with their pool
// ids. The output is estimated from the pool's own state (exact within the
// active tick, which is exact enough for a $25 trade against $70k of depth),
// the transaction is simulated from the wallet before anything is signed,
// and the minimum output is the estimate less the slippage allowance.
//
// This chain's router does NOT accept the standard v4-periphery swap
// encodings. The shape that lands here is the path-based SWAP_EXACT_IN with
// SETTLE and TAKE, and an ExactInputParams with an extra empty bytes field
// before the amounts, tuple-wrapped. It is encoded below and checked, in
// simulation, every time before it is sent.
import { encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from "viem";
import { chainMemory, poolRead, type PoolSpec, type PoolRead } from "../obscura/pools.ts";
import { ASSETS, assetKey, chainOf, type Asset } from "./assets.ts";
import { checkRails, type Intent, type RailContext } from "./rails.ts";
import { recordTrade, readBook, latestTrades, type Trade } from "./book.ts";
import { simulateFromWallet, sendTx, waitReceipt, readNativeBalance, readTokenBalance, readErc20Allowance, readPermit2Allowance, approveErc20Data, approvePermit2Data, type RawTx } from "./signer.ts";
import { WALLET_ADDRESS } from "../config.ts";
import { dynamicAssets, dynamicPoolSpec, readFeed, tokenInfo, upsertToken, exitVerdict, type FeedSnapshot } from "./candidates.ts";
import { readPrices } from "./analysis.ts";
import { positions } from "./book.ts";
import type { QuoteRead } from "./thoughts.ts";

export const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const Q96 = 2n ** 96n;
const ACTIONS = "0x070b0e" as const; // SWAP_EXACT_IN, SETTLE, TAKE
const V4_SWAP = "0x10" as const;
const ROUTER_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const SLIPPAGE_PCT = Number(process.env.OBS_SLIPPAGE_PCT ?? 1);

export interface Hop {
  key: string;
  spec: PoolSpec;
  /** True when the hop sells the pool's token0. */
  zeroForOne: boolean;
  currencyOut: `0x${string}`;
  fee: number;
  tickSpacing: number;
}
export interface Route {
  from: Asset;
  to: Asset;
  currencyIn: `0x${string}`;
  hops: Hop[];
}

/** The currency address of a registry asset on Robinhood Chain; native ETH is the zero address. */
export function currencyOf(a: Asset): `0x${string}` {
  return a.kind === "native" ? NATIVE : (a.contract as `0x${string}`);
}
const robinhood = (symbol: string, dyn: Record<string, Asset>): Asset | null => ASSETS[`${symbol}@robinhood`] ?? dyn[`${symbol}@robinhood`] ?? null;

/** The pool a dynamic token trades in, and the symbol on the other side of it. */
function dynamicSpec(symbol: string, dyn: Record<string, Asset>): { spec: PoolSpec; quote: string } | null {
  const a = dyn[`${symbol}@robinhood`];
  const spec = a ? dynamicPoolSpec(a) : null;
  return spec ? { spec, quote: spec.quote ?? "USDG" } : null;
}

/** PURE: the hop that sells `from` for `to`: a reference pool, a dynamic token's side pool, or its launch curve. Null when there is none. */
function hop(from: string, to: string, pools: Record<string, PoolSpec>, dyn: Record<string, Asset>): Hop | null {
  const out = robinhood(to, dyn);
  if (!out) return null;
  // A dynamic token's own pool wins over any reference pool: named "<token>/USDG" for a side pool, "<quote>/<token>" for a launch curve.
  const dynSym = dynamicSpec(to, dyn) ? to : dynamicSpec(from, dyn) ? from : null;
  const d = dynSym ? dynamicSpec(dynSym, dyn) : null;
  let key: string;
  let spec: PoolSpec | undefined;
  if (d && dynSym) {
    spec = d.spec;
    key = d.spec.hookAddress ? `${d.quote}/${dynSym}` : `${dynSym}/USDG`;
  } else {
    key = from === "USDG" ? `${to}/USDG` : `${from}/USDG`;
    spec = pools[key];
  }
  if (!spec || spec.venue !== "uniswap-v4") return null;
  if (spec.hooks && !spec.hookAddress) return null;
  if (spec.token0 !== from && spec.token1 !== from) return null;
  if (spec.token0 !== to && spec.token1 !== to) return null;
  return { key, spec, zeroForOne: spec.token0 === from, currencyOut: currencyOf(out), fee: spec.feePips ?? Math.round(spec.feePct * 10000), tickSpacing: spec.tickSpacing };
}

/** PURE: the legs from A to B. The hub is USDG; a launch token quoted in NVDA or ETH is reached through that quote first. */
function legsFor(from: string, to: string, dyn: Record<string, Asset>): string[][] {
  const quoteOf = (sym: string) => dynamicSpec(sym, dyn)?.quote ?? null;
  const qFrom = quoteOf(from);
  const qTo = quoteOf(to);
  if (qFrom && from !== "USDG") return [[from, qFrom], ...(qFrom === to ? [] : legsFor(qFrom, to, dyn))];
  if (qTo && to !== "USDG") return [...(from === qTo ? [] : legsFor(from, qTo, dyn)), [qTo, to]];
  if (from === to) return [];
  if (from === "USDG" || to === "USDG") return [[from, to]];
  return [[from, "USDG"], ["USDG", to]];
}

/** PURE: the route from A to B. Null when a leg has no pool. */
export function routeFor(from: Asset, to: Asset, pools: Record<string, PoolSpec> = chainMemory().referencePools, dyn: Record<string, Asset> = dynamicFor(from, to)): Route | null {
  if (from.chain !== "robinhood" || to.chain !== "robinhood" || from.symbol === to.symbol) return null;
  const hops: Hop[] = [];
  for (const [a, b] of legsFor(from.symbol, to.symbol, dyn)) {
    const h = hop(a, b, pools, dyn);
    if (!h) return null;
    hops.push(h);
  }
  return hops.length ? { from, to, currencyIn: currencyOf(from), hops } : null;
}

/** The dynamic assets a route may need: the legs themselves when they are candidates, else whatever the feed and the token file know. */
function dynamicFor(from: Asset, to: Asset): Record<string, Asset> {
  const own: Record<string, Asset> = {};
  for (const a of [from, to]) if (a.candidate) own[`${a.symbol}@robinhood`] = a;
  if (Object.keys(own).length) return own;
  try {
    return dynamicAssets();
  } catch {
    return {};
  }
}

/** PURE: exact-in output inside the active tick. Raw units; sqrtP is Q64.96; fee in pips of a million. */
export function exactInWithinTick(amountIn: bigint, sqrtP: bigint, liquidity: bigint, feePips: number, zeroForOne: boolean): { out: bigint; sqrtPAfter: bigint } {
  const x = (amountIn * BigInt(1_000_000 - feePips)) / 1_000_000n;
  if (liquidity <= 0n || sqrtP <= 0n || x <= 0n) return { out: 0n, sqrtPAfter: sqrtP };
  if (zeroForOne) {
    const sqrtPAfter = (liquidity * sqrtP * Q96) / (liquidity * Q96 + x * sqrtP);
    return { out: (liquidity * (sqrtP - sqrtPAfter)) / Q96, sqrtPAfter };
  }
  const sqrtPAfter = sqrtP + (x * Q96) / liquidity;
  return { out: (liquidity * (sqrtPAfter - sqrtP) * Q96) / (sqrtP * sqrtPAfter), sqrtPAfter };
}

export interface PoolQuote {
  route: Route;
  amountIn: number;
  amountOut: number;
  /** The estimate less the slippage allowance; the transaction's floor. */
  minOut: number;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  minOutRaw: bigint;
  /** Dollars per unit as the pools set them, for the from and to assets. */
  priceInUsd: number | null;
  priceOutUsd: number | null;
  /** What the route costs against the pools' own mid prices: fees plus impact. */
  costPct: number | null;
  feePct: number;
  pools: Array<{ key: string; read: PoolRead }>;
}

const toRaw = (v: number, decimals: number): bigint => BigInt(Math.round(v * 10 ** Math.min(decimals, 9))) * 10n ** BigInt(Math.max(decimals - 9, 0));
const fromRaw = (v: bigint, decimals: number): number => Number(v) / 10 ** decimals;

/** The route quoted from live pool state. Null when a pool did not answer. */
export async function quoteOnChain(from: Asset, to: Asset, amountIn: number, slippagePct = SLIPPAGE_PCT): Promise<PoolQuote | null> {
  const route = routeFor(from, to);
  if (!route || !(amountIn > 0)) return null;
  const pools: Array<{ key: string; read: PoolRead }> = [];
  let raw = toRaw(amountIn, from.decimals);
  for (const h of route.hops) {
    const read = await poolRead(h.spec);
    if (!read) return null;
    pools.push({ key: h.key, read });
    const feeForEstimate = h.spec.hookAddress ? Math.round(h.spec.feePct * 10000) : h.fee;
    raw = exactInWithinTick(raw, BigInt(read.sqrtPriceX96), BigInt(read.liquidity), feeForEstimate, h.zeroForOne).out;
  }
  const amountOutRaw = raw;
  // A curve's hook prices in ways the tick math cannot see; the floor sits wider there.
  const slip = route.hops.some((h) => h.spec.hookAddress) ? Math.max(slippagePct, Number(process.env.OBS_CURVE_SLIPPAGE_PCT ?? 8)) : slippagePct;
  const minOutRaw = (amountOutRaw * BigInt(Math.round((100 - slip) * 1000))) / 100_000n;
  const usdOf = (a: Asset): number | null => {
    if (a.symbol === "USDG") return 1;
    const p = pools.find((x) => x.key === `${a.symbol}/USDG`);
    if (p) return p.read.priceUsd;
    // A launch token quoted in NVDA or ETH: its pool price times that quote's dollar price from the same route.
    const own = pools.find((x) => x.key.split("/").includes(a.symbol) && x.key !== `${a.symbol}/USDG`);
    if (!own) return null;
    const quote = own.key.split("/").find((k) => k !== a.symbol) ?? "USDG";
    const qp = quote === "USDG" ? 1 : (pools.find((x) => x.key === `${quote}/USDG`)?.read.priceUsd ?? null);
    return qp == null ? null : own.read.priceUsd * qp;
  };
  const priceInUsd = usdOf(from);
  const priceOutUsd = usdOf(to);
  const amountOut = fromRaw(amountOutRaw, to.decimals);
  const costPct = priceInUsd != null && priceOutUsd != null && priceInUsd > 0 ? (1 - (amountOut * priceOutUsd) / (amountIn * priceInUsd)) * 100 : null;
  const feePct = (1 - route.hops.reduce((k, h) => k * (1 - h.fee / 1_000_000), 1)) * 100;
  return { route, amountIn, amountOut, minOut: fromRaw(minOutRaw, to.decimals), amountInRaw: toRaw(amountIn, from.decimals), amountOutRaw, minOutRaw, priceInUsd, priceOutUsd, costPct, feePct, pools };
}

/** PURE: the router call for a route, in the shape this chain's fork accepts. */
export function encodeSwap(route: Route, amountIn: bigint, minOut: bigint, recipient: `0x${string}`, deadline: bigint, router: `0x${string}` = chainMemory().contracts.uniswapV4.universalRouter as `0x${string}`): RawTx {
  const path = route.hops.map((h) => ({ intermediateCurrency: h.currencyOut, fee: h.fee, tickSpacing: h.tickSpacing, hooks: (h.spec.hookAddress ?? NATIVE) as `0x${string}`, hookData: "0x" as Hex }));
  const swap = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "currencyIn", type: "address" },
          {
            name: "path",
            type: "tuple[]",
            components: [
              { name: "intermediateCurrency", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
              { name: "hookData", type: "bytes" },
            ],
          },
          { name: "extra", type: "bytes" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
        ],
      },
    ],
    [{ currencyIn: route.currencyIn, path, extra: "0x", amountIn, amountOutMinimum: minOut }],
  );
  const currencyOut = route.hops[route.hops.length - 1].currencyOut;
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [route.currencyIn, 0n, true]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [currencyOut, recipient, 0n]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [ACTIONS, [swap, settle, take]]);
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "execute", args: [V4_SWAP, [input], deadline] });
  return { to: router, data, value: route.currencyIn === NATIVE ? amountIn : 0n };
}

/** The two one-time approvals an ERC-20 from-leg needs: token to Permit2, Permit2 to the router. Sends only what is missing. */
export async function ensureAllowances(from: Asset, amountRaw: bigint, now = Date.now()): Promise<string[]> {
  if (from.kind !== "erc20") return [];
  const c = chainMemory().contracts.uniswapV4;
  const token = from.contract as `0x${string}`;
  const permit2 = c.permit2 as `0x${string}`;
  const router = c.universalRouter as `0x${string}`;
  const sent: string[] = [];
  if ((await readErc20Allowance(from, token, permit2)) < amountRaw) {
    const hash = await sendTx(from, { to: token, data: approveErc20Data(permit2), value: 0n });
    const r = await waitReceipt(from, hash);
    if (!r || r.status !== "success") throw new Error(`token approval ${hash} did not land`);
    sent.push(hash);
  }
  const p = await readPermit2Allowance(from, permit2, token, router);
  const nowSec = Math.floor(now / 1000);
  if (p.amount < amountRaw || p.expiration <= nowSec) {
    const hash = await sendTx(from, { to: permit2, data: approvePermit2Data(token, router, nowSec + 365 * 86400), value: 0n });
    const r = await waitReceipt(from, hash);
    if (!r || r.status !== "success") throw new Error(`Permit2 approval ${hash} did not land`);
    sent.push(hash);
  }
  return sent;
}

/** What ensureAllowances would have to send, without sending it. For the probe. */
export async function ensureAllowancesNeeded(from: Asset, amountRaw: bigint, now = Date.now()): Promise<string[]> {
  if (from.kind !== "erc20") return [];
  const c = chainMemory().contracts.uniswapV4;
  const token = from.contract as `0x${string}`;
  const need: string[] = [];
  if ((await readErc20Allowance(from, token, c.permit2 as `0x${string}`)) < amountRaw) need.push(`${from.symbol}.approve(Permit2)`);
  const p = await readPermit2Allowance(from, c.permit2 as `0x${string}`, token, c.universalRouter as `0x${string}`);
  if (p.amount < amountRaw || p.expiration <= Math.floor(now / 1000)) need.push(`Permit2.approve(${from.symbol}, router)`);
  return need;
}

/** PURE: the most a route may cost against the pool mark, in percent. A launch token's pool charges its own tier each way, so its floor is that tier plus the ordinary allowance; everything else gets the ordinary allowance alone. */
export function costFloorPct(i: Intent, minFillRatio: number): number {
  const allowance = (1 - minFillRatio) * 100;
  const tier = Math.max(i.from.candidate?.tierPct ?? 0, i.to.candidate?.tierPct ?? 0);
  return allowance + tier;
}

export type OnChainResult = { ok: true; trade: Trade } | { ok: false; reason: string; trade?: Trade };

const balanceOf = (a: Asset): Promise<bigint> => (a.kind === "native" ? readNativeBalance(a) : readTokenBalance(a, a.contract as `0x${string}`));

/** The lane: rails, route, quote, floor, encode, simulate, approvals, send, receipt, the row. */
export async function executeOnChain(i: Intent, c: RailContext, now = Date.now()): Promise<OnChainResult> {
  const gate = checkRails(i, c);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const q = await quoteOnChain(i.from, i.to, i.amount);
  if (!q) return { ok: false, reason: `no pool route from ${assetKey(i.from)} to ${assetKey(i.to)}, or the pools did not answer` };
  const floor = costFloorPct(i, c.rails.minFillRatio);
  if (!i.exit && q.costPct != null && q.costPct > floor) return { ok: false, reason: `the pool route costs ${q.costPct.toFixed(2)}% against the mark; the floor is ${floor.toFixed(1)}%` };
  const deadline = BigInt(Math.floor(now / 1000) + 20 * 60);
  const tx = encodeSwap(q.route, q.amountInRaw, q.minOutRaw, WALLET_ADDRESS as `0x${string}`, deadline);
  let approvals: string[] = [];
  try {
    approvals = await ensureAllowances(i.from, q.amountInRaw, now);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const sim = await simulateFromWallet(i.from, tx);
  if (!sim.ok) return { ok: false, reason: `the swap would revert: ${sim.reason}` };
  const before = await balanceOf(i.to);
  const base: Trade = {
    at: now,
    id: `pool-${now}`,
    status: "pending",
    venue: "pool",
    ...(i.exit ? { exit: true } : {}),
    from: { asset: i.from.symbol, network: i.from.network, amount: i.amount, usd: i.usd },
    to: { asset: i.to.symbol, network: i.to.network, amount: q.amountOut, usd: q.priceOutUsd != null ? q.amountOut * q.priceOutUsd : null },
    partner: "pool",
    note: `${q.route.hops.map((h) => h.key).join(" then ")} on chain; expected ${q.amountOut} ${i.to.symbol}, floor ${q.minOut}${q.costPct != null ? `, route cost ${q.costPct.toFixed(2)}% (fees ${q.feePct.toFixed(2)}%)` : ""}${approvals.length ? `; approvals ${approvals.join(", ")}` : ""}`,
  };
  let hash: `0x${string}`;
  try {
    hash = await sendTx(i.from, tx);
  } catch (err) {
    const failed: Trade = { ...base, status: "failed", note: `not sent: ${err instanceof Error ? err.message : String(err)}` };
    recordTrade(failed);
    return { ok: false, reason: failed.note ?? "send failed", trade: failed };
  }
  const explorerUrl = chainOf(i.from).explorerTx(hash);
  const receipt = await waitReceipt(i.from, hash);
  if (!receipt) {
    const pending: Trade = { ...base, settlementTx: hash, explorerUrl, note: `${base.note}; sent, awaiting the receipt` };
    recordTrade(pending);
    return { ok: true, trade: pending };
  }
  if (receipt.status !== "success") {
    const failed: Trade = { ...base, status: "failed", updatedAt: Date.now(), settlementTx: hash, explorerUrl, note: `reverted on chain` };
    recordTrade(failed);
    return { ok: false, reason: `swap ${hash} reverted`, trade: failed };
  }
  const after = await balanceOf(i.to);
  let gotRaw = after - before;
  if (i.to.kind === "native") gotRaw += receipt.gasCostWei;
  const got = gotRaw > 0n ? fromRaw(gotRaw, i.to.decimals) : q.amountOut;
  const settled: Trade = {
    ...base,
    status: "settled",
    updatedAt: Date.now(),
    settlementTx: hash,
    explorerUrl,
    to: { ...base.to, amount: got, usd: q.priceOutUsd != null ? got * q.priceOutUsd : null },
    note: `${base.note}; received ${got} ${i.to.symbol}`,
  };
  recordTrade(settled);
  if (i.to.candidate && got > 0) {
    const proof = await proveSellable(i.to, gotRaw > 0n ? gotRaw : q.amountOutRaw, now);
    const withProof: Trade = { ...settled, note: `${settled.note}; ${proof}` };
    recordTrade(withProof);
    return { ok: true, trade: withProof };
  }
  return { ok: true, trade: settled };
}

/**
 * The probe rule's second half. Right after the first buy of a launch token
 * the desk grants the two approvals and simulates selling what it just got.
 * A token whose sell reverts is blacklisted (bounded cost: the probe) and
 * never bought again; one whose sell simulates is proven and may be sized
 * up to the ordinary cap on later cycles.
 */
export async function proveSellable(token: Asset, amountRaw: bigint, now = Date.now()): Promise<string> {
  const eth = ASSETS["ETH@robinhood"];
  const known = tokenInfo(token.contract as string);
  const c = token.candidate as NonNullable<Asset["candidate"]>;
  const base = known ?? { symbol: token.symbol, contract: token.contract as `0x${string}`, decimals: token.decimals, poolId: c.poolId, feePct: c.tierPct, tickSpacing: c.tickSpacing, usdgIs0: c.usdgIs0, firstSeen: now, proven: null, blacklisted: false, ...(c.curve ? { curve: c.curve } : {}) };
  if (base.proven === true) return "sell already proven";
  try {
    await ensureAllowances(token, amountRaw, now);
    const route = routeFor(token, eth);
    if (!route) throw new Error("no route back to ETH");
    const sim = await simulateFromWallet(token, encodeSwap(route, amountRaw, 1n, WALLET_ADDRESS as `0x${string}`, BigInt(Math.floor(now / 1000) + 1200)));
    if (!sim.ok) throw new Error(sim.reason);
    upsertToken({ ...base, proven: true, blacklisted: false, note: `sell proven ${new Date(now).toISOString()}` });
    return "sell proven: the token can be sold back through its pool";
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    upsertToken({ ...base, proven: false, blacklisted: true, note: `sell failed in simulation: ${why}` });
    return `sell NOT proven (${why}); ${token.symbol} is blacklisted, no further buys`;
  }
}

/**
 * Exits the rails force, before the model thinks: every held launch token is
 * checked against the time stop, the floor and the volume roll-over, and sold
 * back to ETH when one trips. Exits skip the caps; they are never blocked.
 */
export async function exitCandidates(balances: Record<string, number>, prices: Record<string, number | null>, ctx: RailContext, feed: FeedSnapshot = readFeed(), now = Date.now(), exec: (i: Intent, c: RailContext, now: number) => Promise<OnChainResult> = executeOnChain, extraTrades: Trade[] = []): Promise<Trade[]> {
  const out: Trade[] = [];
  const eth = ASSETS["ETH@robinhood"];
  const dyn = dynamicAssets(feed);
  const book = readBook();
  const allTrades = [...book.trades, ...extraTrades];
  const pos = positions(book.flows, allTrades, balances, prices).positions;
  for (const a of Object.values(dyn)) {
    const held = balances[a.symbol] ?? 0;
    if (!(held > 0) || !a.candidate) continue;
    const p = pos.find((x) => x.asset === a.symbol);
    const hourly = feed.hourly[a.candidate.poolId.toLowerCase()] ?? [];
    const buys = allTrades.filter((t) => t.to.asset === a.symbol && (t.status === "settled" || t.status === "pending"));
    const firstBuy = buys.map((t) => t.at).sort()[0] ?? a.candidate.seenAt;
    // The peak since entry, from the desk's own price samples, against the position's average cost.
    const avgCost = p?.avgCostUsd ?? null;
    const peakPx = readPrices().filter((s) => s.symbol === a.symbol && s.at >= firstBuy).reduce((m, s) => Math.max(m, s.priceUsd), prices[a.symbol] ?? 0);
    const peakPnlPct = avgCost != null && avgCost > 0 && peakPx > 0 ? ((peakPx - avgCost) / avgCost) * 100 : null;
    const tookProfit = allTrades.some((t) => t.from.asset === a.symbol && t.exit && (t.note ?? "").includes("take profit"));
    const v = exitVerdict({ ageH: (now - firstBuy) / 3600e3, pnlPct: p?.unrealizedPct != null ? p.unrealizedPct * 100 : null, hourly, peakPnlPct, tookProfit }, ctx.rails);
    if (!v) continue;
    const amount = v.share >= 1 ? held : Number((held * v.share).toPrecision(8));
    const usd = prices[a.symbol] != null ? amount * (prices[a.symbol] as number) : null;
    const r = await exec({ from: a, to: eth, amount, usd, exit: true }, ctx, now);
    if (r.ok) {
      const row: Trade = { ...r.trade, note: `exit (${v.kind}), ${v.reason}; ${r.trade.note ?? ""}` };
      if (exec === executeOnChain) recordTrade(row);
      out.push(row);
    } else if ("trade" in r && r.trade) out.push(r.trade);
    else console.error(`[desk] exit of ${a.symbol} refused: ${r.reason}`);
  }
  return out;
}

/** Rows the lane sent but could not wait for: settle them by their receipt. */
export async function settleOnChain(now = Date.now()): Promise<Trade[]> {
  const updated: Trade[] = [];
  for (const t of latestTrades(readBook().trades).filter((x) => x.status === "pending" && x.venue === "pool" && x.settlementTx)) {
    const from = ASSETS[`${t.from.asset}@${t.from.network ?? "robinhood"}`];
    if (!from) continue;
    const r = await waitReceipt(from, t.settlementTx as `0x${string}`, 5_000);
    if (!r) continue;
    const row: Trade = { ...t, status: r.status === "success" ? "settled" : "failed", updatedAt: now, note: `${t.note ?? ""}; ${r.status === "success" ? "landed" : "reverted"} (amount as estimated)` };
    recordTrade(row);
    updated.push(row);
  }
  return updated;
}

/** The pool routes for the watchlist legs on Robinhood Chain, as quotes the observation can print beside Obscura's. */
export async function poolQuotes(legs: Array<{ from: Asset; to: Asset; amount: number }>, now = Date.now()): Promise<QuoteRead[]> {
  const out: QuoteRead[] = [];
  for (const l of legs) {
    const q = await quoteOnChain(l.from, l.to, l.amount);
    out.push({ from: l.from.symbol, to: l.to.symbol, amountIn: l.amount, amountOut: q ? q.amountOut : null, partner: q ? `pool on chain${q.costPct != null ? `, ${q.costPct.toFixed(2)}% all in` : ""}` : "pool", at: now });
  }
  return out;
}
