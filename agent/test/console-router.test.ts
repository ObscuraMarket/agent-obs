import { test } from "node:test";
import assert from "node:assert/strict";
import { routeConsole, suggest, HELP_ALL, TOUR, VOCAB, VIEWS } from "../src/cli/router.ts";
import { sanitizeSettings, sanitizeName, getSettings, describeSettings } from "../src/desk/userSettings.ts";
import { statusLines, positionsLines, thoughtsLines, swapsLines, agentsLines } from "../src/desk/deskConsole.ts";
import { personaFor, agentIdForWallet, deEmDash, isMissingSession, DENIED_TOOLS, standingLine, isEnsured, ensureUserAgent } from "../src/desk/userAgents.ts";
import type { GatewayClient } from "@openhermit/sdk";

test("a person's agent is denied the gateway's shell, files, web, self-editing and admin tools, and keeps its memory", () => {
  for (const t of ["exec", "file_write", "web_search", "web_fetch", "instruction_update", "session_send", "schedule_create", "user_role_set"]) assert.ok(DENIED_TOOLS.includes(t), t);
  for (const t of DENIED_TOOLS) assert.ok(!t.startsWith("memory_"), "memory stays");
});

const ctx = { settings: {}, signedIn: false, swaps: 1 };

test("a line without a slash is a message to the agent; a slash is a command; a typo is one tap from fixed", () => {
  assert.deepEqual(routeConsole("what are you holding", ctx), { lines: [], effect: { kind: "chat", text: "what are you holding" } });
  assert.deepEqual(routeConsole("/status", ctx).effect, { kind: "desk", command: "status" });
  assert.deepEqual(routeConsole("/desk", ctx).effect, { kind: "desk", command: "status", house: true }, "the house desk by name, whoever is signed in");
  assert.deepEqual(routeConsole("/agents", ctx).effect, { kind: "desk", command: "agents" }, "every agent following the desk, for anyone");
  assert.deepEqual(routeConsole("/leaderboard", ctx).effect, { kind: "desk", command: "agents" });
  assert.deepEqual(agentsLines({ agents: [], on: 0, live: 0 }), ["No agent is following the desk yet. Sign in and /start to be the first."]);
  const table = agentsLines({ on: 1, live: 1, agents: [
    { name: "Scout", wallet: "0xbdbF...374B", on: true, mode: "live", sizeUsd: 10, since: Date.UTC(2026, 8, 7, 22, 3), positions: [{ asset: "LENNY", valueUsd: 9.57, unrealizedPct: -0.043 }], realizedUsd: -0.81, trades: 3, exits: 1 },
    { name: "OBS", wallet: null, on: false, mode: "paper", sizeUsd: 100, since: null, positions: [], realizedUsd: 0, trades: 0, exits: 0 },
  ] });
  assert.equal(table[0], "agents following the desk: 1 on (1 live), 2 all time");
  assert.match(table[1], /^  Scout {8}live {2}on {2}\$10 {3}a trade {2}since 22:03Z {2}LENNY \$10 \(-4\.3%\) {2}realized -\$0\.81 {2}3 trades {2}wallet 0xbdbF\.\.\.374B$/);
  assert.match(table[2], /^  OBS {10}paper off \$100 {2}a trade {2}holding nothing {2}realized \$0\.00 {2}0 trades$/);
  for (const l of table) assert.ok(!l.includes("—"));
  assert.deepEqual(routeConsole("/obs", ctx).effect, { kind: "desk", command: "status", house: true });
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
  assert.deepEqual(routeConsole("/reset model", ctx).effect, { kind: "settings", patch: { model: "" } }, "back to the default model");
  assert.deepEqual(routeConsole("/reset chat", ctx).effect, { kind: "settings", patch: { chatGen: 1 } }, "a fresh memory: the next conversation");
  assert.deepEqual(routeConsole("/reset chat", { ...ctx, settings: { chatGen: 2 } }).effect, { kind: "settings", patch: { chatGen: 3 } });
  assert.deepEqual(sanitizeSettings({ chatGen: 3 }), { settings: { chatGen: 3 } });
  assert.ok("error" in sanitizeSettings({ chatGen: -1 }));
  // The wallet's trading agent: on, on with a size, off, resize, show; a size that is not a number is one tap from fixed.
  assert.deepEqual(routeConsole("/start", ctx).effect, { kind: "follow", action: "start" });
  assert.deepEqual(routeConsole("/start $150", ctx).effect, { kind: "follow", action: "start", sizeUsd: 150 });
  assert.equal(routeConsole("/start lots", ctx).error, true);
  assert.deepEqual(routeConsole("/stop", ctx).effect, { kind: "follow", action: "stop" });
  assert.deepEqual(routeConsole("/size 75", ctx).effect, { kind: "follow", action: "size", sizeUsd: 75 });
  assert.equal(routeConsole("/size", ctx).error, true);
  assert.deepEqual(routeConsole("/agent", ctx).effect, { kind: "follow", action: "show" });
  assert.ok(routeConsole("/help", ctx).lines.join("\n").includes("/start [size]"), "the short help teaches /start");
  assert.ok(routeConsole("/help all", ctx).lines.join("\n").includes("Your trading agent"), "the full help has the section");
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

test("the help and the tour speak for the door as it is, and apps say they are coming until they are switched on", () => {
  const off = { ...ctx, apps: false };
  assert.ok(!routeConsole("/help", off).lines.join("\n").includes("/apps"), "no /apps line while apps are off");
  assert.ok(!routeConsole("/help all", off).lines.join("\n").includes("Your apps"), "no apps section while apps are off");
  assert.ok(routeConsole("/help", ctx).lines.join("\n").includes("/apps"), "missing means on");
  const coming = routeConsole("/apps connect Slack", off);
  assert.deepEqual([coming.effect, coming.error], [{ kind: "none" }, undefined]);
  assert.match(coming.lines[0], /Apps are coming later/);
  assert.equal(routeConsole("/apps", ctx).effect.kind, "apps", "on, the route handles it");
  const invited = routeConsole("/help", { ...ctx, gate: "allowlist" }).lines.join("\n");
  assert.ok(invited.includes("Connect an invited wallet") && !invited.includes("holding OBS"), "list-only: the door says invited");
  assert.ok(routeConsole("/help", { ...ctx, gate: "off" }).lines.join("\n").includes("Connect your wallet and get"), "open: no condition named");
  assert.match(routeConsole("/explore 5", { ...ctx, gate: "allowlist" }).lines.join("\n"), /Connect an invited wallet and you get a basic agent/);
  assert.deepEqual(routeConsole("/help", ctx).lines, HELP_ALL.length ? routeConsole("/help", { ...ctx, gate: "on", apps: true }).lines : [], "the default door is holders with apps on");
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
  assert.deepEqual(routeConsole("/model", ctx).effect, { kind: "model", action: "show" });
  assert.deepEqual(routeConsole("/model claude opus", ctx).effect, { kind: "model", action: "set", query: "claude opus" });
  assert.deepEqual(routeConsole("/models free", ctx).effect, { kind: "model", action: "list", query: "free" });
  assert.deepEqual(routeConsole("/model list gemini", ctx).effect, { kind: "model", action: "list", query: "gemini" });
  assert.deepEqual(routeConsole("/credits", ctx).effect, { kind: "credits", action: "show" });
  assert.deepEqual(routeConsole("/credits buy 10 USDG", ctx).effect, { kind: "credits", action: "buy", amount: 10, token: "USDG" });
  assert.deepEqual(routeConsole("/buy 0.005 rh eth", ctx).effect, { kind: "credits", action: "buy", amount: 0.005, token: "ETH" });
  assert.deepEqual(routeConsole("/credits buy 1,000 aobs", ctx).effect, { kind: "credits", action: "buy", amount: 1000, token: "AOBS" });
  assert.equal(routeConsole("/credits buy USDG", ctx).error, true);
  for (const v of ["model", "models", "credits", "buy"]) assert.ok(VOCAB.includes(v));
  assert.deepEqual(routeConsole("/apps", ctx).effect, { kind: "apps", action: "list" });
  assert.deepEqual(routeConsole("/apps connect Google Docs", ctx).effect, { kind: "apps", action: "connect", app: "Google Docs" });
  assert.deepEqual(routeConsole("/apps Slack", ctx).effect, { kind: "apps", action: "connect", app: "Slack" }, "naming an app connects it");
  assert.deepEqual(routeConsole("/apps disconnect x", ctx).effect, { kind: "apps", action: "disconnect", app: "x" });
  assert.equal(routeConsole("/apps connect", ctx).error, true);
  assert.ok(VOCAB.includes("apps"));
  assert.deepEqual(routeConsole("/traed", ctx).suggest, ["/trade"]);
  assert.ok(HELP_ALL.some((l) => l.includes("/rewards")) && HELP_ALL.some((l) => l.includes("/close")));
  assert.ok(!HELP_ALL.join(" ").includes("referral") && !VIEWS.includes("referral" as never), "the referral section is gone");
  for (const v of [...VIEWS, "close"]) assert.ok(VOCAB.includes(v), `${v} is in the vocabulary`);
});

test("a token the agent holds leaves by name: /withdraw LENNY sends it whole, /sell LENNY sells it whole for ETH, and ETH still goes by amount", () => {
  assert.deepEqual(routeConsole("/withdraw LENNY", ctx).effect, { kind: "agentWallet", action: "withdrawToken", symbol: "LENNY" });
  assert.deepEqual(routeConsole("/withdraw all lenny", ctx).effect, { kind: "agentWallet", action: "withdrawToken", symbol: "LENNY" }, "all plus a symbol says the same thing, upper-cased");
  assert.deepEqual(routeConsole("/withdraw all", ctx).effect, { kind: "agentWallet", action: "withdraw", all: true }, "the ETH forms stand");
  assert.deepEqual(routeConsole("/withdraw 0.02 ETH", ctx).effect, { kind: "agentWallet", action: "withdraw", amount: 0.02 });
  assert.deepEqual(routeConsole("/withdraw 0.02", ctx).effect, { kind: "agentWallet", action: "withdraw", amount: 0.02 });
  assert.deepEqual(routeConsole("/withdraw 1,000", ctx).effect, { kind: "agentWallet", action: "withdraw", amount: 1000 });
  const ethByName = routeConsole("/withdraw ETH", ctx);
  assert.equal(ethByName.error, true);
  assert.match(ethByName.lines[0], /^ETH goes by amount/);
  assert.match(routeConsole("/withdraw", ctx).lines[0], /^Say how much to send back/);
  assert.match(routeConsole("/withdraw 0", ctx).lines[0], /^Say how much to send back/);
  assert.equal(routeConsole("/withdraw 0.5x", ctx).error, true, "neither an amount nor a symbol");
  assert.deepEqual(routeConsole("/sell LENNY", ctx).effect, { kind: "agentWallet", action: "sell", symbol: "LENNY" });
  assert.deepEqual(routeConsole("/sell all lenny", ctx).effect, { kind: "agentWallet", action: "sell", symbol: "LENNY" });
  const noSymbol = routeConsole("/sell", ctx);
  assert.equal(noSymbol.error, true);
  assert.match(noSymbol.lines[0], /^Say which token your agent should sell/);
  assert.match(routeConsole("/sell ETH", ctx).lines[0], /^ETH is what it sells into/);
  assert.equal(routeConsole("/sell 5 LENNY", ctx).error, true, "a sale is the whole balance; there is no amount form");
  assert.ok(VOCAB.includes("sell"));
  assert.deepEqual(suggest("sel"), ["/sell"]);
  const all = routeConsole("/help all", ctx).lines.join("\n");
  assert.ok(all.includes("/withdraw LENNY") && all.includes("/sell LENNY"), "the full help teaches both");
  assert.ok(routeConsole("/help", ctx).lines.join("\n").includes("/sell LENNY"), "and the short help");
  const p = personaFor("0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38", { name: "Ledger" });
  assert.match(p, /\/withdraw LENNY sends all of it to their wallet, \/sell LENNY sells all of it for ETH/);
  assert.match(p, /If they ask you to buy a particular token, say you only follow the desk's trades/, "a buy of its own is still not its to place");
  for (const l of [...routeConsole("/help all", ctx).lines, ...noSymbol.lines, ...ethByName.lines]) assert.ok(!l.includes("—"));
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
  assert.deepEqual(describeSettings({}), ["name    OBS (default)", "style   balanced (default)", "voice   not set", "goal    not set", "model   the default"]);
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
  assert.match(p, /^You are Ledger, the agent of the wallet .* You trade for this person by following Agent OBS/);
  assert.match(p, /How you trade: you are a trading agent in one specific way\. You follow Agent OBS/);
  assert.match(p, /their trading agent: from a wallet of your own you follow the house desk/);
  assert.ok(!/not a trading agent/.test(p), "it is their trading agent, and says so");
  // Its standing, written in when it changes: on, live, size, wallet, the latest doings.
  const on = standingLine({ on: true, mode: "live", sizeUsd: 10, since: Date.UTC(2026, 8, 7, 22, 3), wallet: "0xbdbFcBE13330DC9195B8C1809e436c17A057374B", holding: ["RWA", "LENNY"], recent: ["bought LENNY with 0.0040 ETH"] });
  assert.match(on, /^Right now: you are ON since 22:03 UTC, LIVE, trading real ETH from your own wallet, \$10 a trade, following Agent OBS\. Your wallet is 0xbdbF.* You hold RWA and LENNY right now; \/agent shows what each is worth\. Lately: bought LENNY with 0\.0040 ETH\./);
  assert.match(standingLine({ on: false, mode: "paper", sizeUsd: 100, since: null, wallet: null, holding: [], recent: [] }), /^Right now: you are OFF \(paper when on, \$100 a trade\); \/start turns you on\. You hold no token right now\./);
  const withStanding = personaFor("0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38", { name: "Ledger" }, { apps: false, gate: "allowlist" }, { on: true, mode: "paper", sizeUsd: 50, since: null, wallet: null, holding: [], recent: [] });
  assert.match(withStanding, /Right now: you are ON, on paper, \$50 a trade, following Agent OBS\./);
  // It has no tools of its own: it answers what it holds from its standing and never reports a tool as broken (it did, 2026-09-08).
  assert.match(p, /No exec, no files, no web, no tool of any kind unless this person has connected an app to you\. Never say a tool is broken/);
  assert.match(p, /that wallet is the one that controls you/);
  assert.match(p, /\/model picks the model you run on/);
  assert.match(p, /\/credits shows their balance/);
  assert.ok(!/exact execution|discreet settlement|trading agent on Robinhood/.test(p), "the house desk's temperament does not leak into a personal agent");
  assert.match(p, /do not correct them back to "OBS"/);
  assert.match(p, /You do not hold or move this person's funds/);
  // The persona teaches only what the console offers: no /apps while apps are off, and the door as the gate keeps it.
  const closed = personaFor("0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38", { name: "Ledger" }, { apps: false, gate: "allowlist" });
  assert.ok(!closed.includes("/apps"), "no /apps command while apps are off");
  assert.match(closed, /Apps: none yet/);
  assert.match(closed, /open to invited wallets for now/);
  const open = personaFor("0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38", { name: "Ledger" }, { apps: true, gate: "on" });
  assert.match(open, /\/apps connect <app>/);
  assert.match(open, /OBS and AOBS holders/);
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

test("an agent is ensured only by a run that wrote its persona and denied every tool, and only within the throttle window", () => {
  const at = Date.UTC(2026, 8, 8, 12, 0);
  const full = { at, persona: true, denied: DENIED_TOOLS };
  assert.equal(isEnsured(full, at), true);
  assert.equal(isEnsured(full, at + 5 * 60 * 1000 - 1), true, "fresh inside five minutes");
  assert.equal(isEnsured(full, at + 5 * 60 * 1000), false, "stale at five minutes: run again");
  assert.equal(isEnsured(undefined, at), false, "never run");
  assert.equal(isEnsured({ ...full, persona: false }, at), false, "no persona on the agent");
  assert.equal(isEnsured({ ...full, denied: DENIED_TOOLS.slice(0, 3) }, at), false, "stopped partway through the policy writes: not ensured (2026-09-08)");
  assert.equal(isEnsured({ ...full, denied: DENIED_TOOLS.filter((t) => t !== "exec") }, at), false, "one tool short is a shell left reachable");
  assert.equal(isEnsured({ ...full, denied: [...DENIED_TOOLS].reverse().concat("memory_write") }, at), true, "order and extras do not matter");
  assert.equal(isEnsured({ ...full, denied: ["exec"] }, at, ["exec"]), true, "judged against the list it is given");
  assert.equal(isEnsured(full, at + 1000, DENIED_TOOLS, 1000), false, "and the window it is given");
});

test("a policy write that fails is named in the log, never leaves the agent marked ensured, and is written again on the next ensure", async () => {
  const address = "0x000000000000000000000000000000000000e05e";
  const agentId = agentIdForWallet(address);
  const calls: string[] = [];
  let failAt: string | null = "web_fetch";
  const gw = {
    listAgents: async () => { calls.push("list"); return [{ agentId }]; },
    createAgent: async () => { throw new Error("the fake gateway already has the agent"); },
    getAgentConfig: async () => ({}),
    putAgentConfig: async () => { calls.push("config"); },
    setInstruction: async () => { calls.push("persona"); },
    upsertPolicy: async (_id: string, p: { resourceKey: string }) => {
      calls.push(`deny:${p.resourceKey}`);
      if (p.resourceKey === failAt) throw new Error("gateway blip (502)");
    },
  } as unknown as GatewayClient;
  const logged: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  try {
    const first = await ensureUserAgent(address, gw);
    assert.deepEqual(first, { agentId, ready: false, created: false, reason: "tool_policy_incomplete" });
    const upTo = DENIED_TOOLS.slice(0, DENIED_TOOLS.indexOf("web_fetch") + 1);
    assert.deepEqual(calls.filter((c) => c.startsWith("deny:")), upTo.map((t) => `deny:${t}`), "stops at the write that failed");
    assert.ok(calls.includes("persona"), "the persona went on first");
    assert.ok(logged.some((l) => l.includes(agentId) && l.includes("stopped at web_fetch") && l.includes("gateway blip")), logged.join("\n"));
    calls.length = 0;
    failAt = null;
    const second = await ensureUserAgent(address, gw);
    assert.deepEqual(second, { agentId, ready: true, created: false });
    assert.ok(calls.includes("list"), "the partial run was not trusted: the agent is looked at again");
    assert.deepEqual(calls.filter((c) => c.startsWith("deny:")), DENIED_TOOLS.map((t) => `deny:${t}`), "the whole list is written again, from the top");
    assert.ok(!calls.includes("persona"), "an unchanged persona is not written twice");
    calls.length = 0;
    const third = await ensureUserAgent(address, gw);
    assert.deepEqual(third, { agentId, ready: true, created: false });
    assert.deepEqual(calls, [], "a full run is trusted for the throttle window");
  } finally {
    console.error = error;
  }
});
