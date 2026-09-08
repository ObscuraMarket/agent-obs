// The feed builder: the hourly rows the desk's rules were tuned on, computed
// on the desk itself. The launch watcher that wrote them ran on the operator's
// machine and stopped at 11:19Z on 2026-09-07; from then on no trail passed
// the stability read, the volume exit sliced frozen rows, and nobody supplied
// senders. Each round rebuilds its watched set (the screener's keepers with a
// key, the tokens the desk has traded, the scout's ranked pools, and young
// launches only behind OBS_FEEDBUILD_YOUNG_H), capped at
// OBS_FEEDBUILD_MAX_POOLS; reads their swaps in one batched tape read and the
// tokens' Transfer events in one scan; pairs the two by transaction hash the
// way wallets.ts does, to count the wallets behind a pool; and appends one
// hourly row per pool per CLOSED hour to OBS_CANDIDATE_FEED itself, in the
// watcher's exact shape, plus one side-pool row the first time a hookless USDG
// pool is watched. Never a partial hour (the volume exit reads the raw last
// three rows), never a candidate row, never a truncation of the file (held
// tokens' history lives in it). A pool seen for the first time is read
// OBS_FEEDBUILD_HISTORY_H hours back, a few pools a round under a call budget,
// so a trail with six active hours exists soon after a pool joins. The round
// lives here; the loop is feedbuild.ts. Nothing here trades.
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, http, parseAbi, decodeEventLog } from "viem";
import { RPC_URL, NEVER_TRADE, dataPath } from "../config.ts";
import { chainMemory, type PoolSpec } from "../obscura/pools.ts";
import { readScreener } from "./screener.ts";
import { readScout } from "./scout.ts";
import { readTokens, dynamicAssets, dynamicPoolSpec, candidateAsset, screenerCandidates, feedOptions, readFeed, parseFeed, earlyAsCandidate, curveKey, type Candidate, type FeedSnapshot } from "./candidates.ts";
import { readTape, updateTapes, updateTapeRead, type SwapRow } from "./tape.ts";
import { infrastructureAddresses, type TransferRow } from "./holders.ts";
import { sidePoolRow } from "./chainlaunch.ts";
import { readPrices } from "./analysis.ts";
import { latestSampleUsd } from "./railInput.ts";

export const HOUR_MS = 3600e3;
const CURSOR_FILE = "obs-feedbuild.json";
const UA = "AgentOBS/1.0 (+https://obscura.markets)";
const TRANSFER_ABI = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
/** Blocks come about ten a second; a log's time is estimated from the head, the way the tapes do it. */
const BLOCKS_PER_SEC = 10;
const TAPE_CHUNK = 20_000n;
/** The tape window the batched read keeps in memory: two hours holds the hour that just closed whatever the round's timing. */
const WINDOW_MIN = 120;
/** Calls a round may spend on first-sight history (swaps, then the transfers behind them), the way the screener budgets its rounds (OBS_FEEDBUILD_MAX_CALLS): sixty is three pools an eight-hour window at 20k-block chunks, a hundred-odd pools in a couple of hours. The public RPC answered 429 to a burst of sixty calls in half a minute on 2026-09-08, and the live watch reads its tapes from the same RPC every three seconds, so the reads are paced and the budget is the operator's. */
const DEFAULT_MAX_CALLS = 60;
/** Distinct wallets kept per pool in the cursor; past it the count freezes, far beyond every bar that reads it (20 for stability, 40 for grade A). */
const SENDERS_CAP = 2000;
/** A pool out of the watched set this long leaves the cursor, as an idle tape leaves the tape dir. */
const KEEP_MS = 3 * 24 * HOUR_MS;
/** Closed hours written for one pool in one round at most: a long gap is written from its recent end, not from its start. */
const MAX_HOURS_PER_ROUND = 48;
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
/** Milliseconds between chunks of one scan (the screener's gap between its calls), and the unit of the wait before a refused range is tried again. */
const PACE_MS = 250;
const RETRY_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- The rows, pure. ----

export interface HourlyMeta {
  id: string;
  token: string;
  symbol: string;
  tierPct: number;
  source: string;
  /** Swaps counted before this hour; the row's figure adds the hour's own. */
  swaps: number;
  /** Distinct wallets seen so far. */
  senders: number;
}
/** The watcher's hourly row as parseFeed reads it (candidates.ts): ts in milliseconds, no volumeUsd, usd in dollars. */
export interface HourlyRow {
  ts: number;
  kind: "hourly";
  id: string;
  token: string;
  symbol: string;
  tier: number;
  gateOk: true;
  launchSource: string;
  hour: number;
  swaps: number;
  senders: number;
  lastHour: { swaps: number; usd: number; px: number | null };
}

/**
 * PURE: one closed hour of a pool as a feed row. `rows` may reach before the hour: the swaps inside it give the
 * count and the dollars (quote units times `quoteUsd`), and the last swap at or before its close gives the price,
 * so a quiet hour carries the price of the last trade rather than none. `hour` counts from `launchAt`. No
 * volumeUsd: a cumulative that starts mid-life reads as unknown on its first row (stability.ts, hourVolumes),
 * whereas the hour's own figure is the series; a quiet hour is written with usd 0, which the read counts as inactive.
 */
export function hourlyRow(rows: SwapRow[], hourStart: number, launchAt: number, quoteUsd: number, meta: HourlyMeta, ts: number = hourStart + HOUR_MS): HourlyRow {
  const end = hourStart + HOUR_MS;
  let swaps = 0, usd = 0;
  let last: SwapRow | null = null;
  for (const r of rows) {
    if (r.at >= end) continue;
    if (r.at >= hourStart) {
      swaps++;
      usd += r.quoteAmount * quoteUsd;
    }
    if (r.price > 0 && (!last || r.at > last.at || (r.at === last.at && r.block >= last.block))) last = r;
  }
  return {
    ts,
    kind: "hourly",
    id: meta.id.toLowerCase(),
    token: meta.token.toLowerCase(),
    symbol: meta.symbol,
    tier: meta.tierPct,
    gateOk: true,
    launchSource: meta.source,
    hour: Math.max(0, Math.floor((hourStart - launchAt) / HOUR_MS)),
    swaps: meta.swaps + swaps,
    senders: meta.senders,
    lastHour: { swaps, usd, px: last ? last.price * quoteUsd : null },
  };
}

/**
 * PURE: the starts of the hours closed since `from` (a cursor, or the moment a pool's tape is complete from), in
 * order, the last `maxHours` of them: never the hour still open, never a partial hour. A cursor far behind writes
 * the recent end of its gap, and the cursor moves past the rest.
 */
export function closedHoursSince(from: number, now: number, maxHours = MAX_HOURS_PER_ROUND): number[] {
  const out: number[] = [];
  for (let h = Math.ceil(from / HOUR_MS) * HOUR_MS; h + HOUR_MS <= now; h += HOUR_MS) out.push(h);
  return out.slice(-Math.max(0, maxHours));
}

const hashOf = (tx: string) => tx.split(":")[0].toLowerCase();

/**
 * PURE: the wallets behind a pool's swaps, from the token's transfers paired to the swaps by transaction hash (the
 * wallets.ts rule): a transfer out of infrastructure in a buying transaction names the buyer, one into it in a
 * selling transaction names the seller. On this chain the Swap event's sender is the router (141 senders behind
 * 8,801 swaps on 2026-09-08), so the event itself cannot count wallets. Distinct, lowercased.
 */
export function sendersFrom(transfers: TransferRow[], swaps: SwapRow[], infra: Set<string>): string[] {
  const byHash = new Map<string, SwapRow>();
  for (const s of swaps) byHash.set(hashOf(s.tx), s);
  const out = new Set<string>();
  for (const t of transfers) {
    const swap = byHash.get(hashOf(t.tx));
    if (!swap) continue;
    const from = t.from.toLowerCase(), to = t.to.toLowerCase();
    const fromInfra = infra.has(from), toInfra = infra.has(to);
    if (fromInfra && !toInfra && swap.side === "buy") out.add(to);
    else if (toInfra && !fromInfra && swap.side === "sell") out.add(from);
  }
  return [...out];
}

// ---- The cursor: data/obs-feedbuild.json. ----

export interface PoolCursor {
  firstSeen: number;
  /** The launch time the hour index counts from, fixed at first sight so the index never shifts between rounds. */
  launchAt: number;
  /** Where the pool's tape is complete from, ms; rows before it are not read. */
  coverage: number;
  /** The start of the next hour to write, ms. */
  nextHour: number;
  /** The last block the pool's swaps were read to. */
  scannedTo: number;
  swaps: number;
  senders: string[];
  sidePool?: boolean;
  seenAt: number;
}
export interface FeedbuildCursor {
  pools: Record<string, PoolCursor>;
  /** The last block the watched tokens' transfers were read to. */
  transfersTo?: number;
  at?: number;
}

export function readCursor(): FeedbuildCursor {
  const p = dataPath(CURSOR_FILE);
  if (!existsSync(p)) return { pools: {} };
  try {
    const c = JSON.parse(readFileSync(p, "utf8")) as FeedbuildCursor;
    return c && typeof c === "object" && c.pools && typeof c.pools === "object" ? c : { pools: {} };
  } catch {
    return { pools: {} };
  }
}
function writeCursor(c: FeedbuildCursor): void {
  const p = dataPath(CURSOR_FILE);
  writeFileSync(p + ".tmp", JSON.stringify(c));
  renameSync(p + ".tmp", p);
}

// ---- The watched set. ----

export type WatchRole = "held" | "scout" | "keeper" | "young";
export interface WatchedPool {
  id: string;
  token: string;
  symbol: string;
  spec: PoolSpec;
  tierPct: number;
  feePips: number;
  source: string;
  launchAt: number | null;
  role: WatchRole;
}

function tailText(path: string, mb: number): string {
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

/** The screener poller's known set (obs-known-tokens.json): a source and a launch time for tokens the screener no longer names. */
function knownTokens(): Map<string, { source: string; launchAt: number | null }> {
  const out = new Map<string, { source: string; launchAt: number | null }>();
  const p = dataPath("obs-known-tokens.json");
  if (!existsSync(p)) return out;
  try {
    for (const k of JSON.parse(readFileSync(p, "utf8")) as Array<{ token?: string; source?: string; launchAt?: number | null }>) if (k?.token) out.set(k.token.toLowerCase(), { source: k.source ?? "", launchAt: k.launchAt ?? null });
  } catch {
    /* the screener's file, rebuilt by it */
  }
  return out;
}

/**
 * The pools to write rows for this round, in the order the cap keeps them: the tokens the desk has traded (a held
 * token's trail feeds its exit rules), the scout's ranked pools (the watch's slots), the screener's keepers with a
 * key as screenerCandidates admits them (its market-cap floor and ceiling included, so a stable trail cannot put a
 * token the screener refused back on the board, 2026-09-06), and young launches only when `youngH` is set.
 */
export async function watchedSet(now: number, env: NodeJS.ProcessEnv, maxPools: number, youngH: number, feedPath: string): Promise<{ pools: WatchedPool[]; counts: Record<WatchRole, number> }> {
  const opts = feedOptions(env);
  const out: WatchedPool[] = [];
  const seen = new Set<string>();
  const add = (p: WatchedPool | null): void => {
    if (!p || !p.spec.id || seen.has(p.id) || NEVER_TRADE.has(p.token)) return;
    seen.add(p.id);
    out.push(p);
  };
  const known = knownTokens();
  const screener = readScreener();
  const launchAtOf = new Map<string, number | null>(screener.tokens.map((t) => [t.token.toLowerCase(), t.launchAt ?? t.pool.pairCreatedAt ?? null]));
  const launchOf = (token: string): number | null => launchAtOf.get(token.toLowerCase()) ?? known.get(token.toLowerCase())?.launchAt ?? null;
  const fromCandidate = (c: Candidate, role: WatchRole, launchAt: number | null): WatchedPool | null => {
    const spec = dynamicPoolSpec(candidateAsset(c));
    if (!spec?.id) return null;
    return { id: spec.id.toLowerCase(), token: c.token.toLowerCase(), symbol: c.symbol, spec, tierPct: c.tierPct, feePips: c.feePips, source: c.source || "unknown", launchAt, role };
  };
  // The tokens the desk has traded, newest first, through the pools it traded them in.
  const empty: FeedSnapshot = { candidates: [], early: [], hourly: {}, readAt: now, path: null };
  const assets = dynamicAssets(empty);
  for (const t of [...readTokens()].filter((t) => !t.blacklisted).sort((a, b) => b.firstSeen - a.firstSeen)) {
    const a = assets[`${t.symbol}@robinhood`];
    if (!a || (a.contract ?? "").toLowerCase() !== t.contract.toLowerCase()) continue;
    const spec = dynamicPoolSpec(a);
    if (!spec?.id) continue;
    const token = t.contract.toLowerCase();
    add({ id: spec.id.toLowerCase(), token, symbol: t.symbol, spec, tierPct: t.feePct, feePips: t.curve ? t.curve.feePips : Math.round(t.feePct * 10_000), source: known.get(token)?.source || (t.curve ? "pons-v2" : "desk"), launchAt: launchOf(token), role: "held" });
  }
  const survivors = screenerCandidates(screener.tokens, now, opts, env);
  const survivorByPool = new Map(survivors.map((c) => [c.poolId.toLowerCase(), c]));
  // The scout's ranked pools. A ranked pool the screener no longer names is on the board by its own trail, and the feed has it.
  let feed: FeedSnapshot | null = null;
  for (const r of readScout().ranked) {
    const id = String(r.poolId ?? "").toLowerCase();
    const c = survivorByPool.get(id) ?? (feed ??= readFeed(now, env)).candidates.find((x) => x.poolId.toLowerCase() === id) ?? null;
    if (c) add(fromCandidate(c, "scout", launchOf(c.token)));
  }
  for (const c of survivors) add(fromCandidate(c, "keeper", launchOf(c.token)));
  if (youngH > 0) {
    const chainPath = env.OBS_CHAIN_FEED?.trim() || join(dirname(feedPath), "launch-chain.jsonl");
    if (existsSync(chainPath)) {
      const early = parseFeed(tailText(chainPath, 2), now, { ...opts, earlyMaxAgeMs: youngH * HOUR_MS, stable: undefined }).early;
      for (const l of early) {
        if (!l.gateOk || (l.creatorTaxBps != null && l.creatorTaxBps > 100)) continue;
        const key = !l.sidePools.length && l.curvePoolId ? await curveKey(l.curvePoolId as `0x${string}`) : null;
        const c = earlyAsCandidate(l, now, false, key);
        if (c) add(fromCandidate(c, "young", l.at));
      }
    }
  }
  const pools = out.slice(0, Math.max(0, maxPools));
  const counts: Record<WatchRole, number> = { held: 0, scout: 0, keeper: 0, young: 0 };
  for (const p of pools) counts[p.role]++;
  return { pools, counts };
}

// ---- The transfers behind the swaps. ----

type Rpc = ReturnType<typeof createPublicClient>;

/**
 * The watched tokens' Transfer events over a block range, one call per chunk with the tokens as an address array.
 * The chunk shrinks with the address list, and again when the chain refuses a range, so a busy hour never asks for
 * more logs than one answer carries. Returns the rows by token, the last block fully read (null when none was), and
 * the calls spent.
 */
async function scanTransfers(pub: Rpc, tokens: string[], from: bigint, to: bigint, head: bigint, now: number, maxCalls: number): Promise<{ rows: Array<{ token: string; row: TransferRow }>; scannedTo: bigint | null; calls: number; error: string | null }> {
  const rows: Array<{ token: string; row: TransferRow }> = [];
  let calls = 0;
  let scannedTo: bigint | null = null;
  let error: string | null = null;
  if (!tokens.length || from > to) return { rows, scannedTo, calls, error };
  const initial = tokens.length <= 8 ? 20_000n : 4_000n;
  let chunk = initial;
  let start = from;
  let streak = 0, throttled = 0;
  while (start <= to && calls < maxCalls) {
    const end = start + chunk - 1n > to ? to : start + chunk - 1n;
    try {
      const logs = await pub.getLogs({ address: tokens as `0x${string}`[], event: TRANSFER_ABI[0], fromBlock: start, toBlock: end });
      calls++;
      for (const l of logs) {
        let d: { from: string; to: string };
        try {
          d = decodeEventLog({ abi: TRANSFER_ABI, data: l.data, topics: l.topics }).args as { from: string; to: string; value: bigint };
        } catch {
          continue;
        }
        const block = Number(l.blockNumber);
        rows.push({ token: String(l.address).toLowerCase(), row: { at: now - Math.round((Number(head) - block) / BLOCKS_PER_SEC) * 1000, block, tx: `${l.transactionHash}:${l.logIndex}`, from: d.from.toLowerCase(), to: d.to.toLowerCase(), amount: 0 } });
      }
      scannedTo = end;
      start = end + 1n;
      // A range shrunk after a refusal grows back after three answers in a row, so a busy hour does not fix the pace.
      if (++streak >= 3 && chunk < initial) {
        chunk = chunk * 2n > initial ? initial : chunk * 2n;
        streak = 0;
      }
      // A breath between chunks, as the launch backfill takes one: the public RPC throttles a burst (2026-09-08).
      if (start <= to) await sleep(PACE_MS);
    } catch (e) {
      calls++;
      streak = 0;
      error = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 120);
      if (/429|too many requests|rate limit/i.test(error)) {
        // Throttled: the same range again after a longer breath, a few times. Shrinking it would only multiply the
        // calls, which is what turned a two-hour window into sixty calls on 2026-09-08.
        if (throttled++ < 3) {
          await sleep(RETRY_MS * 2 ** throttled);
          continue;
        }
        break;
      }
      // Refused for its size: the same range in quarters.
      if (chunk > 1_000n) {
        chunk /= 4n;
        await sleep(RETRY_MS);
        continue;
      }
      break;
    }
  }
  return { rows, scannedTo, calls, error: scannedTo != null && scannedTo >= to ? null : error };
}

/** What is not a wallet for a pool: the pool manager, the router, the position manager, permit2, the launchpads and the pool's own hook, the token, the zero and burn addresses. */
function infraFor(p: WatchedPool): Set<string> {
  const mem = chainMemory() as { contracts?: { uniswapV4?: Record<string, string | undefined>; launchpads?: Record<string, string> } };
  return new Set([ZERO, DEAD, p.token, ...infrastructureAddresses([p.spec.hookAddress, mem.contracts?.uniswapV4?.permit2, ...Object.values(mem.contracts?.launchpads ?? {})])].map((a) => a.toLowerCase()));
}

// ---- The round. ----

export interface RoundSummary {
  watched: number;
  held: number;
  scout: number;
  keeper: number;
  young: number;
  /** Pools read back over the history window this round; pools waiting for the next round's budget; pools whose read the chain refused. */
  backfilled: number;
  deferred: number;
  failed: number;
  rows: number;
  sidePools: number;
  /** Pools with a closed hour whose quote (ETH or NVDA) had no dollar price: the hour waits, it is not written in quote units. */
  unpriced: number;
  calls: number;
  headBlock: number | null;
  /** What the chain said when a transfer scan stopped short; the wallets of the unread span wait for the next round. */
  transfersError?: string;
  note?: string;
}

/** Each pool's window of rows between rounds, so the tape files are not re-read every five minutes. */
const tapeCache = new Map<string, SwapRow[]>();

export async function feedbuildRound(now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<RoundSummary> {
  const feedPath = env.OBS_CANDIDATE_FEED?.trim();
  if (!feedPath) throw new Error("OBS_CANDIDATE_FEED is not set; nothing to build");
  const n = (k: string, d: number) => {
    const v = Number(env[k] ?? d);
    return Number.isFinite(v) ? v : d;
  };
  const maxPools = n("OBS_FEEDBUILD_MAX_POOLS", 120), historyH = Math.max(1, n("OBS_FEEDBUILD_HISTORY_H", 8)), youngH = n("OBS_FEEDBUILD_YOUNG_H", 0), maxCalls = n("OBS_FEEDBUILD_MAX_CALLS", DEFAULT_MAX_CALLS);
  const historyBlocks = BigInt(Math.ceil(historyH * 3600 * BLOCKS_PER_SEC));
  const windowBlocks = BigInt(WINDOW_MIN * 60 * BLOCKS_PER_SEC);
  const { pools, counts } = await watchedSet(now, env, maxPools, youngH, feedPath);
  const cursor = readCursor();
  for (const [id, c] of Object.entries(cursor.pools)) if (!c || !(now - c.seenAt <= KEEP_MS)) delete cursor.pools[id];
  const sum: RoundSummary = { watched: pools.length, ...counts, backfilled: 0, deferred: 0, failed: 0, rows: 0, sidePools: 0, unpriced: 0, calls: 0, headBlock: null };
  if (!pools.length) {
    writeCursor(cursor);
    return { ...sum, note: "nothing to watch" };
  }
  // No retries inside the transport: a throttled call is backed off by the scan itself, not asked again at once.
  const pub = createPublicClient({ transport: http(RPC_URL, { retryCount: 0, fetchOptions: { headers: { "User-Agent": UA } } }) });
  const head = await pub.getBlockNumber();
  sum.calls++;
  // First sight, or a pool so far behind that its history window is read afresh rather than every block since: a
  // pool a day behind would drag the whole batch that far back, and the batch carries every watched id.
  const fresh: WatchedPool[] = [], known: WatchedPool[] = [];
  for (const p of pools) {
    const c = cursor.pools[p.id];
    if (c && Number.isFinite(c.scannedTo) && Number.isFinite(c.nextHour) && head - BigInt(c.scannedTo) <= historyBlocks) known.push(p);
    else fresh.push(p);
  }
  const rowsInHand = new Map<string, SwapRow[]>();
  const perPool = Number(historyBlocks / TAPE_CHUNK) + 1;
  let budget = maxCalls - (fresh.length ? perPool : 0);
  const backfilled: WatchedPool[] = [];
  for (const p of fresh) {
    if (budget < perPool) {
      sum.deferred++;
      continue;
    }
    budget -= perPool;
    sum.calls += perPool;
    if (backfilled.length) await sleep(RETRY_MS);
    // The whole window is read whatever the tape file holds: a file another reader left, or one this builder left
    // behind a gap, is complete from nowhere the builder can see; the duplicates fold on every read (dedupeRows).
    const r = await updateTapeRead(p.spec, p.symbol, now, historyH * 60, head - historyBlocks);
    if (!r.ok || r.headBlock == null) {
      sum.failed++;
      // A refused read is the chain throttling more often than not; the pools behind this one wait for the next round.
      budget = -1;
      continue;
    }
    const coverage = now - historyH * HOUR_MS + 60e3;
    const prev = cursor.pools[p.id];
    cursor.pools[p.id] = prev
      ? { ...prev, coverage, nextHour: Math.max(prev.nextHour, Math.ceil(coverage / HOUR_MS) * HOUR_MS), scannedTo: r.headBlock, seenAt: now }
      : { firstSeen: now, launchAt: p.launchAt ?? coverage, coverage, nextHour: Math.ceil(coverage / HOUR_MS) * HOUR_MS, scannedTo: r.headBlock, swaps: 0, senders: [], seenAt: now };
    rowsInHand.set(p.id, r.rows);
    backfilled.push(p);
    sum.backfilled++;
  }
  const pair = (transfers: Array<{ token: string; row: TransferRow }>, targets: WatchedPool[]): void => {
    const byToken = new Map<string, TransferRow[]>();
    for (const t of transfers) (byToken.get(t.token) ?? byToken.set(t.token, []).get(t.token)!).push(t.row);
    for (const p of targets) {
      const xs = byToken.get(p.token);
      const cur = cursor.pools[p.id];
      if (!xs?.length || !cur) continue;
      const found = sendersFrom(xs, rowsInHand.get(p.id) ?? [], infraFor(p));
      if (!found.length) continue;
      const set = new Set(cur.senders);
      for (const w of found) {
        if (set.size >= SENDERS_CAP) break;
        set.add(w);
      }
      cur.senders = [...set];
    }
  };
  // The wallets behind the history just read, before the batch: a batch the chain refuses must not lose them.
  if (backfilled.length) {
    await sleep(RETRY_MS);
    const bf = await scanTransfers(pub, [...new Set(backfilled.map((p) => p.token))], head - historyBlocks, head, head, now, perPool * 2);
    sum.calls += bf.calls;
    if (bf.error) sum.transfersError = bf.error;
    pair(bf.rows, backfilled);
  }
  // The known pools in one batched read, each from the block it was last read to.
  let headBlock = Number(head);
  if (known.length) {
    const scanned = new Map(known.map((p) => [p.id, cursor.pools[p.id].scannedTo]));
    const oldest = known.reduce((m, p) => Math.min(m, cursor.pools[p.id].scannedTo), Number(head));
    sum.calls += 1 + Math.ceil(Math.max(1, Number(head) - oldest) / Number(TAPE_CHUNK));
    const r = await updateTapes(known.map((p) => ({ spec: p.spec, symbol: p.symbol })), now, WINDOW_MIN, tapeCache, scanned);
    if (!r.ok || r.headBlock == null) {
      cursor.at = now;
      writeCursor(cursor);
      return { ...sum, note: "the chain did not answer the tape read; nothing written for the known pools" };
    }
    headBlock = r.headBlock;
    for (const p of known) {
      const cur = cursor.pools[p.id];
      cur.scannedTo = headBlock;
      cur.seenAt = now;
      rowsInHand.set(p.id, r.tapes.get(p.spec.id as string) ?? []);
    }
  }
  sum.headBlock = headBlock;
  // The transfers since the last round, for every watched token; a builder far behind reads its history window, not
  // every block since (the wallets of the span before are not counted).
  let from = cursor.transfersTo != null ? BigInt(cursor.transfersTo) + 1n : BigInt(headBlock) - windowBlocks;
  if (BigInt(headBlock) - from > historyBlocks) from = BigInt(headBlock) - historyBlocks;
  const fromAt = now - Number(BigInt(headBlock) - from) * (1000 / BLOCKS_PER_SEC);
  // A pool whose pending hours, or whose transfer span, reach past the window in memory is read from its file.
  const windowEdge = now - (WINDOW_MIN - 10) * 60e3;
  for (const p of known) {
    const cur = cursor.pools[p.id];
    if (cur.nextHour < windowEdge || fromAt < windowEdge) rowsInHand.set(p.id, readTape(p.id));
  }
  const targets = [...known, ...backfilled];
  if (backfilled.length) await sleep(RETRY_MS);
  const main = await scanTransfers(pub, [...new Set(targets.map((p) => p.token))], from, BigInt(headBlock), BigInt(headBlock), now, 80);
  sum.calls += main.calls;
  if (main.error) sum.transfersError = main.error;
  pair(main.rows, targets);
  if (main.scannedTo != null) cursor.transfersTo = Number(main.scannedTo);
  // The rows: one side-pool row the first time a hookless USDG pool is watched, then one hourly row per closed hour.
  const prices = readPrices();
  const quoteUsdOf = (quote: string): number | null => (quote === "USDG" ? 1 : latestSampleUsd(prices, quote, now, 6 * HOUR_MS));
  const lines: string[] = [];
  for (const p of targets) {
    const cur = cursor.pools[p.id];
    if (!cur) continue;
    const quote = p.spec.quote ?? "USDG";
    if (!cur.sidePool && !p.spec.hooks && quote === "USDG") {
      lines.push(JSON.stringify(sidePoolRow(p.id, p.token, p.feePips, p.spec.tickSpacing, p.source, now)));
      cur.sidePool = true;
      sum.sidePools++;
    }
    const hours = closedHoursSince(cur.nextHour, now);
    if (!hours.length) continue;
    const quoteUsd = quoteUsdOf(quote);
    if (quoteUsd == null) {
      // ETH units in a dollar column would meet the exit rule and the stability bar as dollars; the hour waits.
      sum.unpriced++;
      continue;
    }
    const rows = (rowsInHand.get(p.id) ?? []).filter((r) => r.at >= cur.coverage);
    for (const h of hours) {
      const row = hourlyRow(rows, h, cur.launchAt, quoteUsd, { id: p.id, token: p.token, symbol: p.symbol, tierPct: p.tierPct, source: p.source, swaps: cur.swaps, senders: cur.senders.length }, now);
      cur.swaps = row.swaps;
      cur.nextHour = h + HOUR_MS;
      lines.push(JSON.stringify(row));
      sum.rows++;
    }
  }
  if (lines.length) {
    mkdirSync(dirname(feedPath), { recursive: true });
    appendFileSync(feedPath, lines.join("\n") + "\n");
  }
  cursor.at = now;
  writeCursor(cursor);
  return sum;
}

/** PURE: the round as one log line. */
export function roundLine(s: RoundSummary, seconds: number): string {
  const set = `watched ${s.watched} (${s.held} held, ${s.scout} scout, ${s.keeper} keepers${s.young ? `, ${s.young} young` : ""})`;
  const history = s.backfilled || s.deferred || s.failed ? `; history read for ${s.backfilled}${s.deferred ? `, ${s.deferred} waiting for the budget` : ""}${s.failed ? `, ${s.failed} refused by the chain` : ""}` : "";
  const rows = `; ${s.rows} hourly row${s.rows === 1 ? "" : "s"}${s.sidePools ? `, ${s.sidePools} side-pool row${s.sidePools === 1 ? "" : "s"}` : ""}${s.unpriced ? `, ${s.unpriced} pool${s.unpriced === 1 ? "" : "s"} waiting for a quote price` : ""}`;
  return `${set}${history}${rows}; ${s.calls} calls${s.headBlock != null ? `, head ${s.headBlock}` : ""}${s.transfersError ? `; a transfer scan stopped short: ${s.transfersError}` : ""}${s.note ? `; ${s.note}` : ""}; ${seconds.toFixed(0)} s`;
}
