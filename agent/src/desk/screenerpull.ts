// The screener poller: the desk's board of survivors, from every token it
// has ever learned of. Every OBS_SCREENER_EVERY_SEC it screens the hot set
// (the keepers, and anything launched in the last two days) in full, then a
// rotating slice of the cold set under a per-round call budget, so the whole
// known set comes around every couple of hours and a survivor that wakes up
// is promoted. Tokens come from the watcher's feed, the desk's own launch
// feed, the backfill of pool creations, and the keepers themselves; a token
// known by address alone takes its symbol from the screener. Each keeper's
// pools are then read to pick the one the desk would trade, and that pool's
// key is resolved on chain once. Nothing here trades.
import { existsSync, openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchTokenPairs, fetchTokensBatch, pickPool, readScreener, writeScreener, screenerRulesFromEnv, recordFails, capKeeps, rotateSlice, type ScreenerToken, type ScreenerPair } from "./screener.ts";
import { curveKey } from "./candidates.ts";
import { NEVER_TRADE, dataPath } from "../config.ts";

const FEED = process.env.OBS_CANDIDATE_FEED ?? "";
const CHAIN_FEED = process.env.OBS_CHAIN_FEED ?? (FEED ? join(dirname(FEED), "launch-chain.jsonl") : "");
const BACKFILL = FEED ? join(dirname(FEED), "pools-backfill.jsonl") : "";
const KNOWN_FILE = dataPath("obs-known-tokens.json");
const EVERY = Number(process.env.OBS_SCREENER_EVERY_SEC ?? 600);
const CALLS = Number(process.env.OBS_SCREENER_MAX_CALLS ?? 120);
const HOT_HOURS = Number(process.env.OBS_SCREENER_HOT_HOURS ?? 48);
const SCAN_MB = Number(process.env.OBS_SCREENER_SCAN_MB ?? 96);
const GAP_MS = Number(process.env.OBS_SCREENER_GAP_MS ?? 250);
const KEEP_DAYS = Number(process.env.OBS_SCREENER_KEEP_DAYS ?? 7);
const rules = screenerRulesFromEnv();

interface Known { token: `0x${string}`; symbol: string; source: string; launchAt: number | null; creatorTaxBps: number | null; firstSeen: number }

function tailText(path: string, mb: number): string {
  if (!path || !existsSync(path)) return "";
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - mb * 1024 * 1024);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}
const clean = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);

/** The known set, persisted: every token the desk has learned of, by address. */
function readKnown(): Map<string, Known> {
  const out = new Map<string, Known>();
  if (!existsSync(KNOWN_FILE)) return out;
  try {
    for (const k of JSON.parse(readFileSync(KNOWN_FILE, "utf8")) as Known[]) if (k?.token) out.set(k.token, k);
  } catch { /* fresh */ }
  return out;
}
function writeKnown(m: Map<string, Known>): void {
  writeFileSync(KNOWN_FILE + ".tmp", JSON.stringify([...m.values()]));
  renameSync(KNOWN_FILE + ".tmp", KNOWN_FILE);
}

/** Every token the feeds and the backfill name, folded into the known set. */
function discover(known: Map<string, Known>, now: number): number {
  let added = 0;
  const take = (token: string, symbol: string, source: string, launchAt: number | null, creatorTaxBps: number | null) => {
    const t = token.toLowerCase() as `0x${string}`;
    if (!/^0x[0-9a-f]{40}$/.test(t) || NEVER_TRADE.has(t)) return;
    const prev = known.get(t);
    if (!prev) { known.set(t, { token: t, symbol, source, launchAt, creatorTaxBps, firstSeen: now }); added++; }
    else if (!prev.symbol && symbol) prev.symbol = symbol;
  };
  for (const text of [tailText(FEED, SCAN_MB), tailText(CHAIN_FEED, 8)]) {
    for (const line of text.split("\n")) {
      if (!line || !line.includes('"launch"')) continue;
      let r: Record<string, unknown>;
      try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (r.kind !== "launch" || typeof r.token !== "string") continue;
      const ts = Number(r.ts ?? 0);
      take(r.token, clean(r.symbol), String(r.source ?? "launch"), ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : null, r.creatorTaxBps == null ? null : Number(r.creatorTaxBps));
    }
  }
  for (const line of tailText(BACKFILL, 64).split("\n")) {
    if (!line) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (typeof r.token !== "string") continue;
    const ts = Number(r.ts ?? 0);
    take(r.token, "", "pool", ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : null, null);
  }
  return added;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function round(): Promise<void> {
  const now = Date.now();
  const prior = readScreener();
  const known = readKnown();
  const added = discover(known, now);
  for (const t of prior.tokens) if (!known.has(t.token)) known.set(t.token, { token: t.token, symbol: t.symbol, source: t.source, launchAt: t.launchAt, creatorTaxBps: t.creatorTaxBps, firstSeen: now });
  // The hot set every round; a slice of the cold set, by the cursor, under the budget.
  const keepers = new Set(prior.tokens.filter((t) => now - t.readAt < KEEP_DAYS * 86400e3).map((t) => t.token));
  const all = [...known.values()];
  const hot = all.filter((k) => keepers.has(k.token) || (k.launchAt != null && now - k.launchAt < HOT_HOURS * 3600e3) || now - k.firstSeen < 3600e3);
  const cold = all.filter((k) => !hot.includes(k));
  const hotCalls = Math.ceil(hot.length / 30);
  const coldBudget = Math.max(0, CALLS - hotCalls) * 30;
  const { slice: coldSlice, cursor } = rotateSlice(cold.map((k) => k.token), prior.cursor ?? 0, coldBudget);
  const coldByToken = new Map(cold.map((k) => [k.token, k]));
  const list: Known[] = [...hot, ...coldSlice.map((t) => coldByToken.get(t)!).filter(Boolean)];
  // Pass one: the screener's main pool per token, thirty at a time.
  const main = new Map<string, ScreenerPair>();
  let calls = 0, failed = 0;
  for (let i = 0; i < list.length; i += 30) {
    try {
      for (const [t, p] of await fetchTokensBatch(list.slice(i, i + 30).map((k) => k.token))) main.set(t, p);
      calls++;
    } catch { failed++; }
    await sleep(GAP_MS);
  }
  // Pass two: each keeper's pools, the one the desk would trade, and its key.
  const kept: ScreenerToken[] = [];
  for (const k of list) {
    const m = main.get(k.token);
    if (!m) continue;
    if (!k.symbol && m.baseSymbol) k.symbol = m.baseSymbol;
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
    kept.push({ token: k.token, symbol: k.symbol || pool.baseSymbol, source: k.source, launchAt: k.launchAt ?? pool.pairCreatedAt, creatorTaxBps: k.creatorTaxBps, pool, key, kept: !recordFails(pool, rules) ? "record" : "cap", capUsd, readAt: now });
  }
  // Keepers not in this round's list carry over until they age out, so a cold-slice miss never drops a survivor.
  const inRound = new Set(list.map((k) => k.token));
  for (const t of prior.tokens) if (!inRound.has(t.token) && now - t.readAt < KEEP_DAYS * 86400e3 && !kept.some((x) => x.token === t.token)) kept.push(t);
  kept.sort((a, b) => b.pool.vol24 - a.pool.vol24);
  writeScreener({ at: now, tokens: kept, cursor });
  writeKnown(known);
  const caps = kept.filter((t) => t.kept === "cap").length;
  console.log(`[screener] known ${known.size} (+${added}), hot ${hot.length}, cold ${cold.length} of which ${coldSlice.length} this round (cursor ${cursor}); ${calls} calls (${failed} failed), ${main.size} answered: ${kept.length} kept (${kept.length - caps} with a record, ${caps} by market cap)${kept.length ? `: ${kept.slice(0, 6).map((t) => `${t.symbol} $${Math.round(t.pool.vol24 / 1000)}k/24h${t.capUsd != null ? ` cap $${(t.capUsd / 1e6).toFixed(2)}M` : ""}`).join(", ")}` : ""}; ${((Date.now() - now) / 1000).toFixed(0)} s`);
}

console.log(`[screener] every ${EVERY} s: the hot set in full, the cold set by ${CALLS} calls a round, kept on a record or a cap of $${(rules.minCapUsd / 1e6).toFixed(1)}M`);
for (;;) {
  try {
    await round();
  } catch (e) {
    console.log(`[screener] ${e instanceof Error ? e.message : String(e)}`);
  }
  await sleep(EVERY * 1000);
}
