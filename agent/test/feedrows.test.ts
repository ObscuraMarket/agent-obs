import { test } from "node:test";
import assert from "node:assert/strict";
import { hourlyRow, closedHoursSince, sendersFrom, roundLine, HOUR_MS } from "../src/desk/feedrows.ts";
import { sidePoolRow } from "../src/desk/chainlaunch.ts";
import { parseFeed, exitVerdict, gradeCandidate, gradeRulesFromEnv } from "../src/desk/candidates.ts";
import { stabilityRead, stabilityRulesFromEnv } from "../src/desk/stability.ts";
import type { SwapRow } from "../src/desk/tape.ts";
import type { TransferRow } from "../src/desk/holders.ts";

const R = stabilityRulesFromEnv({} as NodeJS.ProcessEnv);
/** An hour boundary. */
const now = 1_800_000_000_000;
const POOL = "0x" + "cd".repeat(32);
const TOKEN = "0x00000000000000000000000000000000000000aa";
const meta = { id: POOL, token: TOKEN, symbol: "STEADY", tierPct: 4, source: "pons-v2" };
const swap = (at: number, block: number, quote: number, price: number, side: "buy" | "sell" = "buy"): SwapRow => ({ at, block, tx: `0x${block.toString(16).padStart(8, "0")}:0`, side, tokenAmount: quote / price, quoteAmount: quote, price });

test("an hourly row counts the hour's swaps in dollars, carries the last price across a quiet hour, and is cumulative in swaps", () => {
  const h0 = now - 3 * HOUR_MS;
  const rows = [swap(h0 + 5 * 60e3, 10, 100, 0.01), swap(h0 + 40 * 60e3, 20, 300, 0.012, "sell"), swap(h0 + 2 * HOUR_MS + 60e3, 30, 50, 0.011)];
  const first = hourlyRow(rows, h0, h0, 1, { ...meta, swaps: 0, senders: 3 }, h0 + HOUR_MS + 30e3);
  assert.equal(first.kind, "hourly");
  assert.equal(first.hour, 0);
  assert.equal(first.swaps, 2);
  assert.deepEqual(first.lastHour, { swaps: 2, usd: 400, px: 0.012 });
  assert.equal(first.ts, h0 + HOUR_MS + 30e3, "ts is the write time in milliseconds");
  assert.equal(first.gateOk, true);
  assert.equal(first.tier, 4);
  assert.equal(first.launchSource, "pons-v2");
  assert.equal("volumeUsd" in first, false, "no cumulative: the hour's own figure is the series");
  const quiet = hourlyRow(rows, h0 + HOUR_MS, h0, 1, { ...meta, swaps: first.swaps, senders: 3 });
  assert.equal(quiet.hour, 1);
  assert.deepEqual(quiet.lastHour, { swaps: 0, usd: 0, px: 0.012 }, "a quiet hour: usd 0, the last trade's price carried");
  assert.equal(quiet.swaps, 2, "nothing added");
  const third = hourlyRow(rows, h0 + 2 * HOUR_MS, h0, 1, { ...meta, swaps: quiet.swaps, senders: 3 });
  assert.deepEqual(third.lastHour, { swaps: 1, usd: 50, px: 0.011 });
  assert.equal(third.swaps, 3);
  const eth = hourlyRow(rows, h0, h0, 2500, { ...meta, swaps: 0, senders: 3 });
  assert.equal(eth.lastHour.usd, 1_000_000, "an ETH-quoted pool is priced through ETH");
  assert.equal(eth.lastHour.px, 30);
  assert.equal(hourlyRow([], h0, h0, 1, { ...meta, swaps: 0, senders: 0 }).lastHour.px, null, "no trade ever: no price");
  assert.equal(hourlyRow(rows, h0, h0 + 30 * 60e3, 1, { ...meta, swaps: 0, senders: 0 }).hour, 0, "an hour that starts before the launch is hour 0, never negative");
  assert.equal(hourlyRow(rows, h0 + 5 * HOUR_MS, h0 + 30 * 60e3, 1, { ...meta, swaps: 0, senders: 0 }).hour, 4);
});

test("closed hours since a cursor: whole hours only, never the open one, the recent end of a long gap", () => {
  assert.deepEqual(closedHoursSince(now - 2.5 * HOUR_MS, now), [now - 2 * HOUR_MS, now - HOUR_MS], "an unaligned start rounds up to the next boundary");
  assert.deepEqual(closedHoursSince(now - HOUR_MS, now), [now - HOUR_MS], "an aligned cursor writes its own hour");
  assert.deepEqual(closedHoursSince(now - 30 * 60e3, now), [], "the open hour waits");
  assert.deepEqual(closedHoursSince(now - HOUR_MS, now + 10 * 60e3), [now - HOUR_MS], "ten minutes into the next hour, only the closed one");
  const gap = closedHoursSince(now - 100 * HOUR_MS, now, 48);
  assert.equal(gap.length, 48);
  assert.equal(gap[gap.length - 1], now - HOUR_MS);
  assert.equal(gap[0], now - 48 * HOUR_MS, "the oldest hours of the gap are left behind");
});

test("senders come from transfers paired to swaps by hash, buyers from a transfer out of infrastructure, sellers into it", () => {
  const POOLMGR = "0xpoolmanager";
  const infra = new Set([POOLMGR, TOKEN]);
  const sw = (hash: string, side: "buy" | "sell"): SwapRow => ({ at: 1, block: 1, tx: `${hash}:3`, side, tokenAmount: 1, quoteAmount: 1, price: 1 });
  const xf = (hash: string, from: string, to: string): TransferRow => ({ at: 1, block: 1, tx: `${hash}:1`, from, to, amount: 0 });
  const senders = sendersFrom(
    [xf("0xa", POOLMGR, "0xW1"), xf("0xb", "0xw2", POOLMGR), xf("0xc", "0xw3", "0xw4"), xf("0xd", POOLMGR, "0xw5"), xf("0xe", POOLMGR, "0xw6"), xf("0xf", POOLMGR, "0xw1")],
    [sw("0xa", "buy"), sw("0xb", "sell"), sw("0xc", "buy"), sw("0xd", "sell"), sw("0xf", "buy")],
    infra,
  );
  assert.deepEqual(senders, ["0xw1", "0xw2"], "a wallet-to-wallet transfer, a transfer without a swap, and a mismatched side count nobody; a repeat wallet counts once; lowercased");
  assert.deepEqual(sendersFrom([], [sw("0xa", "buy")], infra), []);
});

const feedOpts = { maxAgeMs: 6 * HOUR_MS, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 90 * 60e3, stable: R };

test("a written trail round-trips through parseFeed and stabilityRead, and its side-pool row gives the spacing the id alone cannot", () => {
  // Seven closed hours, the last one five minutes ago: twenty swaps of $60 an hour, the price holding in a band.
  const start = now - 7 * HOUR_MS - 5 * 60e3;
  const pxs = [0.01, 0.011, 0.012, 0.0115, 0.011, 0.0118, 0.0112];
  const swaps: SwapRow[] = [];
  for (let h = 0; h < 7; h++) for (let i = 0; i < 20; i++) swaps.push(swap(start + h * HOUR_MS + i * 3 * 60e3, 1000 + h * 100 + i, 60, pxs[h], i % 3 ? "buy" : "sell"));
  const lines = [JSON.stringify(sidePoolRow(POOL, TOKEN, 40000, 888, "pons-v2", start))];
  let cum = 0;
  for (let h = 0; h < 7; h++) {
    const row = hourlyRow(swaps, start + h * HOUR_MS, start, 1, { ...meta, swaps: cum, senders: 25 }, start + (h + 1) * HOUR_MS + 90e3);
    cum = row.swaps;
    lines.push(JSON.stringify(row));
  }
  const snap = parseFeed(lines.join("\n") + "\n", now, feedOpts);
  const trail = snap.hourly[POOL];
  assert.equal(trail.length, 7);
  assert.deepEqual(trail.map((x) => x.usd), Array.from({ length: 7 }, () => 1200));
  assert.deepEqual(trail.map((x) => x.hour), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(trail[6].swaps, 140, "cumulative swaps on the row");
  assert.equal(trail[6].senders, 25);
  assert.equal(trail[6].cumUsd, undefined, "no volumeUsd was written, so no cumulative is read");
  assert.equal(trail[6].px, 0.0112);
  const read = stabilityRead(trail, "STEADY", now, R);
  assert.equal(read.stable, true, read.why);
  assert.equal(read.activeHours, 7);
  assert.equal(read.hoursKnown, 7, "every hour's volume is known: the series is the hour's own figure");
  assert.ok((read.ageH as number) < 0.2, "the last row is fresh");
  // The stable trail alone puts the pool on the board, through its side pool at a spacing SPACINGS does not list.
  assert.equal(snap.candidates.length, 1);
  const c = snap.candidates[0];
  assert.equal(c.symbol, "STEADY");
  assert.equal(c.tickSpacing, 888);
  assert.equal(c.feePips, 40000);
  assert.equal(c.stable?.stable, true);
  assert.equal(c.hour, 6);
  assert.equal(c.volUsd, 1200);
  assert.equal(c.senders, 25);
  assert.equal(gradeCandidate(c, trail, 30_000, gradeRulesFromEnv({} as NodeJS.ProcessEnv)).grade, "B");
  const noSidePool = parseFeed(lines.slice(1).join("\n") + "\n", now, feedOpts);
  assert.equal(noSidePool.candidates.length, 0, "without the side-pool row the spacing cannot be derived and the pool is not tradable");
  assert.equal(noSidePool.hourly[POOL].length, 7, "the trail is still read for a held token's rules");
});

test("closed-hour rows wake the volume exit: two hours each 30% under the one before sell the whole position", () => {
  const start = now - 4 * HOUR_MS;
  const volumes = [1200, 1000, 600, 300];
  const swaps: SwapRow[] = [];
  volumes.forEach((v, h) => {
    for (let i = 0; i < 10; i++) swaps.push(swap(start + h * HOUR_MS + i * 5 * 60e3, 5000 + h * 100 + i, v / 10, 0.01));
  });
  const lines: string[] = [];
  let cum = 0;
  for (let h = 0; h < 4; h++) {
    const row = hourlyRow(swaps, start + h * HOUR_MS, start, 1, { ...meta, swaps: cum, senders: 30 }, start + (h + 1) * HOUR_MS + 60e3);
    cum = row.swaps;
    lines.push(JSON.stringify(row));
  }
  const trail = parseFeed(lines.join("\n") + "\n", now, feedOpts).hourly[POOL];
  const rails = { candidateMaxHoldH: 24, candidateFloorPct: 30, candidateVolumeDropPct: 30, tapeRolloverExit: false };
  const v = exitVerdict({ ageH: 2, pnlPct: 4, hourly: trail, tapeTrend: "holding" }, rails);
  assert.equal(v?.kind, "volume");
  assert.match(v?.reason ?? "", /\$1000 then \$600 then \$300 an hour/);
  assert.equal(exitVerdict({ ageH: 2, pnlPct: 4, hourly: trail.slice(0, 3), tapeTrend: "holding" }, rails), null, "1200, 1000, 600: the first step is under 30%");
});

test("the round's log line names the set, the history reads and the rows", () => {
  const line = roundLine({ watched: 87, held: 3, scout: 6, keeper: 78, young: 0, backfilled: 5, deferred: 12, failed: 1, rows: 91, sidePools: 3, unpriced: 2, calls: 112, headBlock: 57626243 }, 41.2);
  assert.equal(line, "watched 87 (3 held, 6 scout, 78 keepers); history read for 5, 12 waiting for the budget, 1 refused by the chain; 91 hourly rows, 3 side-pool rows, 2 pools waiting for a quote price; 112 calls, head 57626243; 41 s");
  assert.equal(roundLine({ watched: 0, held: 0, scout: 0, keeper: 0, young: 0, backfilled: 0, deferred: 0, failed: 0, rows: 0, sidePools: 0, unpriced: 0, calls: 0, headBlock: null, note: "nothing to watch" }, 0.2), "watched 0 (0 held, 0 scout, 0 keepers); 0 hourly rows; 0 calls; nothing to watch; 0 s");
});
