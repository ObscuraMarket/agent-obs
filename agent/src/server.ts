// The OBS dashboard API. Read-only JSON over plain node:http with CORS, so
// Obscura's team can render OBS inside their own app (Angular, anything)
// without running our code in their build. The standalone page in
// ../dashboard is served at / for previews and for iframing.
//
// Nothing private crosses this boundary: the copywriter's NOTEs never leave
// the journal, no key or token is read here, and the ledgers are shaped down
// to what a public timeline already shows. Run: npm run dashboard.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLedger } from "./ledger.ts";
import { liveReads, readsBlock, assetPrices, readMarketSamples, marketSeries, change24h, type Reads } from "./obscura/reads.ts";
import { readBook, latestTrades, snapshot, snapshotFromChain, series, positions, latestSaneMark, bookMovedSince, type Trade, type BookSnapshot } from "./desk/book.ts";
import { trackRecord, basisSignal, ratioStats, readPrices, usSession } from "./desk/analysis.ts";
import { stockReference } from "./obscura/stockRef.ts";
import { readFeed, gradeCandidate, gradeRulesFromEnv, dynamicPoolSpec, candidateAsset, readTokens, resolveAny, isHolding } from "./desk/candidates.ts";
import { entryRead, entryRulesFromEnv } from "./desk/entry.ts";
import { readCloses, launchRecord, launchRecordLine } from "./desk/trade-memory.ts";
import { readTape, tapeStats } from "./desk/tape.ts";
import { poolRead } from "./obscura/pools.ts";
import { readThoughts, type Thought } from "./desk/thoughts.ts";
import { digestThought, watchEvent, type WatchEvent } from "./desk/digest.ts";
import { readResearch } from "./desk/research.ts";
import { readScout } from "./desk/scout.ts";
import { readAgentToken, type AgentTokenRead } from "./desk/agentToken.ts";
import { AGENT_TOKEN } from "./config.ts";

/** A thought as the page reads it: the record plus its digest (verdict, headline, each token's status). Additive. */
const withDigest = (t: Thought) => ({ ...t, digest: digestThought(t) });

/** The live watch's file as one terminal line, or null when it is stale or absent. */
function readWatch(now = Date.now()): WatchEvent | null {
  const p = dataPath("obs-live.json");
  if (!existsSync(p)) return null;
  try {
    return watchEvent(JSON.parse(readFileSync(p, "utf8")), now);
  } catch {
    return null;
  }
}
/** How often the stream repeats the watch line when nothing else moved. */
const WATCH_EVERY_MS = 60_000;
import { tradingArmed, railsFromEnv, sentTodayUsd, type Rails } from "./desk/rails.ts";
import { walletBalances } from "./obscura/reads.ts";
import { X_HANDLE, X_AGENT_ID, AGENT_ID, MAX_TWEET_CHARS, OBS_CONTRACT, SITE_URL, ROOT_DIR, WALLET_ADDRESS, EXPLORER_URL, dataPath } from "./config.ts";
import { xLive, xConfigured } from "./social/xClient.ts";

const PORT = Number(process.env.OBS_DASHBOARD_PORT ?? 4671);
// Public exposure needs manners: a per-address budget on requests and a cap
// on open streams, so one client cannot make the ledgers unreadable for the
// rest. Both are generous for a page and tight for a loop.
const RATE_PER_MIN = Number(process.env.OBS_DASHBOARD_RATE_PER_MIN ?? 120);
const MAX_STREAMS = Number(process.env.OBS_DASHBOARD_MAX_STREAMS ?? 100);
const MAX_STREAMS_PER_IP = Number(process.env.OBS_DASHBOARD_MAX_STREAMS_PER_IP ?? 4);
const ORIGINS = (process.env.OBS_DASHBOARD_ORIGINS ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

/** PURE: whether an origin is on the allowlist. An entry may carry one wildcard host label, `https://*.vercel.app`, which admits any single subdomain. */
export function originAllowed(origin: string, list: string[]): boolean {
  if (!origin) return false;
  for (const entry of list) {
    if (entry === "*" || entry === origin) return true;
    const star = entry.indexOf("*");
    if (star < 0) continue;
    const head = entry.slice(0, star);
    const tail = entry.slice(star + 1);
    if (!origin.startsWith(head) || !origin.endsWith(tail)) continue;
    const label = origin.slice(head.length, origin.length - tail.length);
    if (label && !label.includes("/") && !label.includes(".")) return true;
  }
  return false;
}
const refusedOrigins = new Map<string, number>();
const READS_TTL_MS = 60_000;

export interface FeedItem {
  at: number;
  kind: "post" | "reply";
  text: string;
  posted: boolean;
  mode: "live" | "draft" | "unconfigured";
  id?: string;
  url?: string;
  inReplyToId?: string;
}

interface PostRow {
  at?: number;
  mode?: string;
  posted?: boolean;
  id?: string;
  text?: string;
  inReplyToId?: string;
  deletedId?: string;
}

/** PURE: the public feed, newest first. Only fields a timeline already
 *  shows; failed writes and deletions are dropped. Exported for tests. */
export function publicFeed(posts: PostRow[], replies: PostRow[], handle: string, limit = 30): FeedItem[] {
  const shape = (r: PostRow, kind: "post" | "reply"): FeedItem | null => {
    if (!r.text || !r.at || r.deletedId) return null;
    if (r.mode === "live" && !r.posted) return null; // a failed live write is not content
    const mode = r.mode === "live" ? "live" : r.mode === "unconfigured" ? "unconfigured" : "draft";
    const item: FeedItem = { at: r.at, kind, text: r.text, posted: Boolean(r.posted), mode };
    if (r.id) {
      item.id = r.id;
      item.url = `https://x.com/${handle}/status/${r.id}`;
    }
    if (kind === "reply" && r.inReplyToId) item.inReplyToId = r.inReplyToId;
    return item;
  };
  const all: FeedItem[] = [];
  for (const r of posts) {
    const it = shape(r, "post");
    if (it) all.push(it);
  }
  for (const r of replies) {
    const it = shape(r, "reply");
    if (it) all.push(it);
  }
  return all.sort((a, b) => b.at - a.at).slice(0, Math.max(1, Math.min(limit, 200)));
}

export interface DeskSummary {
  equityUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  netCapitalUsd: number;
  trades: { settled: number; pending: number; proposed: number };
  lastThoughtAt: number | null;
  markedAt: number | null;
  /** Whether a swap decision can execute. False until the execution stage exists. */
  canExecute: boolean;
}

export interface Status {
  agent: { operator: string; voice: string; handle: string; mode: "live" | "draft" | "unconfigured" };
  desk: DeskSummary;
  posts: { total: number; published: number; drafts: number; lastAt: number | null };
  replies: { total: number; published: number; lastAt: number | null };
  decisions: { post: number; hold: number };
  token: { contract: string; site: string };
  limits: { maxTweetChars: number };
  at: number;
}

/** PURE: the desk summary from the latest stored snapshot (no network on the status path). */
export function buildDesk(latest: BookSnapshot | null, trades: Trade[], lastThoughtAt: number | null, canExecute = false): DeskSummary {
  const t = latestTrades(trades);
  return {
    equityUsd: latest?.equityUsd ?? null,
    pnlUsd: latest?.pnlUsd ?? null,
    pnlPct: latest?.pnlPct ?? null,
    netCapitalUsd: latest?.netCapitalUsd ?? 0,
    trades: { settled: t.filter((x) => x.status === "settled").length, pending: t.filter((x) => x.status === "pending").length, proposed: t.filter((x) => x.status === "proposed").length },
    lastThoughtAt,
    markedAt: latest?.at ?? null,
    canExecute,
  };
}

export interface RailsSummary {
  tradingOn: boolean;
  maxSwapUsd: number;
  dailySwapUsd: number;
  maxOpenOrders: number;
  gasReserveEth: number;
  /** Dollars sent into routes in the last 24 hours, against the daily cap. */
  sentTodayUsd: number;
  openOrders: number;
  allowedAssets: string[];
  allowedPartners: string[] | null;
  /** Chain keys both legs must be on; the mandate is Robinhood Chain only. */
  allowedChains: string[];
}

/** PURE: the rails as the dashboard shows them: each cap next to what is used. */
export function railsSummary(rails: Rails, trades: Trade[], now: number): RailsSummary {
  const t = latestTrades(trades);
  return {
    tradingOn: rails.tradingOn,
    maxSwapUsd: rails.maxSwapUsd,
    dailySwapUsd: rails.dailySwapUsd,
    maxOpenOrders: rails.maxOpenOrders,
    gasReserveEth: rails.gasReserveEth,
    sentTodayUsd: sentTodayUsd(t, now),
    openOrders: t.filter((x) => x.status === "pending").length,
    allowedAssets: [...rails.allowedAssets],
    allowedPartners: rails.allowedPartners ? [...rails.allowedPartners] : null,
    allowedChains: [...rails.allowedChains],
  };
}

/** PURE: the status card. Exported for tests. */
export function buildStatus(posts: PostRow[], replies: PostRow[], decisions: Array<{ decision?: string }>, opts: { live: boolean; configured: boolean; now: number; desk?: DeskSummary }): Status {
  const content = (rows: PostRow[]) => rows.filter((r) => r.text && r.at && !r.deletedId);
  const p = content(posts);
  const r = content(replies);
  const lastAt = (rows: PostRow[]) => (rows.length ? Math.max(...rows.map((x) => x.at as number)) : null);
  return {
    agent: { operator: AGENT_ID, voice: X_AGENT_ID, handle: X_HANDLE, mode: !opts.configured ? "unconfigured" : opts.live ? "live" : "draft" },
    desk: opts.desk ?? buildDesk(null, [], null),
    posts: { total: p.length, published: p.filter((x) => x.posted).length, drafts: p.filter((x) => !x.posted && x.mode !== "live").length, lastAt: lastAt(p) },
    replies: { total: r.length, published: r.filter((x) => x.posted).length, lastAt: lastAt(r) },
    decisions: { post: decisions.filter((d) => d.decision === "post").length, hold: decisions.filter((d) => d.decision === "hold").length },
    token: { contract: OBS_CONTRACT, site: SITE_URL },
    limits: { maxTweetChars: MAX_TWEET_CHARS },
    at: opts.now,
  };
}

/** The last live read, with the moment it began: the wallet's balances are as of then, not as of when it finished. */
let readsCache: { at: number; startedAt: number; value: Reads } | null = null;
let readsRefreshing: Promise<void> | null = null;
function refreshReads(): Promise<void> {
  const startedAt = Date.now();
  return liveReads().then((value) => { readsCache = { at: Date.now(), startedAt, value }; });
}
/** The live reads: answered from the last value at once; a value older than the TTL is refreshed in the background, never on the caller's clock. */
async function cachedReads(): Promise<Reads> {
  if (readsCache && Date.now() - readsCache.at >= READS_TTL_MS && !readsRefreshing) {
    readsRefreshing = refreshReads().catch(() => undefined).finally(() => { readsRefreshing = null; });
  }
  if (readsCache) return readsCache.value;
  // Cold: one read in flight, shared by every caller, never several at once.
  if (!readsRefreshing) readsRefreshing = refreshReads().finally(() => { readsRefreshing = null; });
  await readsRefreshing;
  const warmed = readsCache as { at: number; startedAt: number; value: Reads } | null;
  if (!warmed) throw new Error("reads unavailable");
  return warmed.value;
}
/**
 * Whether the warm read is behind the book: a swap settled after the read began. The read walks the wallet one balance
 * at a time, ETH first and the desk's launch tokens last, so one that straddles a sell can carry the ETH from before the
 * proceeds landed and no longer list the token sold, which priced the desk a whole position short until the next read.
 * When it is behind, the next read starts now rather than on the TTL.
 */
function readsBehindBook(trades: Trade[]): boolean {
  if (!readsCache || !bookMovedSince(trades, readsCache.startedAt)) return false;
  if (!readsRefreshing) readsRefreshing = refreshReads().catch(() => undefined).finally(() => { readsRefreshing = null; });
  return true;
}
/**
 * Prices, one entry per symbol with the moment it was read. A request is answered from the book at once, fresh or
 * stale, and anything missing or older than the TTL is refreshed behind it; refreshes run one after another, since
 * a launch token's price is a pool read on a rate-limited RPC. The old cache was keyed on the whole symbol set, so a
 * new position or a restart forced a cold read of every symbol, one pool at a time, with every request waiting on it.
 */
const priceBook = new Map<string, { at: number; price: number | null }>();
let priceRefresh: Promise<void> | null = null;
function refreshPrices(symbols: string[]): Promise<void> {
  const run = (priceRefresh ?? Promise.resolve())
    .then(() => assetPrices(symbols, { OBS: readsCache?.value.market?.priceUsd ?? null }))
    .then((value) => { const at = Date.now(); for (const [s, p] of Object.entries(value)) priceBook.set(s.toUpperCase(), { at, price: p }); })
    .catch(() => undefined);
  priceRefresh = run.finally(() => { if (priceRefresh === run) priceRefresh = null; });
  return priceRefresh;
}
/** Prices for these symbols from the book, at once; null for a symbol never read. `wait` awaits the refresh only when a symbol has never been read (the cold boot), for background callers. */
async function cachedPrices(symbols: string[], opts: { wait?: boolean } = {}): Promise<Record<string, number | null>> {
  const want = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const now = Date.now();
  const stale = want.filter((s) => { const e = priceBook.get(s); return !e || now - e.at >= READS_TTL_MS; });
  const refresh = stale.length ? refreshPrices(stale) : null;
  if (opts.wait && refresh && want.some((s) => !priceBook.has(s))) await refresh;
  const out: Record<string, number | null> = {};
  for (const s of want) out[s] = priceBook.get(s)?.price ?? null;
  return out;
}
/** PURE: the held symbols (above dust) whose price has never been read: the snapshot cannot be marked from the chain until they are. */
function unpricedHeld(bySymbol: Record<string, number>): string[] {
  return Object.entries(bySymbol).filter(([s, q]) => isHolding(q) && !priceBook.has(s.toUpperCase())).map(([s]) => s);
}
/** The reads when they are warm, else null at once: for endpoints that must never wait. */
function warmReads(): Reads | null {
  void cachedReads().catch(() => undefined);
  return readsCache?.value ?? null;
}

// The agent's own token is read in the background on a timer and answered from the last read at once:
// its first read walks a day of swaps and the token's transfers, which no visitor should wait for.
let agentTokenCache: AgentTokenRead | null = null;
let agentTokenRefreshing = false;
async function refreshAgentToken(): Promise<void> {
  if (agentTokenRefreshing) return;
  agentTokenRefreshing = true;
  try {
    const p = await cachedPrices(["ETH"], { wait: true });
    agentTokenCache = await readAgentToken(p.ETH ?? null, Date.now());
  } catch {
    /* keep the last read */
  } finally {
    agentTokenRefreshing = false;
  }
}

/** The trade rows as the dashboard shows them. The ledger never holds a deposit or payout address, so nothing is stripped; this is the seam if that ever changes. */
export function publicTrades(trades: Trade[], limit = 50): Trade[] {
  return latestTrades(trades).slice(0, Math.max(1, Math.min(limit, 500)));
}
const deskFromDisk = () => {
  const book = readBook();
  const latest = latestSaneMark(book.snapshots);
  const thoughts = readThoughts(1);
  return { book, desk: buildDesk(latest, book.trades, thoughts[0]?.at ?? null, tradingArmed()) };
};

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin ?? "";
  const allow = ORIGINS.includes("*") ? "*" : originAllowed(origin, ORIGINS) ? origin : "";
  if (allow) res.setHeader("Access-Control-Allow-Origin", allow);
  else if (origin && (Date.now() - (refusedOrigins.get(origin) ?? 0)) > 60_000) {
    // Say which origin was refused, once a minute per origin, so a page that cannot reach the API can be traced.
    refusedOrigins.set(origin, Date.now());
    console.log(`[obs] origin refused by OBS_DASHBOARD_ORIGINS: ${origin}`);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "public, max-age=30");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const DASHBOARD = join(ROOT_DIR, "..", "dashboard", "index.html");

// The live stream: server-sent events, so the page's terminal shows a thought
// the moment the desk writes it instead of on the next poll. The ledgers are
// append-only files, so "new" is cheap to detect: the file grew. Two seconds
// between looks; a keepalive comment every 25 so proxies keep the socket.
const STREAM_POLL_MS = 2000;
const STREAM_PING_MS = 25_000;

/** PURE: a sliding-window request budget per client. Exported for tests. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perMinute: number, private windowMs = 60_000) {}
  /** True when the client may proceed; records the hit. */
  allow(client: string, now = Date.now()): boolean {
    const cut = now - this.windowMs;
    const list = (this.hits.get(client) ?? []).filter((t) => t > cut);
    if (list.length >= this.perMinute) {
      this.hits.set(client, list);
      return false;
    }
    list.push(now);
    this.hits.set(client, list);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((t) => t > cut)) this.hits.delete(k);
    return true;
  }
}
const limiter = new RateLimiter(RATE_PER_MIN);
const streams = new Map<string, number>();
let streamCount = 0;
const clientOf = (req: IncomingMessage): string => {
  const fwd = req.headers["x-forwarded-for"] ?? req.headers["cf-connecting-ip"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  return (first ? first.split(",")[0].trim() : "") || req.socket.remoteAddress || "unknown";
};

/** PURE: one SSE frame. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
/** PURE: rows written after `at`, oldest first. */
export function newerThan<T extends { at: number; updatedAt?: number }>(rows: T[], at: number): T[] {
  return rows.filter((r) => (r.updatedAt ?? r.at) > at).sort((a, b) => (a.updatedAt ?? a.at) - (b.updatedAt ?? b.at));
}
const sizeOf = (file: string): number => {
  try {
    return statSync(dataPath(file)).size;
  } catch {
    return 0;
  }
};

function stream(req: IncomingMessage, res: ServerResponse, limit: number): void {
  const client = clientOf(req);
  if (streamCount >= MAX_STREAMS || (streams.get(client) ?? 0) >= MAX_STREAMS_PER_IP) {
    json(res, 429, { error: "too many open streams; poll /api/obs/thoughts instead" });
    return;
  }
  streamCount++;
  streams.set(client, (streams.get(client) ?? 0) + 1);
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const history = readThoughts(limit).reverse();
  const trades = publicTrades(readBook().trades, 20);
  let lastThoughtAt = history.length ? history[history.length - 1].at : 0;
  let lastTradeAt = trades.length ? Math.max(...trades.map((t) => t.updatedAt ?? t.at)) : 0;
  let thoughtsSize = sizeOf("obs-thoughts.jsonl");
  let tradesSize = sizeOf("obs-trades.jsonl");
  const firstWatch = readWatch();
  let lastWatchAt = firstWatch ? Date.now() : 0;
  let lastWatchTrigger = firstWatch?.trigger ?? null;
  const researchHistory = readResearch(40).reverse();
  let lastResearchAt = researchHistory.length ? researchHistory[researchHistory.length - 1].at : 0;
  let researchSize = sizeOf("obs-research.jsonl");
  res.write(sseFrame("hello", { at: Date.now(), thoughts: history.map(withDigest), trades, canExecute: tradingArmed(), research: researchHistory, ...(firstWatch ? { watch: firstWatch } : {}) }));
  const look = () => {
    // The research log: every new line as it lands.
    const rsz = sizeOf("obs-research.jsonl");
    if (rsz !== researchSize) {
      researchSize = rsz;
      for (const e of readResearch(100).reverse()) {
        if (e.at <= lastResearchAt) continue;
        lastResearchAt = e.at;
        res.write(sseFrame("research", e));
      }
    }
    // The live watch between cycles: a line a minute, and every trigger the moment it fires.
    const w = readWatch();
    if (w && (w.trigger !== lastWatchTrigger || Date.now() - lastWatchAt >= WATCH_EVERY_MS)) {
      lastWatchAt = Date.now();
      lastWatchTrigger = w.trigger;
      res.write(sseFrame("watch", w));
    }
    const ts = sizeOf("obs-thoughts.jsonl");
    if (ts !== thoughtsSize) {
      thoughtsSize = ts;
      for (const t of newerThan(readThoughts(50), lastThoughtAt)) {
        lastThoughtAt = t.at;
        res.write(sseFrame("thought", withDigest(t)));
      }
    }
    const rs = sizeOf("obs-trades.jsonl");
    if (rs !== tradesSize) {
      tradesSize = rs;
      for (const t of newerThan(publicTrades(readBook().trades, 50), lastTradeAt)) {
        lastTradeAt = t.updatedAt ?? t.at;
        res.write(sseFrame("trade", t));
      }
    }
  };
  const poll = setInterval(look, STREAM_POLL_MS);
  const ping = setInterval(() => res.write(": ping\n\n"), STREAM_PING_MS);
  req.on("close", () => {
    clearInterval(poll);
    clearInterval(ping);
    streamCount = Math.max(0, streamCount - 1);
    const n = (streams.get(client) ?? 1) - 1;
    if (n <= 0) streams.delete(client);
    else streams.set(client, n);
  });
}

// The signals strip is computed on a timer and answered from the last result: it parses the launch feed and
// the tapes, and reads every candidate's pool, which no visitor should wait for. The live heartbeat is read
// per request, since it is one small file.
let signalsCache: { at: number; value: Record<string, unknown> } | null = null;
let signalsRefreshing = false;
async function computeSignals(now: number): Promise<Record<string, unknown>> {
  const r = await cachedReads();
        const basisOn = (process.env.OBS_BASIS ?? "off") === "on";
        const prices = await cachedPrices(basisOn ? ["ETH", "NVDA"] : ["ETH"], { wait: true });
        const ref = basisOn ? await stockReference("NVDA", now) : null;
        const nvda = basisOn ? prices.NVDA ?? null : null;
        const basis = ref && nvda ? basisSignal(nvda, ref, 0.62, Number(process.env.OBS_BASIS_MIN_EDGE_PCT ?? 0.25)) : null;
        const feed = readFeed(now);
        const rules = gradeRulesFromEnv();
        const candidates: Array<{ symbol: string; grade: "A" | "B" | "C" | null; [k: string]: unknown }> = [];
        for (const c of feed.candidates.slice(0, 4)) {
          const spec = dynamicPoolSpec(candidateAsset(c));
          const depth = spec ? await poolRead(spec).then((p) => p?.depthUsd2pct ?? null).catch(() => null) : null;
          const g = gradeCandidate(c, feed.hourly[c.poolId.toLowerCase()] ?? [], depth, rules);
          candidates.push({ symbol: c.symbol, stable: c.stable ? { stable: c.stable.stable, activeHours: c.stable.activeHours, hoursKnown: c.stable.hoursKnown, why: c.stable.why } : null, hour: c.hour, volUsd: c.volUsd, movePct: c.movePct, senders: c.senders, tierPct: c.tierPct, grade: g.grade, capUsd: g.capUsd, why: g.why, depthUsd: g.depthUsd, trend: g.trend });
        }
        const early = feed.early.slice(0, 6).map((l) => ({ symbol: l.symbol, source: l.source, ageMin: Math.round((now - l.at) / 60e3), gateOk: l.gateOk, creatorTaxBps: l.creatorTaxBps, ignitedAfterMin: l.ignitedAfterMin, sidePoolTierPct: l.sidePools[0]?.tierPct ?? null, tradable: !!resolveAny(`${l.symbol}@robinhood`, feed)?.candidate, via: l.sidePools.length ? "side pool" : "curve" }));
        // Tokens in play and their tapes, and the launch record: what the desk is actually doing.
        const held = readTokens().map((t) => t.symbol);
        const inPlay = [...new Set([...held, ...early.filter((e) => e.ignitedAfterMin != null && e.gateOk).map((e) => e.symbol), ...candidates.filter((c) => c.grade).map((c) => c.symbol)])].slice(0, 6);
        const entryRules = entryRulesFromEnv();
        const tapes = inPlay.map((sym) => {
          const a = resolveAny(`${sym}@robinhood`, feed);
          const spec = a?.candidate ? dynamicPoolSpec(a) : null;
          if (!spec?.id) return { symbol: sym, trend: "unknown", swaps: null, buyPressurePct: null, entry: null };
          const rows = readTape(spec.id);
          const st = tapeStats(rows, sym, now, 15);
          const g = candidates.find((x) => x.symbol === sym)?.grade;
          const er = entryRead(rows, sym, now, entryRules, held.includes(sym) || g === "A" || g === "B");
          return { symbol: sym, trend: st.trend, swaps: st.swaps, buyPressurePct: st.buyPressurePct, movePct: st.movePct, offPeakPct: st.offPeakPct, entry: { state: er.state, ok: er.ok, why: er.why, pickup: er.pickup, offPeakPct: er.offPeakPct, recentBuyPressurePct: er.recentBuyPressurePct } };
        });
        return { basis, reference: ref ? { printStatus: ref.printStatus, printAt: ref.printAt, perpTradesDay: ref.perpTradesDay, perpChangeDayPct: ref.perpChangeDayPct } : null, ratio: basisOn ? ratioStats(readPrices(), "ETH", "NVDA", now) : null, session: basisOn ? usSession(now) : null, candidates, early, tapes, launch: { ...launchRecord(readCloses()), line: launchRecordLine(launchRecord(readCloses())) }, market: r.market ?? null, at: now };
}
async function refreshSignals(): Promise<void> {
  if (signalsRefreshing) return;
  signalsRefreshing = true;
  try {
    const now = Date.now();
    signalsCache = { at: now, value: await computeSignals(now) };
  } catch {
    /* keep the last result */
  } finally {
    signalsRefreshing = false;
  }
}
function liveBlock(now: number): Record<string, unknown> {
  try {
    const lp = dataPath("obs-live.json");
    if (existsSync(lp)) {
      const b = JSON.parse(readFileSync(lp, "utf8")) as { at: number };
      return { live: now - Number(b.at) < 30_000, ...b };
    }
  } catch {
    /* not live */
  }
  return { live: false, watching: [] };
}

export function handle(req: IncomingMessage, res: ServerResponse): void {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    json(res, 405, { error: "read-only" });
    return;
  }
  if (!limiter.allow(clientOf(req), Date.now())) {
    res.setHeader("Retry-After", "30");
    json(res, 429, { error: `rate limited: ${RATE_PER_MIN} requests a minute per client` });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const now = Date.now();
  if (path === "/skill" || path.startsWith("/skill/")) {
    // The skill: SKILL.md and its references, for another model to load. Read-only files, no traversal.
    const rel = path === "/skill" ? "SKILL.md" : path.slice("/skill/".length);
    if (!/^[A-Za-z0-9_./-]+$/.test(rel) || rel.includes("..")) {
      json(res, 404, { error: "not found" });
      return;
    }
    const file = join(ROOT_DIR, "skills", "agent-obs", rel);
    if (!existsSync(file) || !statSync(file).isFile()) {
      json(res, 404, { error: "not found" });
      return;
    }
    const type = rel.endsWith(".md") ? "text/markdown; charset=utf-8" : rel.endsWith(".sh") ? "text/x-shellscript; charset=utf-8" : "text/plain; charset=utf-8";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=300" });
    createReadStream(file).pipe(res);
    return;
  }
  if (path === "/" || path === "/dashboard") {
    if (!existsSync(DASHBOARD)) {
      json(res, 404, { error: "dashboard page not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(DASHBOARD, "utf8"));
    return;
  }
  if (path === "/api/obs/health") {
    json(res, 200, { status: "ok", at: now });
    return;
  }
  if (path === "/api/obs/status") {
    const d = deskFromDisk();
    json(res, 200, {
      ...buildStatus(readLedger<PostRow>("x-posts.jsonl"), readLedger<PostRow>("x-replies.jsonl"), readLedger("obs-decisions.jsonl"), { live: xLive(), configured: xConfigured(), now, desk: d.desk }),
      rails: railsSummary(railsFromEnv(), d.book.trades, now),
      // The desk's own wallet is public on purpose: every balance and every settlement is checkable there.
      wallet: WALLET_ADDRESS ? { address: WALLET_ADDRESS, explorerUrl: `${EXPLORER_URL}/address/${WALLET_ADDRESS}` } : null,
    });
    return;
  }
  if (path === "/api/obs/stream") {
    const limit = Number(url.searchParams.get("limit") ?? 12);
    stream(req, res, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 12);
    return;
  }
  if (path === "/api/obs/agent-token") {
    // The agent's own token, for the Market card: the last background read, at once. Never traded by the desk.
    if (!agentTokenCache) void refreshAgentToken();
    json(res, 200, agentTokenCache ?? { contract: AGENT_TOKEN, pending: true, at: now });
    return;
  }
  if (path === "/api/obs/research") {
    // The research log: what the desk learned about tokens between cycles, newest first.
    const limit = Number(url.searchParams.get("limit") ?? 50);
    json(res, 200, { items: readResearch(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50), at: now });
    return;
  }
  if (path === "/api/obs/thoughts") {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    json(res, 200, { items: readThoughts(Number.isFinite(limit) ? limit : 20).map(withDigest), at: now });
    return;
  }
  if (path === "/api/obs/trades") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    json(res, 200, { items: publicTrades(readBook().trades, Number.isFinite(limit) ? limit : 50), at: now });
    return;
  }
  if (path === "/api/obs/pnl") {
    const hours = Number(url.searchParams.get("hours") ?? 168);
    const { book } = deskFromDisk();
    // The chain is the truth once a wallet exists; the ledgers are the fallback. A cold read is never waited for:
    // the ledger's last snapshot answers at once, marked pending, and the next request gets the chain.
    const warm = warmReads();
    if (!warm) {
      const t0 = latestTrades(book.trades);
      const last = book.snapshots[book.snapshots.length - 1] ?? snapshot(book.flows, book.trades, {}, now);
      json(res, 200, { pending: true, snapshot: last, prices: {}, positions: [], realizedUsd: 0, inFlight: [], track: null, series: series(book.snapshots, (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 90) : 168) * 3600e3, now), capital: { netUsd: last.netCapitalUsd, deposits: book.flows.filter((f) => f.kind === "deposit").length, withdrawals: book.flows.filter((f) => f.kind === "withdraw").length }, trades: { settled: t0.filter((x) => x.status === "settled").length, pending: t0.filter((x) => x.status === "pending").length, proposed: t0.filter((x) => x.status === "proposed").length, failed: t0.filter((x) => x.status === "failed").length }, canExecute: tradingArmed(), at: now });
      return;
    }
    // A read that began before the last swap settled is not the truth for the minute until the next one: the ledger
    // stands in, marked pending, so the page never anchors its curve to a wallet priced a position short.
    const behind = readsBehindBook(book.trades);
    Promise.resolve(warm)
      .then(async (r) => {
        const chain = !behind && r.wallet ? walletBalances(r.wallet) : null;
        const held = chain ? Object.keys(chain.bySymbol) : Object.keys(snapshot(book.flows, book.trades, {}, now).holdings);
        const prices = await cachedPrices(held);
        // A held token whose price has never been read (a new position, or the first request after a restart) would
        // mark the wallet short by that position; the cycle's last mark stands in, pending, until its price lands.
        const unpriced = chain ? unpricedHeld(chain.bySymbol) : [];
        const standIn = unpriced.length ? latestSaneMark(book.snapshots) : null;
        const live = standIn ?? (chain ? snapshotFromChain(book.flows, book.trades, chain.bySymbol, prices, now) : snapshot(book.flows, book.trades, prices, now));
        const t = latestTrades(book.trades);
        const pos = positions(book.flows, book.trades, live.holdings, prices);
        json(res, 200, {
          ...(behind || standIn ? { pending: true } : {}),
          snapshot: live,
          prices,
          positions: pos.positions,
          realizedUsd: pos.realizedUsd,
          inFlight: pos.inFlight,
          track: trackRecord(pos.events, now),
          series: series(book.snapshots, (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 90) : 168) * 3600e3, now),
          capital: { netUsd: live.netCapitalUsd, deposits: book.flows.filter((f) => f.kind === "deposit").length, withdrawals: book.flows.filter((f) => f.kind === "withdraw").length },
          trades: { settled: t.filter((x) => x.status === "settled").length, pending: t.filter((x) => x.status === "pending").length, proposed: t.filter((x) => x.status === "proposed").length, failed: t.filter((x) => x.status === "failed" || x.status === "cancelled").length },
          canExecute: tradingArmed(),
          at: now,
        });
      })
      .catch((err) => json(res, 502, { error: err instanceof Error ? err.message : "pnl unavailable" }));
    return;
  }
  if (path === "/api/obs/feed-tail") {
    // The launch feed's bytes from an offset, for a hosted desk that pulls it (src/desk/feedpull.ts).
    // Not public: a shared token, and nothing without OBS_FEED_TOKEN set. Headers carry the file's size.
    const token = process.env.OBS_FEED_TOKEN ?? "";
    const feedPath = process.env.OBS_CANDIDATE_FEED ?? "";
    if (!token || !feedPath || req.headers["x-obs-feed-token"] !== token) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (!existsSync(feedPath)) {
      json(res, 404, { error: "no feed" });
      return;
    }
    const size = statSync(feedPath).size;
    const from = Math.max(0, Math.min(size, Number(url.searchParams.get("from") ?? 0) || 0));
    const want = Math.max(1, Math.min(8 * 1024 * 1024, Number(url.searchParams.get("size") ?? 1_048_576) || 1_048_576));
    const end = Math.min(size, from + want);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-OBS-Feed-Size": String(size), "X-OBS-Feed-From": String(from) });
    if (end <= from) {
      res.end();
      return;
    }
    createReadStream(feedPath, { start: from, end: end - 1 }).pipe(res);
    return;
  }
  if (path === "/api/obs/live") {
    // The live watch's heartbeat: what it follows block by block, and its last trigger. Live when written in the last half minute.
    const p = dataPath("obs-live.json");
    if (!existsSync(p)) {
      json(res, 200, { live: false, watching: [] });
      return;
    }
    try {
      const beat = JSON.parse(readFileSync(p, "utf8")) as { at: number };
      json(res, 200, { live: Date.now() - Number(beat.at) < 30_000, ...beat });
    } catch {
      json(res, 200, { live: false, watching: [] });
    }
    return;
  }
  if (path === "/api/obs/signals") {
    // What the desk is watching and how close each is to acting: the last computed strip, with a fresh heartbeat.
    if (!signalsCache) void refreshSignals();
    json(res, 200, { ...(signalsCache?.value ?? { pending: true, candidates: [], early: [], tapes: [], launch: null, basis: null, reference: null, ratio: null, session: null, market: null }), live: liveBlock(now), scout: readScout(), at: now });
    return;
  }
  if (path === "/api/obs/market") {
    const hours = Number(url.searchParams.get("hours") ?? 168);
    const rows = readMarketSamples();
    json(res, 200, { series: marketSeries(rows, (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 365) : 168) * 3600e3, now), change24hPct: change24h(rows, now), samples: rows.length, at: now });
    return;
  }
  if (path === "/api/obs/feed") {
    const limit = Number(url.searchParams.get("limit") ?? 30);
    json(res, 200, { items: publicFeed(readLedger<PostRow>("x-posts.jsonl"), readLedger<PostRow>("x-replies.jsonl"), X_HANDLE, Number.isFinite(limit) ? limit : 30), at: now });
    return;
  }
  if (path === "/api/obs/reads") {
    cachedReads()
      .then((r) => json(res, 200, { ...r, block: readsBlock(r) }))
      .catch((err) => json(res, 502, { error: err instanceof Error ? err.message : "reads unavailable" }));
    return;
  }
  json(res, 404, { error: "not found", routes: ["/", "/api/obs/health", "/api/obs/status", "/api/obs/thoughts?limit=20", "/api/obs/trades?limit=50", "/api/obs/pnl?hours=168", "/api/obs/feed?limit=30", "/api/obs/reads", "/api/obs/market?hours=168", "/api/obs/signals", "/api/obs/live", "/api/obs/stream?limit=12 (server-sent events)"] });
}

// Compare paths, not URL strings: a space in the checkout path is "%20" in
// import.meta.url and a literal space in argv, so the string form never matched.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void refreshAgentToken();
  setInterval(() => void refreshAgentToken(), 45_000).unref();
  void refreshSignals();
  setInterval(() => void refreshSignals(), 20_000).unref();
  // Warm the reads and prices at boot, and keep them warm, so no visitor ever pays for a cold read.
  // Warm at boot and keep warm: ETH and whatever the wallet holds, so the first request after a restart, and the first
  // after a new position, is answered from the book rather than waiting on a cold read of every pool.
  const heldSymbols = () => { const w = readsCache?.value.wallet; return w ? ["ETH", ...Object.keys(walletBalances(w).bySymbol)] : ["ETH"]; };
  void cachedReads().then(() => cachedPrices(heldSymbols())).catch(() => undefined);
  setInterval(() => { void cachedReads().then(() => cachedPrices(heldSymbols())).catch(() => undefined); }, READS_TTL_MS).unref();
  createServer(handle).listen(PORT, process.env.OBS_DASHBOARD_HOST || "127.0.0.1", () => {
    console.log(`[obs] dashboard API on http://localhost:${PORT} (page at /, JSON under /api/obs/*)`);
  });
}
