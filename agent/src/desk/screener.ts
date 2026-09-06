// The survivors: tokens with a day or more of trading behind them, found
// through a public screener rather than the launch watcher's feed, which
// stops following a token at its 24th hour. The poller (screenerpull.ts)
// asks the screener about tokens the feed once knew, keeps the ones still
// trading, resolves each one's pool key on chain, and writes
// data/obs-screener.json. The desk reads that file like a second feed: a
// token on it that passes the record rule is a candidate with a trading
// record, graded for a swing at ordinary size. Nothing here trades.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dataPath } from "../config.ts";

export const SCREENER_FILE = "obs-screener.json";
const UA = "AgentOBS/1.0 (+https://obscura.markets)";

/** One pool as the screener reports it. */
export interface ScreenerPair {
  poolId: `0x${string}`;
  dex: string;
  labels: string[];
  quoteSymbol: string;
  quoteAddress: `0x${string}`;
  priceUsd: number | null;
  vol24: number;
  vol6: number;
  vol1: number;
  txns24: number;
  txns1: number;
  buys1: number;
  sells1: number;
  liqUsd: number | null;
  chg1: number | null;
  chg24: number | null;
  fdvUsd: number | null;
  pairCreatedAt: number | null;
}

/** A token the poller keeps: its identity from the feed, its best pool from the screener, and that pool's key from chain. */
export interface ScreenerToken {
  token: `0x${string}`;
  symbol: string;
  source: string;
  /** From the feed's launch row when known, else the pool's creation. */
  launchAt: number | null;
  creatorTaxBps: number | null;
  pool: ScreenerPair;
  key: { currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}` } | null;
  readAt: number;
}

export interface ScreenerFile { at: number; tokens: ScreenerToken[] }

export interface ScreenerRules {
  minVol24Usd: number;
  minVol1hUsd: number;
  minTxns24: number;
  minLiqUsd: number;
  /** The last six hours must carry at least this share of the day's volume: still trading, not a morning that died. */
  minSixHourShare: number;
}
export function screenerRulesFromEnv(env: NodeJS.ProcessEnv = process.env): ScreenerRules {
  const n = (k: string, d: number) => Number(env[k] ?? d);
  return {
    minVol24Usd: n("OBS_SCREENER_MIN_VOL24_USD", 250_000),
    minVol1hUsd: n("OBS_SCREENER_MIN_VOL1H_USD", 10_000),
    minTxns24: n("OBS_SCREENER_MIN_TXNS24", 1000),
    minLiqUsd: n("OBS_SCREENER_MIN_LIQ_USD", 50_000),
    minSixHourShare: n("OBS_SCREENER_MIN_SIX_HOUR_SHARE", 0.1),
  };
}

/** PURE: the record rule. Null when the pool passes; otherwise the first reason it does not. */
export function recordFails(p: ScreenerPair, r: ScreenerRules): string | null {
  if (p.vol24 < r.minVol24Usd) return `24h volume $${Math.round(p.vol24).toLocaleString("en-US")} under $${r.minVol24Usd.toLocaleString("en-US")}`;
  if (p.vol1 < r.minVol1hUsd) return `last hour $${Math.round(p.vol1).toLocaleString("en-US")} under $${r.minVol1hUsd.toLocaleString("en-US")}`;
  if (p.txns24 < r.minTxns24) return `${p.txns24} swaps in 24h under ${r.minTxns24}`;
  if (p.liqUsd == null || p.liqUsd < r.minLiqUsd) return p.liqUsd == null ? "liquidity not reported" : `liquidity $${Math.round(p.liqUsd).toLocaleString("en-US")} under $${r.minLiqUsd.toLocaleString("en-US")}`;
  if (p.vol24 > 0 && p.vol6 / p.vol24 < r.minSixHourShare) return `the last six hours carried ${((p.vol6 / p.vol24) * 100).toFixed(0)}% of the day's volume (${Math.round(r.minSixHourShare * 100)}% needed): the day is over`;
  return null;
}

/** PURE: the record in words, for the candidate line. */
export function recordLine(t: ScreenerToken, now: number): string {
  const p = t.pool;
  const ageH = ((now - (t.launchAt ?? p.pairCreatedAt ?? now)) / 3600e3);
  const k = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}k` : `$${Math.round(x)}`);
  return `record: ${ageH >= 48 ? `${(ageH / 24).toFixed(1)} days` : `${ageH.toFixed(0)} h`} old, ${k(p.vol24)} in 24h, ${k(p.vol6)} in 6h, ${k(p.vol1)} last hour, ${p.txns24.toLocaleString("en-US")} swaps in 24h, liquidity ${p.liqUsd != null ? k(p.liqUsd) : "unknown"}, price ${p.chg1 != null ? `${p.chg1 >= 0 ? "+" : ""}${p.chg1.toFixed(0)}% 1h` : ""}${p.chg24 != null ? `, ${p.chg24 >= 0 ? "+" : ""}${p.chg24.toFixed(0)}% 24h` : ""} on its ${p.quoteSymbol} pool`;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : 0);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** The screener's pools for one token on Robinhood Chain. Empty on any failure; the caller retries next round. */
export async function fetchTokenPairs(token: string, timeoutMs = 8000): Promise<ScreenerPair[]> {
  const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${token}`, { headers: { "User-Agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`screener answered ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) return [];
  const out: ScreenerPair[] = [];
  for (const r of rows) {
    const base = (r.baseToken ?? {}) as Record<string, unknown>;
    const quote = (r.quoteToken ?? {}) as Record<string, unknown>;
    if (String(base.address ?? "").toLowerCase() !== token.toLowerCase()) continue;
    const vol = (r.volume ?? {}) as Record<string, unknown>;
    const tx = (r.txns ?? {}) as Record<string, Record<string, unknown>>;
    const chg = (r.priceChange ?? {}) as Record<string, unknown>;
    const liq = (r.liquidity ?? {}) as Record<string, unknown>;
    const t24 = tx.h24 ?? {}, t1 = tx.h1 ?? {};
    out.push({
      poolId: String(r.pairAddress ?? "").toLowerCase() as `0x${string}`,
      dex: String(r.dexId ?? ""),
      labels: Array.isArray(r.labels) ? (r.labels as unknown[]).map(String) : [],
      quoteSymbol: String(quote.symbol ?? "").toUpperCase(),
      quoteAddress: String(quote.address ?? "").toLowerCase() as `0x${string}`,
      priceUsd: numOrNull(r.priceUsd),
      vol24: num(vol.h24), vol6: num(vol.h6), vol1: num(vol.h1),
      txns24: num(t24.buys) + num(t24.sells), txns1: num(t1.buys) + num(t1.sells), buys1: num(t1.buys), sells1: num(t1.sells),
      liqUsd: numOrNull(liq.usd),
      chg1: numOrNull(chg.h1), chg24: numOrNull(chg.h24),
      fdvUsd: numOrNull(r.fdv),
      pairCreatedAt: numOrNull(r.pairCreatedAt),
    });
  }
  return out;
}

/** PURE: the pool the desk would trade: a Uniswap v4 pool quoted in something the desk holds or hops through, the deepest by liquidity, then by 24h volume. */
export function pickPool(pairs: ScreenerPair[], quotes: string[] = ["ETH", "USDG", "NVDA"]): ScreenerPair | null {
  const ok = pairs.filter((p) => p.dex === "uniswap" && p.labels.includes("v4") && /^0x[0-9a-f]{64}$/.test(p.poolId) && quotes.includes(p.quoteSymbol));
  ok.sort((a, b) => (b.liqUsd ?? 0) - (a.liqUsd ?? 0) || b.vol24 - a.vol24);
  return ok[0] ?? null;
}

export function readScreener(): ScreenerFile {
  const p = dataPath(SCREENER_FILE);
  if (!existsSync(p)) return { at: 0, tokens: [] };
  try {
    const f = JSON.parse(readFileSync(p, "utf8")) as ScreenerFile;
    return Array.isArray(f.tokens) ? f : { at: 0, tokens: [] };
  } catch {
    return { at: 0, tokens: [] };
  }
}

export function writeScreener(f: ScreenerFile): void {
  const p = dataPath(SCREENER_FILE);
  writeFileSync(p + ".tmp", JSON.stringify(f));
  renameSync(p + ".tmp", p);
}
