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
import { recentAlerts, raiseAlert, staleVerdict, backupVerdict, readBackupFailure, alertRulesFromEnv } from "./desk/alerts.ts";
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
import { refreshModel, modelFor, personaFor, approveTool, ensureUserAgent, streamUserAgent, userAgentHistory, refreshPersona, agentDisplayName, chatGuard, endTurn, deEmDash } from "./desk/userAgents.ts";
import { shouldEndTurn, meteredReply, type TurnState } from "./desk/chatTurn.ts";
import { routeConsole } from "./cli/router.ts";
import { statusLines, positionsLines, thoughtsLines, researchLines, watchLines, readsLines, swapsLines, appsLines, agentsLines } from "./desk/deskConsole.ts";
import { appsOn, ensureApps, listApps, connectApp, disconnectApp, resolveApp, appName, allowedToolkits } from "./desk/apps.ts";
import { holderGate, forgetHolder, gateMode, doorNow } from "./desk/gate.ts";
import { followState, readFollow, recordFollow, checkSize, followMaxUsd, followBook, followLines, liveBook, readFollowTrades, readFollowNotes, liveTrades, liveHoldings, mirrorTrades, followEvents, type FollowMode } from "./desk/follow.ts";
import { readEntries } from "./desk/trade-memory.ts";
import { liveOn, canStartLive } from "./desk/mirror.ts";
import { latestEthUsd } from "./desk/onchain.ts";
import { walletsOn, agentWalletAddress, agentWalletAddressOrNull, WalletDerivationError, rememberWallet, fundTx, withdrawEth, withdrawToken, sellToken, agentBalanceEth, verifyFunding, walletLines, walletBook, readAgentCapital } from "./desk/agentWallet.ts";
import type { Prices } from "./desk/book.ts";
import { catalog, findModels, featured, modelInfo, modelLine, estimateTokens, turnCostUsd, DEFAULT_MODEL, DEFAULT_MODEL_INFO } from "./desk/models.ts";
import { readCredits, balanceUsd, creditsSummary, grantFree, chargeTurn, creditsOn, freeUsd, marginPct, contextTokens, payTokens, resolvePayToken, paymentTx, verifyPayment, toCredits, fmtCredits, CREDITS_PER_USD } from "./desk/credits.ts";
import { Lru } from "./lru.ts";

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
// Keyed on the Origin header, which anyone can vary per request, so bounded: past five thousand the origin refused
// longest ago is forgotten and would be logged again, which is the cheap side to err on (2026-09-08).
const refusedOrigins = new Lru<string, number>(5_000);
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
    // What the console offers today, so the page shows no door or button that is not there yet.
    console: { gate: gateMode(), apps: appsOn(), credits: creditsOn(), freeCredits: Math.round(freeUsd() * CREDITS_PER_USD) },
  };
}

/** The agent's own token, for the Market card: the last background read, at once. Never traded by the desk. */
function agentTokenPayload(now: number): AgentTokenRead | { contract: string; pending: true; at: number } {
  if (!agentTokenCache) void refreshAgentToken();
  return agentTokenCache ?? { contract: AGENT_TOKEN, pending: true, at: now };
}
/** The live reads with the block the agent sees. Waits on a cold read, the way the route always has. */
async function readsPayload(): Promise<Record<string, unknown>> {
  const r = await cachedReads();
  return { ...r, block: readsBlock(r) };
}
/** The $OBS price over time, sampled from the pool, and its 24-hour change. */
function marketPayload(hours: number, now: number): Record<string, unknown> {
  const rows = readMarketSamples();
  return { series: marketSeries(rows, (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 365) : 168) * 3600e3, now), change24hPct: change24h(rows, now), samples: rows.length, at: now };
}
function tradesPayload(limit: number, now: number): Record<string, unknown> {
  return { items: publicTrades(readBook().trades, Number.isFinite(limit) ? limit : 50), at: now };
}
function feedPayload(limit: number, now: number): Record<string, unknown> {
  return { items: publicFeed(readLedger<PostRow>("x-posts.jsonl"), readLedger<PostRow>("x-replies.jsonl"), X_HANDLE, Number.isFinite(limit) ? limit : 30), at: now };
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

/**
 * The wallet a request proves through its bearer, or null after a 401; and still at the door, or null after a 403.
 * The door is asked on every signed-in call from what it already knows (the list, or a cached holder read), so a
 * wallet taken off the list loses the console at once rather than at the end of its seven-day bearer (2026-09-08).
 */
function requireWallet(req: IncomingMessage, res: ServerResponse): string | null {
  const address = verifySession(bearerOf(req.headers.authorization));
  if (!address) {
    json(res, 401, { ok: false, error: "sign in with your wallet first" });
    return null;
  }
  const door = doorNow(address);
  if (door && !door.ok) {
    json(res, 403, { ok: false, code: "not_holder", error: door.reason ?? "this wallet is not at the door any more; sign in again" });
    return null;
  }
  return address;
}

/** The desk's read-only commands as lines, from the same payloads the page reads. */
/**
 * The prices an agent's book is marked at: the desk's live read when it is warm, and for anything that read has not
 * priced (a cold read right after a restart answers from the last snapshot), the desk's latest price sample within
 * three hours. A follower's token is one the desk holds or held, so a sample nearly always exists.
 */
function pricesNow(p: Record<string, unknown>, now: number): Prices {
  const out: Prices = { ...((p.prices as Prices | undefined) ?? {}) };
  for (const s of readPrices().filter((x) => now - x.at <= 3 * 3600e3).sort((a, b) => a.at - b.at)) {
    const k = s.symbol.toUpperCase();
    if (out[k] == null) out[k] = s.priceUsd;
  }
  return out;
}

// ---- Every agent following the desk, in public: who is on, what they hold, what they made. ----------------------
// A person's own wallet is never shown; the agent's name and its own wallet are. Cached for thirty seconds.
export interface PublicAgent {
  name: string;
  wallet: string | null;
  walletUrl: string | null;
  on: boolean;
  mode: "paper" | "live";
  sizeUsd: number;
  since: number | null;
  positions: Array<{ asset: string; valueUsd: number | null; unrealizedPct: number | null }>;
  realizedUsd: number;
  trades: number;
  exits: number;
}
let agentsCache: { at: number; value: { ok: true; agents: PublicAgent[]; on: number; live: number; at: number } } | null = null;
async function agentsPayload(now: number): Promise<{ ok: true; agents: PublicAgent[]; on: number; live: number; at: number }> {
  if (agentsCache && now - agentsCache.at < 30_000) return agentsCache.value;
  const rows = readFollow();
  const addresses = [...new Set(rows.map((r) => r.address))];
  const p = await pnlPayload(1, now, false);
  const prices = pricesNow(p, now);
  const deskTrades = deskFromDisk().book.trades;
  const tradeRows = readFollowTrades();
  const notes = readFollowNotes();
  const agents: PublicAgent[] = [];
  for (const a of addresses) {
    const state = followState(rows, a);
    const book = state.mode === "live" ? liveBook(a, state, tradeRows, notes, prices, null) : followBook(deskTrades, state, prices);
    // No wallet shown for one the seed no longer derives (the operator is paged inside), and one such wallet never hides the list.
    const wallet = agentWalletAddressOrNull(a);
    agents.push({
      name: agentDisplayName(a),
      wallet: wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : null,
      walletUrl: wallet ? `${EXPLORER_URL}/address/${wallet}` : null,
      on: state.on, mode: state.mode, sizeUsd: state.sizeUsd, since: state.since,
      positions: book.positions.positions.map((x) => ({ asset: x.asset, valueUsd: x.valueUsd, unrealizedPct: x.unrealizedPct })),
      realizedUsd: book.positions.realizedUsd, trades: book.trades.length, exits: book.trades.filter((t) => t.exit).length,
    });
  }
  agents.sort((x, y) => Number(y.on) - Number(x.on) || y.realizedUsd - x.realizedUsd);
  const value = { ok: true as const, agents: agents.slice(0, 50), on: agents.filter((x) => x.on).length, live: agents.filter((x) => x.on && x.mode === "live").length, at: now };
  agentsCache = { at: now, value };
  return value;
}

// ---- The Agent page's one read ----------------------------------------------------------------------------------
// One idle Agent page tab polled eight of these routes every fifteen seconds (2026-09-08), each poll re-reading the
// ledgers eight times over. This is the same eight payloads assembled once and shared by every viewer for five
// seconds. Each part keeps its route's shape exactly, and a part whose route would have failed is null here rather
// than failing the whole read. The single routes stay, for every other consumer.
const DASHBOARD_TTL_MS = 5_000;

/** PURE: one value per key, remade once it is older than the TTL; callers inside the TTL share one making. Exported for tests. */
export class TtlCache<T> {
  private entries = new Map<string, { at: number; value: Promise<T> }>();
  constructor(private ttlMs: number) {}
  get(key: string, make: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    for (const [k, e] of this.entries) if (now - e.at >= this.ttlMs) this.entries.delete(k);
    const entry = { at: now, value: make() };
    this.entries.set(key, entry);
    // A making that failed is not kept for the TTL: the next caller tries again.
    entry.value.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    return entry.value;
  }
}

/** PURE: a read that answers null instead of throwing, so one failed part never fails the page's whole read. Exported for tests. */
export async function attempt<T>(read: () => T | Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** PURE: the one read's query: each route's own default, clamped the way that route clamps, so equal asks share one cache entry. Exported for tests. */
export function dashboardQuery(params: URLSearchParams): { hours: number; trades: number; feed: number } {
  const num = (k: string, fallback: number, lo: number, hi: number) => {
    const v = Number(params.get(k) ?? fallback);
    return Number.isFinite(v) && v > 0 ? Math.max(lo, Math.min(hi, v)) : fallback;
  };
  return { hours: num("hours", 168, 1, 24 * 365), trades: num("trades", 50, 1, 500), feed: num("feed", 30, 1, 200) };
}

const dashboardCache = new TtlCache<Record<string, unknown>>(DASHBOARD_TTL_MS);
function dashboardPayload(q: { hours: number; trades: number; feed: number }, now: number): Promise<Record<string, unknown>> {
  return dashboardCache.get(`${q.hours}|${q.trades}|${q.feed}`, async () => {
    const [status, agentToken, reads, pnl, agents, market, trades, feed] = await Promise.all([
      attempt(() => statusPayload(now)),
      attempt(() => agentTokenPayload(now)),
      attempt(readsPayload),
      attempt(() => pnlPayload(q.hours, now)),
      attempt(() => agentsPayload(now)),
      attempt(() => marketPayload(q.hours, now)),
      attempt(() => tradesPayload(q.trades, now)),
      attempt(() => feedPayload(q.feed, now)),
    ]);
    return { status, agentToken, reads, pnl, agents, market, trades, feed, at: now };
  }, now);
}

async function deskLines(command: string, n: number | undefined, now: number): Promise<string[]> {
  switch (command) {
    case "agents": return agentsLines(await agentsPayload(now));
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
/** A token quantity as a person reads it: whole tokens with the thousands marked, up to four decimals for a small one. */
const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

const DASHBOARD = join(ROOT_DIR, "..", "dashboard", "index.html");

// The live stream: server-sent events, so the page's terminal shows a thought
// the moment the desk writes it instead of on the next poll. The ledgers are
// append-only files, so "new" is cheap to detect: the file grew. Two seconds
// between looks; a keepalive comment every 25 so proxies keep the socket.
const STREAM_POLL_MS = 2000;
/** How often the stream re-prices the positions from the live watch's tape. */
const PNL_EVERY_MS = 4000;
/** The re-priced book every stream shares: refreshed at most once per tick, by whichever stream asks first. */
const sharedPnl: { at: number; inFlight: boolean; value: unknown; fingerprint: string } = { at: 0, inFlight: false, value: null, fingerprint: "" };
function refreshSharedPnl(): void {
  if (Date.now() - sharedPnl.at < PNL_EVERY_MS || sharedPnl.inFlight) return;
  sharedPnl.inFlight = true;
  sharedPnl.at = Date.now();
  pnlPayload(24, Date.now(), false)
    .then((p) => { sharedPnl.value = p; sharedPnl.fingerprint = pnlFingerprint(p as never); })
    .catch(() => undefined)
    .finally(() => { sharedPnl.inFlight = false; });
}
const STREAM_PING_MS = 25_000;

/** How many clients the budget remembers at once; past it the client seen longest ago is forgotten. */
export const RATE_CLIENTS_MAX = 20_000;
/** How often the budget forgets clients whose window has passed. */
const RATE_SWEEP_MS = 60_000;

/** PURE: a sliding-window request budget per client. Exported for tests. */
export class RateLimiter {
  private hits: Lru<string, number[]>;
  constructor(private perMinute: number, private windowMs = 60_000, maxClients = RATE_CLIENTS_MAX) {
    this.hits = new Lru(maxClients);
  }
  /** How many clients are remembered right now. */
  get clients(): number {
    return this.hits.size;
  }
  /** True when the client may proceed; records the hit. */
  allow(client: string, now = Date.now()): boolean {
    const cut = now - this.windowMs;
    const list = (this.hits.get(client) ?? []).filter((t) => t > cut);
    const ok = list.length < this.perMinute;
    if (ok) list.push(now);
    // Bounded by the map itself: past the cap the client seen longest ago is forgotten. Quiet clients are swept on a
    // timer; the sweep once ran inside every request whenever more than ten thousand were known, so a burst of new
    // addresses made each request walk them all (2026-09-08).
    this.hits.set(client, list);
    return ok;
  }
  /** Forgets every client with no hit inside the window; how many went. Run on a timer, never on a request. */
  sweep(now = Date.now()): number {
    const cut = now - this.windowMs;
    let dropped = 0;
    for (const [client, list] of this.hits) {
      if (list.some((t) => t > cut)) continue;
      this.hits.delete(client);
      dropped++;
    }
    return dropped;
  }
}
const limiter = new RateLimiter(RATE_PER_MIN);
// Unref'd: the sweep must not hold a test or a one-shot import open.
setInterval(() => limiter.sweep(), RATE_SWEEP_MS).unref();
const streams = new Map<string, number>();
let streamCount = 0;

/**
 * PURE: whether a peer address is loopback or private: 127/8, ::1, 10/8, 172.16/12, 192.168/16 and fc00::/7, which
 * is what Railway's edge and a proxy on the same host present. An IPv4 address mapped into IPv6 (::ffff:10.0.0.1,
 * how node reports an IPv4 peer on a dual-stack socket) is read as the IPv4. Anything unparseable is not private.
 */
export function isPrivatePeer(address: string | null | undefined): boolean {
  if (!address) return false;
  let a = address.trim().toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  if (a.startsWith("::ffff:") && a.includes(".")) a = a.slice("::ffff:".length);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return false;
    const [o1, o2] = octets;
    return o1 === 127 || o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168);
  }
  if (a === "::1") return true;
  if (!a.includes(":")) return false;
  // fc00::/7: the first seven bits are 1111110, so the leading group runs fc00 to fdff.
  const head = a.split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(head)) return false;
  return (parseInt(head, 16) & 0xfe00) === 0xfc00;
}

/**
 * PURE: the address a request is budgeted by. The forwarded headers name the real client only when the socket's
 * peer is the edge (loopback or a private range); from anyone else they are whatever the sender typed, and a loop
 * that sent a fresh X-Forwarded-For with every request rotated past the budget and the stream cap until 2026-09-08.
 */
export function clientFrom(peer: string | null | undefined, headers: Record<string, string | string[] | undefined>): string {
  if (isPrivatePeer(peer)) {
    const fwd = headers["x-forwarded-for"] ?? headers["cf-connecting-ip"];
    const first = Array.isArray(fwd) ? fwd[0] : fwd;
    const named = first ? first.split(",")[0].trim() : "";
    if (named) return named;
  }
  return peer || "unknown";
}
let publicPeerNoted = false;
const clientOf = (req: IncomingMessage): string => {
  const peer = req.socket.remoteAddress;
  // Said once per process: if the edge in front of this desk ever presents a public address, every visitor is
  // budgeted as that one peer, and this line is how the operator would tell.
  if (!publicPeerNoted && peer && !isPrivatePeer(peer) && (req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"])) {
    publicPeerNoted = true;
    console.log(`[obs] forwarded address ignored: the peer ${peer} is not loopback or private, so requests are budgeted by the peer`);
  }
  return clientFrom(peer, req.headers);
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
  let lastPnlFingerprint = "";
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
    // One book for every stream: computed once per tick and shared, where each stream once re-read every ledger
    // for itself every four seconds (2026-09-08).
    refreshSharedPnl();
    if (sharedPnl.value != null && sharedPnl.fingerprint !== lastPnlFingerprint) { lastPnlFingerprint = sharedPnl.fingerprint; res.write(sseFrame("pnl", sharedPnl.value)); }
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
  const WRITES = new Set(["/api/obs/console/swap", "/api/obs/my-agent/wallet/verify", "/api/obs/account/challenge", "/api/obs/account/link", "/api/obs/console/cli", "/api/obs/my-agent/ensure", "/api/obs/my-agent/stream", "/api/obs/my-agent/settings", "/api/obs/my-agent/approve", "/api/obs/credits/verify"]);
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
    // "ok" while the live watch is looking; "stale" once it has been quiet past OBS_ALERT_STALE_MIN, so an outside
    // uptime check can read the word off the body. The latest alerts ride along.
    const beat = livePayload() as { at?: number; lastCycleAt?: number | null; lastCycleCode?: number | null };
    const stale = staleVerdict(typeof beat.at === "number" ? beat.at : null, now, alertRulesFromEnv().staleMin);
    json(res, 200, { status: stale ? "stale" : "ok", at: now, ...(stale ? { reason: stale } : {}), live: { at: beat.at ?? null, lastCycleAt: beat.lastCycleAt ?? null, lastCycleCode: beat.lastCycleCode ?? null }, alerts: recentAlerts(now) });
    return;
  }
  if (path === "/api/obs/status") {
    json(res, 200, statusPayload(now));
    return;
  }
  if (path === "/api/obs/agents") {
    // Every agent following the desk, for anyone: names, their own wallets, what they hold and what they made.
    res.setHeader("Cache-Control", "public, max-age=30");
    agentsPayload(now).then((p) => json(res, 200, p)).catch((err) => json(res, 502, { ok: false, error: err instanceof Error ? err.message : "agents unavailable" }));
    return;
  }
  if (path === "/api/obs/console/door") {
    // Whether a wallet may use the console: the same door sign-in uses, so the site's header can light the link for
    // an invited wallet and keep it greyed for everyone else. A read, cached like the gate itself.
    res.setHeader("Cache-Control", "no-store");
    const address = url.searchParams.get("address") ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { json(res, 200, { ok: true, open: false, mode: gateMode() }); return; }
    holderGate(address, now)
      .then((g) => json(res, 200, { ok: true, open: g.ok, mode: gateMode(), ...(g.ok ? {} : { reason: g.reason }) }))
      .catch(() => json(res, 200, { ok: true, open: false, mode: gateMode() }));
    return;
  }
  if (path === "/api/obs/stream") {
    const limit = Number(url.searchParams.get("limit") ?? 12);
    stream(req, res, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 12);
    return;
  }
  if (path === "/api/obs/agent-token") {
    json(res, 200, agentTokenPayload(now));
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
    json(res, 200, tradesPayload(Number(url.searchParams.get("limit") ?? 50), now));
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
    json(res, 200, marketPayload(Number(url.searchParams.get("hours") ?? 168), now));
    return;
  }
  if (path === "/api/obs/feed") {
    json(res, 200, feedPayload(Number(url.searchParams.get("limit") ?? 30), now));
    return;
  }
  if (path === "/api/obs/dashboard") {
    // The Agent page's one read: every payload it polls, in one object, shared by every viewer for five seconds.
    res.setHeader("Cache-Control", "public, max-age=5");
    dashboardPayload(dashboardQuery(url.searchParams), now)
      .then((p) => json(res, 200, p))
      .catch((err) => json(res, 502, { error: err instanceof Error ? err.message : "dashboard unavailable" }));
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
    // The wallet the swap is counted for is the one that signed in, never one named in the body; and only a signed-in
    // wallet may ask, where anyone once could and each ask held a receipt wait (2026-09-08).
    const signedAddress = requireWallet(req, res);
    if (!signedAddress) return;
    readBody(req, 4096)
      .then((text) => {
        let b: Record<string, unknown>;
        try {
          b = JSON.parse(text) as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "the body must be JSON: {address, txHash, from, to, amountIn}" });
          return;
        }
        return verifySwap(String(b.txHash ?? ""), signedAddress, String(b.from ?? ""), String(b.to ?? ""), Number(b.amountIn)).then((r) =>
          r.ok ? (forgetHolder(r.swap.address), json(res, 200, { ok: true, already: r.already, swap: r.swap, standing: consoleStanding(r.swap.address) })) : json(res, 409, { ok: false, reason: r.reason }),
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
      // Every attempt at the door is logged with its outcome, so "I can't get in" can be read off the log by wallet.
      if (!r.ok) { console.log(`[account] link refused for ${typeof b.address === "string" ? b.address : "?"}: ${r.error}`); json(res, 401, { ok: false, error: r.error }); return; }
      // The console is for holders: the signature proves the wallet, the chain says whether it holds OBS or AOBS.
      const gate = await holderGate(r.session.address, now);
      if (!gate.ok) { console.log(`[account] door closed for ${r.session.address}: ${gate.reason}`); json(res, 403, { ok: false, code: "not_holder", error: gate.reason, obs: gate.obs, aobs: gate.aobs, minObs: gate.minObs, minAobs: gate.minAobs }); return; }
      console.log(`[account] signed in ${r.session.address}${gate.invited ? " (invited)" : ""}`);
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
    // A signed-in wallet is also asked at the door again: off the list, it is a guest here from that moment.
    const signed = verifySession(bearerOf(req.headers.authorization));
    const door = signed ? doorNow(signed) : null;
    const closed = !!(signed && door && !door.ok);
    let address = closed ? null : signed;
    readBody(req, 4096).then(async (text) => {
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(text) as Record<string, unknown>; } catch { /* empty body */ }
      const line = typeof b.line === "string" ? b.line : "";
      if (line.length > 2000) { json(res, 400, { ok: false, lines: ["That's too long for one line."] }); return; }
      const standing = address ? consoleStanding(address) : { address: "", swaps: 0, recent: [] };
      const before = address ? getSettings(address) : {};
      const routed = routeConsole(line, { settings: before, signedIn: !!address, swaps: standing.swaps, apps: appsOn(), gate: gateMode() });
      const base = { lines: routed.lines, suggest: routed.suggest };
      const needsWallet = routed.effect.kind === "chat" || routed.effect.kind === "settings" || routed.effect.kind === "read" || routed.effect.kind === "apps" || routed.effect.kind === "credits" || routed.effect.kind === "follow" || routed.effect.kind === "agentWallet" || (routed.effect.kind === "model" && routed.effect.action === "set");
      if (needsWallet && !address) {
        // A wallet whose door has closed keeps the two things that are its own money: its agent's wallet (/wallet,
        // /withdraw) and turning its agent off (/stop, /agent). Everything else answers with the door's own words,
        // not a prompt to connect a wallet that is already connected (2026-09-08).
        const rescue = closed && signed && (routed.effect.kind === "agentWallet" || (routed.effect.kind === "follow" && (routed.effect.action === "stop" || routed.effect.action === "show")));
        if (rescue) address = signed;
        else if (closed) { json(res, 200, { ok: false, effect: "none", code: "not_holder", lines: [door?.reason ?? "This wallet is not at the console's door any more."], suggest: ["/trade", "/status"] }); return; }
        else { json(res, 200, { ok: false, effect: "none", lines: ["Connect your wallet first. It's your account here and the wallet that controls your agent: one signature, no transaction."], suggest: ["/connect"] }); return; }
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
        case "model": {
          // The model the agent runs on: any model OpenRouter serves, at its price. A guest may look; picking needs the wallet.
          const cat = await catalog();
          const cur = address ? modelFor(address) : DEFAULT_MODEL;
          const money = (v: number) => (v === 0 ? "free" : `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`);
          const priceOf = (id: string) => { const m = cat.find((x) => x.id === id); return m ? (m.free ? "free" : `${money(m.promptPerM)} in, ${money(m.completionPerM)} out per million tokens`) : "price unknown"; };
          if (routed.effect.action === "show") {
            const feat = featured(cat);
            json(res, 200, { ok: true, effect: "model", lines: [`Your agent runs on ${cur} (${priceOf(cur)}).`, "", ...(feat.length ? ["Featured:", ...feat.map((m) => modelLine(m, m.id === cur)), ""] : []), `/model <name> picks one. /models <search> finds any of the ${cat.length} models.`], suggest: feat.filter((m) => m.id !== cur).slice(0, 3).map((m) => `/model ${m.id}`) });
            return;
          }
          if (routed.effect.action === "list") {
            const q = routed.effect.query ?? "";
            const hits = q ? findModels(cat, q, 10) : featured(cat);
            json(res, 200, { ok: !!hits.length, effect: "model", lines: hits.length ? [q ? `Models matching "${q}":` : "Featured:", ...hits.map((m) => modelLine(m, m.id === cur))] : [`No model matches "${q}". Try a maker or a family: /models claude, /models gemini, /models free.`], suggest: hits.slice(0, 3).map((m) => `/model ${m.id}`) });
            return;
          }
          const hits = findModels(cat, routed.effect.query ?? "", 5);
          if (!hits.length) { json(res, 200, { ok: false, effect: "none", lines: [`No model matches "${routed.effect.query ?? ""}". /models <search> lists what there is.`], suggest: ["/models claude", "/models free"] }); return; }
          if (hits.length > 1 && hits[0].id.toLowerCase() !== (routed.effect.query ?? "").trim().toLowerCase()) {
            json(res, 200, { ok: true, effect: "model", lines: ["Which one?", ...hits.map((m) => modelLine(m))], suggest: hits.slice(0, 4).map((m) => `/model ${m.id}`) });
            return;
          }
          const pick = hits[0];
          updateSettings(address as string, { model: pick.id });
          void refreshModel(address as string).catch((e) => console.error(`[my-agent] model for ${address}: ${e instanceof Error ? e.message : String(e)}`));
          json(res, 200, { ok: true, effect: "model", lines: [`Your agent now runs on ${pick.id} (${priceOf(pick.id)}).`, pick.free ? "Turns on it cost nothing." : "Each turn costs from your credits at that price."], suggest: ["/credits", "/whoami"] });
          return;
        }
        case "credits": {
          // Credits: the balance, or one payment to sign. Buying is on when the operator named a treasury.
          const a = address as string;
          const rows = readCredits();
          if (routed.effect.action === "show") {
            const sum = creditsSummary(a, rows);
            const tokens = payTokens();
            const stocks = tokens.filter((t) => t.group === "stock").map((t) => t.symbol);
            const lines = [`Credits: ${fmtCredits(toCredits(sum.balance))}${sum.turns ? ` (${fmtCredits(toCredits(sum.spent))} spent over ${sum.turns} turn${sum.turns === 1 ? "" : "s"})` : ""}. A thousand credits are $10 of USDG.`, `Your agent runs on ${modelFor(a)}; each turn costs from this at the model's price, free models nothing.`];
            if (creditsOn()) lines.push("", "Add credits by sending ETH, USDG, AOBS or a tokenized stock to the treasury, in one signed transaction:", "  /credits buy 10 USDG   or   /credits buy 0.005 ETH   or   /credits buy 1000 AOBS", `  Stocks: ${stocks.join(", ")}. Paying in AOBS earns a little extra.`);
            else lines.push("", "Buying credits isn't switched on here yet.");
            json(res, 200, { ok: true, effect: "credits", lines, balance: toCredits(sum.balance), suggest: creditsOn() ? ["/credits buy 10 USDG", "/credits buy 0.005 ETH", "/model"] : ["/model"] });
            return;
          }
          const tok = resolvePayToken(routed.effect.token ?? "");
          if (!tok) { json(res, 200, { ok: false, effect: "none", lines: [`"${routed.effect.token ?? ""}" isn't something you can pay with here. ETH, USDG, AOBS, or a tokenized stock: ${payTokens().filter((t) => t.group === "stock").map((t) => t.symbol).join(", ")}.`], suggest: ["/credits"] }); return; }
          const pay = await paymentTx(tok, routed.effect.amount ?? 0);
          if ("error" in pay) { json(res, 200, { ok: false, effect: "none", lines: [pay.error], suggest: ["/credits"] }); return; }
          json(res, 200, { ok: true, effect: "pay", pay, lines: [`${pay.amount} ${pay.token} is about ${fmtCredits(pay.credits)} credits${pay.bonusPct ? ` (+${pay.bonusPct}% for paying in ${pay.token})` : ""}, at prices right now. Sign it in your wallet.`] });
          return;
        }
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
        case "desk": {
          // Signed in, /status is the person's own agent, with the house desk in one line under it; /desk is the desk.
          if (address && routed.effect.command === "status" && !routed.effect.house) {
            const a = address as string;
            const state = followState(readFollow(), a);
            const p = await pnlPayload(1, now, false);
            const prices = pricesNow(p, now);
            const book = state.mode === "live"
              ? liveBook(a, state, readFollowTrades(), readFollowNotes(), prices, await agentBalanceEth(a).catch(() => null))
              : followBook(deskFromDisk().book.trades, state, prices);
            const desk = await deskLines("status", undefined, now);
            const holding = desk.find((l) => l.startsWith("holding ")) ?? "";
            json(res, 200, { ok: true, effect: "follow", lines: [...followLines(book, now), "", `Agent OBS, the desk it follows: ${holding || "no read right now"}. /desk shows the whole desk.`], suggest: state.on ? ["/agent", "/desk", "/stop"] : ["/start", "/desk", "/wallet"] });
            return;
          }
          json(res, 200, { ok: true, lines: await deskLines(routed.effect.command, routed.effect.n, now), effect: "desk", ...(address ? {} : routed.effect.command === "status" ? { suggest: ["/connect", "/explore"] } : {}) });
          return;
        }
        case "agentWallet": {
          // The agent's own wallet: made from the seed and the person's address, funded by them, emptied back to them only.
          const a = address as string;
          if (!walletsOn()) { json(res, 200, { ok: false, effect: "none", lines: ["Agent wallets aren't switched on here yet."], suggest: ["/agent", "/help"] }); return; }
          // A wallet the desk remembers that today's seed does not derive is the console's line and a page to the
          // operator, for /wallet, /fund and /withdraw alike; never a fresh, empty address in its place (2026-09-08).
          let wallet: `0x${string}`;
          try { wallet = agentWalletAddress(a); } catch (e) {
            if (!(e instanceof WalletDerivationError)) throw e;
            json(res, 200, { ok: false, effect: "none", lines: [e.message], suggest: ["/agent", "/help"] });
            return;
          }
          rememberWallet(a, wallet, undefined, now);
          const act = routed.effect.action;
          if (act === "fund") {
            const pay = fundTx(wallet, routed.effect.amount ?? 0);
            if ("error" in pay) { json(res, 200, { ok: false, effect: "none", lines: [pay.error], suggest: ["/fund 0.05 ETH", "/wallet"] }); return; }
            json(res, 200, { ok: true, effect: "pay", pay, lines: [`${pay.amount} ETH to your agent's wallet ${wallet}. Sign it in your wallet.`], suggest: ["/wallet"] });
            return;
          }
          if (act === "withdrawToken") {
            // A token the agent holds, sent to the person's wallet whole; the destination is the signed-in wallet by construction.
            const r = await withdrawToken(a, routed.effect.symbol ?? "", now);
            if (!r.ok) { json(res, 200, { ok: false, effect: "none", lines: [r.reason], suggest: ["/agent", "/wallet"] }); return; }
            void refreshPersona(a);
            json(res, 200, { ok: true, effect: "agentWallet", lines: [`Sent ${qty(r.amount)} ${r.symbol} to your wallet, all of it. ${r.explorerUrl}`], suggest: ["/wallet", "/agent"] });
            return;
          }
          if (act === "sell") {
            // A token the agent holds, sold whole for ETH through the desk's lane on the person's word; the row lands in the agent's own ledger.
            const r = await sellToken(a, routed.effect.symbol ?? "", now);
            if (!r.ok) { json(res, 200, { ok: false, effect: "none", lines: [r.reason], suggest: ["/agent", "/wallet", "/fund 0.005 ETH"] }); return; }
            const t = r.trade;
            void refreshPersona(a);
            const got = `${t.to.amount.toFixed(5)} ETH${t.to.usd != null ? ` ($${t.to.usd.toFixed(2)})` : ""}`;
            json(res, 200, { ok: true, effect: "agentWallet", lines: [`Sold ${qty(t.from.amount)} ${t.from.asset} for ${got}, ${t.status === "settled" ? "landed" : "sent, waiting for the chain"}.${t.explorerUrl ? ` ${t.explorerUrl}` : ""}`], suggest: ["/agent", "/wallet", "/withdraw all"] });
            return;
          }
          if (act === "withdraw") {
            // While the agent holds a token live, "all" leaves the gas reserve behind so the desk can still sell it.
            const holdsLive = Object.values(liveHoldings(readFollowTrades(), a)).some((q) => q > 0);
            const r = await withdrawEth(a, routed.effect.all ? "all" : (routed.effect.amount ?? 0), now, holdsLive ? railsFromEnv().gasReserveEth : 0);
            if (!r.ok) { json(res, 200, { ok: false, effect: "none", lines: [r.reason], suggest: ["/wallet", "/withdraw all"] }); return; }
            const left = await agentBalanceEth(a).catch(() => null);
            void refreshPersona(a);
            json(res, 200, { ok: true, effect: "agentWallet", lines: [`Sent ${r.amount.toFixed(5)} ETH back to your wallet. ${r.explorerUrl}`, ...(left != null ? [`Your agent's wallet holds ${left.toFixed(5)} ETH now.`] : [])], suggest: ["/wallet", "/agent"] });
            return;
          }
          const [bal, px] = await Promise.all([agentBalanceEth(a).catch(() => null), cachedPrices(["ETH"]).then((p) => p.ETH ?? null).catch(() => null)]);
          const lines = bal == null ? [`Your agent's wallet: ${wallet}`, "  its balance could not be read right now; try again in a moment."] : walletLines(wallet, bal, px, walletBook(a, readAgentCapital()));
          json(res, 200, { ok: true, effect: "agentWallet", lines, wallet, suggest: ["/fund 0.05 ETH", "/withdraw all", "/agent"] });
          return;
        }
        case "follow": {
          // The wallet's own trading agent: it follows the desk at the wallet's size, live from its own wallet once
          // funded, on paper until then. One row per command; the book is the desk's own accounting on the agent's
          // trades, marked at the desk's prices.
          const a = address as string;
          const deskMax = followMaxUsd(railsFromEnv().maxSwapUsd);
          let state = followState(readFollow(), a);
          const act = routed.effect.action;
          const wasOn = state.on;
          let startedLive = false;
          // Why a start that did not ask for paper landed on paper, in the same words the live check gave.
          let paperWhy = "";
          if (act === "start" || act === "size") {
            const size = routed.effect.sizeUsd != null ? checkSize(routed.effect.sizeUsd, deskMax) : { sizeUsd: state.sizeUsd };
            if ("error" in size) { json(res, 200, { ok: false, lines: [size.error], effect: "follow", suggest: ["/agent"] }); return; }
            let mode: FollowMode | undefined;
            if (act === "start") {
              // Live when the agent's own wallet can cover a trade and the person did not say paper; paper otherwise.
              // Asked for live without the ETH for it, the answer says what to fund rather than starting anything.
              const forced = routed.effect.mode;
              mode = "paper";
              if (forced !== "paper" && walletsOn() && liveOn()) {
                // A wallet today's seed does not derive is no wallet to start from. Without this the balance read
                // fell to 0 and the start went to paper on "holds 0 ETH, /fund it first", sending the person to fund
                // a wallet that is not theirs, or live on a ledger holding the mirror could not sell (2026-09-08).
                try { agentWalletAddress(a); } catch (e) {
                  if (!(e instanceof WalletDerivationError)) throw e;
                  json(res, 200, { ok: false, effect: "follow", lines: [e.message], suggest: ["/agent", "/wallet", "/start paper"] });
                  return;
                }
                const bal = await agentBalanceEth(a).catch(() => 0);
                const px = (await cachedPrices(["ETH"]).catch(() => ({} as Record<string, number | null>))).ETH ?? latestEthUsd(now);
                // The same bar the mirror holds an entry to, and an agent holding live tokens stays live regardless.
                const holdsLive = Object.values(liveHoldings(readFollowTrades(), a)).some((q) => q > 0);
                const can = canStartLive(size.sizeUsd, px ?? null, bal, railsFromEnv().gasReserveEth, holdsLive);
                if (can.ok) mode = "live";
                else if (forced === "live") { json(res, 200, { ok: false, effect: "follow", lines: [can.reason], suggest: ["/wallet", "/fund 0.05 ETH", "/start paper"] }); return; }
                else paperWhy = can.reason;
              } else if (forced === "live") { json(res, 200, { ok: false, effect: "follow", lines: ["Live trading isn't switched on here yet; /start paper runs it on paper."], suggest: ["/start paper", "/wallet"] }); return; }
              else if (forced !== "paper") paperWhy = "Live trading isn't switched on here yet.";
              startedLive = mode === "live";
            }
            state = recordFollow(a, act, size.sizeUsd, now, mode);
          } else if (act === "stop") {
            if (!wasOn) { json(res, 200, { ok: true, lines: ["Your agent is already off."], effect: "follow", suggest: ["/start", "/agent"] }); return; }
            state = recordFollow(a, "stop", undefined, now);
          }
          const p = await pnlPayload(1, now, false);
          const prices = pricesNow(p, now);
          const book = state.mode === "live"
            ? liveBook(a, state, readFollowTrades(), readFollowNotes(), prices, await agentBalanceEth(a).catch(() => null))
            : followBook(deskFromDisk().book.trades, state, prices);
          const lines = followLines(book, now);
          if (act === "start") lines.unshift(startedLive ? `Your agent is on, LIVE. It trades real ETH from its own wallet at $${state.sizeUsd} a trade, following Agent OBS.` : wasOn && state.mode === "paper" ? `Your agent was already on; $${state.sizeUsd} a trade from here.` : (paperWhy ? `Your agent is on, on paper: ${paperWhy}` : "Your agent is on, on paper. Fund its wallet and /start again to trade live."));
          if (act === "size") lines.unshift(`$${state.sizeUsd} a trade from here.`);
          // The agent's own instruction carries its standing: refreshed now that it changed.
          if (act !== "show") void refreshPersona(a);
          json(res, 200, { ok: true, effect: "follow", lines, follow: { on: state.on, sizeUsd: state.sizeUsd, mode: state.mode, since: state.since }, suggest: state.on ? ["/agent", "/status", "/stop"] : ["/start", "/status"] });
          return;
        }
        case "read":
          if (routed.effect.what === "whoami") { json(res, 200, { ok: true, lines: describeSettings(before), effect: "read" }); return; }
          json(res, 200, { ok: true, lines: swapsLines(standing), effect: "read", standing, ...(standing.swaps ? {} : { suggest: ["/quote 0.05 ETH USDG", "/swap 0.05 ETH USDG"] }) });
          return;
        case "settings": {
          const cleaned = sanitizeSettings(routed.effect.patch);
          if ("error" in cleaned) { json(res, 200, { ok: false, lines: [cleaned.error], effect: "settings" }); return; }
          const settings = updateSettings(address as string, cleaned.settings);
          void refreshPersona(address as string);
          // A model in the patch (a reset to the default included) reaches the gateway now, not at the next ensure.
          if ("model" in cleaned.settings) void refreshModel(address as string).catch((e) => console.error(`[my-agent] model for ${address}: ${e instanceof Error ? e.message : String(e)}`));
          // /reset chat: the agent moves to a fresh conversation on the gateway; what was taught stays.
          if ("chatGen" in cleaned.settings) { json(res, 200, { ok: true, lines: ["Fresh start: your agent's memory of this conversation is cleared. Its name, style, voice, goal, model and trading stay as they are."], effect: "settings", settings, suggest: ["/whoami", "/agent"] }); return; }
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
    // The door first (holders only), then the agent. One chain, one answer.
    holderGate(address, now)
      .then(async (gate) => {
        if (!gate.ok) { json(res, 403, { ok: false, code: "not_holder", error: gate.reason, obs: gate.obs, aobs: gate.aobs }); return; }
        const r = await ensureUserAgent(address);
        grantFree(address);
        if (appsOn()) void ensureApps(address).catch((e) => console.error(`[apps] attach for ${address}: ${e instanceof Error ? e.message : String(e)}`));
        // The agent's own wallet rides along so the page knows it from sign-in: a /fund may go there and nowhere else (2026-09-08).
        json(res, 200, { ok: true, ...r, name: agentDisplayName(address), settings: getSettings(address), wallet: walletsOn() ? agentWalletAddress(address) : null });
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
    readBody(req, 4096).then(async (text) => {
      let b: unknown = {};
      try { b = JSON.parse(text); } catch { /* empty body */ }
      const cleaned = sanitizeSettings(b);
      if ("error" in cleaned) { json(res, 400, { ok: false, error: cleaned.error }); return; }
      // A model set here is held to the catalog the same way /model is: an id the catalog does not list was
      // accepted on shape alone and then charged nothing per turn (2026-09-08).
      if (cleaned.settings.model) {
        const cat = await catalog();
        if (!cat.some((m) => m.id === cleaned.settings.model)) { json(res, 400, { ok: false, error: `no model called ${cleaned.settings.model} in the catalog; /models <search> lists what there is` }); return; }
      }
      const settings = updateSettings(address, cleaned.settings);
      void refreshPersona(address);
      if ("model" in cleaned.settings) void refreshModel(address).catch((e) => console.error(`[my-agent] model for ${address}: ${e instanceof Error ? e.message : String(e)}`));
      json(res, 200, { ok: true, settings, name: agentDisplayName(address) });
    }).catch((err) => json(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" }));
    return;
  }
  if (path === "/api/obs/credits") {
    // The wallet's credits: balance, what it spent, the model it runs on.
    res.setHeader("Cache-Control", "no-store");
    const address = requireWallet(req, res);
    if (!address) return;
    const sum = creditsSummary(address, readCredits());
    json(res, 200, { ok: true, balance: toCredits(sum.balance), granted: toCredits(sum.granted), deposited: toCredits(sum.deposited), spent: toCredits(sum.spent), turns: sum.turns, creditsPerUsd: CREDITS_PER_USD, model: modelFor(address), canBuy: creditsOn() });
    return;
  }
  if (path === "/api/obs/credits/verify") {
    // A payment the wallet sent: read off the chain, priced at the pools, credited once.
    res.setHeader("Cache-Control", "no-store");
    const address = requireWallet(req, res);
    if (!address) return;
    readBody(req, 4096).then(async (text) => {
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(text) as Record<string, unknown>; } catch { /* empty body */ }
      const r = await verifyPayment(String(b.txHash ?? ""), address, now);
      if (!r.ok) { json(res, 409, { ok: false, reason: r.reason }); return; }
      json(res, 200, { ok: true, already: r.already, credits: toCredits(r.row.usd), usd: r.row.usd, token: r.row.token, amount: r.row.amount, balance: toCredits(balanceUsd(address, readCredits())) });
    }).catch((err) => json(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" }));
    return;
  }
  if (path === "/api/obs/my-agent/events") {
    // The agent's own account of what it did since a moment, for the console to print as it happens.
    res.setHeader("Cache-Control", "no-store");
    const address = requireWallet(req, res);
    if (!address) return;
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    const state = followState(readFollow(), address);
    const desk = deskFromDisk().book.trades;
    const byId = new Map(latestTrades(desk).map((t) => [t.id, t] as const));
    const trades = state.mode === "live" ? liveTrades(readFollowTrades(), address) : mirrorTrades(desk, state);
    const events = followEvents(state, trades, state.mode === "live" ? readFollowNotes().filter((n) => n.address === address.toLowerCase()) : [], (id) => byId.get(id), readEntries(), since);
    json(res, 200, { ok: true, events: events.slice(-20), on: state.on, mode: state.mode, at: now });
    return;
  }
  if (path === "/api/obs/my-agent/wallet/verify") {
    // A funding the person sent to their agent's wallet: read off the chain, recorded once.
    res.setHeader("Cache-Control", "no-store");
    const address = requireWallet(req, res);
    if (!address) return;
    readBody(req, 4096).then(async (text) => {
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(text) as Record<string, unknown>; } catch { /* empty body */ }
      const r = await verifyFunding(String(b.txHash ?? ""), address, now);
      if (!r.ok) { json(res, 409, { ok: false, reason: r.reason }); return; }
      const balance = await agentBalanceEth(address).catch(() => null);
      void refreshPersona(address);
      json(res, 200, { ok: true, already: r.already, amount: r.row.amount, usd: r.row.usd, balance });
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
    // The slot goes back exactly once, and only when chatGuard held one. Until 2026-09-08 every refusal on the way
    // out gave a slot back, a body too large or an empty message included, which cleared another turn's in-flight
    // mark for this wallet and decremented the shared slot count for everyone.
    const turn: TurnState = { guarded: false, ended: false };
    const release = () => { if (shouldEndTurn(turn)) { turn.ended = true; endTurn(address); } };
    readBody(req, 4096).then(async (text) => {
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(text) as Record<string, unknown>; } catch { /* empty body */ }
      const msg = typeof b.text === "string" ? b.text.trim() : "";
      if (!msg) { json(res, 400, { ok: false, error: "empty message" }); return; }
      if (msg.length > 2000) { json(res, 400, { ok: false, error: "message too long (2000 characters at most)" }); return; }
      const gate = await holderGate(address, now);
      if (!gate.ok) { json(res, 403, { ok: false, code: "not_holder", error: gate.reason }); return; }
      const guard = chatGuard(address, now);
      if (guard) { json(res, guard.status, { ok: false, error: guard.error }); return; }
      turn.guarded = true;
      // The turn's price: the wallet's model at OpenRouter's rates plus the margin. Out of credits is a refusal only
      // where credits can be bought; without a treasury the desk meters and lets the turn through.
      let modelId = modelFor(address);
      // A model the catalog no longer lists (set before the catalog check, or dropped by OpenRouter since) is not
      // handed to the gateway to fail on: the wallet goes back to the default and hears so. A turn the catalog
      // cannot price at all is metered at the default model's known price, never at nothing (2026-09-08).
      let dropped: string | null = null;
      if (modelId !== DEFAULT_MODEL && !(await modelInfo(modelId))) {
        dropped = modelId;
        modelId = DEFAULT_MODEL;
        updateSettings(address, { model: "" });
        void refreshModel(address).catch((e) => console.error(`[my-agent] model for ${address}: ${e instanceof Error ? e.message : String(e)}`));
      }
      const model = (await modelInfo(modelId)) ?? DEFAULT_MODEL_INFO;
      const paid = !model.free;
      if (paid && creditsOn() && balanceUsd(address, readCredits()) <= 0) { release(); json(res, 402, { ok: false, error: "You're out of credits. /credits shows how to add some (a thousand credits are $10 of USDG), and /models free lists models that cost nothing." }); return; }
      // What came back, kept for the meter: the final text, the deltas joined, and how many events of any kind the
      // gateway sent, since a turn that stops early has no final and a turn nothing came back on owes nothing.
      let replyText = "";
      let streamed = "";
      let delivered = 0;
      let closed = false;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (dropped) send({ type: "note", text: `${dropped} is no longer offered; your agent is back on ${DEFAULT_MODEL}. /models <search> finds another.` });
      const ac = new AbortController();
      res.on("close", () => { closed = true; ac.abort(); });
      let idle: ReturnType<typeof setTimeout> | undefined;
      const arm = (ms = 60_000) => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), ms); };
      try {
        arm();
        const stream = await streamUserAgent(address, msg, ac.signal);
        for await (const ev of stream) {
          arm();
          delivered++;
          if (ev.type === "text_delta") { streamed += ev.text; send({ type: "delta", text: deEmDash(ev.text) }); }
          else if (ev.type === "text_final") { replyText = ev.text; send({ type: "final", text: deEmDash(ev.text) }); }
          else if (ev.type === "error") send({ type: "error", message: (ev as { message?: string }).message ?? "your agent could not respond" });
          else if (ev.type === "tool_call") send({ type: "tool", phase: "call", tool: ev.tool, toolCallId: ev.toolCallId, args: ev.args });
          else if (ev.type === "tool_result") send({ type: "tool", phase: "result", tool: ev.tool, toolCallId: ev.toolCallId, ok: !ev.isError });
          // A tool inside one of their apps waits for them: the page shows Allow and Deny, and the turn waits up to five minutes for the tap.
          else if (ev.type === "approval_requested") { arm(300_000); send({ type: "approval", requestId: ev.requestId, toolCallId: ev.toolCallId, tool: ev.resourceKey, args: ev.args }); }
          else if (ev.type === "approval_resolved") send({ type: "approval_resolved", toolCallId: ev.toolCallId, decision: ev.decision });
          else if (ev.type === "agent_end") break;
        }
      } catch (err) {
        console.error(`[my-agent] stream failed (aborted=${ac.signal.aborted}, closed=${closed}, delivered=${delivered}, streamed=${streamed.length} chars): ${err instanceof Error ? err.message : String(err)}`);
        if (!ac.signal.aborted) send({ type: "error", message: "your agent could not respond just now; try again shortly" });
      } finally {
        clearTimeout(idle);
        // Metered here, on what actually came back, whether the stream finished, failed, timed out or the socket
        // closed: until 2026-09-08 the charge ran only after a finished stream, so a client that hung up mid-reply
        // had the inference free. The gateway reports no token counts, so about four characters a token, plus a
        // context allowance. Nothing came back, nothing is owed.
        try {
          const metered = meteredReply({ delivered, final: replyText, streamed });
          if (metered !== null) {
            const tokensIn = estimateTokens(personaFor(address)) + estimateTokens(msg) + contextTokens();
            const tokensOut = estimateTokens(metered);
            const charged = turnCostUsd(model, tokensIn, tokensOut, marginPct());
            chargeTurn(address, charged, { model: modelId, tokensIn, tokensOut }, Date.now());
            if (!closed) send({ type: "done", charged: toCredits(charged), balance: toCredits(balanceUsd(address, readCredits())), model: modelId });
          }
        } catch (err) {
          // The ledger failed, not the stream: said in the log, and the slot still goes back below.
          console.error(`[my-agent] metering failed for ${address}: ${err instanceof Error ? err.message : String(err)}`);
        }
        res.end();
        release();
      }
    }).catch((err) => {
      release();
      // Once the stream headers are out a JSON error cannot follow them; the response just ends.
      if (res.headersSent) { res.end(); return; }
      json(res, 400, { ok: false, error: err instanceof Error ? err.message : "bad request" });
    });
    return;
  }
  if (path === "/api/obs/reads") {
    readsPayload()
      .then((p) => json(res, 200, p))
      .catch((err) => json(res, 502, { error: err instanceof Error ? err.message : "reads unavailable" }));
    return;
  }
  json(res, 404, { error: "not found", routes: ["/", "/api/obs/health", "/api/obs/dashboard?hours=168&trades=50&feed=30", "/api/obs/status", "/api/obs/thoughts?limit=20", "/api/obs/trades?limit=50", "/api/obs/pnl?hours=168", "/api/obs/feed?limit=30", "/api/obs/reads", "/api/obs/market?hours=168", "/api/obs/signals", "/api/obs/live", "/api/obs/stream?limit=12 (server-sent events)", "/api/obs/console/quote?from=ETH&to=USDG&amount=0.05&user=0x...", "/api/obs/console/swaps?address=0x...", "POST /api/obs/console/swap {address, txHash, from, to, amountIn}", "POST /api/obs/account/challenge {address}", "POST /api/obs/account/link {address, nonce, signature}", "POST /api/obs/console/cli {line} (bearer)", "POST /api/obs/my-agent/ensure (bearer)", "GET /api/obs/my-agent/history (bearer)", "GET|POST /api/obs/my-agent/settings (bearer)", "POST /api/obs/my-agent/stream {text} (bearer, server-sent events)"] });
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
  // The heartbeat check: the live watch writes its look every few seconds; once it has been quiet past the stale
  // bar while trading is on, that is raised as an alert from here, since a hung loop cannot raise its own. The
  // memory backup's marker is read on the same clock, trading on or off: a refused push was silent and permanent
  // (2026-09-08), and a shell script that has already exited cannot raise its own. The cooldown keeps a marker
  // that stays for hours to one message per cooldown.
  const checkHeartbeat = () => {
    const now = Date.now();
    const backup = backupVerdict(readBackupFailure(), now);
    if (backup) void raiseAlert("backup", backup, now);
    if (!railsFromEnv().tradingOn) return;
    const beat = livePayload() as { at?: number };
    const stale = staleVerdict(typeof beat.at === "number" ? beat.at : null, now, alertRulesFromEnv().staleMin);
    if (stale) void raiseAlert("stale", stale, now);
  };
  setInterval(checkHeartbeat, 60_000).unref();
  createServer(handle).listen(PORT, process.env.OBS_DASHBOARD_HOST || "127.0.0.1", () => {
    console.log(`[obs] dashboard API on http://localhost:${PORT} (page at /, JSON under /api/obs/*)`);
  });
}
