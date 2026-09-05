import { test } from "node:test";
import assert from "node:assert/strict";
import { digestThought, tokenStatusLine, watchEvent } from "../src/desk/digest.ts";
import type { Thought } from "../src/desk/thoughts.ts";

const observation = [
  "Book: 0.41 ETH.",
  "Early launches from the watcher, minute one onward, newest first: COFF@robinhood (pons-v2, 4 min old, gate ok, PonsV2LauncherToken, creator tax 0.0%, ignited at +2 min, no side pool: PROBE ALLOWED through its USDG curve); LOCATR@robinhood (pons-v2, 32 min old, gate FAILED, creator tax 2.0%, ignited at +5 min, no side pool: gate failed, never); OZZY@robinhood (pons-v2, 54 min old, gate ok, PonsV2LauncherToken, creator tax 1.0%, ignited at +8 min, no side pool: PROBE ALLOWED through its ETH curve).",
  "Launch candidates from the watcher, graded against the bar: CATSTRO@robinhood GRADE B, up to $25.00 (stable: 9 active hours): hour 8, 1.0h ago, $9,600 prior-hour volume; SPORES@robinhood BELOW THE BAR, not tradable (below the bar: volume rolling over): hour 1, 1.4h ago.",
  "Tape COFF (last 15 min): 1936 swaps; buys $104,837 vs sells $99,358 (51% buy pressure); price +181.2% over the window; 20% off its peak; 5-minute volume $0 then $0 then $204,195, holding.",
  "Entry COFF (last 30 min, 1936 swaps): volume where there was none; ran +251% to its peak, now 20% off it, held a higher low and turned up +17% off the trough, buy pressure 51% over the last 10 min: pullback holding, entry allowed. PULLBACK, ENTRY ALLOWED.",
  "Holders COFF (3931 transfers): 518 wallets; largest 9%; top ten 30% of circulating; first 1 buyers: 0 sharing a block, 0 identical sizes (0% bundled); 1 of the top ten wallets are fresh. HOLDERS OK.",
  "Launch COFF: pons v2, graduated to its pool; dev buy 27.32% of supply for 1,230 of the pair; creator tax 0%, fees to a third party; no wallets exempt from the opening tax; an X link; a fresh deployer. Score 63 (-25 dev buy 27.32%, over 10%; +5 no creator tax). LAUNCH FAIL: the dev buy is 27.3% of supply (8% allowed).",
  "Records COFF: 3 of the top 10 wallets have a record on other tokens; 1 repeat loser (-$73); 2 mixed or still holding.",
  "Entry UNIT (last 30 min, 1071 swaps): no volume pickup; no volume pickup (the last 10 min ran 0.0x the earlier tape, 2x needed). QUIET, NO ENTRY.",
  "Holders UNIT (2557 transfers): 58 wallets; largest 50%; top ten 90% of circulating; first 1 buyers: 0 sharing a block, 0 identical sizes (0% bundled); 4 of the top ten wallets are fresh. HOLDERS FAIL: the largest wallet holds 50% (25% allowed), the top ten hold 90% (60% allowed).",
  "Launch XI: pons v2, on its curve; dev buy 1.85% of supply for 61.50 of the pair; creator tax 0%, fees to a third party; no wallets exempt from the opening tax; an X link, a website; a fresh deployer. Score 100 (+15 dev buy 1.85%, inside the 1 to 6% band). LAUNCH OK.",
  "Held launch token MEME: 1,000, cost $5.00, now $6.10 (+22.0%), held 0.4h; hourly volume $900 per hour.",
];

const base = (decision: Thought["decision"], analysis?: Thought["analysis"]): Thought => ({ at: 1, observation, thoughts: ["COFF has ignited and the entry rails allow the pullback."], decision, ...(analysis ? { analysis } : {}) });

test("a refused probe reads as REFUSED with what was wanted and why", () => {
  const d = digestThought(base({ kind: "hold", reason: "wanted 0.002 ETH@robinhood to COFF@robinhood, refused: the launch fails the read: the dev buy is 27.3% of supply (8% allowed)" }));
  assert.equal(d.verdict, "refused");
  assert.equal(d.wanted, "0.002 ETH to COFF");
  assert.match(d.headline, /^Wanted 0\.002 ETH to COFF; the rails refused it: the launch fails the read/);
});

test("a proposed launch buy reads as PROBE, a hold stays a hold, and the argument only travels with a thesis", () => {
  const p = digestThought(base({ kind: "propose-swap", amount: 0.002, from: "ETH@robinhood", to: "COFF@robinhood", reason: "I am probing COFF as it has ignited. (sized to $5: COFF has no proven sell yet, so a probe)" }, { thesis: "swap 0.002 ETH@robinhood -> COFF@robinhood", evidence: ["Tape shows 1936 swaps with 51 percent buy pressure."], invalidation: "A breakdown below the trough.", conviction: 5 }));
  assert.equal(p.verdict, "probe");
  assert.equal(p.headline, "Probes COFF with 0.002 ETH: I am probing COFF as it has ignited.");
  assert.equal(p.argument?.conviction, 5);
  const h = digestThought(base({ kind: "hold", reason: "I am holding the book in ether as every candidate is gated." }, { thesis: "none", evidence: [], invalidation: "", conviction: 5 }));
  assert.equal(h.verdict, "hold");
  assert.equal(h.argument, undefined, "a thesis of none is not an argument");
  const s = digestThought(base({ kind: "propose-swap", amount: 1000, from: "MEME@robinhood", to: "ETH@robinhood", reason: "buyers thinning" }));
  assert.equal(s.verdict, "sell");
});

test("every token in play gets its entry, holders, launch and records, and the board is counted", () => {
  const d = digestThought(base({ kind: "hold", reason: "holding" }));
  const coff = d.tokens.find((x) => x.symbol === "COFF")!;
  assert.deepEqual(coff.entry, { state: "pullback", ok: true, why: "ran +251% to its peak, now 20% off it, held a higher low and turned up +17% off the trough, buy pressure 51% over the last 10 min" });
  assert.equal(coff.holders?.ok, true);
  assert.match(coff.holders!.why, /^518 wallets; largest 9%; top ten 30% of circulating$/);
  assert.equal(coff.launch?.ok, false);
  assert.equal(coff.launch?.score, 63);
  assert.match(coff.launch!.why, /dev buy is 27\.3%/);
  assert.match(coff.records!, /1 repeat loser/);
  assert.match(coff.tape!, /^1936 swaps in 15 min, 51% buy pressure, \+181\.2%, 20% off its peak, holding$/);
  const unit = d.tokens.find((x) => x.symbol === "UNIT")!;
  assert.deepEqual(unit.entry, { state: "quiet", ok: false, why: "no volume pickup (the last 10 min ran 0.0x the earlier tape, 2x needed)" });
  assert.equal(unit.holders?.ok, false);
  assert.equal(d.tokens.find((x) => x.symbol === "XI")?.launch?.score, 100);
  assert.equal(d.tokens.find((x) => x.symbol === "MEME")?.role, "held");
  assert.deepEqual(d.board, { early: 3, probeAllowed: 2, gateFailed: 1, graded: 1, belowBar: 1 });
  assert.equal(tokenStatusLine(coff).tone, "bad");
  assert.equal(tokenStatusLine(coff).line, "entry: pullback, allowed · holders: ok · launch: FAIL, the dev buy is 27.3% of supply (8% allowed)");
  assert.equal(tokenStatusLine(unit).tone, "bad");
  assert.equal(tokenStatusLine(d.tokens.find((x) => x.symbol === "XI")!).line, "launch: ok 100");
  assert.equal(tokenStatusLine(d.tokens.find((x) => x.symbol === "MEME")!).line, "held");
});

test("the live watch reduces to one terminal line, and a stale file to nothing", () => {
  const now = 1_800_000_000_000;
  const live = { at: now - 5000, block: 55262326, lookMs: 812, watching: [{ symbol: "JOHN", role: "launch", entryState: "breakdown", entryOk: false, trend: "holding" }, { symbol: "BOW", role: "launch", entryState: "pullback", entryOk: true, trend: "rising" }, { symbol: "MEME", role: "held", entryState: "quiet", entryOk: false, trend: "rolling over" }], lastTrigger: "18:22:50Z JOHN gave an entry", cycleRunning: false };
  const w = watchEvent(live, now)!;
  assert.equal(w.line, "watching JOHN breakdown, BOW ENTRY (pullback), MEME held, rolling over; looks 0.8 s");
  assert.equal(w.trigger, "18:22:50Z JOHN gave an entry");
  assert.equal(w.block, 55262326);
  assert.equal(watchEvent({ ...live, at: now - 60_000 }, now), null, "older than half a minute is not live");
  assert.equal(watchEvent({ ...live, watching: [] }, now)!.line, "watching nothing in play; looks 0.8 s");
});
