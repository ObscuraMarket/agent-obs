// Live reads OBS is allowed to cite. Deterministic, public, read-only: the
// $OBS token as it stands on Robinhood Chain, major asset prices, and whether
// the app is up. Every field is nullable; a read that fails this cycle is
// simply not in the block, and the voice doc says what to do then (post
// something evergreen, never invent). The samplers measure, the model
// explains.
//
// The chain's public RPC is Cloudflare-fronted and rejects default
// User-Agents, so every call carries a browser UA. Run `npm run reads` to see
// the block as the model would.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { RPC_URL, OBS_CONTRACT, SITE_URL, API_URL } from "../config.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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

async function ethCall(to: string, data: string): Promise<string | null> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { result?: string };
    return typeof j.result === "string" ? j.result : null;
  } catch {
    return null;
  }
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

/** The $OBS token as the chain reports it right now. */
export async function obsToken(): Promise<TokenRead> {
  const [n, s, d, t, holders] = await Promise.all([ethCall(OBS_CONTRACT, SEL.name), ethCall(OBS_CONTRACT, SEL.symbol), ethCall(OBS_CONTRACT, SEL.decimals), ethCall(OBS_CONTRACT, SEL.totalSupply), explorerHolders()]);
  const decimals = d ? Number(decodeUint(d) ?? -1n) : null;
  const supply = t ? decodeUint(t) : null;
  return {
    address: OBS_CONTRACT,
    name: n ? decodeString(n) : null,
    symbol: s ? decodeString(s) : null,
    decimals: decimals != null && decimals >= 0 ? decimals : null,
    totalSupply: supply != null && decimals != null && decimals >= 0 ? formatSupply(supply, decimals) : null,
    holders,
  };
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

/** USD prices for a set of asset symbols. Missing or unfetchable = null, never zero. */
export async function assetPrices(symbols: string[]): Promise<Record<string, number | null>> {
  const want = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const out: Record<string, number | null> = {};
  const ids = want.map((s) => COINGECKO_IDS[s]).filter(Boolean);
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
}

export async function liveReads(): Promise<Reads> {
  const [token, p, up, api] = await Promise.all([obsToken(), prices(), siteUp(), apiUp()]);
  return { at: Date.now(), token, prices: p, siteUp: up, apiUp: api };
}

/** PURE: the reads block as the prompt shows it. Only measured values appear. */
export function readsBlock(r: Reads): string {
  const lines: string[] = [];
  if (r.token.symbol || r.token.name) {
    lines.push(`- The token on Robinhood Chain: ${r.token.name ?? "?"} (${r.token.symbol ?? "?"})${r.token.totalSupply ? `, total supply ${r.token.totalSupply}` : ""}${r.token.holders != null ? `, ${r.token.holders.toLocaleString("en-US")} holders on the explorer` : ""}. Verified on the site, never pasted.`);
  }
  if (r.prices.btcUsd != null) lines.push(`- BTC ${r.prices.btcUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })} USD`);
  if (r.prices.ethUsd != null) lines.push(`- ETH ${r.prices.ethUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })} USD`);
  lines.push(`- obscura.market is ${r.siteUp ? "up and answering" : "not answering right now (do not mention it)"}; the routing API ${r.apiUp ? "reports healthy" : "did not answer (do not mention it)"}`);
  return lines.join("\n");
}

// Compare paths, not URL strings: a space in the checkout path is "%20" in
// import.meta.url and a literal space in argv, so the string form never matched.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = await liveReads();
  console.log(readsBlock(r));
}
