import { test } from "node:test";
import assert from "node:assert/strict";
import { entryRead, entryLine, entryRulesFromEnv } from "../src/desk/entry.ts";
import type { SwapRow } from "../src/desk/tape.ts";

const R = entryRulesFromEnv({} as NodeJS.ProcessEnv);
const now = 1_000_000_000_000;
const row = (minAgo: number, side: "buy" | "sell", quote: number, price: number): SwapRow => ({ at: now - minAgo * 60e3, block: 1, tx: `${minAgo}-${side}-${price}`, side, tokenAmount: quote / price, quoteAmount: quote, price });
const quietStart = row(25, "buy", 5, 1.0);

test("too few swaps, or no volume pickup, is quiet and never an entry", () => {
  const few = entryRead([row(5, "buy", 10, 1), row(2, "buy", 10, 1.1)], "TOK", now, R);
  assert.equal(few.state, "quiet");
  assert.equal(few.ok, false);
  const steady = [28, 23, 18, 13, 8, 3].map((m) => row(m, "buy", 10, 1));
  const q = entryRead(steady, "TOK", now, R);
  assert.equal(q.state, "quiet");
  assert.equal(q.pickup, false);
  assert.ok(q.pickupRatio != null && Math.abs(q.pickupRatio - 1) < 1e-9, "the last 10 min ran 1x the earlier tape");
  assert.match(entryLine(q), /no volume pickup/);
  assert.match(entryLine(q), /NO ENTRY/);
});

test("the top of a run is a spike, never an entry, however strong the buying", () => {
  const rows = [quietStart, row(9, "buy", 100, 1.1), row(7, "buy", 200, 1.25), row(4, "buy", 300, 1.4), row(2, "buy", 400, 1.55), row(1, "buy", 500, 1.6)];
  const e = entryRead(rows, "TOK", now, R);
  assert.equal(e.pickup, true);
  assert.equal(e.state, "spike");
  assert.equal(e.ok, false);
  assert.ok(Math.abs((e.runPct as number) - 60) < 1e-9);
  assert.equal(e.offPeakPct, 0);
  assert.match(entryLine(e), /SPIKE, NO ENTRY/);
});

test("a pullback that held a higher low and turned up with buyers back is an entry", () => {
  const rows = [quietStart, row(9, "buy", 100, 1.2), row(7, "buy", 300, 1.5), row(6, "buy", 400, 1.6), row(3, "sell", 200, 1.35), row(1, "buy", 250, 1.42)];
  const e = entryRead(rows, "TOK", now, R);
  assert.equal(e.state, "pullback");
  assert.equal(e.ok, true);
  assert.equal(e.higherLow, true);
  assert.ok(Math.abs((e.offPeakPct as number) - 11.25) < 1e-9);
  assert.ok((e.bouncePct as number) > 5 && (e.bouncePct as number) < 5.3);
  assert.ok((e.recentBuyPressurePct as number) > 80);
  assert.match(entryLine(e), /PULLBACK, ENTRY ALLOWED/);
});

test("a survivor drifting a few percent under where the window started is not a breakdown once the tolerance is set", () => {
  // Thirty minutes of steady two-way trade with the price 2% under where the window started, a tight 10-minute range and buyers present.
  const rows: SwapRow[] = [];
  for (let m = 29; m >= 0; m--) rows.push(row(m, m % 2 === 0 ? "buy" : "sell", 100 + (m % 2 === 0 ? 20 : 0), m > 20 ? 1.0 : 0.98 + (m % 3) * 0.004));
  const strict = entryRead(rows, "TOK", now, R, true);
  assert.equal(strict.state, "breakdown", "with no tolerance any tick under the start is a breakdown");
  const eased = entryRead(rows, "TOK", now, { ...R, breakdownPct: 5, baseRangePct: 10 }, true);
  assert.notEqual(eased.state, "breakdown");
  assert.equal(eased.state, "base");
  assert.equal(eased.ok, true);
  assert.equal(entryRulesFromEnv({ OBS_ENTRY_BREAKDOWN_PCT: "5" } as unknown as NodeJS.ProcessEnv).breakdownPct, 5);
  assert.equal(R.breakdownPct, 0, "off by default");
});

test("with pullbacks switched off the same tape is read as a pullback and refused: the desk buys bases only", () => {
  const rows = [quietStart, row(9, "buy", 100, 1.2), row(7, "buy", 300, 1.5), row(6, "buy", 400, 1.6), row(3, "sell", 200, 1.35), row(1, "buy", 250, 1.42)];
  const e = entryRead(rows, "TOK", now, { ...R, allowPullback: false });
  assert.equal(e.state, "pullback");
  assert.equal(e.ok, false);
  assert.match(e.why, /buys bases only, no entry/);
  assert.equal(entryRulesFromEnv({ OBS_ENTRY_PULLBACK: "off" } as unknown as NodeJS.ProcessEnv).allowPullback, false);
  assert.equal(R.allowPullback, true, "on by default");
});

test("a pullback met with selling is not held yet, and not an entry", () => {
  const rows = [quietStart, row(9, "buy", 100, 1.2), row(7, "buy", 300, 1.5), row(6, "buy", 400, 1.6), row(3, "sell", 1500, 1.35), row(1, "buy", 50, 1.42)];
  const e = entryRead(rows, "TOK", now, R);
  assert.equal(e.state, "pullback");
  assert.equal(e.ok, false);
  assert.match(e.why, /not held/);
  assert.match(e.why, /50% needed/);
});

test("a tight base with an old peak and buyers present is an entry", () => {
  const rows = [quietStart, row(14, "buy", 100, 1.3), row(12, "buy", 100, 1.4), row(8, "buy", 150, 1.36), row(5, "sell", 100, 1.34), row(3, "buy", 200, 1.37), row(1, "buy", 150, 1.38)];
  const e = entryRead(rows, "TOK", now, R);
  assert.equal(e.state, "base");
  assert.equal(e.ok, true);
  assert.ok((e.rangePct as number) < 3.1);
  assert.match(entryLine(e), /BASE, ENTRY ALLOWED/);
});

test("more than the max off its peak is a breakdown, not an entry", () => {
  const rows = [quietStart, row(9, "buy", 100, 1.5), row(7, "buy", 300, 2.0), row(5, "sell", 400, 1.5), row(3, "sell", 300, 1.2), row(1, "sell", 200, 1.1)];
  const e = entryRead(rows, "TOK", now, R);
  assert.equal(e.state, "breakdown");
  assert.equal(e.ok, false);
  assert.ok(Math.abs((e.offPeakPct as number) - 45) < 1e-9);
});

test("volume known elsewhere skips the pickup test but the price action still decides", () => {
  const steady = [28, 23, 18, 13, 8, 3].map((m) => row(m, "buy", 10, 1));
  const e = entryRead(steady, "TOK", now, R, true);
  assert.equal(e.pickup, true);
  assert.equal(e.volumeKnown, true);
  assert.equal(e.state, "waiting");
  assert.equal(e.ok, false);
  assert.match(entryLine(e), /established by its hourly figures/);
});

test("entry rules come from the environment with defaults", () => {
  assert.equal(R.pullbackMinPct, 8);
  assert.equal(entryRulesFromEnv({ OBS_ENTRY_PULLBACK_MIN_PCT: "5" } as NodeJS.ProcessEnv).pullbackMinPct, 5);
});
