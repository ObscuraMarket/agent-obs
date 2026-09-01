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
import { RPC_URL, OBS_CONTRACT, SITE_URL, API_URL, WALLET_ADDRESS, ETH_RPC_URL, USDG_CONTRACT, dataPath } from "../config.ts";
import { UA, rpc, ethCall, rpcBlocked } from "./rpc.ts";
import { obsMarket, type MarketRead } from "./pools.ts";

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
  const mainnetP = Promise.all([
    nativeBalance(ETH_RPC_URL, address),
    mainnetTokenBalance("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", address, 6),
    mainnetTokenBalance("0xdAC17F958D2ee523a2206206994597C13D831ec7", address, 6),
  ]);
  const ethRobinhood = await nativeBalance(RPC_URL, address);
  const usdg = await tokenBalance(USDG_CONTRACT, address, 6);
  const obs = await tokenBalance(OBS_CONTRACT, address, 18);
  const nvda = await tokenBalance("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", address, 18);
  const [[ethMainnet, usdc, usdt], rewards] = await Promise.all([
    mainnetP,
    (async () => {
      try {
        const res = await fetch(`${API_URL}/rewards/${address}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
        const j = (await res.json()) as { stats?: { swaps?: number; volumeUsd?: number; rewardsUsd?: number; paidUsd?: number } };
        const s = j.stats;
        return s ? { swaps: Number(s.swaps ?? 0), volumeUsd: Number(s.volumeUsd ?? 0), rewardsUsd: Number(s.rewardsUsd ?? 0), paidUsd: Number(s.paidUsd ?? 0) } : null;
      } catch {
        return null;
      }
    })(),
  ]);
  return { address, ethRobinhood, ethMainnet, usdg, obs, usdc, usdt, nvda, rewards };
}

export interface TokenRead {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  /** Holder count from the chain's explorer, best-effort. */
  holders: number | null;
}

const TOKEN_CACHE = "obs-token.json";
const TOKEN_CACHE_TTL_MS = 24 * 3600e3;

/** The $OBS token as the chain reports it. Name, symbol, decimals and supply
 *  change essentially never, so they are cached on disk for a day and cost
 *  the rate-limited RPC nothing on ordinary cycles; holders stay live. */
export async function obsToken(): Promise<TokenRead> {
  const holdersP = explorerHolders();
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
  return { address: OBS_CONTRACT, ...meta, holders: await holdersP };
}

/** The explorer's view of the token: holder count and its USD rate. Null fields when it will not answer. */
async function explorerToken(): Promise<{ holders: number | null; priceUsd: number | null }> {
  try {
    const res = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${OBS_CONTRACT}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as { holders_count?: string | number; exchange_rate?: string | number | null };
    const n = Number(j.holders_count);
    const p = Number(j.exchange_rate);
    return { holders: Number.isFinite(n) && n > 0 ? n : null, priceUsd: Number.isFinite(p) && p > 0 ? p : null };
  } catch {
    return { holders: null, priceUsd: null };
  }
}
async function explorerHolders(): Promise<number | null> {
  return (await explorerToken()).holders;
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
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
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
  if (want.includes("OBS") && out.OBS == null) out.OBS = (await explorerToken()).priceUsd;
  for (const s of want) if (!(s in out)) out[s] = null;
  return out;
}

export interface PriceRead {
  btcUsd: number | null;
  ethUsd: number | null;
}

/** Spot prices for the two assets every route touches. Best-effort. */
export async function prices(): Promise<PriceRead> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as { bitcoin?: { usd?: number }; ethereum?: { usd?: number } };
    return { btcUsd: j.bitcoin?.usd ?? null, ethUsd: j.ethereum?.usd ?? null };
  } catch {
    return { btcUsd: null, ethUsd: null };
  }
}

/** Is Obscura's API answering right now (its own /health). */
export async function apiUp(): Promise<boolean> {
  try {
    const res = await fetch(API_URL + "/health", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as { status?: string };
    return res.ok && j.status === "ok";
  } catch {
    return false;
  }
}

/** Is the app answering right now. */
export async function siteUp(): Promise<boolean> {
  try {
    const res = await fetch(SITE_URL + "/", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
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

export async function liveReads(): Promise<Reads> {
  const othersP = Promise.all([prices(), siteUp(), apiUp()]);
  // The Robinhood-heavy reads run back to back, not on top of each other.
  const token = await obsToken();
  const wallet = await walletRead();
  const market = await obsMarket();
  const [p, up, api] = await othersP;
  return { at: Date.now(), token, prices: p, siteUp: up, apiUp: api, wallet, market };
}

/** PURE: a small price with the digits that matter, a large one to the cent. */
export function usdPrice(v: number): string {
  return v >= 1 ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${v.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;
}

/** PURE: the market line as the prompt, the observation and the dashboard show it. */
export function marketLine(m: MarketRead): string {
  const venue = m.venue === "ramses-v3" ? "its USDG pool on Ramses" : "its USDG pool";
  return `OBS at ${usdPrice(m.priceUsd)} on its own market (${venue}, ${m.feePct}% tier); about ${usdPrice(m.depthUsd2pct)} of buying moves the price 2%.`;
}

const fmt = (v: number | null, digits: number) => (v == null ? "not read" : v.toLocaleString("en-US", { maximumFractionDigits: digits }));

/** PURE: the wallet lines as the prompt and the dashboard show them. */
export function walletLines(w: WalletRead | null): string[] {
  if (!w) return [];
  const extras = [w.usdc ? `${fmt(w.usdc, 2)} USDC` : "", w.usdt ? `${fmt(w.usdt, 2)} USDT` : "", w.nvda ? `${fmt(w.nvda, 6)} NVDA` : ""].filter(Boolean);
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
