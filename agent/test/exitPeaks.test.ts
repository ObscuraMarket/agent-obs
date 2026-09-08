// The data dir is fixed when config.ts loads, so the throwaway dir is set before anything under src is imported.
import "./tmpdata.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config.ts";
import { exitCandidates } from "../src/desk/onchain.ts";
import { railsFromEnv, type Intent, type RailContext } from "../src/desk/rails.ts";
import { writeTapePeaks } from "../src/desk/tapePeaks.ts";
import type { Candidate, FeedSnapshot } from "../src/desk/candidates.ts";
import type { SwapRow } from "../src/desk/tape.ts";
import type { Trade } from "../src/desk/book.ts";

const M = 60e3;
const H = 3600e3;
const t0 = Date.UTC(2026, 8, 8, 10, 0, 0);
const poolId = `0x${"ab".repeat(32)}` as `0x${string}`;
const token = `0x${"11".repeat(20)}` as `0x${string}`;
// A hookless USDG pool: the quote prices at one, so the figures below are dollars per token as well as quote units.
const candidate: Candidate = { at: t0 - H, poolId, token, symbol: "TOK", tierPct: 1, feePips: 10000, tickSpacing: 200, gateOk: true, source: "test", hour: 1, volUsd: 1000, movePct: 0, senders: 5, swaps: 5, px: null, usdgIs0: true };
const feed: FeedSnapshot = { candidates: [candidate], early: [], hourly: {}, readAt: t0, path: null };
const row = (at: number, price: number, block: number): SwapRow => ({ at, block, tx: `0x${block}:0`, side: "buy", tokenAmount: 1, quoteAmount: price, price });
const rails = railsFromEnv({ OBS_TRADING: "on", OBS_CANDIDATE_MAX_HOLD_H: "6", OBS_CANDIDATE_FLOOR_PCT: "40", OBS_CANDIDATE_TRAIL_ARM_PCT: "30", OBS_CANDIDATE_TRAIL_PCT: "25", OBS_CANDIDATE_TAKE_PROFIT_PCT: "60" } as NodeJS.ProcessEnv);

test("the cycle's exit pass reads the watch's persisted peak: a trail the tape's window and the samples alone would not give", async () => {
  const now = t0 + 2 * H;
  // The desk bought a million TOK for $100 at the cycle's start; the fill landed a minute later.
  const buy: Trade = { at: t0, id: "b1", status: "settled", venue: "pool", partner: "pool", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "TOK", amount: 1_000_000, usd: null }, updatedAt: t0 + M, settlementTx: "0xfillb1" };
  // The tape's window holds one swap, at +20%: under the 30% arm on its own.
  mkdirSync(join(DATA_DIR, "tape"), { recursive: true });
  writeFileSync(join(DATA_DIR, "tape", `${poolId}.jsonl`), JSON.stringify(row(now - M, 0.00012, 10)) + "\n");
  const sold: Intent[] = [];
  const exec = async (i: Intent, _c: RailContext, at: number) => {
    sold.push(i);
    const trade: Trade = { at, id: `x${sold.length}`, status: "settled", venue: "pool", partner: "pool", exit: true, from: { asset: i.from.symbol, amount: i.amount, usd: i.usd }, to: { asset: "ETH", amount: 0.04, usd: null }, updatedAt: at, settlementTx: "0xsold" };
    return { ok: true as const, trade };
  };
  const ctx: RailContext = { rails, balances: { "TOK@robinhood": 1_000_000, "ETH@robinhood": 0.1 }, nativeOnFromChain: 0.1, openOrders: 0, now };
  const balances = { TOK: 1_000_000, ETH: 0.1 };
  const prices = { ETH: 2500, TOK: null };
  assert.deepEqual(await exitCandidates(balances, prices, ctx, feed, now, exec, [buy]), [], "off the tape's window alone the trail is not armed");
  assert.equal(sold.length, 0);
  // The watch saw the position at +100% two hours ago, outside the window, and wrote it down (2026-09-08).
  writeTapePeaks([{ symbol: "TOK", firstBuy: t0, quote: "USDG", peakQuote: 0.0002, at: t0 + 10 * M }]);
  const out = await exitCandidates(balances, prices, ctx, feed, now, exec, [buy]);
  assert.equal(sold.length, 1, "the persisted peak arms the trail, and the give-back from it has fired");
  assert.equal(sold[0].from.symbol, "TOK");
  assert.equal(sold[0].exit, true);
  assert.equal(out.length, 1);
  assert.match(out[0].note ?? "", /^exit \(trail\)/);
  // A peak from an earlier position of the token, or in another quote, arms nothing.
  writeTapePeaks([{ symbol: "TOK", firstBuy: t0 - 5 * H, quote: "USDG", peakQuote: 0.0002, at: t0 - 4 * H }]);
  assert.deepEqual(await exitCandidates(balances, prices, ctx, feed, now, exec, [buy]), [], "an earlier position's peak is not this one's");
  writeTapePeaks([{ symbol: "TOK", firstBuy: t0, quote: "ETH", peakQuote: 0.0002, at: t0 + 10 * M }]);
  assert.deepEqual(await exitCandidates(balances, prices, ctx, feed, now, exec, [buy]), [], "a peak in another quote is not read");
  assert.equal(sold.length, 1);
});
