import { test } from "node:test";
import assert from "node:assert/strict";
import { hourlyTrail, hourVolumes, stabilityRead, stabilityRulesFromEnv } from "../src/desk/stability.ts";
import { parseFeed, gradeCandidate, gradeRulesFromEnv, type HourlyStat } from "../src/desk/candidates.ts";

const R = stabilityRulesFromEnv({} as NodeJS.ProcessEnv);
const now = 1_800_000_000_000;
const H = 3600e3;
/** A trail of `hours` rows, cumulative volume stepping by `step` each hour, price from `pxs`. */
const trail = (hours: number, step: number, pxs: number[], senders = 40): HourlyStat[] =>
  Array.from({ length: hours }, (_, h) => ({ hour: h, at: now - (hours - 1 - h) * H, usd: step, cumUsd: step * (h + 1), px: pxs[h] ?? pxs[pxs.length - 1], senders }));

test("the trail keeps the latest row per hour, and hourly volume comes from the cumulative figure", () => {
  const rows: HourlyStat[] = [
    { hour: 0, at: 1, usd: 5, cumUsd: 5, px: 1, senders: 1 },
    { hour: 1, at: 2, usd: 5, cumUsd: 9, px: 1, senders: 2 },
    { hour: 1, at: 3, usd: 5, cumUsd: 12, px: 1, senders: 3 },
    { hour: 2, at: 4, usd: 5, cumUsd: 12, px: 1, senders: 3 },
  ];
  const t = hourlyTrail(rows);
  assert.deepEqual(t.map((x) => [x.hour, x.cumUsd]), [[0, 5], [1, 12], [2, 12]]);
  assert.deepEqual(hourVolumes(t), [5, 7, 0], "a repeated cumulative is a dead hour");
  assert.deepEqual(hourVolumes([{ hour: 4, at: 1, usd: 9, cumUsd: 100, px: 1, senders: 1 }, { hour: 5, at: 2, usd: 9, cumUsd: 130, px: 1, senders: 1 }]), [null, 30], "a trail cut past hour 0 cannot read its first hour");
  assert.deepEqual(hourVolumes([{ hour: 0, at: 1, usd: 9, px: 1, senders: 1 }]), [9], "without a cumulative the hour's own figure stands");
});

test("a token that traded every hour with a held range is stable; dead, collapsing, thin or stale trails are not", () => {
  const steady = stabilityRead(trail(7, 20_000, [0.01, 0.011, 0.012, 0.0115, 0.011, 0.0118, 0.0112]), "STEADY", now, R);
  assert.equal(steady.stable, true, steady.why);
  assert.equal(steady.activeHours, 7);
  assert.match(steady.why, /7 active hours of 7/);
  assert.match(steady.why, /higher lows|range/);
  const dead = stabilityRead(Array.from({ length: 7 }, (_, i) => ({ hour: 4 + i, at: now - (6 - i) * H, usd: 939_648, cumUsd: 9_773_729, px: 0.1057, senders: 80 })), "DEAD", now, R);
  assert.equal(dead.stable, false);
  assert.match(dead.why, /0 active hours of 6/);
  const collapsing = stabilityRead(trail(7, 20_000, [0.01, 0.02, 0.03, 0.025, 0.015, 0.012, 0.011]), "DUMP", now, R);
  assert.equal(collapsing.stable, false);
  assert.match(collapsing.why, /off its 12-hour peak/);
  const thin = stabilityRead(trail(7, 20_000, [0.01, 0.011, 0.012, 0.0115, 0.011, 0.0118, 0.0112], 8), "THIN", now, R);
  assert.match(thin.why, /8 senders/);
  const stale = stabilityRead(trail(7, 20_000, [0.01, 0.011, 0.012, 0.0115, 0.011, 0.0118, 0.0112]).map((h) => ({ ...h, at: h.at - 3 * H })), "STALE", now, R);
  assert.match(stale.why, /last row 3.0h old/);
  const young = stabilityRead(trail(4, 20_000, [0.01, 0.011, 0.012, 0.0115]), "YOUNG", now, R);
  assert.match(young.why, /4 active hours of 4 \(6 needed\)/);
  const fading = stabilityRead(trail(7, 20_000, [0.01, 0.011, 0.012, 0.0115, 0.011, 0.0118, 0.0112]).map((h, i) => ({ ...h, cumUsd: i < 4 ? 20_000 * (i + 1) : 80_000 + 1_500 * (i - 3) })), "FADE", now, R);
  assert.equal(fading.stable, false);
  assert.match(fading.why, /recent hours at/);
});

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TOKEN = "0x00000000000000000000000000000000000000aa";
const POOL = "0x" + "ab".repeat(32);
const feedText = (withCandidateRow: boolean, gateOk = true, launchSource: string | null = "pons-v2"): string => {
  const lines = [JSON.stringify({ kind: "side-pool", id: POOL, token: TOKEN, fee: 40000, tickSpacing: 400, ts: now - 7 * H })];
  const pxs = [0.01, 0.011, 0.012, 0.0115, 0.011, 0.0118, 0.0112];
  for (let h = 0; h < 7; h++) {
    lines.push(JSON.stringify({ kind: "hourly", id: POOL, token: TOKEN, symbol: "steady", tier: 4, gateOk, launchSource, hour: h, swaps: 100 * (h + 1), volumeUsd: 20_000 * (h + 1), senders: 30 + h, ts: now - (6 - h) * H, lastHour: { swaps: 100, usd: 20_000, px: pxs[h] } }));
  }
  if (withCandidateRow) lines.push(JSON.stringify({ kind: "candidate", id: POOL, token: TOKEN, symbol: "steady", tier: 4, gateOk: true, launchSource: "pons-v2", hour: 6, volUsd: 20_000, movePct: -5, senders: 36, swaps: 100, px: 0.0112, ts: now - 10 * 60e3 }));
  return lines.join("\n") + "\n";
};
const opts = { maxAgeMs: 6 * H, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 90 * 60e3, stable: R };

test("a stable pool with no candidate row joins the candidates on its own, tradable through its side pool, at grade B for a swing", () => {
  const snap = parseFeed(feedText(false), now, opts);
  assert.equal(snap.candidates.length, 1);
  const c = snap.candidates[0];
  assert.equal(c.symbol, "STEADY");
  assert.equal(c.tickSpacing, 400);
  assert.equal(c.feePips, 40000);
  assert.equal(c.stable?.stable, true);
  assert.equal(c.volUsd, 20_000, "the last completed hour's volume");
  assert.equal(c.usdgIs0, USDG.toLowerCase() < TOKEN.toLowerCase());
  const g = gradeCandidate(c, snap.hourly[POOL], 30_000, gradeRulesFromEnv({} as NodeJS.ProcessEnv));
  assert.equal(g.grade, "B");
  assert.match(g.why, /^stable: /);
  const off = parseFeed(feedText(false), now, { ...opts, stable: undefined });
  assert.equal(off.candidates.length, 0, "without stability rules only candidate rows count");
});

test("a stable token still has to pass the watcher's gate, with or without a launch record", () => {
  assert.equal(parseFeed(feedText(false, false, "pons-v2"), now, opts).candidates.length, 0, "a failed gate stays off the board");
  assert.equal(parseFeed(feedText(false, false, null), now, opts).candidates.length, 0, "no launch record, no gate, no board");
  assert.equal(parseFeed(feedText(false, false, null), now, { ...opts, requireGate: false }).candidates.length, 1, "unless the operator turned the gate off");
});

test("a candidate row for the same token carries the stability read instead of a duplicate", () => {
  const snap = parseFeed(feedText(true), now, opts);
  assert.equal(snap.candidates.length, 1);
  assert.equal(snap.candidates[0].stable?.stable, true);
  assert.equal(snap.candidates[0].movePct, -5, "the watcher's own row stands");
});
