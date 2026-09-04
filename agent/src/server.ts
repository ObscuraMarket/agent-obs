// The OBS dashboard API. Read-only JSON over plain node:http with CORS, so
// Obscura's team can render OBS inside their own app (Angular, anything)
// without running our code in their build. The standalone page in
// ../dashboard is served at / for previews and for iframing.
//
// Nothing private crosses this boundary: the copywriter's NOTEs never leave
// the journal, no key or token is read here, and the ledgers are shaped down
// to what a public timeline already shows. Run: npm run dashboard.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLedger } from "./ledger.ts";
import { liveReads, readsBlock, assetPrices, readMarketSamples, marketSeries, change24h, type Reads } from "./obscura/reads.ts";
import { readBook, latestTrades, snapshot, snapshotFromChain, series, positions, type Trade, type BookSnapshot } from "./desk/book.ts";
import { trackRecord, basisSignal, ratioStats, readPrices, usSession } from "./desk/analysis.ts";
import { stockReference } from "./obscura/stockRef.ts";
import { readFeed, gradeCandidate, gradeRulesFromEnv, dynamicPoolSpec, candidateAsset } from "./desk/candidates.ts";
import { poolRead } from "./obscura/pools.ts";
import { readThoughts } from "./desk/thoughts.ts";
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

let readsCache: { at: number; value: Reads } | null = null;
async function cachedReads(): Promise<Reads> {
  if (readsCache && Date.now() - readsCache.at < READS_TTL_MS) return readsCache.value;
  const value = await liveReads();
  readsCache = { at: Date.now(), value };
  return value;
}
let pricesCache: { at: number; key: string; value: Record<string, number | null> } | null = null;
async function cachedPrices(symbols: string[]): Promise<Record<string, number | null>> {
  const key = [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(",");
  if (pricesCache && pricesCache.key === key && Date.now() - pricesCache.at < READS_TTL_MS) return pricesCache.value;
  const value = await assetPrices(symbols, { OBS: readsCache?.value.market?.priceUsd ?? null });
  pricesCache = { at: Date.now(), key, value };
  return value;
}

/** The trade rows as the dashboard shows them. The ledger never holds a deposit or payout address, so nothing is stripped; this is the seam if that ever changes. */
export function publicTrades(trades: Trade[], limit = 50): Trade[] {
  return latestTrades(trades).slice(0, Math.max(1, Math.min(limit, 500)));
}
const deskFromDisk = () => {
  const book = readBook();
  const latest = book.snapshots.length ? book.snapshots.reduce((a, b) => (b.at > a.at ? b : a)) : null;
  const thoughts = readThoughts(1);
  return { book, desk: buildDesk(latest, book.trades, thoughts[0]?.at ?? null, tradingArmed()) };
};

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin ?? "";
  const allow = ORIGINS.includes("*") ? "*" : ORIGINS.includes(origin) ? origin : "";
  if (allow) res.setHeader("Access-Control-Allow-Origin", allow);
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
  res.write(sseFrame("hello", { at: Date.now(), thoughts: history, trades, canExecute: tradingArmed() }));
  const look = () => {
    const ts = sizeOf("obs-thoughts.jsonl");
    if (ts !== thoughtsSize) {
      thoughtsSize = ts;
      for (const t of newerThan(readThoughts(50), lastThoughtAt)) {
        lastThoughtAt = t.at;
        res.write(sseFrame("thought", t));
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
  if (path === "/api/obs/thoughts") {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    json(res, 200, { items: readThoughts(Number.isFinite(limit) ? limit : 20), at: now });
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
    // The chain is the truth once a wallet exists; the ledgers are the fallback.
    cachedReads()
      .then(async (r) => {
        const chain = r.wallet ? walletBalances(r.wallet) : null;
        const held = chain ? Object.keys(chain.bySymbol) : Object.keys(snapshot(book.flows, book.trades, {}, now).holdings);
        const prices = await cachedPrices(held);
        const live = chain ? snapshotFromChain(book.flows, book.trades, chain.bySymbol, prices, now) : snapshot(book.flows, book.trades, prices, now);
        const t = latestTrades(book.trades);
        const pos = positions(book.flows, book.trades, live.holdings, prices);
        json(res, 200, {
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
  if (path === "/api/obs/signals") {
    // What the desk is watching and how close each is to acting, for the page's signals strip.
    cachedReads()
      .then(async (r) => {
        const prices = await cachedPrices(["ETH", "NVDA"]);
        const ref = await stockReference("NVDA", now);
        const nvda = prices.NVDA ?? null;
        const basis = nvda ? basisSignal(nvda, ref, 0.62, Number(process.env.OBS_BASIS_MIN_EDGE_PCT ?? 0.25)) : null;
        const feed = readFeed(now);
        const rules = gradeRulesFromEnv();
        const candidates = [];
        for (const c of feed.candidates.slice(0, 4)) {
          const spec = dynamicPoolSpec(candidateAsset(c));
          const depth = spec ? await poolRead(spec).then((p) => p?.depthUsd2pct ?? null).catch(() => null) : null;
          const g = gradeCandidate(c, feed.hourly[c.poolId.toLowerCase()] ?? [], depth, rules);
          candidates.push({ symbol: c.symbol, hour: c.hour, volUsd: c.volUsd, movePct: c.movePct, senders: c.senders, tierPct: c.tierPct, grade: g.grade, capUsd: g.capUsd, why: g.why, depthUsd: g.depthUsd, trend: g.trend });
        }
        const early = feed.early.slice(0, 6).map((l) => ({ symbol: l.symbol, source: l.source, ageMin: Math.round((now - l.at) / 60e3), gateOk: l.gateOk, creatorTaxBps: l.creatorTaxBps, ignitedAfterMin: l.ignitedAfterMin, sidePoolTierPct: l.sidePools[0]?.tierPct ?? null }));
        json(res, 200, { basis, reference: { printStatus: ref.printStatus, printAt: ref.printAt, perpTradesDay: ref.perpTradesDay, perpChangeDayPct: ref.perpChangeDayPct }, ratio: ratioStats(readPrices(), "ETH", "NVDA", now), session: usSession(now), candidates, early, market: r.market ?? null, at: now });
      })
      .catch((err) => json(res, 502, { error: err instanceof Error ? err.message : "signals unavailable" }));
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
  json(res, 404, { error: "not found", routes: ["/", "/api/obs/health", "/api/obs/status", "/api/obs/thoughts?limit=20", "/api/obs/trades?limit=50", "/api/obs/pnl?hours=168", "/api/obs/feed?limit=30", "/api/obs/reads", "/api/obs/market?hours=168", "/api/obs/signals", "/api/obs/stream?limit=12 (server-sent events)"] });
}

// Compare paths, not URL strings: a space in the checkout path is "%20" in
// import.meta.url and a literal space in argv, so the string form never matched.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  createServer(handle).listen(PORT, () => {
    console.log(`[obs] dashboard API on http://localhost:${PORT} (page at /, JSON under /api/obs/*)`);
  });
}
