// The desk's own tape: the swaps in a pool, read from the chain's Swap
// events, kept per pool in data/tape/<poolId>.jsonl so each read is
// incremental, and reduced to what a trader looks at minute by minute: how
// many swaps, buys against sells in dollars, buy pressure, the price path
// and its peak, 5-minute volume buckets and whether they are rolling over.
// Only tokens in play are read (held, probeable, graded), a handful of
// pools, a few calls each, on the fast tick.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, decodeEventLog } from "viem";
import { DATA_DIR, RPC_URL } from "../config.ts";
import { chainMemory, priceFromSqrtPriceX96, type PoolSpec } from "../obscura/pools.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SWAP_ABI = parseAbi(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]);
const CHUNK = 20_000n;
const BLOCKS_PER_SEC = 10;

export interface SwapRow {
  at: number;
  block: number;
  tx: string;
  /** Whether the swap bought the token (took it out of the pool) or sold it. */
  side: "buy" | "sell";
  /** Token units moved, whole units. */
  tokenAmount: number;
  /** Quote units moved, whole units (USDG, NVDA or ETH). */
  quoteAmount: number;
  /** Quote per token after the swap. */
  price: number;
}

const tapeDir = () => join(DATA_DIR, "tape");
const tapePath = (poolId: string) => join(tapeDir(), `${poolId.toLowerCase()}.jsonl`);

export function readTape(poolId: string): SwapRow[] {
  const p = tapePath(poolId);
  if (!existsSync(p)) return [];
  const out: SwapRow[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SwapRow);
    } catch {
      /* skip */
    }
  }
  return dedupeRows(out);
}

/** PURE: one row per swap (tx hash and log index), first occurrence kept, in block order. Two processes may append the same swap to a tape file. */
export function dedupeRows(rows: SwapRow[]): SwapRow[] {
  const seen = new Set<string>();
  const out: SwapRow[] = [];
  for (const r of rows) {
    if (seen.has(r.tx)) continue;
    seen.add(r.tx);
    out.push(r);
  }
  return out.sort((a, b) => a.block - b.block || a.at - b.at);
}

/** PURE: a v4 Swap event decoded into a row. In v4 the event carries the swapper's deltas: a positive token amount means the user received the token (a buy), a negative one that the user paid it (a sell). */
export function decodeSwap(args: { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint }, spec: PoolSpec, tokenIs0: boolean, at: number, block: number, tx: string): SwapRow | null {
  const tokenRaw = tokenIs0 ? args.amount0 : args.amount1;
  const quoteRaw = tokenIs0 ? args.amount1 : args.amount0;
  const tokenDec = tokenIs0 ? spec.decimals0 : spec.decimals1;
  const quoteDec = tokenIs0 ? spec.decimals1 : spec.decimals0;
  if (tokenRaw === 0n) return null;
  const side: SwapRow["side"] = tokenRaw > 0n ? "buy" : "sell";
  const tokenAmount = Number(tokenRaw < 0n ? -tokenRaw : tokenRaw) / 10 ** tokenDec;
  const quoteAmount = Number(quoteRaw < 0n ? -quoteRaw : quoteRaw) / 10 ** quoteDec;
  const t1per0 = priceFromSqrtPriceX96(args.sqrtPriceX96, spec.decimals0, spec.decimals1);
  const price = tokenIs0 ? t1per0 : t1per0 > 0 ? 1 / t1per0 : 0;
  return { at, block, tx, side, tokenAmount, quoteAmount, price };
}

/**
 * PURE: the tape window in minutes (OBS_LIVE_TAPE_MIN, three hours by default). One window for the live watch and
 * the cycle: the dip read looks back that far for the pump it buys under, and a cycle that read a shorter tape
 * called the same token a breakdown while the watch that woke it had read a dip.
 */
export function tapeWindowMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OBS_LIVE_TAPE_MIN ?? 180);
  return Number.isFinite(n) && n > 0 ? n : 180;
}

/** Pull new swaps for a pool since the last stored block (or the last `sinceMin` minutes) and append them. Returns the whole tape for the window. */
export async function updateTape(spec: PoolSpec, tokenSymbol: string, now = Date.now(), sinceMin = tapeWindowMin()): Promise<SwapRow[]> {
  if (spec.venue !== "uniswap-v4" || !spec.id) return [];
  const tokenIs0 = spec.token0 === tokenSymbol;
  const existing = readTape(spec.id);
  const pub = createPublicClient({ transport: http(RPC_URL, { fetchOptions: { headers: { "User-Agent": UA } } }) });
  try {
    const head = await pub.getBlock({ blockTag: "latest" });
    const headBlock = head.number;
    const headAt = Number(head.timestamp) * 1000;
    const lastStored = existing.length ? BigInt(existing[existing.length - 1].block) : null;
    const fromBlock = lastStored != null ? lastStored + 1n : headBlock - BigInt(sinceMin * 60 * BLOCKS_PER_SEC);
    if (fromBlock > headBlock) return existing.filter((r) => r.at >= now - sinceMin * 60e3);
    const rows: SwapRow[] = [];
    for (let start = fromBlock > 0n ? fromBlock : 0n; start <= headBlock; start += CHUNK) {
      const end = start + CHUNK - 1n > headBlock ? headBlock : start + CHUNK - 1n;
      const logs = await pub.getLogs({ address: chainMemory().contracts.uniswapV4.poolManager as `0x${string}`, event: SWAP_ABI[0], args: { id: spec.id as `0x${string}` }, fromBlock: start, toBlock: end });
      for (const l of logs) {
        const d = decodeEventLog({ abi: SWAP_ABI, data: l.data, topics: l.topics }).args as { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint };
        const block = Number(l.blockNumber);
        const at = headAt - Math.round((Number(headBlock) - block) / BLOCKS_PER_SEC) * 1000;
        const row = decodeSwap(d, spec, tokenIs0, at, block, `${l.transactionHash}:${l.logIndex}`);
        if (row) rows.push(row);
      }
    }
    if (rows.length) {
      mkdirSync(tapeDir(), { recursive: true });
      appendFileSync(tapePath(spec.id), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    return [...existing, ...rows].filter((r) => r.at >= now - sinceMin * 60e3);
  } catch {
    return existing.filter((r) => r.at >= now - sinceMin * 60e3);
  }
}

/**
 * The tapes of several pools in one read, for the live watch: one head block
 * and one Swap query across every pool id for the blocks since the last
 * look. A pool with no stored tape is backfilled on its own first (once).
 * `cache` keeps each pool's window in memory between looks so the files are
 * not re-read every few seconds. Returns each pool's rows inside the window
 * and the head block, or what it had when the chain did not answer.
 */
export async function updateTapes(items: Array<{ spec: PoolSpec; symbol: string }>, now = Date.now(), sinceMin = tapeWindowMin(), cache?: Map<string, SwapRow[]>): Promise<{ tapes: Map<string, SwapRow[]>; headBlock: number | null }> {
  const tapes = new Map<string, SwapRow[]>();
  const live = items.filter((i) => i.spec.venue === "uniswap-v4" && i.spec.id);
  const inWindow = (rows: SwapRow[]) => rows.filter((r) => r.at >= now - sinceMin * 60e3);
  if (!live.length) return { tapes, headBlock: null };
  const pub = createPublicClient({ transport: http(RPC_URL, { fetchOptions: { headers: { "User-Agent": UA } } }) });
  let head: { number: bigint; timestamp: bigint };
  try {
    head = await pub.getBlock({ blockTag: "latest" });
  } catch {
    for (const i of live) tapes.set(i.spec.id as string, inWindow(cache?.get(i.spec.id as string) ?? readTape(i.spec.id as string)));
    return { tapes, headBlock: null };
  }
  const headBlock = head.number;
  const headAt = Number(head.timestamp) * 1000;
  const batch: Array<{ item: { spec: PoolSpec; symbol: string }; existing: SwapRow[]; from: bigint }> = [];
  for (const item of live) {
    const id = item.spec.id as string;
    const existing = cache?.get(id) ?? readTape(id);
    if (!existing.length) {
      const rows = await updateTape(item.spec, item.symbol, now, sinceMin);
      cache?.set(id, rows);
      tapes.set(id, rows);
      continue;
    }
    batch.push({ item, existing, from: BigInt(existing[existing.length - 1].block) + 1n });
  }
  if (batch.length) {
    const fromBlock = batch.reduce((m, b) => (b.from < m ? b.from : m), headBlock + 1n);
    const byId = new Map(batch.map((b) => [(b.item.spec.id as string).toLowerCase(), b]));
    const fresh = new Map<string, SwapRow[]>();
    try {
      for (let start = fromBlock; start <= headBlock; start += CHUNK) {
        const end = start + CHUNK - 1n > headBlock ? headBlock : start + CHUNK - 1n;
        const logs = await pub.getLogs({ address: chainMemory().contracts.uniswapV4.poolManager as `0x${string}`, event: SWAP_ABI[0], args: { id: batch.map((b) => b.item.spec.id as `0x${string}`) }, fromBlock: start, toBlock: end });
        for (const l of logs) {
          const id = String(l.topics[1] ?? "").toLowerCase();
          const b = byId.get(id);
          if (!b) continue;
          const block = Number(l.blockNumber);
          if (BigInt(block) < b.from) continue;
          const d = decodeEventLog({ abi: SWAP_ABI, data: l.data, topics: l.topics }).args as { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint };
          const at = headAt - Math.round((Number(headBlock) - block) / BLOCKS_PER_SEC) * 1000;
          const row = decodeSwap(d, b.item.spec, b.item.spec.token0 === b.item.symbol, at, block, `${l.transactionHash}:${l.logIndex}`);
          if (row) (fresh.get(id) ?? fresh.set(id, []).get(id)!).push(row);
        }
      }
    } catch {
      /* keep what we have; the next look tries again */
    }
    for (const b of batch) {
      const id = b.item.spec.id as string;
      const rows = fresh.get(id.toLowerCase()) ?? [];
      if (rows.length) {
        mkdirSync(tapeDir(), { recursive: true });
        appendFileSync(tapePath(id), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      }
      const all = inWindow(dedupeRows([...b.existing, ...rows]));
      cache?.set(id, all);
      tapes.set(id, all);
    }
  }
  return { tapes, headBlock: Number(headBlock) };
}

export interface TapeStats {
  symbol: string;
  windowMin: number;
  swaps: number;
  buys: number;
  sells: number;
  buyQuote: number;
  sellQuote: number;
  /** Buys as a share of buys plus sells, in quote terms. Null with no volume. */
  buyPressurePct: number | null;
  first: number | null;
  last: number | null;
  peak: number | null;
  trough: number | null;
  /** Last against first, and last against the peak, in percent. */
  movePct: number | null;
  offPeakPct: number | null;
  /** Quote volume per 5-minute bucket, oldest first, covering the window. */
  buckets5m: number[];
  /** "rising", "holding", "rolling over" from the last three buckets, or "thin" with too little. */
  trend: "rising" | "holding" | "rolling over" | "thin";
  lastSwapAgoMin: number | null;
}

/** PURE: the tape reduced to what a trader reads, over the last `windowMin` minutes. */
export function tapeStats(rows: SwapRow[], symbol: string, now: number, windowMin = 15, dropPct = 30): TapeStats {
  const w = rows.filter((r) => r.at >= now - windowMin * 60e3 && r.at <= now).sort((a, b) => a.at - b.at);
  const buys = w.filter((r) => r.side === "buy");
  const sells = w.filter((r) => r.side === "sell");
  const buyQuote = buys.reduce((s, r) => s + r.quoteAmount, 0);
  const sellQuote = sells.reduce((s, r) => s + r.quoteAmount, 0);
  const prices = w.map((r) => r.price).filter((p) => p > 0);
  const first = prices[0] ?? null;
  const last = prices.length ? prices[prices.length - 1] : null;
  const peak = prices.length ? Math.max(...prices) : null;
  const trough = prices.length ? Math.min(...prices) : null;
  const nBuckets = Math.max(1, Math.ceil(windowMin / 5));
  const buckets5m = Array.from({ length: nBuckets }, () => 0);
  for (const r of w) {
    const i = Math.min(nBuckets - 1, Math.floor((r.at - (now - windowMin * 60e3)) / (5 * 60e3)));
    buckets5m[i] += r.quoteAmount;
  }
  const b = buckets5m.slice(-3);
  const k = 1 - dropPct / 100;
  let trend: TapeStats["trend"] = "thin";
  if (b.length === 3 && b.some((x) => x > 0)) {
    if (b[2] < b[1] * k && b[1] < b[0] * k) trend = "rolling over";
    else if (b[2] > b[1] && b[1] > b[0]) trend = "rising";
    else trend = "holding";
  }
  const lastAt = w.length ? w[w.length - 1].at : null;
  return {
    symbol,
    windowMin,
    swaps: w.length,
    buys: buys.length,
    sells: sells.length,
    buyQuote,
    sellQuote,
    buyPressurePct: buyQuote + sellQuote > 0 ? (buyQuote / (buyQuote + sellQuote)) * 100 : null,
    first,
    last,
    peak,
    trough,
    movePct: first != null && last != null && first > 0 ? ((last - first) / first) * 100 : null,
    offPeakPct: peak != null && last != null && peak > 0 ? ((peak - last) / peak) * 100 : null,
    buckets5m,
    trend,
    lastSwapAgoMin: lastAt != null ? (now - lastAt) / 60e3 : null,
  };
}

/** PURE: the tape as one observation line, dollars via the quote's price. */
export function tapeLine(t: TapeStats, quoteUsd: number | null, quote: string): string {
  const usd = (q: number) => (quoteUsd != null ? `$${(q * quoteUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : `${q.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${quote}`);
  if (!t.swaps) return `Tape ${t.symbol} (last ${t.windowMin} min): no swaps${t.lastSwapAgoMin != null ? `, last one ${t.lastSwapAgoMin.toFixed(0)} min ago` : ""}.`;
  const bits = [`${t.swaps} swaps`, `buys ${usd(t.buyQuote)} vs sells ${usd(t.sellQuote)}${t.buyPressurePct != null ? ` (${t.buyPressurePct.toFixed(0)}% buy pressure)` : ""}`];
  if (t.movePct != null) bits.push(`price ${t.movePct >= 0 ? "+" : ""}${t.movePct.toFixed(1)}% over the window`);
  if (t.offPeakPct != null && t.offPeakPct > 0.5) bits.push(`${t.offPeakPct.toFixed(0)}% off its peak`);
  bits.push(`5-minute volume ${t.buckets5m.slice(-3).map((v) => usd(v)).join(" then ")}, ${t.trend}`);
  return `Tape ${t.symbol} (last ${t.windowMin} min): ${bits.join("; ")}.`;
}
