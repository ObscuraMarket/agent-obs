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
const robinhood = (symbol: string): Asset | null => ASSETS[`${symbol}@robinhood`] ?? null;

/** PURE: the hop that sells `from` for `to` in the pool `<X>/USDG`, or null. */
function hop(from: string, to: string, pools: Record<string, PoolSpec>): Hop | null {
  const key = from === "USDG" ? `${to}/USDG` : `${from}/USDG`;
  const spec = pools[key];
  const out = robinhood(to);
  if (!spec || spec.venue !== "uniswap-v4" || spec.hooks || !out) return null;
  if (spec.token0 !== from && spec.token1 !== from) return null;
  return { key, spec, zeroForOne: spec.token0 === from, currencyOut: currencyOf(out), fee: Math.round(spec.feePct * 10000), tickSpacing: spec.tickSpacing };
}

/** PURE: the route from A to B through USDG: one hop when either side is USDG, two otherwise. Null when a leg has no pool. */
export function routeFor(from: Asset, to: Asset, pools: Record<string, PoolSpec> = chainMemory().referencePools): Route | null {
  if (from.chain !== "robinhood" || to.chain !== "robinhood" || from.symbol === to.symbol) return null;
  const legs = from.symbol === "USDG" || to.symbol === "USDG" ? [[from.symbol, to.symbol]] : [[from.symbol, "USDG"], ["USDG", to.symbol]];
  const hops: Hop[] = [];
  for (const [a, b] of legs) {
    const h = hop(a, b, pools);
    if (!h) return null;
    hops.push(h);
  }
  return { from, to, currencyIn: currencyOf(from), hops };
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
    raw = exactInWithinTick(raw, BigInt(read.sqrtPriceX96), BigInt(read.liquidity), h.fee, h.zeroForOne).out;
  }
  const amountOutRaw = raw;
  const minOutRaw = (amountOutRaw * BigInt(Math.round((100 - slippagePct) * 1000))) / 100_000n;
  const usdOf = (a: Asset): number | null => {
    if (a.symbol === "USDG") return 1;
    const p = pools.find((x) => x.key === `${a.symbol}/USDG`);
    return p ? p.read.priceUsd : null;
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
  const path = route.hops.map((h) => ({ intermediateCurrency: h.currencyOut, fee: h.fee, tickSpacing: h.tickSpacing, hooks: NATIVE, hookData: "0x" as Hex }));
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

export type OnChainResult = { ok: true; trade: Trade } | { ok: false; reason: string; trade?: Trade };

const balanceOf = (a: Asset): Promise<bigint> => (a.kind === "native" ? readNativeBalance(a) : readTokenBalance(a, a.contract as `0x${string}`));

/** The lane: rails, route, quote, floor, encode, simulate, approvals, send, receipt, the row. */
export async function executeOnChain(i: Intent, c: RailContext, now = Date.now()): Promise<OnChainResult> {
  const gate = checkRails(i, c);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const q = await quoteOnChain(i.from, i.to, i.amount);
  if (!q) return { ok: false, reason: `no pool route from ${assetKey(i.from)} to ${assetKey(i.to)}, or the pools did not answer` };
  if (q.costPct != null && q.costPct > (1 - c.rails.minFillRatio) * 100) return { ok: false, reason: `the pool route costs ${q.costPct.toFixed(2)}% against the mark; the floor is ${((1 - c.rails.minFillRatio) * 100).toFixed(1)}%` };
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
  return { ok: true, trade: settled };
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
