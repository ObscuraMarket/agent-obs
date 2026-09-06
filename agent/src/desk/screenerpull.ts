// The screener poller: every OBS_SCREENER_EVERY_SEC it takes the tokens the
// launch watcher's feed once followed to a late hour, asks the screener what
// each one is doing now, keeps the ones still trading, resolves each one's
// pool key on chain (once, then cached), and writes data/obs-screener.json
// for the desk to read as its board of survivors. Nothing here trades.
import { existsSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { fetchTokenPairs, pickPool, readScreener, writeScreener, screenerRulesFromEnv, recordFails, type ScreenerToken } from "./screener.ts";
import { curveKey } from "./candidates.ts";
import { NEVER_TRADE } from "../config.ts";

const FEED = process.env.OBS_CANDIDATE_FEED ?? "";
const EVERY = Number(process.env.OBS_SCREENER_EVERY_SEC ?? 600);
const MAX_TOKENS = Number(process.env.OBS_SCREENER_MAX_TOKENS ?? 300);
const MIN_FEED_HOUR = Number(process.env.OBS_SCREENER_MIN_FEED_HOUR ?? 18);
const SCAN_MB = Number(process.env.OBS_SCREENER_SCAN_MB ?? 96);
const GAP_MS = Number(process.env.OBS_SCREENER_GAP_MS ?? 250);
const KEEP_DAYS = Number(process.env.OBS_SCREENER_KEEP_DAYS ?? 7);
const rules = screenerRulesFromEnv();

interface Known { token: `0x${string}`; symbol: string; source: string; launchAt: number | null; creatorTaxBps: number | null; maxHour: number }

/** Tokens the feed followed to a late hour: its launch rows for identity, its hourly rows for how far it followed each pool. */
function discover(): Known[] {
  if (!FEED || !existsSync(FEED)) return [];
  const fd = openSync(FEED, "r");
  let text: string;
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - SCAN_MB * 1024 * 1024);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
  const byPool = new Map<string, number>();
  const launches = new Map<string, Known & { poolId: string }>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const kind = r.kind;
    if (kind === "hourly" || kind === "candidate") {
      const id = String(r.id ?? "").toLowerCase();
      const h = Number(r.hour ?? 0);
      if (id && h > (byPool.get(id) ?? -1)) byPool.set(id, h);
    } else if (kind === "launch" && typeof r.token === "string") {
      const token = r.token.toLowerCase() as `0x${string}`;
      const ts = Number(r.ts ?? 0);
      launches.set(token, { token, symbol: String(r.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12), source: String(r.source ?? "launch"), launchAt: ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : null, creatorTaxBps: r.creatorTaxBps == null ? null : Number(r.creatorTaxBps), maxHour: 0, poolId: String(r.curvePoolId ?? "").toLowerCase() });
    }
  }
  const out: Known[] = [];
  for (const l of launches.values()) {
    if (NEVER_TRADE.has(l.token)) continue;
    const h = l.poolId ? (byPool.get(l.poolId) ?? 0) : 0;
    if (h >= MIN_FEED_HOUR && l.symbol) out.push({ ...l, maxHour: h });
  }
  return out;
}

async function round(): Promise<void> {
  const now = Date.now();
  const prior = readScreener();
  const known = new Map<string, Known>();
  for (const k of discover()) known.set(k.token, k);
  // Survivors already on the board stay under watch for a week even after the feed forgets them.
  for (const t of prior.tokens) if (!known.has(t.token) && now - t.readAt < KEEP_DAYS * 86400e3) known.set(t.token, { token: t.token, symbol: t.symbol, source: t.source, launchAt: t.launchAt, creatorTaxBps: t.creatorTaxBps, maxHour: 24 });
  const list = [...known.values()].slice(0, MAX_TOKENS);
  const kept: ScreenerToken[] = [];
  let asked = 0, failed = 0;
  for (const k of list) {
    let pairs;
    try { pairs = await fetchTokenPairs(k.token); asked++; } catch { failed++; continue; }
    const pool = pickPool(pairs);
    if (!pool) continue;
    if (recordFails(pool, rules)) continue;
    let key = prior.tokens.find((t) => t.token === k.token && t.pool.poolId === pool.poolId)?.key ?? null;
    if (!key) {
      try { const ck = await curveKey(pool.poolId); if (ck) key = { currency0: ck.currency0, currency1: ck.currency1, fee: ck.fee, tickSpacing: ck.tickSpacing, hooks: ck.hooks }; } catch { /* next round */ }
    }
    kept.push({ token: k.token, symbol: k.symbol, source: k.source, launchAt: k.launchAt ?? pool.pairCreatedAt, creatorTaxBps: k.creatorTaxBps, pool, key, readAt: now });
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  kept.sort((a, b) => b.pool.vol24 - a.pool.vol24);
  writeScreener({ at: now, tokens: kept });
  console.log(`[screener] ${list.length} tokens asked (${asked} answered, ${failed} failed): ${kept.length} with a record${kept.length ? `: ${kept.slice(0, 8).map((t) => `${t.symbol} $${Math.round(t.pool.vol24 / 1000)}k/24h${t.key ? "" : " (key pending)"}`).join(", ")}` : ""}; ${((Date.now() - now) / 1000).toFixed(0)} s`);
}

console.log(`[screener] every ${EVERY} s, tokens the feed followed to hour ${MIN_FEED_HOUR}+, at most ${MAX_TOKENS} a round`);
for (;;) {
  try {
    await round();
  } catch (e) {
    console.log(`[screener] ${e instanceof Error ? e.message : String(e)}`);
  }
  await new Promise((r) => setTimeout(r, EVERY * 1000));
}
