import { test } from "node:test";
import assert from "node:assert/strict";
import { publicFeed, buildStatus, sseFrame, newerThan, railsSummary, RateLimiter } from "../src/server.ts";
import { originAllowed } from "../src/server.ts";
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
  const r = railsSummary(railsFromEnv({ OBS_MAX_SWAP_USD: "25", OBS_DAILY_SWAP_USD: "100", OBS_MAX_OPEN_ORDERS: "1" }), trades, now);
  assert.equal(r.tradingOn, false);
  assert.deepEqual([r.maxSwapUsd, r.dailySwapUsd, r.maxOpenOrders], [25, 100, 1]);
  assert.equal(r.openOrders, 1, "one pending; the proposal is not an order");
  assert.ok(r.sentTodayUsd >= 20, `today's sends counted, got ${r.sentTodayUsd}`);
  assert.ok(r.allowedAssets.includes("USDG@robinhood"));
  assert.equal(r.allowedPartners, null);
});

test("the request budget is per client and slides", () => {
  const l = new RateLimiter(3, 1000);
  assert.deepEqual([l.allow("a", 0), l.allow("a", 100), l.allow("a", 200), l.allow("a", 300)], [true, true, true, false]);
  assert.equal(l.allow("b", 300), true, "another client has its own budget");
  assert.equal(l.allow("a", 1101), true, "the oldest hit slid out of the window");
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
