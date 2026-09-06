// The screener poller: every OBS_SCREENER_EVERY_SEC it takes every token the
// launch watcher's feed has logged (a launch row, in the last
// OBS_SCREENER_SCAN_MB of the file), asks the screener about them thirty at
// a time, keeps the ones with a trading record or a market cap at the floor,
// reads each keeper's pools to pick the one the desk would trade, resolves
// that pool's key on chain (once, then cached), and writes
// data/obs-screener.json for the desk to read as its board of survivors.
// Nothing here trades.
import { existsSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { fetchTokenPairs, fetchTokensBatch, pickPool, readScreener, writeScreener, screenerRulesFromEnv, recordFails, capKeeps, type ScreenerToken, type ScreenerPair } from "./screener.ts";
import { curveKey } from "./candidates.ts";
import { NEVER_TRADE } from "../config.ts";

const FEED = process.env.OBS_CANDIDATE_FEED ?? "";
const EVERY = Number(process.env.OBS_SCREENER_EVERY_SEC ?? 600);
const MAX_TOKENS = Number(process.env.OBS_SCREENER_MAX_TOKENS ?? 6000);
const SCAN_MB = Number(process.env.OBS_SCREENER_SCAN_MB ?? 96);
const GAP_MS = Number(process.env.OBS_SCREENER_GAP_MS ?? 250);
const KEEP_DAYS = Number(process.env.OBS_SCREENER_KEEP_DAYS ?? 7);
const rules = screenerRulesFromEnv();

interface Known { token: `0x${string}`; symbol: string; source: string; launchAt: number | null; creatorTaxBps: number | null }

/** Every token the feed logged a launch for, newest first. */
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
  const clean = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  const launches = new Map<string, Known>();
  for (const line of text.split("\n")) {
    if (!line || !line.includes('"launch"')) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (r.kind !== "launch" || typeof r.token !== "string") continue;
    const token = r.token.toLowerCase() as `0x${string}`;
    if (NEVER_TRADE.has(token)) continue;
    const ts = Number(r.ts ?? 0);
    const symbol = clean(r.symbol);
    if (!symbol) continue;
    launches.set(token, { token, symbol, source: String(r.source ?? "launch"), launchAt: ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : null, creatorTaxBps: r.creatorTaxBps == null ? null : Number(r.creatorTaxBps) });
  }
  return [...launches.values()].reverse();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function round(): Promise<void> {
  const now = Date.now();
  const prior = readScreener();
  const known = new Map<string, Known>();
  for (const k of discover()) known.set(k.token, k);
  // Keepers stay under watch for a week even after the feed's window moves past their launch.
  for (const t of prior.tokens) if (!known.has(t.token) && now - t.readAt < KEEP_DAYS * 86400e3) known.set(t.token, { token: t.token, symbol: t.symbol, source: t.source, launchAt: t.launchAt, creatorTaxBps: t.creatorTaxBps });
  const list = [...known.values()].slice(0, MAX_TOKENS);
  // Pass one: thirty at a time, the screener's main pool per token, to find the keepers.
  const main = new Map<string, ScreenerPair>();
  let calls = 0, failed = 0;
  for (let i = 0; i < list.length; i += 30) {
    try {
      for (const [t, p] of await fetchTokensBatch(list.slice(i, i + 30).map((k) => k.token))) main.set(t, p);
      calls++;
    } catch { failed++; }
    await sleep(GAP_MS);
  }
  // Pass two: each keeper's pools, to pick the one the desk would trade, and its key from chain.
  const kept: ScreenerToken[] = [];
  for (const k of list) {
    const m = main.get(k.token);
    if (!m) continue;
    const byRecord = !recordFails(m, rules);
    const byCap = capKeeps(m, rules);
    if (!byRecord && !byCap) continue;
    let pool: ScreenerPair | null = null;
    try { pool = pickPool(await fetchTokenPairs(k.token)); } catch { /* next round */ }
    await sleep(GAP_MS);
    if (!pool) continue;
    let key = prior.tokens.find((t) => t.token === k.token && t.pool.poolId === pool!.poolId)?.key ?? null;
    if (!key) {
      try { const ck = await curveKey(pool.poolId); if (ck) key = { currency0: ck.currency0, currency1: ck.currency1, fee: ck.fee, tickSpacing: ck.tickSpacing, hooks: ck.hooks }; } catch { /* next round */ }
    }
    const capUsd = m.capUsd ?? pool.capUsd;
    kept.push({ token: k.token, symbol: k.symbol, source: k.source, launchAt: k.launchAt ?? pool.pairCreatedAt, creatorTaxBps: k.creatorTaxBps, pool, key, kept: !recordFails(pool, rules) ? "record" : "cap", capUsd, readAt: now });
  }
  kept.sort((a, b) => b.pool.vol24 - a.pool.vol24);
  writeScreener({ at: now, tokens: kept });
  const caps = kept.filter((t) => t.kept === "cap").length;
  console.log(`[screener] ${list.length} tokens in ${calls} calls (${failed} failed), ${main.size} known to the screener: ${kept.length} kept (${kept.length - caps} with a record, ${caps} by market cap)${kept.length ? `: ${kept.slice(0, 8).map((t) => `${t.symbol} $${Math.round(t.pool.vol24 / 1000)}k/24h${t.capUsd != null ? ` cap $${(t.capUsd / 1e6).toFixed(1)}M` : ""}${t.key ? "" : " (key pending)"}`).join(", ")}` : ""}; ${((Date.now() - now) / 1000).toFixed(0)} s`);
}

console.log(`[screener] every ${EVERY} s: every launch in the feed's last ${SCAN_MB} MB, kept on a record or a cap of $${(rules.minCapUsd / 1e6).toFixed(1)}M`);
for (;;) {
  try {
    await round();
  } catch (e) {
    console.log(`[screener] ${e instanceof Error ? e.message : String(e)}`);
  }
  await sleep(EVERY * 1000);
}
