// Live reads OBS is allowed to cite. Deterministic, public, read-only: the
// $OBS token as it stands on Robinhood Chain, major asset prices, and whether
// the app is up. Every field is nullable; a read that fails this cycle is
// simply not in the block, and the voice doc says what to do then (post
// something evergreen, never invent). The samplers measure, the model
// explains.
//
// Every chain call goes through rpc.ts (browser UA, one at a time, a cooldown
// after a refusal). $OBS is priced by its own market, the pool in pools.ts,
// ahead of the explorer's lagging rate. Run `npm run reads` to see the block
// as the model would.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { RPC_URL, OBS_CONTRACT, SITE_URL, API_URL, WALLET_ADDRESS, ETH_RPC_URL, USDG_CONTRACT, DRY, dataPath, AGENT_TOKEN, AGENT_TOKEN_SYMBOL } from "../config.ts";
import { appendLedger, readLedger } from "../ledger.ts";
import { ASSETS } from "../desk/assets.ts";
import { readTokens, dynamicPoolSpec, dynamicAssets } from "../desk/candidates.ts";
import { UA, rpc, ethCall, rpcBlocked } from "./rpc.ts";
import { obsMarket, poolRead, chainMemory, type MarketRead, type PoolSpec } from "./pools.ts";

export { rpcBlocked };
export type { MarketRead };

// ERC-20 selectors.
const SEL = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd" } as const;

/** PURE: decode an ABI-encoded string return. Exported for tests. */
export function decodeString(hex: string): string | null {
  const h = hex.replace(/^0x/, "");
  if (h.length < 128) return null;
  const off = parseInt(h.slice(0, 64), 16) * 2;
  const len = parseInt(h.slice(off, off + 64), 16) * 2;
  const body = h.slice(off + 64, off + 64 + len);
  if (!body || body.length !== len) return null;
  try {
    return Buffer.from(body, "hex").toString("utf8");
  } catch {
    return null;
  }
}
/** PURE: decode a uint256 return as a bigint. Exported for tests. */
export function decodeUint(hex: string): bigint | null {
  const h = hex.replace(/^0x/, "");
  if (h.length !== 64) return null;
  try {
    return BigInt("0x" + h);
  } catch {
    return null;
  }
}
/** PURE: a whole-token figure from raw units, no decimals shown past what is meaningful. */
export function formatSupply(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals);
  return whole.toLocaleString("en-US");
}


/** PURE: whole units from raw, as a number with sensible precision. */
export function fromRaw(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}
/** PURE: balanceOf(holder) calldata. Exported for tests. */
export function balanceOfData(holder: string): string {
  return "0x70a08231" + holder.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function nativeBalance(url: string, holder: string): Promise<number | null> {
  const r = await rpc(url, "eth_getBalance", [holder, "latest"]);
  if (!r) return null;
  try {
    return fromRaw(BigInt(r), 18);
  } catch {
    return null;
  }
}
async function tokenBalance(token: string, holder: string, decimals: number): Promise<number | null> {
  const r = await ethCall(token, balanceOfData(holder));
  const v = r ? decodeUint(r) : null;
  return v == null ? null : fromRaw(v, decimals);
}

export interface WalletRead {
  address: string;
  /** Native ETH on Robinhood Chain and on Ethereum mainnet. */
  ethRobinhood: number | null;
  ethMainnet: number | null;
  usdg: number | null;
  obs: number | null;
  usdc: number | null;
  usdt: number | null;
  nvda: number | null;
  /** Every registered token balance keyed SYMBOL@network, the named fields above included. Null = the chain did not answer. */
  tokens?: Record<string, number | null>;
  /**
   * The desk's own token (AOBS), read on its own. It is wallet value: on the book and in equity, booked as capital
   * when it arrives so it never reads as profit, but not listed as a position, and never on either leg of a swap. Null = not answered.
   */
  own?: { symbol: string; contract: string; qty: number | null };
  /** Obscura's own cashback stats for this wallet (GET /rewards/{wallet}). */
  rewards: { swaps: number; volumeUsd: number; rewardsUsd: number; paidUsd: number } | null;
}

async function mainnetTokenBalance(token: string, holder: string, decimals: number): Promise<number | null> {
  const r = await rpc(ETH_RPC_URL, "eth_call", [{ to: token, data: balanceOfData(holder) }, "latest"]);
  const v = r ? decodeUint(r) : null;
  return v == null ? null : fromRaw(v, decimals);
}

/** PURE: balances keyed the way the rails and the book read them (SYMBOL@network and SYMBOL).
 *  `unread` names the balances the chain did not answer for this cycle; they are absent, not zero. */
export function walletBalances(w: WalletRead): { byKey: Record<string, number>; bySymbol: Record<string, number>; unread: string[] } {
  const pairs: Array<[string, string, number | null]> = [
    ["ETH@eth", "ETH", w.ethMainnet],
    ["ETH@robinhood", "ETH", w.ethRobinhood],
    ["USDC@erc20", "USDC", w.usdc],
    ["USDT@erc20", "USDT", w.usdt],
    ["USDG@robinhood", "USDG", w.usdg],
    ["NVDA@robinhood", "NVDA", w.nvda],
    ["OBS@robinhood", "OBS", w.obs],
  ];
  const named = new Set(pairs.map(([k]) => k));
  for (const [k, v] of Object.entries(w.tokens ?? {})) if (!named.has(k)) pairs.push([k, k.split("@")[0], v]);
  // The desk's own token is wallet value: on the book and in the mark, priced from its pool, never on either leg of a swap.
  if (w.own) pairs.push([`${w.own.symbol}@robinhood`, w.own.symbol, w.own.qty]);
  const byKey: Record<string, number> = {};
  const bySymbol: Record<string, number> = {};
  const unread: string[] = [];
  for (const [k, s, v] of pairs) {
    if (v == null) {
      unread.push(k);
      continue;
    }
    byKey[k] = v;
    bySymbol[s] = (bySymbol[s] ?? 0) + v;
  }
  return { byKey, bySymbol, unread };
}

/** The desk's wallet as the chains and Obscura report it. Null when no wallet is configured. */
export async function walletRead(address = WALLET_ADDRESS): Promise<WalletRead | null> {
  if (!address) return null;
  // Robinhood Chain reads one at a time (rate-limited RPC); the rest in parallel.
  // Every registered erc20: Ethereum ones in parallel, Robinhood ones one at a time.
  const registered = Object.values(ASSETS).filter((a) => a.kind === "erc20" && a.contract);
  const mainnetTokens = registered.filter((a) => a.chain === "ethereum");
  const mainnetP = Promise.all([nativeBalance(ETH_RPC_URL, address), ...mainnetTokens.map((a) => mainnetTokenBalance(a.contract as string, address, a.decimals))]);
  const tokens: Record<string, number | null> = {};
  const ethRobinhood = await nativeBalance(RPC_URL, address);
  const usdg = await tokenBalance(USDG_CONTRACT, address, 6);
  const obs = await tokenBalance(OBS_CONTRACT, address, 18);
  tokens["USDG@robinhood"] = usdg;
  tokens["OBS@robinhood"] = obs;
  for (const a of registered.filter((x) => x.chain === "robinhood" && x.symbol !== "USDG")) tokens[`${a.symbol}@${a.network}`] = await tokenBalance(a.contract as string, address, a.decimals);
  // Launch tokens the desk has traded (data/obs-tokens.json): read too, so a held one is on the book.
  for (const t of readTokens()) if (!ASSETS[`${t.symbol}@robinhood`]) tokens[`${t.symbol}@robinhood`] = await tokenBalance(t.contract, address, t.decimals);
  const own = { symbol: AGENT_TOKEN_SYMBOL, contract: AGENT_TOKEN, qty: await tokenBalance(AGENT_TOKEN, address, 18) };
  const nvda = tokens["NVDA@robinhood"] ?? null;
  const [[ethMainnet, ...mainnetBalances], rewards] = await Promise.all([
    mainnetP,
    (async () => {
      try {
        const res = await fetch(`${API_URL}/rewards/${address}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6_000) });
        const j = (await res.json()) as { stats?: { swaps?: number; volumeUsd?: number; rewardsUsd?: number; paidUsd?: number } };
        const s = j.stats;
        return s ? { swaps: Number(s.swaps ?? 0), volumeUsd: Number(s.volumeUsd ?? 0), rewardsUsd: Number(s.rewardsUsd ?? 0), paidUsd: Number(s.paidUsd ?? 0) } : null;
      } catch {
        return null;
      }
    })(),
  ]);
  mainnetTokens.forEach((a, i) => (tokens[`${a.symbol}@${a.network}`] = mainnetBalances[i] ?? null));
  const usdc = tokens["USDC@erc20"] ?? null;
  const usdt = tokens["USDT@erc20"] ?? null;
  return { address, ethRobinhood, ethMainnet, usdg, obs, usdc, usdt, nvda, tokens, own, rewards };
}

export interface TokenRead {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  /** Holder count from the chain's explorer, best-effort. */
  holders: number | null;
  /** The explorer's own numbers, which lag the pool: its USD rate, 24h volume and market cap. */
  explorerPriceUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  /** The 24-hour volume, the holder count and the market's TVL against the oldest sample inside the last day, as fractions; measured by the desk, the same for every viewer. */
  change24h?: { volume: number | null; holders: number | null; liquidity: number | null };
}

const TOKEN_CACHE = "obs-token.json";
const TOKEN_SAMPLES = "obs-token-samples.jsonl";
interface TokenSample { at: number; volume24hUsd: number | null; holders: number | null; tvlUsd: number | null; /** Which pool the TVL came from; a TVL is only compared with its own pool's. */ pool?: string | null }
const frac24 = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null && a > 0 ? (b - a) / a : null);
/** Append this read's figures and measure each against the oldest sample inside the last day. */
function tokenChanges(sample: TokenSample, now: number): NonNullable<TokenRead["change24h"]> {
  if (!DRY) appendLedger(TOKEN_SAMPLES, sample as unknown as Record<string, unknown>);
  const rows = readLedger<TokenSample>(TOKEN_SAMPLES).filter((r) => r && Number.isFinite(r.at) && now - r.at <= 24 * 3600e3);
  if (rows.length < 2) return { volume: null, holders: null, liquidity: null };
  const first = (k: keyof TokenSample, from: TokenSample[] = rows) => from.find((r) => r[k] != null && (r[k] as number) > 0)?.[k] as number | undefined;
  const samePool = rows.filter((r) => (r.pool ?? null) === (sample.pool ?? null));
  return { volume: frac24(first("volume24hUsd"), sample.volume24hUsd), holders: frac24(first("holders"), sample.holders), liquidity: frac24(first("tvlUsd", samePool), sample.tvlUsd) };
}
const TOKEN_CACHE_TTL_MS = 24 * 3600e3;

/** The $OBS token as the chain reports it. Name, symbol, decimals and supply
 *  change essentially never, so they are cached on disk for a day and cost
 *  the rate-limited RPC nothing on ordinary cycles; holders stay live. */
export async function obsToken(): Promise<TokenRead> {
  const explorerP = explorerToken();
  let meta: Pick<TokenRead, "name" | "symbol" | "decimals" | "totalSupply"> | null = null;
  try {
    const p = dataPath(TOKEN_CACHE);
    if (existsSync(p)) {
      const c = JSON.parse(readFileSync(p, "utf8")) as { at?: number; address?: string; name?: string; symbol?: string; decimals?: number; totalSupply?: string };
      if (c.address === OBS_CONTRACT && c.at && Date.now() - c.at < TOKEN_CACHE_TTL_MS && c.symbol) meta = { name: c.name ?? null, symbol: c.symbol, decimals: c.decimals ?? null, totalSupply: c.totalSupply ?? null };
    }
  } catch {
    meta = null;
  }
  if (!meta) {
    // One Robinhood RPC call at a time; the explorer is a different host.
    const n = await ethCall(OBS_CONTRACT, SEL.name);
    const s = await ethCall(OBS_CONTRACT, SEL.symbol);
    const d = await ethCall(OBS_CONTRACT, SEL.decimals);
    const t = await ethCall(OBS_CONTRACT, SEL.totalSupply);
    const decimals = d ? Number(decodeUint(d) ?? -1n) : null;
    const supply = t ? decodeUint(t) : null;
    meta = {
      name: n ? decodeString(n) : null,
      symbol: s ? decodeString(s) : null,
      decimals: decimals != null && decimals >= 0 ? decimals : null,
      totalSupply: supply != null && decimals != null && decimals >= 0 ? formatSupply(supply, decimals) : null,
    };
    if (meta.symbol && meta.totalSupply) {
      try {
        writeFileSync(dataPath(TOKEN_CACHE), JSON.stringify({ at: Date.now(), address: OBS_CONTRACT, ...meta }));
      } catch {
        /* a cache miss next time costs four calls, nothing more */
      }
    }
  }
  const x = await explorerP;
  // The explorer is flaky; its last good figures stand in for up to six hours rather than a blank card.
  const EXPLORER_CACHE = "obs-explorer.json";
  let view = x;
  if (x.holders == null && x.volume24hUsd == null && x.priceUsd == null) {
    try {
      const c = JSON.parse(readFileSync(dataPath(EXPLORER_CACHE), "utf8")) as ExplorerView & { at?: number };
      if (c.at && Date.now() - c.at < 6 * 3600e3) view = { holders: c.holders ?? null, priceUsd: c.priceUsd ?? null, volume24hUsd: c.volume24hUsd ?? null, marketCapUsd: c.marketCapUsd ?? null };
    } catch {
      /* nothing cached */
    }
  } else if (!DRY) {
    try {
      writeFileSync(dataPath(EXPLORER_CACHE), JSON.stringify({ at: Date.now(), ...x }));
    } catch {
      /* the cache is a convenience */
    }
  }
  return { address: OBS_CONTRACT, ...meta, holders: view.holders, explorerPriceUsd: view.priceUsd, volume24hUsd: view.volume24hUsd, marketCapUsd: view.marketCapUsd };
}

interface ExplorerView {
  holders: number | null;
  priceUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
}
const pos = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
/** The explorer's view of the token: holders, its USD rate, 24h volume, market cap. Null fields when it will not answer. */
async function explorerToken(): Promise<ExplorerView> {
  try {
    const res = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${OBS_CONTRACT}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6_000) });
    const j = (await res.json()) as { holders_count?: string | number; exchange_rate?: string | number | null; volume_24h?: string | number | null; circulating_market_cap?: string | number | null };
    return { holders: pos(j.holders_count), priceUsd: pos(j.exchange_rate), volume24hUsd: pos(j.volume_24h), marketCapUsd: pos(j.circulating_market_cap) };
  } catch {
    return { holders: null, priceUsd: null, volume24hUsd: null, marketCapUsd: null };
  }
}

// The $OBS price over time, for the chart. One sample a minute at most,
// written whenever a read succeeds (the desk cycle, the dashboard), so the
// curve exists without a separate job and the file stays small.
const MARKET_LEDGER = "obs-market.jsonl";
const SAMPLE_GAP_MS = 55_000;
let lastSampleAt: number | null = null;
export interface MarketSample {
  at: number;
  priceUsd: number;
  depthUsd2pct: number;
}
function sampleMarket(m: MarketRead): void {
  if (lastSampleAt == null) {
    const rows = readMarketSamples();
    lastSampleAt = rows.length ? rows[rows.length - 1].at : 0;
  }
  if (m.at - lastSampleAt < SAMPLE_GAP_MS) return;
  lastSampleAt = m.at;
  appendLedger(MARKET_LEDGER, { at: m.at, priceUsd: m.priceUsd, depthUsd2pct: m.depthUsd2pct });
}
export function readMarketSamples(): MarketSample[] {
  return readLedger<MarketSample>(MARKET_LEDGER).filter((r) => r && Number.isFinite(Number(r.at)) && Number(r.priceUsd) > 0);
}
/** PURE: the samples inside a window, oldest first, thinned to about maxPoints with the last one always kept. */
export function marketSeries(rows: MarketSample[], sinceMs: number, now: number, maxPoints = 400): MarketSample[] {
  const inWindow = rows.filter((r) => r.at >= now - sinceMs).sort((a, b) => a.at - b.at);
  if (inWindow.length <= maxPoints) return inWindow;
  const step = Math.ceil(inWindow.length / maxPoints);
  const out = inWindow.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== inWindow[inWindow.length - 1]) out.push(inWindow[inWindow.length - 1]);
  return out;
}
/** PURE: the move over the last day, against the oldest sample inside it. Null with fewer than two samples. */
export function change24h(rows: MarketSample[], now: number): number | null {
  const s = marketSeries(rows, 24 * 3600e3, now, Number.MAX_SAFE_INTEGER);
  if (s.length < 2) return null;
  const a = s[0].priceUsd;
  const b = s[s.length - 1].priceUsd;
  return a > 0 ? (b - a) / a : null;
}

// Assets the desk can mark, by CoinGecko id. Anything not here (and not a
// dollar stable) is "unpriced" in the book, which the snapshot says out loud.
const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  TRX: "tron",
  XMR: "monero",
  LTC: "litecoin",
  TON: "the-open-network",
  SUI: "sui",
  POL: "polygon-ecosystem-token",
  MATIC: "matic-network",
  AVAX: "avalanche-2",
  ARB: "arbitrum",
  OP: "optimism",
  XRP: "ripple",
  HYPE: "hyperliquid",
  LINK: "chainlink",
  DOGE: "dogecoin",
  WBTC: "wrapped-bitcoin",
  UNI: "uniswap",
  AAVE: "aave",
};

/** USD prices for a set of asset symbols. Missing or unfetchable = null, never zero.
 *  `known` carries prices already measured this cycle (OBS from its own pool); they win. */
export async function assetPrices(symbols: string[], known: Record<string, number | null> = {}): Promise<Record<string, number | null>> {
  const want = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const out: Record<string, number | null> = {};
  for (const s of want) if (typeof known[s] === "number" && (known[s] as number) > 0) out[s] = known[s];
  const ids = want.filter((s) => !(s in out)).map((s) => COINGECKO_IDS[s]).filter(Boolean);
  if (ids.length) {
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6_000) });
      const j = (await res.json()) as Record<string, { usd?: number }>;
      for (const s of want) {
        const id = COINGECKO_IDS[s];
        const p = id ? j[id]?.usd : undefined;
        if (typeof p === "number" && p > 0) out[s] = p;
      }
    } catch {
      /* every missing symbol stays null below */
    }
  }
  // Tokenized stocks, and anything else CoinGecko does not carry: the asset's
  // own USDG pool on Robinhood Chain, from the chain memory or, for a launch
  // token, from the candidate feed or the token file. One at a time.
  let dyn: ReturnType<typeof dynamicAssets> | null = null;
  for (const s of want) {
    if (s in out) continue;
    let spec: PoolSpec | undefined = chainMemory().referencePools[`${s}/USDG`];
    if (!spec) {
      dyn ??= dynamicAssets();
      const a = dyn[`${s}@robinhood`];
      spec = (a && dynamicPoolSpec(a)) ?? undefined;
    }
    if (!spec) continue;
    const r = await poolRead(spec);
    if (!r || !(r.priceUsd > 0)) continue;
    // A launch curve quoted in NVDA or ETH prices the token in that quote; convert through the quote's dollar price.
    if (spec.quote && spec.quote !== "USDG") {
      let qp = out[spec.quote] ?? null;
      if (qp == null) {
        const qs = chainMemory().referencePools[`${spec.quote}/USDG`];
        const qr = qs ? await poolRead(qs) : null;
        qp = qr && qr.priceUsd > 0 ? qr.priceUsd : null;
      }
      if (qp == null) continue;
      out[s] = r.priceUsd * qp;
    } else out[s] = r.priceUsd;
  }
  if (want.includes("OBS") && out.OBS == null) out.OBS = (await explorerToken()).priceUsd;
  for (const s of want) if (!(s in out)) out[s] = null;
  return out;
}

export interface PriceRead {
  btcUsd: number | null;
  ethUsd: number | null;  /** The wider market's 24h moves, from the same read. Null when not answered. */
  btcChange24hPct?: number | null;
  ethChange24hPct?: number | null;
}

/** Spot prices for the two assets every route touches. Best-effort. */
export async function prices(): Promise<PriceRead> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&price_change_percentage=24h", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6_000) });
    const rows = (await res.json()) as Array<{ id?: string; current_price?: number; price_change_percentage_24h?: number | null }>;
    const by = (id: string) => (Array.isArray(rows) ? rows.find((r) => r.id === id) : undefined);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { btcUsd: num(by("bitcoin")?.current_price), ethUsd: num(by("ethereum")?.current_price), btcChange24hPct: num(by("bitcoin")?.price_change_percentage_24h), ethChange24hPct: num(by("ethereum")?.price_change_percentage_24h) };
  } catch {
    return { btcUsd: null, ethUsd: null, btcChange24hPct: null, ethChange24hPct: null };
  }
}

/** Is Obscura's API answering right now (its own /health). */
export async function apiUp(): Promise<boolean> {
  try {
    const res = await fetch(API_URL + "/health", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6_000) });
    const j = (await res.json()) as { status?: string };
    return res.ok && j.status === "ok";
  } catch {
    return false;
  }
}

/** Is the app answering right now. */
export async function siteUp(): Promise<boolean> {
  try {
    const res = await fetch(SITE_URL + "/", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface Reads {
  at: number;
  token: TokenRead;
  prices: PriceRead;
  siteUp: boolean;
  apiUp: boolean;
  wallet: WalletRead | null;
  /** $OBS as its own on-chain market prices it. Null when the chain did not answer. */
  market: MarketRead | null;
}

/** The last ETH price the desk sampled (obs-prices.jsonl), for a market read when the price feed is down, and for pricing a launch's first swaps. */
export function lastSampledEth(): number | null {
  const rows = readLedger<{ at: number; symbol: string; priceUsd: number }>("obs-prices.jsonl").filter((r) => r && r.symbol === "ETH" && Number(r.priceUsd) > 0 && Date.now() - Number(r.at) < 6 * 3600e3);
  return rows.length ? Number(rows[rows.length - 1].priceUsd) : null;
}

export async function liveReads(): Promise<Reads> {
  const othersP = Promise.all([prices(), siteUp(), apiUp()]);
  // The Robinhood-heavy reads run back to back, not on top of each other.
  const token = await obsToken();
  const wallet = await walletRead();
  const [p, up, api] = await othersP;
  // OBS's market needs the ETH price when its deep pool is the ETH one; when the price feed is down, the last sampled ETH price serves.
  const ethUsd = p.ethUsd ?? lastSampledEth();
  const market = await obsMarket(ethUsd);
  if (market && !DRY) sampleMarket(market);
  const now = Date.now();
  token.change24h = tokenChanges({ at: now, volume24hUsd: token.volume24hUsd, holders: token.holders, tvlUsd: market?.tvlUsd ?? null, pool: market ? `${market.venue}:${market.quote ?? ""}` : null }, now);
  return { at: Date.now(), token, prices: p, siteUp: up, apiUp: api, wallet, market };
}

/** PURE: a small price with the digits that matter, a large one to the cent. */
export function usdPrice(v: number): string {
  return v >= 1 ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${v.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;
}

/** PURE: the market line as the prompt, the observation and the dashboard show it. */
export function marketLine(m: MarketRead): string {
  const venue = m.quote === "ETH" ? "its ETH pool on Uniswap v4" : m.venue === "ramses-v3" ? "its USDG pool on Ramses" : "its USDG pool";
  return `OBS at ${usdPrice(m.priceUsd)} on its own market (${venue}, ${m.feePct}% tier); about ${usdPrice(m.depthUsd2pct)} of buying moves the price 2%.`;
}

const fmt = (v: number | null, digits: number) => (v == null ? "not read" : v.toLocaleString("en-US", { maximumFractionDigits: digits }));

/** PURE: the wallet lines as the prompt and the dashboard show them. */
export function walletLines(w: WalletRead | null): string[] {
  if (!w) return [];
  const extras = Object.entries(w.tokens ?? {})
    .filter(([k, v]) => v != null && v > 0 && !["USDG@robinhood", "OBS@robinhood"].includes(k))
    .map(([k, v]) => `${fmt(v as number, k.startsWith("USD") || k.startsWith("DAI") ? 2 : 6)} ${k.split("@")[0]}${k.endsWith("@erc20") ? " on Ethereum" : ""}`);
  const out = [`- The desk's wallet (on chain): ${fmt(w.ethRobinhood, 6)} ETH on Robinhood Chain, ${fmt(w.ethMainnet, 6)} ETH on Ethereum, ${fmt(w.usdg, 2)} USDG, ${fmt(w.obs, 2)} OBS${extras.length ? ", " + extras.join(", ") : ""}.`];
  if (w.rewards) out.push(`- Obscura cashback for this wallet: ${w.rewards.swaps} swaps, $${w.rewards.volumeUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} volume, $${w.rewards.rewardsUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} earned, $${w.rewards.paidUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} paid out.`);
  return out;
}

/** PURE: the reads block as the prompt shows it. Only measured values appear. */
export function readsBlock(r: Reads): string {
  const lines: string[] = [];
  if (r.token.symbol || r.token.name) {
    lines.push(`- The token on Robinhood Chain: ${r.token.name ?? "?"} (${r.token.symbol ?? "?"})${r.token.totalSupply ? `, total supply ${r.token.totalSupply}` : ""}${r.token.holders != null ? `, ${r.token.holders.toLocaleString("en-US")} holders on the explorer` : ""}. Verified on the site, never pasted.`);
  }
  if (r.prices.btcUsd != null) lines.push(`- BTC ${r.prices.btcUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })} USD`);
  if (r.prices.ethUsd != null) lines.push(`- ETH ${r.prices.ethUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })} USD`);
  if (r.market) lines.push(`- ${marketLine(r.market)}`);
  lines.push(...walletLines(r.wallet));
  lines.push(`- obscura.market is ${r.siteUp ? "up and answering" : "not answering right now (do not mention it)"}; the routing API ${r.apiUp ? "reports healthy" : "did not answer (do not mention it)"}`);
  return lines.join("\n");
}

// Compare paths, not URL strings: a space in the checkout path is "%20" in
// import.meta.url and a literal space in argv, so the string form never matched.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = await liveReads();
  console.log(readsBlock(r));
}
