import "./tmpdata.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { publicFeed, buildStatus, sseFrame, newerThan, railsSummary, RateLimiter, tapePrices, pnlFingerprint } from "../src/server.ts";
import { originAllowed, isPrivatePeer, clientFrom, RATE_CLIENTS_MAX, TtlCache, attempt, dashboardQuery, handle, myAgentBookPayload } from "../src/server.ts";
import { railsFromEnv } from "../src/desk/rails.ts";
import { mintSession } from "../src/desk/accounts.ts";
import { followState, followBook, recordFollow } from "../src/desk/follow.ts";
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

test("a paper agent's book has the owner's shape: its state, its empty book, no wallet leg and no chain read", async () => {
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
    assert.deepEqual([r.j.wallet, r.j.walletUrl, r.j.walletEth], [null, null, null], "wallets are off here: no address, no balance, no read");
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
