// The agent's own token, read for the page: name, supply, the price and
// depth of its pool, its 24-hour volume from the pool's own swaps, and how
// many wallets hold it. The desk never trades it (NEVER_TRADE in the rails);
// this is the one place it reads it, and only to show it.
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { AGENT_TOKEN, RPC_URL, EXPLORER_URL } from "../config.ts";
import { chainMemory, poolRead, fullRangeAmounts, type PoolSpec } from "../obscura/pools.ts";
import { curvePoolIdFor, curveKey } from "./candidates.ts";
import { updateTape } from "./tape.ts";
import { updateTransfers, balancesFrom, holderRulesFromEnv, infrastructureAddresses } from "./holders.ts";
import { appendLedger, readLedger } from "../ledger.ts";

const ERC20 = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"]);
const FACTORY = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);
const CURVE = parseAbi(["function launchedAt() view returns (uint256)"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const PHASE = ["on its curve", "swept", "in its pool", "rescued"];

export interface AgentTokenRead {
  contract: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: number | null;
  /** The launchpad's phase, in words, or null when the factory does not know the token. */
  phase: string | null;
  pair: string | null;
  poolId: string | null;
  /** Dollars per token from the pool, and the dollars of buying that move it 2%. */
  priceUsd: number | null;
  depthUsd2pct: number | null;
  marketCapUsd: number | null;
  /** From the pool's own swaps over the last 24 hours. */
  volume24hUsd: number | null;
  swaps24h: number | null;
  holders: number | null;
  /** What the pool holds, in dollars: one full-range locked position, from its liquidity and price. */
  tvlUsd: number | null;
  /** The price against the oldest sample inside the last day, as a fraction; null until there are two samples. */
  change24hPct: number | null;
  /** The same for the pool's TVL, the 24-hour volume and the holder count. */
  change24h: { price: number | null; liquidity: number | null; volume: number | null; holders: number | null };
  launchedAt: number | null;
  explorerUrl: string;
  at: number;
}

/** The token's price samples, one per read, kept a day: the 24-hour change is measured against the oldest. */
const SAMPLES = "obs-agent-token.jsonl";
interface Sample { at: number; priceUsd: number | null; tvlUsd?: number | null; volume24hUsd?: number | null; holders?: number | null }
const frac = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && a > 0 ? (b - a) / a : null);
/** Append this read's figures and measure each against the oldest sample inside the last day. */
function sampleAndChanges(s: Sample, now: number): AgentTokenRead["change24h"] {
  appendLedger(SAMPLES, s as unknown as Record<string, unknown>);
  const rows = readLedger<Sample>(SAMPLES).filter((r) => r && Number.isFinite(r.at) && now - r.at <= 24 * 3600e3);
  if (rows.length < 2) return { price: null, liquidity: null, volume: null, holders: null };
  const first = (k: keyof Sample) => rows.find((r) => r[k] != null && (r[k] as number) > 0)?.[k] as number | undefined;
  return { price: frac(first("priceUsd"), s.priceUsd), liquidity: frac(first("tvlUsd"), s.tvlUsd), volume: frac(first("volume24hUsd"), s.volume24hUsd), holders: frac(first("holders"), s.holders) };
}

let cache: { at: number; read: AgentTokenRead } | null = null;
let meta: { name: string; symbol: string; decimals: number; totalSupply: number } | null = null;

/** The token as the page shows it. `ethUsd` prices an ETH-paired pool. Cached a minute. */
export async function readAgentToken(ethUsd: number | null, now = Date.now()): Promise<AgentTokenRead> {
  if (cache && now - cache.at < 60_000) return cache.read;
  const token = AGENT_TOKEN as `0x${string}`;
  const pub = createPublicClient({ transport: http(RPC_URL) });
  const read: AgentTokenRead = { contract: token, name: null, symbol: null, decimals: 18, totalSupply: null, phase: null, pair: null, poolId: null, priceUsd: null, depthUsd2pct: null, marketCapUsd: null, volume24hUsd: null, swaps24h: null, holders: null, tvlUsd: null, change24hPct: null, change24h: { price: null, liquidity: null, volume: null, holders: null }, launchedAt: null, explorerUrl: `${EXPLORER_URL}/token/${token}`, at: now };
  try {
    if (!meta) {
      const [name, symbol, decimals, supply] = await Promise.all([
        pub.readContract({ address: token, abi: ERC20, functionName: "name" }),
        pub.readContract({ address: token, abi: ERC20, functionName: "symbol" }),
        pub.readContract({ address: token, abi: ERC20, functionName: "decimals" }),
        pub.readContract({ address: token, abi: ERC20, functionName: "totalSupply" }),
      ]);
      meta = { name, symbol, decimals: Number(decimals), totalSupply: Number(formatUnits(supply, Number(decimals))) };
    }
    Object.assign(read, meta);
  } catch {
    /* the token's metadata stays null and the page says so */
  }
  try {
    const factory = ((chainMemory() as { contracts?: { launchpads?: Record<string, string> } }).contracts?.launchpads?.ponsV2Launcher ?? "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e") as `0x${string}`;
    const rec = await pub.readContract({ address: factory, abi: FACTORY, functionName: "getLaunchedToken", args: [token] });
    if (rec.exists) {
      read.phase = PHASE[Number(rec.phase)] ?? `phase ${rec.phase}`;
      const pairSym = rec.pairToken.toLowerCase() === ZERO ? "ETH" : rec.pairToken.toLowerCase() === "0x5fc5360d0400a0fd4f2af552add042d716f1d168" ? "USDG" : null;
      read.pair = pairSym ?? rec.pairToken.toLowerCase();
      try {
        read.launchedAt = Number(await pub.readContract({ address: rec.curve, abi: CURVE, functionName: "launchedAt" })) * 1000 || null;
      } catch { /* not every curve answers */ }
      const id = curvePoolIdFor(token, pairSym, pairSym ? null : (rec.pairToken.toLowerCase() as `0x${string}`));
      const key = id ? await curveKey(id) : null;
      if (key && pairSym) {
        read.poolId = key.poolId;
        const quoteIs0 = key.currency1.toLowerCase() === token;
        const qd = pairSym === "USDG" ? 6 : 18;
        const spec: PoolSpec = { venue: "uniswap-v4", id: key.poolId, token0: quoteIs0 ? pairSym : (read.symbol ?? "TOKEN"), token1: quoteIs0 ? (read.symbol ?? "TOKEN") : pairSym, decimals0: quoteIs0 ? qd : read.decimals, decimals1: quoteIs0 ? read.decimals : qd, usdToken: quoteIs0 ? 0 : 1, feePct: 1, tickSpacing: key.tickSpacing, hooks: true, hookAddress: key.hooks, feePips: key.fee, quote: pairSym };
        const quoteUsd = pairSym === "USDG" ? 1 : ethUsd;
        try {
          const p = await poolRead(spec);
          if (p && quoteUsd != null) {
            read.priceUsd = p.priceUsd * quoteUsd;
            read.depthUsd2pct = p.depthUsd2pct * quoteUsd;
            if (read.totalSupply != null) read.marketCapUsd = read.priceUsd * read.totalSupply;
            const { amount0, amount1 } = fullRangeAmounts(p.liquidity, p.sqrtPriceX96, spec.decimals0, spec.decimals1);
            const quoteAmount = quoteIs0 ? amount0 : amount1;
            const tokenAmount = quoteIs0 ? amount1 : amount0;
            read.tvlUsd = quoteAmount * quoteUsd + tokenAmount * read.priceUsd;
          }
        } catch { /* the pool did not answer */ }
        try {
          const rows = await updateTape(spec, read.symbol ?? "TOKEN", now, 24 * 60);
          const day = rows.filter((r) => r.at >= now - 24 * 3600e3);
          read.swaps24h = day.length;
          if (quoteUsd != null) read.volume24hUsd = day.reduce((s, r) => s + r.quoteAmount, 0) * quoteUsd;
        } catch { /* no tape this time */ }
      }
    }
  } catch {
    /* no factory record: not a launchpad token, the pool fields stay null */
  }
  try {
    const rules = holderRulesFromEnv();
    const transfers = await updateTransfers(token, read.decimals, now, read.launchedAt, rules);
    const infra = new Set(infrastructureAddresses().map((x) => x.toLowerCase()));
    read.holders = [...balancesFrom(transfers).entries()].filter(([a, v]) => v > 0 && !infra.has(a)).length;
  } catch {
    /* the transfers did not read; holders stays null */
  }
  if (read.priceUsd != null) {
    read.change24h = sampleAndChanges({ at: now, priceUsd: read.priceUsd, tvlUsd: read.tvlUsd, volume24hUsd: read.volume24hUsd, holders: read.holders }, now);
    read.change24hPct = read.change24h.price;
  }
  cache = { at: now, read };
  return read;
}
