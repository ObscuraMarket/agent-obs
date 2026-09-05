// Where OBS's assets trade on chain, and the arithmetic that turns a pool's
// state into a price and a depth. The facts (contracts, pool ids, the
// snapshot measured when they were verified) live in obs-chain.json, his
// chain memory; this file reads them and refreshes the numbers that move.
//
// Both kinds of pool here are concentrated liquidity and answer the same two
// questions: a Q64.96 square-root price and the liquidity in range at it.
// Uniswap v4 pools answer through StateView by pool id; the Ramses V3 pool
// that carries the real $OBS market answers on its own address. Every number
// is measured or absent. Run `npm run pools` to see the table live.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { toFunctionSelector } from "viem";
import { ethCall } from "./rpc.ts";

export interface PoolSpec {
  venue: "uniswap-v4" | "ramses-v3";
  /** Uniswap v4: the pool id. */
  id?: string;
  /** Ramses V3: the pool's own address. */
  pool?: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  /** Which side is the dollar (USDG). Prices and depths are quoted in it. */
  usdToken: 0 | 1;
  feePct: number;
  tickSpacing: number;
  /** True when the pool has a hook contract; the desk trades hookless pools only. */
  hooks?: boolean;
  /** A hooked pool's hook contract (a launch curve), when the desk trades through it. */
  hookAddress?: string;
  /** The exact fee field of the pool key in pips; a launch curve carries 0 and lets its hook charge. */
  feePips?: number;
  /** The symbol on the other side of the pool, when it is not the dollar: "NVDA" or "ETH" for a launch curve. */
  quote?: string;
}

export interface ChainMemory {
  verifiedAt: string;
  chain: { id: number; name: string; publicRpc: string; explorer: string };
  contracts: { uniswapV4: { poolManager: string; stateView: string; positionManager: string; universalRouter: string; quoter: string; permit2: string }; ramsesV3: { factory: string } };
  tokens: Record<string, { address?: string; decimals?: number } | Record<string, string>>;
  obsMarket: {
    primary: PoolSpec & { measured: { at: string; priceUsd: number; usdgDepth2pct: number } };
    /** The OBS/ETH pool on Uniswap v4 behind the pons v2 hook, the deep market from 2026-09-05; priced through ETH. */
    ethPool?: PoolSpec & { note?: string; measured?: { at: string; priceEth: number; depth2pctEth: number } };
    holders: { at: string; count: number };
    uniswapV4Dust: { note: string; pools: Array<{ id: string; feePct: number; usdgDepth2pct: number }> };
  };
  referencePools: Record<string, PoolSpec & { measured: { at: string; priceUsd: number; usdgDepth2pct: number } }>;
}

let memory: ChainMemory | null = null;
/** The chain memory as committed. Read once per process. */
export function chainMemory(): ChainMemory {
  if (!memory) memory = JSON.parse(readFileSync(new URL("../../obs-chain.json", import.meta.url), "utf8")) as ChainMemory;
  return memory;
}

const Q96 = 2n ** 96n;

/** PURE: token1 per token0 in whole units, from a Q64.96 square-root price. */
export function priceFromSqrtPriceX96(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const sp = Number(sqrtPriceX96) / Number(Q96);
  return sp * sp * 10 ** (decimals0 - decimals1);
}

/** PURE: token0 that must be sold into the pool at the current tick to move
 *  token1's price up 2%, in whole token0 units. Zero when nothing is in range.
 *  It measures the active tick only, which is the honest number for a small
 *  trade; a bigger one walks into whatever the next ticks hold. */
export function depthToken0At2pct(liquidity: bigint, sqrtPriceX96: bigint, decimals0: number): number {
  if (liquidity <= 0n || sqrtPriceX96 <= 0n) return 0;
  const sp = Number(sqrtPriceX96) / Number(Q96);
  return (Number(liquidity) * (Math.sqrt(1.02) - 1)) / sp / 10 ** decimals0;
}

/** PURE: the same for the other side: token1 that must be sold into the pool
 *  to move token0's price up 2%, in whole token1 units. */
export function depthToken1At2pct(liquidity: bigint, sqrtPriceX96: bigint, decimals1: number): number {
  if (liquidity <= 0n || sqrtPriceX96 <= 0n) return 0;
  const sp = Number(sqrtPriceX96) / Number(Q96);
  return (Number(liquidity) * sp * (Math.sqrt(1.02) - 1)) / 10 ** decimals1;
}

/** PURE: one ABI word as a bigint, or null. */
export function decodeWord(hex: string): bigint | null {
  const h = hex.replace(/^0x/, "");
  if (h.length < 64) return null;
  try {
    return BigInt("0x" + h.slice(0, 64));
  } catch {
    return null;
  }
}

/** PURE: slot0 as both pool kinds return it. StateView answers four words and
 *  a v3-style pool seven, but the first is sqrtPriceX96 and the second the
 *  tick in both. */
export function decodeSlot0(hex: string): { sqrtPriceX96: bigint; tick: number } | null {
  const h = hex.replace(/^0x/, "");
  if (h.length < 128) return null;
  try {
    const sqrtPriceX96 = BigInt("0x" + h.slice(0, 64));
    const raw = BigInt("0x" + h.slice(64, 128));
    const tick = Number(raw > (1n << 255n) ? raw - (1n << 256n) : raw);
    return { sqrtPriceX96, tick };
  } catch {
    return null;
  }
}

export const SEL = {
  getSlot0: toFunctionSelector("getSlot0(bytes32)"),
  getLiquidity: toFunctionSelector("getLiquidity(bytes32)"),
  slot0: toFunctionSelector("slot0()"),
  liquidity: toFunctionSelector("liquidity()"),
} as const;

export interface PoolRead {
  venue: PoolSpec["venue"];
  feePct: number;
  /** Dollars per one of the non-dollar token, as the pool sets it. */
  priceUsd: number;
  /** Dollars of buying that move that price up 2% at the current tick. */
  depthUsd2pct: number;
  liquidity: string;
  tick: number;
  /** The raw Q64.96 square-root price, for exact swap arithmetic. */
  sqrtPriceX96: string;
  at: number;
}

/** Two calls, one after the other, against the rate-limited RPC. Null when either did not answer. */
export async function poolRead(spec: PoolSpec, stateView = chainMemory().contracts.uniswapV4.stateView): Promise<PoolRead | null> {
  const v4 = spec.venue === "uniswap-v4";
  const to = v4 ? stateView : spec.pool;
  if (!to || (v4 && !spec.id)) return null;
  const idWord = v4 ? (spec.id as string).replace(/^0x/, "").padStart(64, "0") : "";
  const s = await ethCall(to, v4 ? SEL.getSlot0 + idWord : SEL.slot0);
  const slot = s ? decodeSlot0(s) : null;
  if (!slot || slot.sqrtPriceX96 <= 0n) return null;
  const l = await ethCall(to, v4 ? SEL.getLiquidity + idWord : SEL.liquidity);
  const liquidity = l ? decodeWord(l) : null;
  if (liquidity == null) return null;
  const token1PerToken0 = priceFromSqrtPriceX96(slot.sqrtPriceX96, spec.decimals0, spec.decimals1);
  const usdIs0 = spec.usdToken === 0;
  const priceUsd = usdIs0 ? (token1PerToken0 > 0 ? 1 / token1PerToken0 : 0) : token1PerToken0;
  const depthUsd2pct = usdIs0 ? depthToken0At2pct(liquidity, slot.sqrtPriceX96, spec.decimals0) : depthToken1At2pct(liquidity, slot.sqrtPriceX96, spec.decimals1);
  return { venue: spec.venue, feePct: spec.feePct, priceUsd, depthUsd2pct, liquidity: liquidity.toString(), tick: slot.tick, sqrtPriceX96: slot.sqrtPriceX96.toString(), at: Date.now() };
}

export interface MarketRead {
  venue: PoolSpec["venue"];
  feePct: number;
  /** Dollars per OBS as the pool sets it (token0 is USDG). */
  priceUsd: number;
  /** Dollars of buying that move the price 2% at the current tick. */
  depthUsd2pct: number;
  liquidity: string;
  at: number;
  /** What the pool holds, whole units, and its dollar value at the pool's own price. Null when not read. */
  usdgInPool?: number | null;
  obsInPool?: number | null;
  tvlUsd?: number | null;
  /** The pool's quote asset: USDG for the Ramses pool, ETH for the v4 pool. */
  quote?: "USDG" | "ETH";
}

/** balanceOf(holder) calldata. */
const balanceOfData = (holder: string) => "0x70a08231" + holder.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** $OBS priced by its own market, the Ramses V3 USDG pool, with what the
 *  pool holds. Null when the chain did not answer this cycle; the reserves
 *  are null on their own if only they did not. */
/**
 * PURE: what a full-range position holds at the current price, from the pool's liquidity and its square-root
 * price: amount0 = L / sqrtP, amount1 = L * sqrtP. A pons v2 graduated pool is one full-range, permanently locked
 * position, so this is its whole TVL. Returns the two amounts in whole units.
 */
export function fullRangeAmounts(liquidity: string, sqrtPriceX96: string, decimals0: number, decimals1: number): { amount0: number; amount1: number } {
  const L = BigInt(liquidity);
  const sp = BigInt(sqrtPriceX96);
  if (L <= 0n || sp <= 0n) return { amount0: 0, amount1: 0 };
  const amount0 = Number((L * Q96) / sp) / 10 ** decimals0;
  const amount1 = Number((L * sp) / Q96) / 10 ** decimals1;
  return { amount0, amount1 };
}

/**
 * OBS on its own market. Two pools are read: the Ramses USDG pool and, when the chain memory names one and an ETH
 * price is at hand, the v4 OBS/ETH pool. The deeper one (dollars of buying that move the price 2%) sets the price;
 * the USDG pool's holdings are still read for its TVL when it wins.
 */
export async function obsMarket(ethUsd: number | null = null): Promise<MarketRead | null> {
  const m = chainMemory();
  const spec = m.obsMarket.primary;
  const [ramses, v4] = await Promise.all([
    poolRead(spec).catch(() => null),
    m.obsMarket.ethPool && ethUsd ? poolRead(m.obsMarket.ethPool).catch(() => null) : Promise.resolve(null),
  ]);
  const ethRead = v4 && ethUsd && v4.priceUsd > 0 ? { ...v4, priceUsd: v4.priceUsd * ethUsd, depthUsd2pct: v4.depthUsd2pct * ethUsd } : null;
  if (ethRead && (!ramses || ethRead.depthUsd2pct > ramses.depthUsd2pct)) {
    // The pool is one full-range locked position: its TVL follows from its liquidity and price.
    const e = m.obsMarket.ethPool as PoolSpec;
    const { amount0, amount1 } = fullRangeAmounts(ethRead.liquidity, ethRead.sqrtPriceX96, e.decimals0, e.decimals1);
    const ethAmount = e.usdToken === 0 ? amount0 : amount1;
    const obsAmount = e.usdToken === 0 ? amount1 : amount0;
    const tvlUsd = ethAmount * (ethUsd as number) + obsAmount * ethRead.priceUsd;
    return { venue: ethRead.venue, feePct: ethRead.feePct, priceUsd: ethRead.priceUsd, depthUsd2pct: ethRead.depthUsd2pct, liquidity: ethRead.liquidity, at: ethRead.at, usdgInPool: null, obsInPool: obsAmount, tvlUsd, quote: "ETH" };
  }
  const r = ramses;
  if (!r || !(r.priceUsd > 0)) return null;
  const out: MarketRead = { venue: r.venue, feePct: r.feePct, priceUsd: r.priceUsd, depthUsd2pct: r.depthUsd2pct, liquidity: r.liquidity, at: r.at, usdgInPool: null, obsInPool: null, tvlUsd: null, quote: "USDG" };
  if (spec.pool) {
    const token = (k: string) => m.tokens[k] as { address: string; decimals: number };
    const held = async (t: { address: string; decimals: number }) => {
      const v = await ethCall(t.address, balanceOfData(spec.pool as string));
      const w = v ? decodeWord(v) : null;
      return w == null ? null : Number(w) / 10 ** t.decimals;
    };
    out.usdgInPool = await held(token("USDG"));
    out.obsInPool = await held(token("OBS"));
    if (out.usdgInPool != null && out.obsInPool != null) out.tvlUsd = out.usdgInPool + out.obsInPool * r.priceUsd;
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const m = chainMemory();
  const rows: Array<[string, PoolSpec]> = [["OBS/USDG", m.obsMarket.primary], ...Object.entries(m.referencePools)];
  for (const [label, spec] of rows) {
    const r = await poolRead(spec);
    console.log(
      r
        ? `${label.padEnd(10)} ${spec.venue.padEnd(11)} ${String(spec.feePct).padStart(5)}%  $${r.priceUsd.toLocaleString("en-US", { maximumSignificantDigits: 6 })}  2% depth $${r.depthUsd2pct.toLocaleString("en-US", { maximumFractionDigits: 0 })}  tick ${r.tick}`
        : `${label.padEnd(10)} ${spec.venue.padEnd(11)} ${String(spec.feePct).padStart(5)}%  not read`,
    );
  }
}
