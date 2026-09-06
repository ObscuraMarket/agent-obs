import { test } from "node:test";
import assert from "node:assert/strict";
import { observationLines, parseThoughtReply, guardThoughts, buildThoughtPrompt } from "../src/desk/thoughts.ts";
import { snapshot } from "../src/desk/book.ts";

const reads = {
  at: 0,
  token: { address: "0xfe24", name: "Obscura", symbol: "OBS", decimals: 18, totalSupply: "1,000,000,000", holders: 3266 , explorerPriceUsd: null, volume24hUsd: null, marketCapUsd: null },
  prices: { btcUsd: 78000, ethUsd: 2455.5 },
  siteUp: true,
  apiUp: true,
  wallet: null,
  market: null,
};

test("an empty desk observes that it has nothing, and never invents a mark", () => {
  const lines = observationLines({ reads, book: snapshot([], [], {}, 1), quotes: [], open: [], now: 1 });
  assert.match(lines[0], /no capital yet/);
  assert.ok(lines.some((l) => /BTC \$78,000\.00/.test(l)));
  assert.ok(lines.some((l) => /3,266 holders/.test(l)));
  assert.ok(!lines.some((l) => /own market/.test(l)), "an unread market is absent");
  assert.ok(!lines.some((l) => /—/.test(l)));
});

test("the observation carries OBS's own market when the chain answered", () => {
  const market = { venue: "ramses-v3" as const, feePct: 2, priceUsd: 0.00048142, depthUsd2pct: 202, liquidity: "1", at: 1 };
  const lines = observationLines({ reads: { ...reads, market }, book: snapshot([], [], {}, 1), quotes: [], open: [], now: 1 });
  assert.ok(lines.some((l) => /^OBS at \$0\.000481 on its own market \(its USDG pool on Ramses, 2% tier\); about \$202\.00 of buying moves the price 2%\.$/.test(l)), lines.join("\n"));
});

test("a funded desk observes its book, in-flight swaps and quotes", () => {
  const flows = [{ at: 1, kind: "deposit" as const, asset: "ETH", amount: 1, usd: 2400 }];
  const open = [{ at: 2, id: "x", status: "pending" as const, from: { asset: "ETH", amount: 0.2, usd: 490 }, to: { asset: "USDG", amount: 488, usd: 488 }, partner: "Relay" }];
  const book = snapshot(flows, open, { ETH: 2455.5 }, 3);
  const lines = observationLines({ reads, book, quotes: [{ from: "ETH", to: "USDG", amountIn: 0.1, amountOut: 244.2, partner: "SwapSpace", at: 3 }], open, now: 3 });
  assert.match(lines[0], /Book: 0\.8 ETH, \$490\.00 in flight/);
  assert.match(lines[1], /Equity \$2,454\.40 against \$2,400\.00 net capital; PnL \$54\.40 \(2\.27%\)/);
  assert.ok(lines.some((l) => /In flight: 0\.2 ETH to USDG via Relay/.test(l)));
  assert.ok(lines.some((l) => /Quotes this cycle: 0\.1 ETH to 244\.2 USDG \(SwapSpace\)/.test(l)));
});

test("the launches reach the model even when no reference leg quoted this cycle", () => {
  const book = snapshot([{ at: 1, kind: "deposit" as const, asset: "ETH", amount: 0.41, usd: 948 }], [], { ETH: 2450 }, 3);
  const candidates = [{ symbol: "CATSTRO", hour: 3, volUsd: 4200, movePct: 12.5, senders: 61, tierPct: 1, ageH: 2.1, trail: "$900, $1,200 per hour", grade: "B" as const, capUsd: 25, why: "stable: 6 active hours" }];
  const lines = observationLines({ reads, book, quotes: [], open: [], now: 3, candidates, early: [], tapes: ["Entry CATSTRO: base, entry allowed.", "HOLDERS OK CATSTRO: 61 wallets."], memory: { record: "Launch record: no closed trades yet.", recalls: [] } });
  assert.ok(!lines.some((l) => /Quotes this cycle/.test(l)), "no quote line without quotes");
  assert.ok(lines.some((l) => /Launch candidates from the watcher, graded against the bar: CATSTRO@robinhood GRADE B/.test(l)));
  assert.ok(lines.some((l) => /Early launches from the watcher: none/.test(l)));
  assert.ok(lines.includes("Entry CATSTRO: base, entry allowed."));
  assert.ok(lines.includes("HOLDERS OK CATSTRO: 61 wallets."));
  assert.ok(lines.includes("Launch record: no closed trades yet."));
});

test("the reply parses into public thoughts, a decision, and a private note", () => {
  const r = parseThoughtReply("THOUGHT: The desk holds nothing, so there is nothing to mark.\nTHOUGHT: ETH sits at 2,455 dollars and the app is up.\nDECISION: hold\nREASON: no capital.\nNOTE: watch for the first deposit.");
  assert.equal(r.thoughts.length, 2);
  assert.equal(r.decision.kind, "hold");
  assert.equal(r.decision.reason, "no capital.");
  assert.equal(r.note, "watch for the first deposit.");
  const s = parseThoughtReply("THOUGHT: quote looks fine.\nDECISION: swap 0.1 ETH -> USDG\nREASON: taking a little off.\nNOTE: check the fill.");
  assert.deepEqual(s.decision, { kind: "propose-swap", amount: 0.1, from: "ETH", to: "USDG", reason: "taking a little off." });
  const n = parseThoughtReply("DECISION: swap 0.005 eth@Robinhood -> usdg@robinhood\nREASON: probe.");
  assert.deepEqual(n.decision, { kind: "propose-swap", amount: 0.005, from: "ETH@robinhood", to: "USDG@robinhood", reason: "probe." });
});

test("public thoughts pass the same boundaries as a tweet", () => {
  const out = guardThoughts([
    "The book is flat and I am fine with that.",
    "Send funds to 0x000000000000000000000000000000000000dEaD and wait.",
    "Dark Orders are coming soon.",
    "short",
    "A public order leaks the pair, the size — and the hurry.",
  ]);
  assert.deepEqual(out, ["The book is flat and I am fine with that.", "A public order leaks the pair, the size, and the hurry."]);
});

test("the prompt tells the truth about whether a swap can execute", () => {
  const p = buildThoughtPrompt(["Book: empty."], [], "", "2026-09-01T12:00:00.000Z", false);
  assert.match(p, /You cannot execute anything yet/);
  const armed = buildThoughtPrompt(["Book: empty."], [], "", "2026-09-01T12:00:00.000Z", true);
  assert.match(armed, /no operator approval step/, "an armed desk is told nothing waits for the operator");
  assert.match(armed, /before the desk was armed and is void/, "and that its older thoughts about proposals no longer count");
  assert.ok(!/You cannot execute anything yet/.test(armed));
  assert.match(p, /DECISION: swap <amount> <FROM> -> <TO>/);
  assert.match(p, /Assets you may name: ETH@robinhood, USDG@robinhood\./, "the default allowlist is what he may name");
  assert.ok(!/basis/i.test(p), "the basis is not in the prompt unless switched on");
  assert.match(buildThoughtPrompt([], [], "", "2026-09-01T12:00:00.000Z", false, undefined, "pool", [], false, true), /a side trade is the basis/);
  assert.match(p, /Both legs of every swap stay on Robinhood Chain/);
  assert.match(buildThoughtPrompt([], [], "", "2026-09-01T12:00:00.000Z", false, ["ETH@robinhood", "USDG@robinhood"]), /Assets you may name: ETH@robinhood, USDG@robinhood\./);
  assert.ok(!/—/.test(p));
});

