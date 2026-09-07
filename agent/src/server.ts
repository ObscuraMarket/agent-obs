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
import { readBook, latestTrades, snapshot, snapshotFromChain, series, positions, latestSaneMark, bookMovedSince, closedTrades, capitalEth, type Trade, type BookSnapshot } from "./desk/book.ts";
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
import { readAgentToken, rememberAgentTokenRead, lastAgentTokenPrice, type AgentTokenRead } from "./desk/agentToken.ts";
import { AGENT_TOKEN, AGENT_TOKEN_SYMBOL } from "./config.ts";

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
import { tradingArmed, railsFromEnv, type Rails } from "./desk/rails.ts";
import { walletBalances } from "./obscura/reads.ts";
import { X_HANDLE, X_AGENT_ID, AGENT_ID, MAX_TWEET_CHARS, OBS_CONTRACT, SITE_URL, ROOT_DIR, WALLET_ADDRESS, EXPLORER_URL, dataPath } from "./config.ts";
import { xLive, xConfigured } from "./social/xClient.ts";
import { consoleQuote, verifySwap, consoleStanding, isAddress } from "./desk/console.ts";
import { issueChallenge, linkAccount, verifySession, bearerOf } from "./desk/accounts.ts";
import { getSettings, updateSettings, sanitizeSettings, describeSettings } from "./desk/userSettings.ts";
import { approveTool, ensureUserAgent, streamUserAgent, userAgentHistory, refreshPersona, agentDisplayName, chatGuard, endTurn, deEmDash } from "./desk/userAgents.ts";
import { routeConsole } from "./cli/router.ts";
import { statusLines, positionsLines, thoughtsLines, researchLines, watchLines, readsLines, swapsLines, appsLines } from "./desk/deskConsole.ts";
import { appsOn, ensureApps, listApps, connectApp, disconnectApp, resolveApp, appName, allowedToolkits } from "./desk/apps.ts";

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
  maxOpenOrders: number;
  gasReserveEth: number;
  openOrders: number;
  allowedAssets: string[];
  allowedPartners: string[] | null;
  /** Chain keys both legs must be on; the mandate is Robinhood Chain only. */
  allowedChains: string[];
}

/** PURE: the rails as the dashboard shows them: each cap next to what is used. Nothing here is counted by the day. */
export function railsSummary(rails: Rails, trades: Trade[], now: number): RailsSummary {
  const t = latestTrades(trades);
  return {
    tradingOn: rails.tradingOn,
    maxSwapUsd: rails.maxSwapUsd,
    maxOpenOrders: rails.maxOpenOrders,
    gasReserveEth: rails.gasReserveEth,
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
    .then(() => assetPrices(symbols, { OBS: readsCache?.value.market?.priceUsd ?? null, [AGENT_TOKEN_SYMBOL]: agentTokenCache?.priceUsd ?? lastAgentTokenPrice() }))
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

/**
 * PURE: prices for held launch tokens from the live watch's tape, which reads every pool in play every three seconds:
 * the last swap's price in the quote, times the quote's dollar price. A wallet read comes once a minute; between
 * reads this is how a position moves on the page in real time. Only tokens the watch follows and can price are
 * overridden; a stale live file (older than 30 s) changes nothing.
 */
export function tapePrices(live: { at?: number; watching?: Array<{ symbol: string; lastPrice?: number | null; quote?: string }> } | null, prices: Record<string, number | null>, held: string[], now = Date.now()): Record<string, number | null> {
  if (!live?.at || now - live.at > 30_000) return prices;
  const out = { ...prices };
  const want = new Set(held.map((s) => s.toUpperCase()));
  for (const w of live.watching ?? []) {
    const sym = w.symbol.toUpperCase();
    if (!want.has(sym) || sym === "ETH" || sym === "NVDA" || !(Number(w.lastPrice) > 0) || !w.quote) continue;
    const quote = w.quote.toUpperCase();
    const quoteUsd = quote === "USDG" || quote === "USDC" || quote === "USDT" ? 1 : prices[quote];
    if (quoteUsd == null || !(quoteUsd > 0)) continue;
    out[sym] = (w.lastPrice as number) * quoteUsd;
  }
  return out;
}
function readLiveFile(): { at?: number; watching?: Array<{ symbol: string; lastPrice?: number | null; quote?: string }> } | null {
  const p = dataPath("obs-live.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as { at?: number; watching?: Array<{ symbol: string; lastPrice?: number | null; quote?: string }> };
  } catch {
    return null;
  }
}

/**
 * The PnL answer: the book from the chain when the reads are warm and current, the ledger otherwise, marked pending.
 * Positions are priced from the live watch's tape between wallet reads. `withSeries` false leaves the curve out, for
 * the stream, which pushes this whenever it changes.
 */
async function pnlPayload(hours: number, now: number, withSeries = true): Promise<Record<string, unknown>> {
  const { book } = deskFromDisk();
  const windowMs = (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 90) : 168) * 3600e3;
  const counts = (ts: Trade[]) => ({ settled: ts.filter((x) => x.status === "settled").length, pending: ts.filter((x) => x.status === "pending").length, proposed: ts.filter((x) => x.status === "proposed").length, failed: ts.filter((x) => x.status === "failed" || x.status === "cancelled").length });
  const capital = (netUsd: number) => ({ netUsd, ethIn: capitalEth(book.flows), deposits: book.flows.filter((f) => f.kind === "deposit").length, withdrawals: book.flows.filter((f) => f.kind === "withdraw").length });
  // The chain is the truth once a wallet exists; the ledgers are the fallback. A cold read is never waited for:
  // the ledger's last snapshot answers at once, marked pending, and the next request gets the chain.
  const warm = warmReads();
  if (!warm) {
    const last = book.snapshots[book.snapshots.length - 1] ?? snapshot(book.flows, book.trades, {}, now);
    return { pending: true, snapshot: last, prices: {}, positions: [], realizedUsd: 0, inFlight: [], track: null, ...(withSeries ? { series: series(book.snapshots, windowMs, now) } : {}), capital: capital(last.netCapitalUsd), trades: counts(latestTrades(book.trades)), canExecute: tradingArmed(), at: now };
  }
  // A read that began before the last swap settled is not the truth for the minute until the next one: the ledger
  // stands in, marked pending, so the page never anchors its curve to a wallet priced a position short.
  const behind = readsBehindBook(book.trades);
  const chain = !behind && warm.wallet ? walletBalances(warm.wallet) : null;
  const held = chain ? Object.keys(chain.bySymbol) : Object.keys(snapshot(book.flows, book.trades, {}, now).holdings);
  const prices = tapePrices(readLiveFile(), await cachedPrices(held), held, now);
  // A held token whose price has never been read (a new position, or the first request after a restart) would
  // mark the wallet short by that position; the cycle's last mark stands in, pending, until its price lands.
  const unpriced = chain ? unpricedHeld(chain.bySymbol).filter((s) => prices[s.toUpperCase()] == null) : [];
  const standIn = unpriced.length ? latestSaneMark(book.snapshots) : null;
  const live = standIn ?? (chain ? snapshotFromChain(book.flows, book.trades, chain.bySymbol, prices, now) : snapshot(book.flows, book.trades, prices, now));
  const pos = positions(book.flows, book.trades, live.holdings, prices);
  return {
    ...(behind || standIn ? { pending: true } : {}),
    snapshot: live,
    prices,
    positions: pos.positions,
    realizedUsd: pos.realizedUsd,
    inFlight: pos.inFlight,
    track: trackRecord(pos.events, now),
    closed: closedTrades(book.trades, pos.events, 24 * 3600e3, now),
    ...(withSeries ? { series: series(book.snapshots, windowMs, now) } : {}),
    capital: capital(live.netCapitalUsd),
    trades: counts(latestTrades(book.trades)),
    canExecute: tradingArmed(),
    at: now,
  };
}
/** PURE: what the stream compares between looks: a position moved, was opened or closed, or equity changed. */
export function pnlFingerprint(p: { snapshot?: { equityUsd?: number | null }; positions?: Array<{ asset: string; qty: number; valueUsd: number | null }> }): string {
  return JSON.stringify({ e: p.snapshot?.equityUsd == null ? null : Math.round(p.snapshot.equityUsd * 100), p: (p.positions ?? []).map((x) => [x.asset, x.qty, x.valueUsd == null ? null : Math.round(x.valueUsd * 100)]) });
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
    rememberAgentTokenRead(agentTokenCache);
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "public, max-age=30");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}
/** The request body, capped: the console's report is a few fields. */
function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error(`body larger than ${max} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function statusPayload(now: number): Record<string, unknown> {
  const d = deskFromDisk();
  return {
    ...buildStatus(readLedger<PostRow>("x-posts.jsonl"), readLedger<PostRow>("x-replies.jsonl"), readLedger("obs-decisions.jsonl"), { live: xLive(), configured: xConfigured(), now, desk: d.desk }),
    rails: railsSummary(railsFromEnv(), d.book.trades, now),
    // The desk's own wallet is public on purpose: every balance and every settlement is checkable there.
    wallet: WALLET_ADDRESS ? { address: WALLET_ADDRESS, explorerUrl: `${EXPLORER_URL}/address/${WALLET_ADDRESS}` } : null,
  };
}

/** The live watch's heartbeat: what it follows block by block, and its last trigger. Live when written in the last half minute. */
function livePayload(): Record<string, unknown> {
  const p = dataPath("obs-live.json");
  if (!existsSync(p)) return { live: false, watching: [] };
  try {
    const beat = JSON.parse(readFileSync(p, "utf8")) as { at: number };
    return { live: Date.now() - Number(beat.at) < 30_000, ...beat };
  } catch {
    return { live: false, watching: [] };
  }
}

/** The wallet a request proves through its bearer, or null after a 401. */
function requireWallet(req: IncomingMessage, res: ServerResponse): string | null {
  const address = verifySession(bearerOf(req.headers.authorization));
  if (!address) {
    json(res, 401, { ok: false, error: "sign in with your wallet first" });
    return null;
  }
  return address;
}

/** The desk's read-only commands as lines, from the same payloads the page reads. */
async function deskLines(command: string, n: number | undefined, now: number): Promise<string[]> {
  switch (command) {
    case "status": return statusLines(statusPayload(now), await pnlPayload(24, now, false));
    case "positions": return positionsLines(await pnlPayload(24, now, false));
    case "thoughts": return thoughtsLines(readThoughts(Math.max(1, Math.min(20, n ?? 3))).map(withDigest));
    case "research": return researchLines(readResearch(Math.max(1, Math.min(50, n ?? 12))));
    case "watch": return watchLines(livePayload());
    case "reads": return readsLines(await cachedReads());
    default: return ["that desk command is not here"];
  }
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
/** How often the stream re-prices the positions from the live watch's tape. */
const PNL_EVERY_MS = 4000;
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
  let lastPnlAt = 0;
  let lastPnlFingerprint = "";
  let pnlInFlight = false;
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
    // The positions, in real time: the book re-priced from the live watch's tape every few seconds, pushed when it moved.
    if (Date.now() - lastPnlAt >= PNL_EVERY_MS && !pnlInFlight) {
      lastPnlAt = Date.now();
      pnlInFlight = true;
      pnlPayload(24, Date.now(), false)
        .then((p) => { const f = pnlFingerprint(p as never); if (f !== lastPnlFingerprint) { lastPnlFingerprint = f; res.write(sseFrame("pnl", p)); } })
        .catch(() => undefined)
        .finally(() => { pnlInFlight = false; });
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
  // A real event, not a comment: a comment never reaches an EventSource listener, so the page could not tell a quiet
  // desk from a dead connection and waited minutes before reconnecting.
  const ping = setInterval(() => res.write(sseFrame("ping", { at: Date.now() })), STREAM_PING_MS);
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
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  // Read-only, with one exception: the console's report of a swap a person sent from their own wallet, which the
  // desk verifies on the chain before it counts anything. Nothing else is written through this API.
  const WRITES = new Set(["/api/obs/console/swap", "/api/obs/account/challenge", "/api/obs/account/link", "/api/obs/console/cli", "/api/obs/my-agent/ensure", "/api/obs/my-agent/stream", "/api/obs/my-agent/settings", "/api/obs/my-agent/approve"]);
  if (req.method !== "GET" && !(req.method === "POST" && WRITES.has(path))) {
    json(res, 405, { error: "read-only" });
    return;
  }
  if (!limiter.allow(clientOf(req), Date.now())) {
    res.setHeader("Retry-After", "30");
    json(res, 429, { error: `rate limited: ${RATE_PER_MIN} requests a minute per client` });
    return;
  }
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
    json(res, 200, statusPayload(now));
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
    pnlPayload(hours, now)
      .then((p) => json(res, 200, p))
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
    json(res, 200, livePayload());
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
  // The swap console: a quote through the desk's router with the transactions the person's own wallet signs, where
  // an address stands against the bar, and the report of a sent swap. Never cached: a quote is a moment.
  if (path === "/api/obs/console/quote") {
    res.setHeader("Cache-Control", "no-store");
    const user = url.searchParams.get("user") ?? "";
    if (!isAddress(user)) {
      json(res, 400, { error: "user must be a 0x address: the swap pays its output there" });
      return;
    }
    consoleQuote(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "", Number(url.searchParams.get("amount")), user, now)
      .then((r) => json(res, "error" in r ? 400 : 200, r))
      .catch((err) => json(res, 502, { error: err instanceof Error ? err.message : "the quote failed" }));
    return;
  }
  // A wallet's swaps through the console, shown back to it. The old path answers the same, for pages not yet redeployed.
  if (path === "/api/obs/console/swaps" || path === "/api/obs/console/eligible") {
    res.setHeader("Cache-Control", "no-store");
    const address = url.searchParams.get("address") ?? "";
    if (!isAddress(address)) {
      json(res, 400, { error: "address must be a 0x address" });
      return;
    }
    json(res, 200, consoleStanding(address));
    return;
  }
  if (path === "/api/obs/console/swap") {
    res.setHeader("Cache-Control", "no-store");
    readBody(req, 4096)
      .then((text) => {
        let b: Record<string, unknown>;
        try {
          b = JSON.parse(text) as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "the body must be JSON: {address, txHash, from, to, amountIn}" });
          return;
        }
        return verifySwap(String(b.txHash ?? ""), String(b.address ?? ""), String(b.from ?? ""), String(b.to ?? ""), Number(b.amountIn)).then((r) =>
          r.ok ? json(res, 200, { ok: true, already: r.already, swap: r.swap, standing: consoleStanding(r.swap.address) }) : json(res, 409, { ok: false, reason: r.reason }),
        );
      })
      .catch((err) => json(res, 400, { error: err instanceof Error ? err.message : "bad request" }));
    return;
  }
  // ---- the console's account: the wallet is the account -------------------------------------------------------
  // A person proves control of a wallet by signing a challenge; the bearer that comes back gates their own agent
  // and their settings. It authorises no transaction and moves no funds.
  if (path === "/api/obs/account/challenge") {
    res.setHeader("Cache-Control", "no-store");
    readBody(req, 1024).then((text) => {
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(text) as Record<string, unknown>; } catch { /* empty body */ }
      const c = issueChallenge(b.address, now);
      if (!c) { json(res, 400, { ok: false, error: "a wallet address is required" }); return; }
      json(res, 200, { ok: true, ...c });
    }).catch((err) => json(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" }));
    return;
  }
  if (path === "/api/obs/account/link") {
    res.setHeader("Cache-Control", "no-store");
    readBody(req, 4096).then(async (text) => {
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(text) as Record<string, unknown>; } catch { /* empty body */ }
      const r = await linkAccount(b, now);
      if (!r.ok) { json(res, 401, { ok: false, error: r.error }); return; }
      json(res, 200, { ok: true, session: r.session, standing: consoleStanding(r.session.address) });
    }).catch((err) => json(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" }));
    return;
  }
  // The console: one typed line in, lines out. The routing is pure (src/cli/router.ts); this is the only place
  // that acts. Chat is not handled here: it returns an intent and the page streams it, so a conversational turn
  // keeps one path. Wallet and view effects come straight back too: the page does those.
  if (path === "/api/obs/console/cli") {
    res.setHeader("Cache-Control", "no-store");
    // A guest may read the desk, take the tour, open the app's pages and quote; shaping an agent and chat need the wallet.
    const address = verifySession(bearerOf(req.headers.authorization));
    readBody(req, 4096).then(async (text) => {
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(text) as Record<string, unknown>; } catch { /* empty body */ }
      const line = typeof b.line === "string" ? b.line : "";
      if (line.length > 2000) { json(res, 400, { ok: false, lines: ["That's too long for one line."] }); return; }
      const standing = address ? consoleStanding(address) : { address: "", swaps: 0, recent: [] };
      const before = address ? getSettings(address) : {};
      const routed = routeConsole(line, { settings: before, signedIn: !!address, swaps: standing.swaps });
      const base = { lines: routed.lines, suggest: routed.suggest };
      const needsWallet = routed.effect.kind === "chat" || routed.effect.kind === "settings" || routed.effect.kind === "read" || routed.effect.kind === "apps";
      if (needsWallet && !address) {
        json(res, 200, { ok: false, effect: "none", lines: ["Connect your wallet first. It's your account here and the wallet that controls your agent: one signature, no transaction."], suggest: ["/connect"] });
        return;
      }
      switch (routed.effect.kind) {
        case "none":
        case "clear":
          json(res, 200, { ok: !routed.error, ...base, effect: routed.effect.kind });
          return;
        case "wallet":
          json(res, 200, { ok: true, ...base, effect: "wallet", ...routed.effect });
          return;
        case "view":
          json(res, 200, { ok: true, ...base, effect: "view", view: routed.effect.view });
          return;
        case "apps": {
          // The person's apps, through Composio, for the wallet that signed in. Off until the operator sets the key.
          if (!appsOn()) { json(res, 200, { ok: false, effect: "none", lines: ["Connecting apps isn't switched on here yet."], suggest: ["/help"] }); return; }
          const a = address as string;
          const names = allowedToolkits().map(appName).join(", ");
          try {
            if (routed.effect.action === "list") {
              const apps = await listApps(a);
              json(res, 200, { ok: true, effect: "apps", lines: appsLines(apps), suggest: apps.filter((x) => !x.connected).slice(0, 3).map((x) => `/apps connect ${x.name}`) });
              return;
            }
            const slug = resolveApp(routed.effect.app ?? "");
            if (!slug) { json(res, 200, { ok: false, effect: "none", lines: [`"${routed.effect.app ?? ""}" isn't an app you can connect here. Try one of: ${names}.`], suggest: ["/apps"] }); return; }
            const name = appName(slug);
            if (routed.effect.action === "connect") {
              const c = await connectApp(a, slug);
              void ensureApps(a).catch((e) => console.error(`[apps] attach for ${a}: ${e instanceof Error ? e.message : String(e)}`));
              json(res, 200, { ok: true, effect: "apps", lines: [c.url ? `Connect ${name}: open the link, approve it there, then come back and type /apps.` : `${name} is already connected, or needs no sign-in.`], links: c.url ? [{ label: `Connect ${name}`, url: c.url }] : [], suggest: ["/apps"] });
              return;
            }
            const n = await disconnectApp(a, slug);
            json(res, 200, { ok: true, effect: "apps", lines: [n ? `${name} disconnected.` : `${name} wasn't connected.`], suggest: ["/apps"] });
            return;
          } catch (err) {
            console.error(`[apps] ${routed.effect.action} for ${a}: ${err instanceof Error ? err.message : String(err)}`);
            json(res, 200, { ok: false, effect: "none", lines: ["Couldn't reach the apps service just now. Try again in a moment."], suggest: ["/apps"] });
            return;
          }
        }
        case "chat":
          json(res, 200, { ok: true, lines: [], effect: "chat", text: routed.effect.text });
          return;
        case "desk":
          json(res, 200, { ok: true, lines: await deskLines(routed.effect.command, routed.effect.n, now), effect: "desk" });
          return;
        case "read":
          if (routed.effect.what === "whoami") { json(res, 200, { ok: true, lines: describeSettings(before), effect: "read" }); return; }
          json(res, 200, { ok: true, lines: swapsLines(standing), effect: "read", standing, ...(standing.swaps ? {} : { suggest: ["/quote 0.05 ETH USDG", "/swap 0.05 ETH USDG"] }) });
          return;
        case "settings": {
          const cleaned = sanitizeSettings(routed.effect.patch);
          if ("error" in cleaned) { json(res, 200, { ok: false, lines: [cleaned.error], effect: "settings" }); return; }
          const settings = updateSettings(address as string, cleaned.settings);
          void refreshPersona(address as string);
          json(res, 200, { ok: true, lines: describeSettings(settings), effect: "settings", settings });
          return;
        }
      }
    }).catch((err) => json(res, 400, { ok: false, lines: [err instanceof Error ? err.message : "bad request"] }));
    return;
  }
  // ---- your own agent ----------------------------------------------------------------------------------------
  if (path === "/api/obs/my-agent/ensure") {
    res.setHeader("Cache-Control", "no-store");
    const address = requireWallet(req, res);
    if (!address) return;
    ensureUserAgent(address)
      .then((r) => {
        if (appsOn()) void ensureApps(address).catch((e) => console.error(`[apps] attach for ${address}: ${e instanceof Error ? e.message : String(e)}`));
        json(res, 200, { ok: true, ...r, name: agentDisplayName(address), settings: getSettings(address) });
      })
      .catch((err) => { console.error(`[my-agent] ensure failed: ${err instanceof Error ? err.message : String(err)}`); json(res, 502, { ok: false, error: "could not reach your agent; try again shortly" }); });
    return;
  }
  if (path === "/api/obs/my-agent/history") {
    res.setHeader("Cache-Control", "no-store");
    const address = requireWallet(req, res);
    if (!address) return;
    userAgentHistory(address).then((turns) => json(res, 200, { ok: true, turns })).catch(() => json(res, 200, { ok: true, turns: [] }));
    return;
  }
  if (path === "/api/obs/my-agent/settings") {
    res.setHeader("Cache-Control", "no-store");
    const address = requireWallet(req, res);
    if (!address) return;
    if (req.method === "GET") { json(res, 200, { ok: true, settings: getSettings(address), name: agentDisplayName(address) }); return; }
    readBody(req, 4096).then((text) => {
      let b: unknown = {};
      try { b = JSON.parse(text); } catch { /* empty body */ }
      const cleaned = sanitizeSettings(b);
      if ("error" in cleaned) { json(res, 400, { ok: false, error: cleaned.error }); return; }
      const settings = updateSettings(address, cleaned.settings);
      void refreshPersona(address);
      json(res, 200, { ok: true, settings, name: agentDisplayName(address) });
    }).catch((err) => json(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" }));
    return;
  }
  if (path === "/api/obs/my-agent/approve") {
    // The person's answer to an approval their agent asked for in the console: a tool call inside one of their apps.
    res.setHeader("Cache-Control", "no-store");
    const address = requireWallet(req, res);
    if (!address) return;
    readBody(req, 4096).then(async (text) => {
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(text) as Record<string, unknown>; } catch { /* empty body */ }
      const toolCallId = typeof b.toolCallId === "string" ? b.toolCallId : "";
      if (!toolCallId) { json(res, 400, { ok: false, error: "toolCallId is required" }); return; }
      const resolved = await approveTool(address, toolCallId, b.approved === true);
      json(res, 200, { ok: true, resolved, approved: b.approved === true });
    }).catch((err) => json(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" }));
    return;
  }
  if (path === "/api/obs/my-agent/stream") {
    // One turn, streamed as server-sent events: one JSON object per data frame. The guards run before the SSE
    // headers, so a refused turn gets a clean JSON error rather than a half-open stream.
    const address = requireWallet(req, res);
    if (!address) return;
    readBody(req, 4096).then(async (text) => {
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(text) as Record<string, unknown>; } catch { /* empty body */ }
      const msg = typeof b.text === "string" ? b.text.trim() : "";
      if (!msg) { json(res, 400, { ok: false, error: "empty message" }); return; }
      if (msg.length > 2000) { json(res, 400, { ok: false, error: "message too long (2000 characters at most)" }); return; }
      const guard = chatGuard(address, now);
      if (guard) { json(res, guard.status, { ok: false, error: guard.error }); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const ac = new AbortController();
      res.on("close", () => ac.abort());
      let idle: ReturnType<typeof setTimeout> | undefined;
      const arm = (ms = 60_000) => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), ms); };
      let deltas = 0;
      try {
        arm();
        const stream = await streamUserAgent(address, msg, ac.signal);
        for await (const ev of stream) {
          arm();
          if (ev.type === "text_delta") { deltas++; send({ type: "delta", text: deEmDash(ev.text) }); }
          else if (ev.type === "text_final") send({ type: "final", text: deEmDash(ev.text) });
          else if (ev.type === "error") send({ type: "error", message: (ev as { message?: string }).message ?? "your agent could not respond" });
          else if (ev.type === "tool_call") send({ type: "tool", phase: "call", tool: ev.tool, toolCallId: ev.toolCallId, args: ev.args });
          else if (ev.type === "tool_result") send({ type: "tool", phase: "result", tool: ev.tool, toolCallId: ev.toolCallId, ok: !ev.isError });
          // A tool inside one of their apps waits for them: the page shows Allow and Deny, and the turn waits up to five minutes for the tap.
          else if (ev.type === "approval_requested") { arm(300_000); send({ type: "approval", requestId: ev.requestId, toolCallId: ev.toolCallId, tool: ev.resourceKey, args: ev.args }); }
          else if (ev.type === "approval_resolved") send({ type: "approval_resolved", toolCallId: ev.toolCallId, decision: ev.decision });
          else if (ev.type === "agent_end") break;
        }
        send({ type: "done" });
      } catch (err) {
        console.error(`[my-agent] stream failed (aborted=${ac.signal.aborted}, deltas=${deltas}): ${err instanceof Error ? err.message : String(err)}`);
        if (!ac.signal.aborted) send({ type: "error", message: "your agent could not respond just now; try again shortly" });
      } finally {
        clearTimeout(idle);
        res.end();
        endTurn(address);
      }
    }).catch((err) => { endTurn(address); json(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" }); });
    return;
  }
  if (path === "/api/obs/reads") {
    cachedReads()
      .then((r) => json(res, 200, { ...r, block: readsBlock(r) }))
      .catch((err) => json(res, 502, { error: err instanceof Error ? err.message : "reads unavailable" }));
    return;
  }
  json(res, 404, { error: "not found", routes: ["/", "/api/obs/health", "/api/obs/status", "/api/obs/thoughts?limit=20", "/api/obs/trades?limit=50", "/api/obs/pnl?hours=168", "/api/obs/feed?limit=30", "/api/obs/reads", "/api/obs/market?hours=168", "/api/obs/signals", "/api/obs/live", "/api/obs/stream?limit=12 (server-sent events)", "/api/obs/console/quote?from=ETH&to=USDG&amount=0.05&user=0x...", "/api/obs/console/swaps?address=0x...", "POST /api/obs/console/swap {address, txHash, from, to, amountIn}", "POST /api/obs/account/challenge {address}", "POST /api/obs/account/link {address, nonce, signature}", "POST /api/obs/console/cli {line} (bearer)", "POST /api/obs/my-agent/ensure (bearer)", "GET /api/obs/my-agent/history (bearer)", "GET|POST /api/obs/my-agent/settings (bearer)", "POST /api/obs/my-agent/stream {text} (bearer, server-sent events)"] });
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
