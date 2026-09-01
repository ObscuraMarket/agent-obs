import { test } from "node:test";
import assert from "node:assert/strict";
import { observationLines, parseThoughtReply, guardThoughts, buildThoughtPrompt } from "../src/desk/thoughts.ts";
import { snapshot } from "../src/desk/book.ts";

const reads = {
  at: 0,
  token: { address: "0xfe24", name: "Obscura", symbol: "OBS", decimals: 18, totalSupply: "1,000,000,000", holders: 3266 },
  prices: { btcUsd: 78000, ethUsd: 2455.5 },
  siteUp: true,
  apiUp: true,
};

test("an empty desk observes that it has nothing, and never invents a mark", () => {
  const lines = observationLines({ reads, book: snapshot([], [], {}, 1), quotes: [], open: [], now: 1 });
  assert.match(lines[0], /no capital yet/);
  assert.ok(lines.some((l) => /BTC \$78,000\.00/.test(l)));
  assert.ok(lines.some((l) => /3,266 holders/.test(l)));
  assert.ok(!lines.some((l) => /—/.test(l)));
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

test("the reply parses into public thoughts, a decision, and a private note", () => {
  const r = parseThoughtReply("THOUGHT: The desk holds nothing, so there is nothing to mark.\nTHOUGHT: ETH sits at 2,455 dollars and the app is up.\nDECISION: hold\nREASON: no capital.\nNOTE: watch for the first deposit.");
  assert.equal(r.thoughts.length, 2);
  assert.equal(r.decision.kind, "hold");
  assert.equal(r.decision.reason, "no capital.");
  assert.equal(r.note, "watch for the first deposit.");
  const s = parseThoughtReply("THOUGHT: quote looks fine.\nDECISION: swap 0.1 ETH -> USDG\nREASON: taking a little off.\nNOTE: check the fill.");
  assert.deepEqual(s.decision, { kind: "propose-swap", amount: 0.1, from: "ETH", to: "USDG", reason: "taking a little off." });
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
  assert.match(p, /DECISION: swap <amount> <FROM> -> <TO>/);
  assert.ok(!/—/.test(p));
});
