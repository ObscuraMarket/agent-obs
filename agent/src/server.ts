// The OBS dashboard API. Read-only JSON over plain node:http with CORS, so
// Obscura's team can render OBS inside their own app (Angular, anything)
// without running our code in their build. The standalone page in
// ../dashboard is served at / for previews and for iframing.
//
// Nothing private crosses this boundary: the copywriter's NOTEs never leave
// the journal, no key or token is read here, and the ledgers are shaped down
// to what a public timeline already shows. Run: npm run dashboard.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLedger } from "./ledger.ts";
import { liveReads, readsBlock, assetPrices, type Reads } from "./obscura/reads.ts";
import { readBook, latestTrades, snapshot, snapshotFromChain, series, type Trade, type BookSnapshot } from "./desk/book.ts";
import { readThoughts } from "./desk/thoughts.ts";
import { tradingArmed } from "./desk/rails.ts";
import { walletBalances } from "./obscura/reads.ts";
import { X_HANDLE, X_AGENT_ID, AGENT_ID, MAX_TWEET_CHARS, OBS_CONTRACT, SITE_URL, ROOT_DIR, WALLET_ADDRESS, EXPLORER_URL } from "./config.ts";
import { xLive, xConfigured } from "./social/xClient.ts";

const PORT = Number(process.env.OBS_DASHBOARD_PORT ?? 4671);
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
}
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const DASHBOARD = join(ROOT_DIR, "..", "dashboard", "index.html");

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
    json(res, 200, {
      ...buildStatus(readLedger<PostRow>("x-posts.jsonl"), readLedger<PostRow>("x-replies.jsonl"), readLedger("obs-decisions.jsonl"), { live: xLive(), configured: xConfigured(), now, desk: deskFromDisk().desk }),
      // The desk's own wallet is public on purpose: every balance and every settlement is checkable there.
      wallet: WALLET_ADDRESS ? { address: WALLET_ADDRESS, explorerUrl: `${EXPLORER_URL}/address/${WALLET_ADDRESS}` } : null,
    });
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
        json(res, 200, {
          snapshot: live,
          prices,
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
  json(res, 404, { error: "not found", routes: ["/", "/api/obs/health", "/api/obs/status", "/api/obs/thoughts?limit=20", "/api/obs/trades?limit=50", "/api/obs/pnl?hours=168", "/api/obs/feed?limit=30", "/api/obs/reads"] });
}

// Compare paths, not URL strings: a space in the checkout path is "%20" in
// import.meta.url and a literal space in argv, so the string form never matched.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  createServer(handle).listen(PORT, () => {
    console.log(`[obs] dashboard API on http://localhost:${PORT} (page at /, JSON under /api/obs/*)`);
  });
}
