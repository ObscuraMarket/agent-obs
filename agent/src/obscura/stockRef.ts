// Where NVDA "should" be, from outside its pool. Two references, both public,
// both read-only: the last official print from the exchange's own quote API
// (live in US hours, frozen otherwise), and the perp venue on this chain,
// which prices NVDA around the clock with real volume and tracks the print
// while it is live and the market's expectation while it is not. The pool's
// distance from these is the basis, and the basis is the desk's bread and
// butter: it opens off-hours and closes at the open.
import { readLedger, appendLedger } from "../ledger.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TTL_MS = 60_000;
export const REF_LEDGER = "obs-stockref.jsonl";

export interface StockRef {
  symbol: string;
  /** The last official print, and whether the exchange says the market is open. */
  printUsd: number | null;
  printStatus: "open" | "closed" | "unknown";
  printAt: string | null;
  /** The extended-hours print when the exchange reports one. */
  extendedUsd: number | null;
  /** The perp venue's last trade, around the clock, with its day's trade count. */
  perpUsd: number | null;
  perpTradesDay: number | null;
  perpChangeDayPct: number | null;
  at: number;
}

/** PURE: the exchange's quote payload, decoded forgivingly. */
export function decodeNasdaq(j: unknown): { printUsd: number | null; printStatus: StockRef["printStatus"]; printAt: string | null; extendedUsd: number | null } {
  const d = ((j as { data?: Record<string, unknown> })?.data ?? {}) as Record<string, unknown>;
  const p = (d.primaryData ?? {}) as Record<string, unknown>;
  const s = (d.secondaryData ?? {}) as Record<string, unknown>;
  const money = (v: unknown): number | null => {
    const n = Number(String(v ?? "").replace(/[$,]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const status = String(d.marketStatus ?? "").toLowerCase();
  return {
    printUsd: money(p.lastSalePrice),
    printStatus: status.includes("open") ? "open" : status.includes("close") ? "closed" : "unknown",
    printAt: typeof p.lastTradeTimestamp === "string" ? p.lastTradeTimestamp : null,
    extendedUsd: money(s.lastSalePrice),
  };
}

/** PURE: the perp venue's stats payload, decoded to the one market we want. */
export function decodeLighter(j: unknown, symbol: string): { perpUsd: number | null; perpTradesDay: number | null; perpChangeDayPct: number | null } {
  const rows = ((j as { order_book_stats?: unknown[] })?.order_book_stats ?? []) as Array<Record<string, unknown>>;
  const row = rows.find((r) => String(r.symbol ?? "").toUpperCase() === symbol.toUpperCase());
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return { perpUsd: row ? num(row.last_trade_price) : null, perpTradesDay: row ? num(row.daily_trades_count) : null, perpChangeDayPct: row ? num(row.daily_price_change) : null };
}

const cache = new Map<string, { at: number; value: StockRef }>();

/** Both references for one symbol, cached a minute. Nulls where a source did not answer; never a guess. */
export async function stockReference(symbol = "NVDA", now = Date.now()): Promise<StockRef> {
  const hit = cache.get(symbol);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const [nq, lt] = await Promise.all([
    fetch(`https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=stocks`, { headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(15_000) })
      .then((r) => r.json())
      .catch(() => null),
    fetch("https://api.rh.lighter.xyz/api/v1/exchangeStats", { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) })
      .then((r) => r.json())
      .catch(() => null),
  ]);
  const a = nq ? decodeNasdaq(nq) : { printUsd: null, printStatus: "unknown" as const, printAt: null, extendedUsd: null };
  const b = lt ? decodeLighter(lt, symbol) : { perpUsd: null, perpTradesDay: null, perpChangeDayPct: null };
  const value: StockRef = { symbol, ...a, ...b, at: now };
  cache.set(symbol, { at: now, value });
  if (value.printUsd != null || value.perpUsd != null) appendLedger(REF_LEDGER, { at: now, symbol, printUsd: value.printUsd, printStatus: value.printStatus, extendedUsd: value.extendedUsd, perpUsd: value.perpUsd });
  return value;
}

export function readReferences(): Array<{ at: number; symbol: string; printUsd: number | null; perpUsd: number | null }> {
  return readLedger<{ at: number; symbol: string; printUsd: number | null; perpUsd: number | null }>(REF_LEDGER).filter((r) => r && Number.isFinite(Number(r.at)));
}
