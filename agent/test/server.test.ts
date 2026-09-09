import "./tmpdata.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { publicFeed, buildStatus, sseFrame, newerThan, railsSummary, RateLimiter, tapePrices, pnlFingerprint , publicNote, publicTrades} from "../src/server.ts";
import { originAllowed, isPrivatePeer, clientFrom, RATE_CLIENTS_MAX, TtlCache, attempt, dashboardQuery, handle, myAgentBookPayload, withinDeadline, WALLET_ETH_DEADLINE_MS } from "../src/server.ts";
import { publicAgentPayload, PUBLIC_AGENT_TRADES } from "../src/server.ts";
import { agentWalletAddressOrNull } from "../src/desk/agentWallet.ts";
import { getAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { railsFromEnv } from "../src/desk/rails.ts";
import { mintSession } from "../src/desk/accounts.ts";
import { followState, followBook, recordFollow } from "../src/desk/follow.ts";
import { signalRows, SIGNALS_LEDGER } from "../src/desk/signalLedger.ts";
import { appendLedger } from "../src/ledger.ts";
import type { Trade } from "../src/desk/book.ts";

const posts = [
  { at: 1, mode: "draft", posted: false, text: "first draft" },
  { at: 3, mode: "live", posted: true, id: "111", text: "went out" },
  { at: 4, mode: "live", posted: false, error: "403", text: "failed write, never content" },
  { at: 5, mode: "live", posted: false, deletedId: "111" },
];
const replies = [{ at: 2, mode: "draft", posted: false, inReplyToId: "9", text: "a reply draft" }];

test("the public feed is newest first and carries only what a timeline shows", () => {
  const feed = publicFeed(posts, replies, "ObscuraCEX");
  assert.deepEqual(feed.map((f) => f.at), [3, 2, 1]);
  assert.equal(feed[0].url, "https://x.com/ObscuraCEX/status/111");
  assert.equal(feed[1].kind, "reply");
  assert.equal(feed[1].inReplyToId, "9");
  assert.equal(feed[2].mode, "draft");
  for (const f of feed) assert.ok(!("note" in f) && !("error" in f), "no private or diagnostic fields leak");
});

test("the status card counts published versus drafts and reports the mode honestly", () => {
  const s = buildStatus(posts, replies, [{ decision: "post" }, { decision: "hold" }, { decision: "hold" }], { live: false, configured: false, now: 10 });
  assert.equal(s.agent.mode, "unconfigured");
  assert.equal(s.posts.published, 1);
  assert.equal(s.posts.drafts, 1);
  assert.equal(s.posts.lastAt, 4);
  assert.equal(s.replies.total, 1);
  assert.deepEqual(s.decisions, { post: 1, hold: 2 });
  assert.equal(buildStatus([], [], [], { live: true, configured: true, now: 10 }).agent.mode, "live");
  assert.equal(buildStatus([], [], [], { live: false, configured: true, now: 10 }).agent.mode, "draft");
});

test("the stream frames events the way EventSource reads them and only sends what is new", () => {
  assert.equal(sseFrame("thought", { at: 1, thoughts: ["a"] }), 'event: thought\ndata: {"at":1,"thoughts":["a"]}\n\n');
  const rows = [{ at: 5 }, { at: 1, updatedAt: 7 }, { at: 3 }];
  assert.deepEqual(newerThan(rows, 3), [{ at: 5 }, { at: 1, updatedAt: 7 }], "oldest first, the updated row counted by its update");
  assert.deepEqual(newerThan(rows, 7), []);
});

test("the rails summary puts each cap next to what is used, from the latest row per trade", () => {
  const now = Date.UTC(2026, 8, 1, 15, 0, 0);
  const trades = [
    { at: now - 3600e3, id: "a", status: "pending" as const, from: { asset: "ETH", amount: 0.01, usd: 24 }, to: { asset: "USDG", amount: 23.5, usd: 23.5 }, partner: "x" },
    { at: now - 3600e3, updatedAt: now - 1800e3, id: "a", status: "settled" as const, from: { asset: "ETH", amount: 0.01, usd: 24 }, to: { asset: "USDG", amount: 23.5, usd: 23.5 }, partner: "x" },
    { at: now - 600e3, id: "b", status: "pending" as const, from: { asset: "USDG", amount: 20, usd: 20 }, to: { asset: "NVDA", amount: 0.09, usd: 20 }, partner: "y" },
    { at: now - 600e3, id: "c", status: "proposed" as const, from: { asset: "USDG", amount: 20, usd: 20 }, to: { asset: "NVDA", amount: 0.09, usd: 20 }, partner: null },
  ];
  const r = railsSummary(railsFromEnv({ OBS_MAX_SWAP_USD: "25", OBS_MAX_OPEN_ORDERS: "1" }), trades, now);
  assert.equal(r.tradingOn, false);
  assert.deepEqual([r.maxSwapUsd, r.maxOpenOrders], [25, 1]);
  assert.equal(r.openOrders, 1, "one pending; the proposal is not an order");
  assert.ok(!("dailySwapUsd" in r) && !("entriesToday" in r) && !("maxEntriesPerDay" in r) && !("sentTodayUsd" in r), "nothing on the wire is counted by the day");
  assert.ok(r.allowedAssets.includes("USDG@robinhood"));
  assert.equal(r.allowedPartners, null);
});

test("the request budget is per client and slides", () => {
  const l = new RateLimiter(3, 1000);
  assert.deepEqual([l.allow("a", 0), l.allow("a", 100), l.allow("a", 200), l.allow("a", 300)], [true, true, true, false]);
  assert.equal(l.allow("b", 300), true, "another client has its own budget");
  assert.equal(l.allow("a", 1101), true, "the oldest hit slid out of the window");
});

test("the request budget forgets the client seen longest ago past its cap, and quiet clients on the sweep", () => {
  const small = new RateLimiter(1, 1000, 2);
  assert.deepEqual([small.allow("a", 0), small.allow("a", 1)], [true, false], "one a window");
  assert.equal(small.allow("b", 2), true);
  assert.equal(small.allow("a", 3), false, "a is still known, and still over");
  assert.equal(small.allow("c", 4), true, "a third client pushes out the one seen longest ago, which is b");
  assert.equal(small.clients, 2);
  assert.equal(small.allow("a", 5), false, "a was touched after b and is kept");
  assert.equal(small.allow("b", 6), true, "forgotten means a fresh budget, never a stuck refusal");
  assert.equal(small.allow("c", 7), true, "c went when b came back, and is fresh too");
  assert.equal(small.clients, 2);
  const l = new RateLimiter(5, 1000);
  l.allow("a", 0);
  l.allow("b", 500);
  assert.equal(l.sweep(1200), 1, "a's only hit is out of the window");
  assert.equal(l.clients, 1);
  assert.equal(l.sweep(1600), 1);
  assert.equal(l.clients, 0);
  assert.equal(new RateLimiter(1).allow("x", 0), true, "the default cap is generous");
  assert.equal(RATE_CLIENTS_MAX, 20_000);
});

test("a peer is private on loopback, the RFC 1918 ranges, the shared 100.64/10 range and fc00::/7, mapped IPv4 included, and nothing else", () => {
  // 100.64.0.2 is what Railway's edge presented on 2026-09-08; the range is the carrier-grade shared space cloud proxies sit in.
  for (const a of ["100.64.0.2", "::ffff:100.64.0.2", "100.127.255.255", "127.0.0.1", "127.255.255.255", "::1", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255", "fc00::1", "fd12:3456::1", "FD00::AB", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:192.168.1.9", "[::1]", "fd00::1%eth0", " 127.0.0.1 "]) {
    assert.equal(isPrivatePeer(a), true, `${a} is private`);
  }
  for (const a of ["8.8.8.8", "1.2.3.4", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "11.0.0.1", "128.0.0.1", "2001:db8::1", "fe80::1", "fb00::1", "fe00::1", "::ffff:8.8.8.8", "::", "999.1.1.1", "10.0.0", "not an address", "", null, undefined]) {
    assert.equal(isPrivatePeer(a), false, `${a} is not private`);
  }
  assert.equal(isPrivatePeer("8.8.8.8", { OBS_TRUSTED_PROXY: "any" } as NodeJS.ProcessEnv), true, "the operator may trust every peer for an edge the list does not know");
});

test("the forwarded address is the client only when the socket's peer is the edge", () => {
  assert.equal(clientFrom("10.0.0.5", { "x-forwarded-for": "203.0.113.7, 10.0.0.5" }), "203.0.113.7", "behind the edge, the first hop is the client");
  assert.equal(clientFrom("::ffff:127.0.0.1", { "cf-connecting-ip": "203.0.113.8" }), "203.0.113.8");
  assert.equal(clientFrom("fd12::1", { "x-forwarded-for": ["203.0.113.9", "1.1.1.1"] }), "203.0.113.9", "a repeated header reads its first value");
  assert.equal(clientFrom("10.0.0.5", {}), "10.0.0.5", "the edge with nothing forwarded is the client itself");
  assert.equal(clientFrom("10.0.0.5", { "x-forwarded-for": " , " }), "10.0.0.5", "an empty forward is no forward");
  assert.equal(clientFrom("198.51.100.4", { "x-forwarded-for": "203.0.113.7" }), "198.51.100.4", "from a public peer the header is whatever it typed and is ignored");
  assert.equal(clientFrom("198.51.100.4", { "cf-connecting-ip": "203.0.113.7" }), "198.51.100.4");
  assert.equal(clientFrom(undefined, { "x-forwarded-for": "203.0.113.7" }), "unknown", "no socket address, no trust");
  const rotated = new RateLimiter(2, 1000);
  const hits = ["a", "b", "c"].map((fake) => rotated.allow(clientFrom("198.51.100.4", { "x-forwarded-for": fake }), 0));
  assert.deepEqual(hits, [true, true, false], "rotating the header from a public peer spends one budget");
});

test("the origin allowlist matches exactly, or one wildcard subdomain label", () => {
  const list = ["https://obscura.market", "https://*.vercel.app", "http://localhost:4200"];
  assert.equal(originAllowed("https://obscura.market", list), true);
  assert.equal(originAllowed("https://www.obscura.market", list), false, "no wildcard on that entry");
  assert.equal(originAllowed("https://obscura-exchange-git-main-john.vercel.app", list), true);
  assert.equal(originAllowed("https://evil.com/?x=.vercel.app", list), false);
  assert.equal(originAllowed("https://a.b.vercel.app", list), false, "one label only");
  assert.equal(originAllowed("https://vercel.app", list), false, "the label must exist");
  assert.equal(originAllowed("", list), false);
  assert.equal(originAllowed("https://anything.example", ["*"]), true);
});

test("held launch tokens are priced from the live watch's tape between wallet reads, in dollars via the quote", () => {
  const now = 1_800_000_000_000;
  const live = { at: now - 3000, watching: [{ symbol: "NSDX", lastPrice: 0.0000268, quote: "ETH" }, { symbol: "WHLR", lastPrice: 0.0021, quote: "USDG" }, { symbol: "RWAPACT", lastPrice: 0.001, quote: "ETH" }] };
  const prices = { ETH: 2500, NSDX: 0.00005, WHLR: 0.0019 };
  const out = tapePrices(live, prices, ["ETH", "NSDX", "WHLR"], now);
  assert.ok(Math.abs((out.NSDX as number) - 0.067) < 1e-9, "quote per token times the quote's dollars");
  assert.equal(out.WHLR, 0.0021, "a USDG quote is dollars already");
  assert.equal(out.ETH, 2500, "ETH keeps the book's price");
  assert.equal(out.RWAPACT, undefined, "not held: not priced here");
  assert.deepEqual(tapePrices({ ...live, at: now - 60_000 }, prices, ["NSDX"], now), prices, "a stale live file changes nothing");
  assert.deepEqual(tapePrices(null, prices, ["NSDX"], now), prices);
});

test("the stream pushes the positions only when something moved", () => {
  const a = { snapshot: { equityUsd: 10153.191 }, positions: [{ asset: "NSDX", qty: 1_720_174, valueUsd: 103.004 }] };
  assert.equal(pnlFingerprint(a), pnlFingerprint({ snapshot: { equityUsd: 10153.194 }, positions: [{ asset: "NSDX", qty: 1_720_174, valueUsd: 103.001 }] }), "a change under a cent is no change");
  assert.notEqual(pnlFingerprint(a), pnlFingerprint({ ...a, positions: [{ asset: "NSDX", qty: 1_720_174, valueUsd: 104 }] }));
  assert.notEqual(pnlFingerprint(a), pnlFingerprint({ ...a, positions: [] }), "a position closed");
});

test("the page's one read is made once per query and shared for the TTL, remade after it, and a failed making is tried again", async () => {
  const c = new TtlCache<number>(5000);
  let made = 0;
  const make = () => Promise.resolve(++made);
  assert.equal(await c.get("a", make, 0), 1);
  assert.equal(await c.get("a", make, 4999), 1, "inside the TTL every caller shares the first making");
  assert.equal(made, 1);
  assert.equal(await c.get("b", make, 4999), 2, "another query is its own making");
  assert.equal(await c.get("a", make, 5000), 3, "past the TTL it is remade");
  await assert.rejects(c.get("c", () => Promise.reject(new Error("cold")), 6000));
  assert.equal(await c.get("c", make, 6001), 4, "a failure is not kept for five seconds");
  const slow = new TtlCache<string>(5000);
  let pending = 0;
  const share = () => { pending++; return new Promise<string>((r) => setTimeout(() => r("done"), 5)); };
  const [x, y] = await Promise.all([slow.get("k", share, 0), slow.get("k", share, 1)]);
  assert.deepEqual([x, y, pending], ["done", "done", 1], "two callers while one making is in flight share it");
});

test("a part of the one read that fails is null, never the whole read", async () => {
  assert.equal(await attempt(() => { throw new Error("ledger unreadable"); }), null);
  assert.equal(await attempt(() => Promise.reject(new Error("reads unavailable"))), null);
  assert.deepEqual(await attempt(() => ({ items: [], at: 1 })), { items: [], at: 1 });
  assert.equal(await attempt(async () => 2), 2);
});

test("the one read's query carries each route's own default and clamp, so equal asks share one entry", () => {
  assert.deepEqual(dashboardQuery(new URLSearchParams("")), { hours: 168, trades: 50, feed: 30 });
  assert.deepEqual(dashboardQuery(new URLSearchParams("hours=24&trades=30&feed=8")), { hours: 24, trades: 30, feed: 8 });
  assert.deepEqual(dashboardQuery(new URLSearchParams("hours=abc&trades=-1&feed=9999")), { hours: 168, trades: 50, feed: 200 }, "nonsense is the default, too much is the cap");
  assert.deepEqual(dashboardQuery(new URLSearchParams("hours=0&trades=0.5&feed=0")), { hours: 168, trades: 1, feed: 30 });
  assert.equal(dashboardQuery(new URLSearchParams("hours=999999")).hours, 24 * 365, "a year at most, the market route's own cap");
});

// ---- The wallet's own book: the signed read behind the Agent page's "Your agent" card. ----

/** The server on a free port for one test, its routes exactly as deployed; closed when the test is done. */
async function withServer(run: (api: string) => Promise<void>): Promise<void> {
  const server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
const read = async (api: string, path: string, token?: string): Promise<{ status: number; headers: Headers; j: Record<string, any> }> => {
  const r = await fetch(api + path, { headers: token ? { Authorization: "Bearer " + token } : {} });
  return { status: r.status, headers: r.headers, j: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const BOOK_KEYS = ["ok", "name", "on", "mode", "sizeUsd", "since", "wallet", "walletUrl", "walletEth", "ethUsd", "positions", "realizedUsd", "unrealizedUsd", "equityUsd", "trades", "tradeCount", "wins", "losses", "at"];

test("the book is behind the bearer: no bearer, no book, and nothing about any wallet in the answer", async () => {
  await withServer(async (api) => {
    const r = await read(api, "/api/obs/my-agent/book");
    assert.equal(r.status, 401);
    assert.deepEqual(r.j, { ok: false, error: "sign in with your wallet first" });
    assert.equal(r.headers.get("cache-control"), "no-store");
    const bad = await read(api, "/api/obs/my-agent/book", "not.a.bearer");
    assert.equal(bad.status, 401, "a forged bearer is no bearer");
  });
});

test("a paper agent's book has the owner's shape: its state, its empty book; wallets off: no address, no balance", async () => {
  const address = "0x1111111111111111111111111111111111111111";
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);
  recordFollow(address, "start", 25, now, "paper");
  await withServer(async (api) => {
    const r = await read(api, "/api/obs/my-agent/book", mintSession(address).token);
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual(Object.keys(r.j).sort(), [...BOOK_KEYS].sort(), "exactly the fields the card reads, nothing else");
    assert.equal(r.j.ok, true);
    assert.equal(typeof r.j.name, "string");
    assert.deepEqual([r.j.on, r.j.mode, r.j.sizeUsd, r.j.since], [true, "paper", 25, now]);
    assert.deepEqual([r.j.wallet, r.j.walletUrl, r.j.walletEth], [null, null, null], "wallets are off here (no seed): no address, so no balance and nothing to read");
    assert.deepEqual([r.j.positions, r.j.trades, r.j.tradeCount, r.j.wins, r.j.losses, r.j.realizedUsd], [[], [], 0, 0, 0, 0]);
    assert.equal(r.j.equityUsd, 0, "a paper book with nothing in it is worth nothing, and that is a number");
    assert.equal(r.j.unrealizedUsd, 0);
    assert.equal(typeof r.j.at, "number");
    const again = await read(api, "/api/obs/my-agent/book", mintSession(address).token);
    assert.equal(again.j.at, r.j.at, "the second read inside ten seconds is the cached one");
    const other = await read(api, "/api/obs/my-agent/book", mintSession("0x2222222222222222222222222222222222222222").token);
    assert.equal(other.status, 200);
    assert.deepEqual([other.j.on, other.j.since, other.j.sizeUsd], [false, null, 100], "another wallet reads its own book, never this one's");
  });
});

test("a wallet whose door has closed still reads its own book, and nothing else behind the door", async () => {
  const address = "0x3333333333333333333333333333333333333333";
  const gate = process.env.OBS_CONSOLE_GATE;
  // List-only with an empty list: the door is closed to every wallet, decided at once, no chain read.
  process.env.OBS_CONSOLE_GATE = "allowlist";
  try {
    await withServer(async (api) => {
      const token = mintSession(address).token;
      const events = await read(api, "/api/obs/my-agent/events?since=0", token);
      assert.equal(events.status, 403, "the door is closed: the other signed routes refuse");
      assert.equal(events.j.code, "not_holder");
      const book = await read(api, "/api/obs/my-agent/book", token);
      assert.equal(book.status, 200, JSON.stringify(book.j));
      assert.equal(book.j.ok, true, "the book is the wallet's own money, kept the way /agent and /wallet are kept in the console");
      assert.deepEqual([book.j.on, book.j.since], [false, null]);
      const none = await read(api, "/api/obs/my-agent/book");
      assert.equal(none.status, 401, "a closed door does not open the book to a request with no bearer");
    });
  } finally {
    process.env.OBS_CONSOLE_GATE = gate;
  }
});

test("the owner's payload: positions with their cost and result, the last twenty trades newest last, exits with their result, equity from the wallet", () => {
  const t0 = Date.UTC(2026, 8, 8, 9, 0, 0);
  const buy = (id: string, at: number, usd: number, amount: number): Trade => ({ at, id, status: "settled", from: { asset: "ETH", amount: usd / 2500, usd }, to: { asset: "NSDX", amount, usd }, partner: null, settlementTx: `0x${id}` });
  const sell = (id: string, at: number, amount: number, usd: number): Trade => ({ at, id, status: "settled", exit: true, from: { asset: "NSDX", amount, usd }, to: { asset: "ETH", amount: usd / 2500, usd }, partner: null, explorerUrl: `https://x/tx/${id}` });
  const desk: Trade[] = [];
  for (let i = 0; i < 12; i++) {
    desk.push(buy(`b${i}`, t0 + i * 600e3, 100, 1000));
    desk.push(sell(`s${i}`, t0 + i * 600e3 + 300e3, 1000, i % 3 === 0 ? 90 : 110));
  }
  desk.push(buy("open", t0 + 13 * 600e3, 100, 1000));
  const state = followState([{ address: "0xabc", at: t0 - 1, action: "start", sizeUsd: 50, mode: "paper" }], "0xabc");
  const book = followBook(desk, state, { NSDX: 0.12, ETH: 2500 });
  const p = myAgentBookPayload("Sable", book, "0x9999999999999999999999999999999999999999", 0.02, 2500, t0 + 14 * 600e3);
  assert.equal(p.name, "Sable");
  assert.equal(p.walletUrl, "https://robinhoodchain.blockscout.com/address/0x9999999999999999999999999999999999999999");
  assert.equal(p.tradeCount, 25, "every mirrored trade is counted");
  assert.equal(p.trades.length, 20, "the last twenty ride along");
  assert.ok(p.trades.every((t, i) => i === 0 || t.at >= p.trades[i - 1].at), "newest last");
  assert.equal(p.trades[p.trades.length - 1].kind, "entry");
  assert.equal(p.trades[p.trades.length - 1].txUrl, "https://robinhoodchain.blockscout.com/tx/0xopen", "a hash without a page becomes the explorer's page");
  const exit = p.trades[p.trades.length - 2];
  assert.deepEqual([exit.kind, exit.asset, exit.txUrl], ["exit", "NSDX", "https://x/tx/s11"]);
  assert.ok(exit.pnlUsd != null && exit.pnlUsd > 0, "an exit carries its realized result");
  assert.equal(p.trades[p.trades.length - 1].pnlUsd, null, "an entry has none");
  assert.deepEqual([p.wins, p.losses], [8, 4]);
  assert.equal(p.positions.length, 1);
  assert.deepEqual(Object.keys(p.positions[0]), ["asset", "qty", "priceUsd", "valueUsd", "avgCostUsd", "unrealizedUsd", "unrealizedPct"]);
  assert.ok(Math.abs((p.positions[0].valueUsd as number) - 60) < 1e-6, "500 NSDX at $0.12: the $50 entry marked at $60");
  assert.ok(Math.abs((p.unrealizedUsd as number) - 10) < 1e-6);
  assert.ok(Math.abs((p.equityUsd as number) - 60) < 1e-6, "paper: what the paper positions are worth, the wallet is not in play");
  const live = myAgentBookPayload("Sable", { ...book, state: { ...state, mode: "live" } }, "0x9999999999999999999999999999999999999999", 0.02, 2500, t0);
  assert.ok(Math.abs((live.equityUsd as number) - 110) < 1e-6, "live: the wallet's ETH in dollars plus the positions");
  assert.equal(myAgentBookPayload("Sable", { ...book, state: { ...state, mode: "live" } }, null, null, 2500, t0).equityUsd, null, "a wallet that could not be read is no equity figure");
  const unpriced = myAgentBookPayload("Sable", followBook(desk, state, { ETH: 2500 }), null, null, 2500, t0);
  assert.deepEqual([unpriced.unrealizedUsd, unpriced.equityUsd], [null, null], "an unpriced position is not summed as zero");
});

test("the wallet's chain read is held to a deadline: a read that never answers is null in time, a quick one is its value", async () => {
  const t0 = Date.now();
  const never = await withinDeadline(() => new Promise<number>(() => { /* a stalled RPC: no answer, ever */ }), 50);
  assert.equal(never, null, "late is null, never a hang");
  assert.ok(Date.now() - t0 < 1_000, "answered on the deadline, not on viem's retries");
  assert.equal(await withinDeadline(() => Promise.resolve(0.25), 50), 0.25);
  assert.equal(await withinDeadline(() => Promise.reject(new Error("rpc down")), 50), null, "a failed read is null, not a throw");
  assert.ok(WALLET_ETH_DEADLINE_MS <= 5_000, "the book must answer well inside the page's own patience");
  // The book with the late read: its shape is whole, the wallet leg alone is null, and a live equity stays null.
  const state = followState([{ address: "0xabc", at: t0 - 1, action: "start", sizeUsd: 50, mode: "live" }], "0xabc");
  const book = followBook([], state, { ETH: 2500 });
  const p = myAgentBookPayload("Sable", book, "0x9999999999999999999999999999999999999999", never, 2500, t0);
  assert.deepEqual([p.wallet, p.walletEth, p.equityUsd], ["0x9999999999999999999999999999999999999999", null, null]);
});

test("the last trades are ordered by the stamp they show: a settled exit stamped after a later entry comes after it", () => {
  const t0 = Date.UTC(2026, 8, 8, 9, 0, 0);
  const desk: Trade[] = [
    { at: t0, id: "b0", status: "settled", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "NSDX", amount: 1000, usd: 100 }, partner: null },
    // Placed at 09:10, settled at 09:30: after the entry at 09:20 by the time the card shows.
    { at: t0 + 600e3, updatedAt: t0 + 1800e3, id: "s0", status: "settled", exit: true, from: { asset: "NSDX", amount: 1000, usd: 110 }, to: { asset: "ETH", amount: 0.044, usd: 110 }, partner: null },
    { at: t0 + 1200e3, id: "b1", status: "settled", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "NSDX", amount: 1000, usd: 100 }, partner: null },
  ];
  const state = followState([{ address: "0xabc", at: t0 - 1, action: "start", sizeUsd: 50, mode: "paper" }], "0xabc");
  const p = myAgentBookPayload("Sable", followBook(desk, state, { NSDX: 0.1, ETH: 2500 }), null, null, 2500, t0 + 3600e3);
  assert.deepEqual(p.trades.map((t) => [t.kind, t.at]), [["entry", t0], ["entry", t0 + 1200e3], ["exit", t0 + 1800e3]], "newest last by the shown stamp");
  assert.ok(p.trades.every((t, i) => i === 0 || t.at >= p.trades[i - 1].at));
});

// ---- One agent in public, by its own wallet: the read behind the Agents table's rows. ----

/** The rows the desk's own fixture makes: `n` round trips, the third of them losing, and one entry still open. */
function roundTrips(n: number, t0: number): Trade[] {
  const buy = (id: string, at: number, usd: number, amount: number): Trade => ({ at, id, status: "settled", from: { asset: "ETH", amount: usd / 2500, usd }, to: { asset: "NSDX", amount, usd }, partner: null, settlementTx: `0x${id}` });
  const sell = (id: string, at: number, amount: number, usd: number): Trade => ({ at, id, status: "settled", exit: true, from: { asset: "NSDX", amount, usd }, to: { asset: "ETH", amount: usd / 2500, usd }, partner: null, explorerUrl: `https://x/tx/${id}` });
  const desk: Trade[] = [];
  for (let i = 0; i < n; i++) {
    desk.push(buy(`b${i}`, t0 + i * 600e3, 100, 1000));
    desk.push(sell(`s${i}`, t0 + i * 600e3 + 300e3, 1000, i % 3 === 0 ? 90 : 110));
  }
  desk.push(buy("open", t0 + (n + 1) * 600e3, 100, 1000));
  return desk;
}

test("the public payload is the owner's book with the last fifty trades and the realized series, cumulative by exit time", () => {
  const t0 = Date.UTC(2026, 8, 8, 9, 0, 0);
  const now = t0 + 40 * 600e3;
  const desk = roundTrips(30, t0);
  const state = followState([{ address: "0xabc", at: t0 - 1, action: "start", sizeUsd: 50, mode: "paper" }], "0xabc");
  const book = followBook(desk, state, { NSDX: 0.12, ETH: 2500 });
  const wallet = "0x9999999999999999999999999999999999999999";
  const p = publicAgentPayload("Sable", book, wallet, 0.02, 2500, now);
  const { series, ...rest } = p;
  assert.deepEqual(rest, myAgentBookPayload("Sable", book, wallet, 0.02, 2500, now, PUBLIC_AGENT_TRADES), "the numbers the owner reads, from the one arithmetic");
  assert.equal(PUBLIC_AGENT_TRADES, 50);
  assert.deepEqual([p.trades.length, p.tradeCount, p.wins, p.losses], [50, 61, 20, 10], "the last fifty ride along, every trade is counted");
  assert.deepEqual([p.wallet, p.walletUrl], [wallet, `https://robinhoodchain.blockscout.com/address/${wallet}`]);
  assert.equal(series.length, 30, "one point per exit");
  assert.ok(series.every((s, i) => i === 0 || s.at >= series[i - 1].at), "in exit order");
  // At half the desk's size each exit is five dollars either way: the running sum is the line the sparkline draws.
  let sum = 0;
  series.forEach((s, i) => { sum += i % 3 === 0 ? -5 : 5; assert.ok(Math.abs(s.usd - sum) < 1e-9, `point ${i} is the sum so far`); });
  assert.ok(Math.abs(series[series.length - 1].usd - Math.round(p.realizedUsd * 100) / 100) < 1e-9, "the last point is the realized total");
  assert.deepEqual(publicAgentPayload("Sable", followBook([], state, { ETH: 2500 }), wallet, null, 2500, now).series, [], "no exit, no series");
});

test("a public agent is asked for by a wallet address and nothing else: anything else is refused before any lookup", async () => {
  await withServer(async (api) => {
    for (const bad of ["not-a-wallet", "0x123", "0x" + "g".repeat(40), "0x" + "1".repeat(39), "sable"]) {
      const r = await read(api, `/api/obs/agents/${bad}`);
      assert.equal(r.status, 400, bad);
      assert.equal(r.j.ok, false);
      assert.equal(typeof r.j.error, "string");
    }
  });
});

test("a wallet no agent owns is not found, with the reason, and never a book", async () => {
  await withServer(async (api) => {
    const r = await read(api, `/api/obs/agents/0x${"d".repeat(40)}`);
    assert.equal(r.status, 404);
    assert.deepEqual(r.j, { ok: false, error: "no agent with that wallet is following the desk" });
    assert.equal(r.headers.get("cache-control"), "public, max-age=10");
  });
});

test("anyone reads a paper agent's book by the agent's own wallet: the owner's shape with the series, cached ten seconds, case-insensitive, and never the person's wallet", async () => {
  const address = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const now = Date.UTC(2026, 8, 8, 13, 0, 0);
  recordFollow(address, "start", 40, now, "paper");
  const seed = process.env.OBS_AGENT_WALLET_SEED;
  // Wallets on for this test alone: the seed derives the agent's own wallet, the key the route is asked by. The
  // wallet's balance read goes to the closed port tmpdata.ts points the chain at, so it is null inside the deadline.
  process.env.OBS_AGENT_WALLET_SEED = "server-test-seed-0123456789abcdef0123456789abcdef";
  try {
    const wallet = agentWalletAddressOrNull(address);
    assert.ok(wallet, "the seed derives a wallet");
    assert.notEqual(wallet.toLowerCase(), address.toLowerCase(), "the agent's wallet is its own, never the person's");
    await withServer(async (api) => {
      const list = await read(api, "/api/obs/agents");
      assert.equal(list.status, 200);
      const row = (list.j.agents as Array<Record<string, unknown>>).find((a) => a.walletAddress === wallet);
      assert.ok(row, "the public list carries the agent's full wallet, the key its row opens on");
      assert.equal(row.wallet, `${wallet.slice(0, 6)}...${wallet.slice(-4)}`, "and still shows it short");
      const r = await fetch(`${api}/api/obs/agents/${wallet}`);
      const text = await r.text();
      const j = JSON.parse(text) as Record<string, any>;
      assert.equal(r.status, 200, text);
      assert.equal(r.headers.get("cache-control"), "public, max-age=10");
      assert.deepEqual(Object.keys(j).sort(), [...BOOK_KEYS, "series"].sort(), "the card's fields and the series, nothing else");
      assert.deepEqual([j.ok, j.wallet, j.walletUrl], [true, wallet, `https://robinhoodchain.blockscout.com/address/${wallet}`], "the agent's wallet in full");
      assert.equal(typeof j.name, "string");
      assert.deepEqual([j.on, j.mode, j.sizeUsd, j.since], [true, "paper", 40, now]);
      assert.deepEqual([j.positions, j.trades, j.series, j.tradeCount, j.wins, j.losses, j.realizedUsd, j.unrealizedUsd, j.equityUsd], [[], [], [], 0, 0, 0, 0, 0, 0]);
      assert.equal(j.walletEth, null, "the chain is a closed port here: the read is null inside the deadline and the book still answers");
      assert.equal(typeof j.at, "number");
      const hex = address.slice(2).toLowerCase();
      assert.ok(!text.includes(address.toLowerCase()), "the person's wallet, lowercase, is nowhere in the body");
      assert.ok(!text.includes(getAddress(address)), "nor checksummed");
      assert.ok(!text.toLowerCase().includes(hex), "nor in any case, with or without its 0x");
      const upper = await read(api, `/api/obs/agents/0x${wallet.slice(2).toUpperCase()}`);
      assert.equal(upper.status, 200, "the wallet is matched whatever its case");
      assert.equal(upper.j.at, j.at, "and inside ten seconds the read is the cached one");
    });
  } finally {
    process.env.OBS_AGENT_WALLET_SEED = seed;
  }
});

test("a hidden follower (OBS_AGENTS_HIDDEN) is off the public board and its public book is a 404, while the list still answers", async () => {
  const address = "0x1111111111111111111111111111111111111111";
  const now = Date.UTC(2026, 8, 8, 14, 0, 0);
  recordFollow(address, "start", 25, now, "paper");
  const seed = process.env.OBS_AGENT_WALLET_SEED;
  const hiddenBefore = process.env.OBS_AGENTS_HIDDEN;
  process.env.OBS_AGENT_WALLET_SEED = "server-test-seed-0123456789abcdef0123456789abcdef";
  try {
    const wallet = agentWalletAddressOrNull(address);
    assert.ok(wallet, "the seed derives a wallet");
    await withServer(async (api) => {
      const shown = await read(api, "/api/obs/agents");
      assert.ok((shown.j.agents as Array<Record<string, unknown>>).some((a) => a.walletAddress === wallet), "listed before it is hidden");
      process.env.OBS_AGENTS_HIDDEN = ` ${address.toUpperCase()} ,`;
      const list = await read(api, "/api/obs/agents");
      assert.equal(list.status, 200);
      assert.ok(!(list.j.agents as Array<Record<string, unknown>>).some((a) => a.walletAddress === wallet), "hidden from the public list, whatever the case of the address");
      const r = await read(api, `/api/obs/agents/${wallet}`);
      assert.equal(r.status, 404, "its public book is no agent at all");
      assert.deepEqual(r.j, { ok: false, error: "no agent with that wallet is following the desk" });
    });
  } finally {
    process.env.OBS_AGENT_WALLET_SEED = seed;
    if (hiddenBefore === undefined) delete process.env.OBS_AGENTS_HIDDEN; else process.env.OBS_AGENTS_HIDDEN = hiddenBefore;
  }
});

// ---- Signing out: the wallet's earlier bearers die on the desk, not only in one browser's storage. ----

const send = async (api: string, path: string, body: unknown, token?: string): Promise<{ status: number; j: Record<string, any> }> => {
  const r = await fetch(api + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, j: (await r.json().catch(() => ({}))) as Record<string, any> };
};

test("/signals answers the latest board to a signed wallet on the operator's list, 401 with no bearer, 403 off the list or behind a closed door, and the research route carries none of it", async () => {
  const at = Date.UTC(2026, 8, 8, 14, 30, 0);
  const rows = signalRows({
    at, cycleId: at,
    board: [{ symbol: "LENNY", lane: "launch", held: false, grade: { grade: "A", capUsd: 200, depthUsd: 900 }, entry: { ok: true, state: "base", why: "base, entry allowed" }, holders: { ok: true, why: "41 wallets", transfers: 120, wallets: 41, top1Pct: 8, top10Pct: 30 }, launch: { exists: true, unread: [], verdict: { ok: true, why: "score 72" }, score: { total: 72, reasons: [] }, devSharePct: 2.1 }, tape: { buyPressurePct: 63, trend: "rising" } }],
    decision: { kind: "propose-swap", reason: "base, entry allowed; swapped 0.01 ETH on chain, settled" }, want: { symbol: "LENNY", exit: false }, executed: true, proposed: false, conviction: 5, rules: { depthMult: 20, maxSwapUsd: 25, topConviction: 5 },
  });
  for (const r of rows) assert.ok(appendLedger(SIGNALS_LEDGER, r as unknown as Record<string, unknown>));
  const operator = "0x4444444444444444444444444444444444444444";
  const list = process.env.OBS_CONSOLE_ALLOWLIST;
  // The gate is off here (tmpdata.ts): every wallet signs in and is at the door, and the list alone decides the board.
  process.env.OBS_CONSOLE_ALLOWLIST = operator;
  try {
    await withServer(async (api) => {
      const none = await send(api, "/api/obs/console/cli", { line: "/signals" });
      assert.equal(none.status, 401, "no bearer, no board");
      assert.deepEqual(none.j, { ok: false, error: "sign in with your wallet first" });
      const forged = await send(api, "/api/obs/console/cli", { line: "/signals" }, "not.a.bearer");
      assert.equal(forged.status, 401);
      const token = mintSession(operator).token;
      const r = await send(api, "/api/obs/console/cli", { line: "/signals" }, token);
      assert.equal(r.status, 200, JSON.stringify(r.j));
      assert.equal(r.j.ok, true);
      assert.equal(r.j.effect, "signals");
      assert.equal(r.j.lines[0], "Board at 14:30Z: 1 token, 1 strong.");
      assert.match(r.j.lines[1], /^LENNY: grade A, launch lane, depth \$900, .*strong\. Took it: base, entry allowed; swapped 0\.01 ETH on chain, settled$/);
      for (const l of r.j.lines as string[]) assert.ok(!l.includes("—"));
      const capped = await send(api, "/api/obs/console/cli", { line: "/signals 0" }, token);
      assert.equal(capped.j.lines.length, 2, "a count of zero shows the whole board");
      // A holder at an open door is not the operator: the strong rows are what the convoy acts on, and a wallet
      // polling them would run ahead of it (review 2026-09-08).
      const holder = await send(api, "/api/obs/console/cli", { line: "/signals" }, mintSession("0x6666666666666666666666666666666666666666").token);
      assert.equal(holder.status, 403, "signed, at the door, not on the list: no board");
      assert.equal(holder.j.code, "not_operator");
      assert.ok(!JSON.stringify(holder.j).includes("Board at"));
      const status = await send(api, "/api/obs/console/cli", { line: "/desk" }, mintSession("0x6666666666666666666666666666666666666666").token);
      assert.equal(status.status, 200, "the same wallet still reads the desk: only the board is the operator's");
      const research = await read(api, "/api/obs/research?limit=50");
      assert.equal(research.status, 200);
      assert.ok(!JSON.stringify(research.j).includes("stance"), "the public research rows carry no signal row");
    });
  } finally {
    if (list == null) delete process.env.OBS_CONSOLE_ALLOWLIST; else process.env.OBS_CONSOLE_ALLOWLIST = list;
  }
  const gate = process.env.OBS_CONSOLE_GATE;
  process.env.OBS_CONSOLE_GATE = "allowlist";
  try {
    await withServer(async (api) => {
      const closed = await send(api, "/api/obs/console/cli", { line: "/signals" }, mintSession("0x5555555555555555555555555555555555555555").token);
      assert.equal(closed.status, 403, "a wallet whose door has closed does not get the board");
      assert.equal(closed.j.code, "not_holder");
      assert.ok(!Array.isArray(closed.j.lines) || !closed.j.lines.some((l: string) => /^Board at/.test(l)));
    });
  } finally {
    process.env.OBS_CONSOLE_GATE = gate;
  }
});

test("sign in, sign out, and the old bearer is refused on a signed route while a fresh sign-in works again (audit 2026-09-08: a stolen bearer kept its week)", async () => {
  const me = privateKeyToAccount(generatePrivateKey());
  await withServer(async (api) => {
    const signIn = async (): Promise<string> => {
      const ch = await send(api, "/api/obs/account/challenge", { address: me.address });
      assert.equal(ch.status, 200, JSON.stringify(ch.j));
      const signature = await me.signMessage({ message: ch.j.message });
      const link = await send(api, "/api/obs/account/link", { address: me.address, nonce: ch.j.nonce, signature });
      assert.equal(link.status, 200, JSON.stringify(link.j));
      assert.equal(typeof link.j.session?.token, "string");
      return link.j.session.token as string;
    };
    const token = await signIn();
    const before = await read(api, "/api/obs/my-agent/book", token);
    assert.equal(before.status, 200, "the bearer reads the wallet's own book before signing out");
    const noBearer = await send(api, "/api/obs/account/logout", {});
    assert.equal(noBearer.status, 401, "signing out needs the bearer it ends");
    const out = await send(api, "/api/obs/account/logout", {}, token);
    assert.equal(out.status, 200, JSON.stringify(out.j));
    assert.deepEqual(out.j, { ok: true });
    const dead = await read(api, "/api/obs/my-agent/book", token);
    assert.equal(dead.status, 401, "the old bearer is refused like an expired one");
    assert.deepEqual(dead.j, { ok: false, error: "sign in with your wallet first" });
    const twice = await send(api, "/api/obs/account/logout", {}, token);
    assert.equal(twice.status, 401, "a revoked bearer cannot sign out again either");
    const guest = await send(api, "/api/obs/console/cli", { line: "/agent" }, token);
    assert.equal(guest.j.ok, false, "at the console the old bearer is a guest");
    const firstLine = guest.j.lines?.[0];
    assert.match(String(typeof firstLine === "string" ? firstLine : firstLine?.text ?? ""), /^Connect your wallet first/);
    const fresh = await signIn();
    assert.notEqual(fresh, token);
    const after = await read(api, "/api/obs/my-agent/book", fresh);
    assert.equal(after.status, 200, "a bearer minted after signing out passes");
    assert.equal(after.j.ok, true);
  });
});

test("a trade note that names who traded by hand never leaves the box", () => {
  // 2026-09-09: a ledger repair explained itself in terms of the operator buying by hand in the same wallet, and
  // the API serves notes whole, so it published the one thing that must never be published. The ledger keeps its
  // own words for the box; what leaves is scrubbed.
  const leak = "exit (tape-profit), the trade is up 18%; CORRECTED to the desk's own share (68.27% of the swap): the operator bought 1283257 by hand in the app. The chain moved the full amount.";
  const out = publicNote(leak);
  assert.ok(!/operator/i.test(out ?? ""), `still names them: ${out}`);
  assert.ok(!/by hand/i.test(out ?? ""));
  assert.match(out ?? "", /tape-profit/, "the part that is the desk's own trading survives");
  // An ordinary note is untouched.
  const fine = "ETH/USDG then MEME/USDG on chain; expected 2319.94 MEME, floor 2296.74; received 2317.57 MEME";
  assert.equal(publicNote(fine), fine);
  // A note that is nothing but the private part becomes a plain stand-in rather than an empty string.
  assert.equal(publicNote("the operator closed it by hand"), "recorded by the desk");
  assert.equal(publicNote(undefined), undefined);
  // And the whole path is covered, not just the helper.
  const rows = publicTrades([{ at: 1, id: "x", status: "settled", venue: "pool", partner: "pool", from: { asset: "MEME", amount: 1, usd: 1 }, to: { asset: "ETH", amount: 1, usd: 1 }, note: leak, updatedAt: 1 } as never]);
  assert.ok(!/operator/i.test(rows[0].note ?? ""), "the endpoint scrubs it too");
});


test("a payload part that HANGS degrades to null, so one dead read never wedges the whole page", async () => {
  // 2026-09-09: the chain reads stopped answering after a restart, readsPayload never settled, and the dashboard's
  // Promise.all never resolved. Every viewer got a 502 while the book on disk was fine. A hang must read as absent.
  const started = Date.now();
  const never = () => new Promise<number>(() => {});
  assert.equal(await attempt(never, 50), null, "a read that never settles comes back as a missing part");
  assert.ok(Date.now() - started < 2000, "and it comes back on the deadline, not never");

  // The other parts of the same payload still answer.
  const [dead, alive] = await Promise.all([attempt(never, 50), attempt(() => ({ items: [], at: 1 }), 50)]);
  assert.equal(dead, null);
  assert.deepEqual(alive, { items: [], at: 1 });

  // A slow-but-answering read inside the deadline is NOT cut off.
  assert.equal(await attempt(() => new Promise<number>((r) => setTimeout(() => r(7), 10)), 500), 7);

  // A rejection after the race is lost must not surface as an unhandled rejection.
  assert.equal(await attempt(() => new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 20)), 5), null);
  await new Promise((r) => setTimeout(r, 60));
});
