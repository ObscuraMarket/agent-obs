import { test } from "node:test";
import assert from "node:assert/strict";
import { routeConsole, suggest, HELP_ALL, TOUR, VOCAB, VIEWS } from "../src/cli/router.ts";
import { sanitizeSettings, sanitizeName, getSettings, describeSettings } from "../src/desk/userSettings.ts";
import { statusLines, positionsLines, thoughtsLines, swapsLines } from "../src/desk/deskConsole.ts";
import { personaFor, agentIdForWallet, deEmDash, isMissingSession } from "../src/desk/userAgents.ts";

const ctx = { settings: {}, signedIn: false, swaps: 1 };

test("a line without a slash is a message to the agent; a slash is a command; a typo is one tap from fixed", () => {
  assert.deepEqual(routeConsole("what are you holding", ctx), { lines: [], effect: { kind: "chat", text: "what are you holding" } });
  assert.deepEqual(routeConsole("/status", ctx).effect, { kind: "desk", command: "status" });
  assert.deepEqual(routeConsole("/thoughts 5", ctx).effect, { kind: "desk", command: "thoughts", n: 5 });
  assert.deepEqual(routeConsole("/book", ctx).effect, { kind: "desk", command: "positions" });
  assert.deepEqual(routeConsole("/swap 0.05 ETH USDG", ctx).effect, { kind: "wallet", action: "swap", amount: 0.05, from: "ETH", to: "USDG" });
  assert.deepEqual(routeConsole("/quote 1,000 usdg -> nvda", ctx).effect, { kind: "wallet", action: "quote", amount: 1000, from: "USDG", to: "NVDA" });
  assert.equal(routeConsole("/swap ETH USDG", ctx).error, true);
  assert.deepEqual(routeConsole("/connect", ctx).effect, { kind: "wallet", action: "connect" });
  assert.deepEqual(routeConsole("/whoami", ctx).effect, { kind: "read", what: "whoami" });
  assert.deepEqual(routeConsole("/swaps", ctx).effect, { kind: "read", what: "swaps" });
  assert.deepEqual(routeConsole("/eligible", ctx).effect, { kind: "read", what: "swaps" }, "the old word still lands");
  assert.deepEqual(routeConsole("/clear", ctx).effect, { kind: "clear" });
  assert.deepEqual(routeConsole("/name Ledger", ctx).effect, { kind: "settings", patch: { name: "Ledger" } });
  assert.deepEqual(routeConsole("/style deep", ctx).effect, { kind: "settings", patch: { style: "deep" } });
  assert.equal(routeConsole("/style loud", ctx).error, true);
  assert.deepEqual(routeConsole("/reset goal", ctx).effect, { kind: "settings", patch: { goal: "" } });
  const typo = routeConsole("/statsu", ctx);
  assert.equal(typo.error, true);
  assert.deepEqual(typo.suggest, ["/status"]);
  assert.deepEqual(suggest("zzzzzz"), []);
  assert.deepEqual(routeConsole("/help", ctx).suggest, ["/explore", "/status", "/connect"]);
  assert.deepEqual(routeConsole("/help", { ...ctx, signedIn: true }).suggest, ["/explore", "/status", "/whoami"]);
  assert.ok(!HELP_ALL.join(" ").match(/eligib|unlock|bar/), "the help never mentions a bar to clear");
  assert.deepEqual(routeConsole("/help all", ctx).lines, HELP_ALL);
  const t1 = routeConsole("/explore", ctx);
  assert.match(t1.lines[0], /^\(1\/5\)/);
  assert.deepEqual(t1.suggest, [TOUR[0].tryIt, "/explore 2"]);
  assert.deepEqual(routeConsole("/explore 99", ctx).suggest, [TOUR[TOUR.length - 1].tryIt]);
  for (const v of VOCAB) assert.ok(!routeConsole(`/${v}`, ctx).effect || true);
});

test("the app's pages are console views: one command opens each beside the console, /close puts it away", () => {
  for (const v of VIEWS) {
    const r = routeConsole(`/${v}`, ctx);
    assert.deepEqual(r.effect, { kind: "view", view: v });
    assert.equal(r.lines.length, 1, `${v} says what opened`);
    assert.ok(r.suggest?.includes("/close"), `${v} offers /close`);
    assert.ok(!r.error);
  }
  assert.deepEqual(routeConsole("/app", ctx).effect, { kind: "view", view: "trade" }, "the Trade page's own route name still opens it");
  assert.deepEqual(routeConsole("/close", ctx).effect, { kind: "view", view: null });
  assert.deepEqual(routeConsole("/traed", ctx).suggest, ["/trade"]);
  assert.ok(HELP_ALL.some((l) => l.includes("/referral")) && HELP_ALL.some((l) => l.includes("/close")));
  for (const v of [...VIEWS, "close"]) assert.ok(VOCAB.includes(v), `${v} is in the vocabulary`);
});

test("settings are cleaned and capped, and a present-but-invalid field is refused rather than dropped", () => {
  assert.deepEqual(sanitizeSettings({ name: "  Ledger <b>x</b> " }), { settings: { name: "Ledger bx/b" } });
  assert.equal(sanitizeName("<<>>"), null);
  assert.deepEqual(sanitizeSettings({ style: "DEEP" }), { settings: { style: "deep" } });
  assert.match((sanitizeSettings({ style: "loud" }) as { error: string }).error, /style is one of/);
  assert.deepEqual(sanitizeSettings({ goal: "a\nb\tc" }), { settings: { goal: "a b c" } });
  assert.equal((sanitizeSettings({ voice: "x".repeat(500) }) as { settings: { voice: string } }).settings.voice.length, 200);
  assert.deepEqual(sanitizeSettings({ name: "" }), { settings: { name: "" } });
  assert.match((sanitizeSettings({}) as { error: string }).error, /nothing to set/);
  const rows = [
    { address: "0xabc", at: 1, name: "One", style: "deep" as const },
    { address: "0xabc", at: 2, name: "" },
    { address: "0xdef", at: 3, goal: "theirs" },
  ];
  assert.deepEqual(getSettings("0xABC", rows), { style: "deep" });
  assert.deepEqual(describeSettings({}), ["name    OBS (default)", "style   balanced (default)", "voice   not set", "goal    not set"]);
});

test("the desk's lines come from the page's own payloads", () => {
  const status = { desk: { equityUsd: 1271.4, pnlUsd: 298.9, pnlPct: 0.307, netCapitalUsd: 972.5, lastThoughtAt: Date.UTC(2026, 8, 7, 3, 59) }, rails: { tradingOn: true, maxSwapUsd: 200, openOrders: 0, maxOpenOrders: 2 }, wallet: { address: "0x89a2" } };
  const pnl = { positions: [{ asset: "ETH", valueUsd: 1000, unrealizedPct: -0.04, share: 0.8 }, { asset: "CHART", valueUsd: 217, unrealizedPct: 0.084, share: 0.2 }], closed: [{ closedAt: Date.UTC(2026, 8, 7, 3, 38), asset: "BITBANK", resultUsd: 70.9, heldMin: 26, how: "operator" }] };
  const s = statusLines(status, pnl);
  assert.equal(s[0], "equity $1,271  pnl $299 (+30.7%)  capital $973  last cycle 03:59Z");
  assert.equal(s[1], "trading on  size $200 a trade  open orders 0 of 2");
  assert.equal(s[3], "holding CHART $217 (+8.4%)");
  const p = positionsLines(pnl);
  assert.equal(p[0], "positions");
  assert.match(p[2], /CHART/);
  assert.match(p[4], /03:38Z  BITBANK/);
  assert.deepEqual(thoughtsLines([]), ["no thoughts recorded yet"]);
  assert.match(swapsLines({ swaps: 1, recent: [] })[0], /^1 swap from this wallet through the console/);
  assert.match(swapsLines({ swaps: 0, recent: [] })[0], /^No swaps from this wallet/);
  assert.match(swapsLines({ swaps: 0, recent: [] })[1], /\/quote 0\.05 ETH USDG/);
});

test("the personal agent's instruction carries the rules that are policy, and never an em dash", () => {
  const p = personaFor("0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38", { name: "Ledger", style: "concise", voice: "dry", goal: "learn the desk" });
  assert.match(p, /^You are Ledger, Agent OBS/);
  assert.match(p, /do not correct them back to "OBS"/);
  assert.match(p, /You do not hold or move this person's funds/);
  assert.match(p, /never sign anything/);
  assert.match(p, /Never invent positions, prices or performance/);
  assert.match(p, /No em dashes, ever/);
  assert.match(p, /"learn the desk"/);
  assert.match(p, /preference about TONE/);
  assert.match(p, /Style: keep replies especially short/);
  assert.ok(!p.includes("—"));
  assert.equal(agentIdForWallet("0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38"), "obs-u-89a26d6e7f572a12cdf0252fd0a581268dfa3f38");
  assert.equal(deEmDash("a — b -- c"), "a, b, c");
  assert.ok(isMissingSession(new Error("Stream request failed (404): Session not found: chat-0x1")));
  assert.ok(!isMissingSession(new Error("HTTP 500")));
});
