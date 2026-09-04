import { test } from "node:test";
import assert from "node:assert/strict";
import { priceStats, ratioStats, usSession, figures, evidenceCheck } from "../src/desk/analysis.ts";
import { parseThoughtReply } from "../src/desk/thoughts.ts";
import { entryStats, railsFromEnv, checkRails } from "../src/desk/rails.ts";
import { resolveAsset } from "../src/desk/assets.ts";

const H = 3600e3;
const now = Date.UTC(2026, 8, 4, 15, 0, 0);

test("price stats from the desk's own samples: 24h change, 7-day range, the typical 30-minute move, and honest nulls early on", () => {
  const rows = [];
  for (let i = 0; i <= 7 * 48; i++) rows.push({ at: now - 7 * 24 * H + i * 30 * 60e3, symbol: "ETH", priceUsd: 2400 + 100 * Math.sin(i / 20) + (i % 2 ? 3 : -3) });
  const st = priceStats(rows, "ETH", now);
  assert.equal(st.samples, rows.length);
  assert.ok(st.change24hPct != null && Math.abs(st.change24hPct) < 15);
  assert.ok(st.low7d != null && st.high7d != null && st.low7d < st.high7d);
  assert.ok(st.rangePosPct != null && st.rangePosPct >= 0 && st.rangePosPct <= 100);
  assert.ok(st.move30mPct != null && st.move30mPct > 0 && st.move30mPct < 2, `typical move ${st.move30mPct}`);
  const young = priceStats(rows.slice(-5), "ETH", now);
  assert.equal(young.change24hPct, null, "no sample a day back, no 24h change");
  assert.equal(young.low7d, null, "too little history for a range");
  assert.equal(young.move30mPct, null);
  assert.equal(priceStats(rows, "NVDA", now).priceUsd, null);
});

test("relative value pairs samples from the same cycle and measures now against the 7-day average", () => {
  const rows = [];
  for (let i = 0; i < 48; i++) {
    const at = now - 48 * H + i * H;
    rows.push({ at, symbol: "ETH", priceUsd: 2400 }, { at: at + 60e3, symbol: "NVDA", priceUsd: i === 47 ? 200 : 240 });
  }
  const r = ratioStats(rows, "ETH", "NVDA", now);
  assert.ok(r.ratioNow != null && Math.abs(r.ratioNow - 12) < 1e-9, "one ETH buys 12 NVDA now");
  assert.ok(r.deviationPct != null && r.deviationPct > 15, "ETH is rich against NVDA versus the week");
  assert.equal(ratioStats(rows, "ETH", "OBS", now).avg7d, null);
});

test("the US session is read in New York time", () => {
  assert.deepEqual(usSession(Date.UTC(2026, 8, 4, 15, 0, 0)).label, "open", "Friday 11:00 ET");
  assert.equal(usSession(Date.UTC(2026, 8, 4, 12, 0, 0)).label, "pre-market", "Friday 08:00 ET");
  assert.equal(usSession(Date.UTC(2026, 8, 4, 21, 0, 0)).label, "after-hours", "Friday 17:00 ET");
  assert.equal(usSession(Date.UTC(2026, 8, 5, 15, 0, 0)).label, "weekend");
  assert.equal(usSession(Date.UTC(2026, 8, 4, 15, 0, 0)).minutesToChange, 300, "closes in five hours");
});

test("evidence must quote observed figures; a swap without an argument is not argued for", () => {
  const observation = ["ETH at $2,401.10; 24h +1.20%; 7-day range $2,300.00 to $2,480.00, sitting at 56% of it; typical 30-minute move 0.35%.", "NVDA pool depth: $71,911.00 moves it 2%.", "US equities: open (closes in 5h0m)."];
  assert.ok(figures(observation.join(" ")).has("2401.10"));
  assert.ok(figures(observation.join(" ")).has("71911"));
  const rule = { minEvidence: 3, minConviction: 4 };
  const good = { thesis: "buy NVDA with ETH while the session is open", evidence: ["ETH sits at 56% of its 7-day range, not stretched", "NVDA depth of $71,911 takes a $25 order without impact", "typical 30-minute move of 0.35% keeps the route cost in proportion"], invalidation: "ETH breaks below 2300", conviction: 4 };
  assert.deepEqual(evidenceCheck(good, observation, rule), { ok: true, cited: 3 });
  const weak = { ...good, evidence: ["it feels right", "momentum looks good", "the depth is fine"] };
  assert.match((evidenceCheck(weak, observation, rule) as { reason: string }).reason, /0 did/);
  const timid = { ...good, conviction: 3 };
  assert.match((evidenceCheck(timid, observation, rule) as { reason: string }).reason, /conviction of at least 4 \(stated 3\)/);
  const noInv = { ...good, invalidation: "" };
  assert.match((evidenceCheck(noInv, observation, rule) as { reason: string }).reason, /an invalidation/);
  assert.match((evidenceCheck(null, observation, rule) as { reason: string }).reason, /no thesis/);
  const oneFigure = { ...good, evidence: ["ETH at 2401.10", "ETH is 2401.10 now", "and still 2401.10"] };
  assert.match((evidenceCheck(oneFigure, observation, rule) as { reason: string }).reason, /1 distinct/);
});

test("the reply parser reads the analysis lines and treats a bare none as absent", () => {
  const p = parseThoughtReply(["THOUGHT: the book is flat", "THESIS: none", "EVIDENCE: ETH at 2401.10 is mid range", "EVIDENCE: depth 71911", "INVALIDATION: none", "CONVICTION: 2", "DECISION: hold", "REASON: nothing to do", "NOTE: watching"].join("\n"));
  assert.deepEqual(p.thoughts, ["the book is flat"]);
  assert.equal(p.analysis!.thesis, "");
  assert.equal(p.analysis!.evidence.length, 2);
  assert.equal(p.analysis!.invalidation, "");
  assert.equal(p.analysis!.conviction, 2);
  assert.equal(parseThoughtReply("THOUGHT: hi\nDECISION: hold\nREASON: x\nNOTE: y").analysis, null, "an older reply shape has no analysis");
  assert.equal(parseThoughtReply("CONVICTION: 9\nDECISION: hold").analysis!.conviction, null, "out of range is not a conviction");
});

test("entries are spaced and counted; exits are neither", () => {
  const t = (at: number, id: string, status: "settled" | "pending" | "failed", exit = false) => ({ at, id, status, from: { asset: "ETH", amount: 0.01, usd: 24 }, to: { asset: "NVDA", amount: 0.1, usd: 24 }, partner: "pool", ...(exit ? { exit: true } : {}) });
  const trades = [t(now - 30 * H, "old", "settled"), t(now - 5 * H, "a", "settled"), t(now - 3 * H, "b", "settled", true), t(now - 1 * H, "c", "pending"), t(now - 0.5 * H, "d", "failed")];
  const st = entryStats(trades, now);
  assert.equal(st.entriesToday, 2, "a and c; the exit and the failure do not count, the old one is out of the day");
  assert.equal(st.lastEntryAt, now - 1 * H);
  const rails = railsFromEnv({ OBS_TRADING: "on", OBS_MIN_HOURS_BETWEEN_ENTRIES: "2", OBS_MAX_ENTRIES_PER_DAY: "3", OBS_TRADE_ASSETS: "ETH@robinhood,USDG@robinhood,NVDA@robinhood" } as NodeJS.ProcessEnv);
  const ETH = resolveAsset("ETH@robinhood")!, NVDA = resolveAsset("NVDA@robinhood")!;
  const ctx = { rails, balances: { "ETH@robinhood": 0.4, "NVDA@robinhood": 1 }, nativeOnFromChain: 0.4, openOrders: 0, sentTodayUsd: 0, now, lastEntryAt: now - 1 * H, entriesToday: 2 };
  assert.match((checkRails({ from: ETH, to: NVDA, amount: 0.01, usd: 24 }, ctx) as { reason: string }).reason, /at least 2h apart/);
  assert.match((checkRails({ from: ETH, to: NVDA, amount: 0.01, usd: 24 }, { ...ctx, lastEntryAt: now - 3 * H, entriesToday: 3 }) as { reason: string }).reason, /limit is 3/);
  assert.deepEqual(checkRails({ from: ETH, to: NVDA, amount: 0.01, usd: 24 }, { ...ctx, lastEntryAt: now - 3 * H, entriesToday: 2 }), { ok: true });
  assert.deepEqual(checkRails({ from: NVDA, to: ETH, amount: 1, usd: 24, exit: true }, { ...ctx, entriesToday: 3 }), { ok: true }, "an exit ignores spacing and the count");
});
