import { test } from "node:test";
import assert from "node:assert/strict";
import { publicFeed, buildStatus, sseFrame, newerThan, railsSummary, RateLimiter, tapePrices, pnlFingerprint } from "../src/server.ts";
import { originAllowed, isPrivatePeer, clientFrom, RATE_CLIENTS_MAX, TtlCache, attempt, dashboardQuery } from "../src/server.ts";
import { railsFromEnv } from "../src/desk/rails.ts";

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
