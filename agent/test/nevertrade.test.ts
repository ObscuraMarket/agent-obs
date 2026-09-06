import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_TOKEN, OBS_CONTRACT, NEVER_TRADE } from "../src/config.ts";
import { checkCandidate, checkRails, railsFromEnv } from "../src/desk/rails.ts";
import { parseFeed } from "../src/desk/candidates.ts";
import { forbiddenReason } from "../src/social/postGuards.ts";

test("the desk never trades its own token: the rails refuse it, the feed never puts it on the board, and a post may name it", () => {
  assert.ok(NEVER_TRADE.has(AGENT_TOKEN));
  const rails = railsFromEnv({} as NodeJS.ProcessEnv);
  const to = { symbol: "AOBS", code: "aobs", network: "robinhood", chain: "robinhood", kind: "erc20", contract: AGENT_TOKEN, decimals: 18, deposit: true, withdrawal: true, candidate: { at: 1, poolId: "0x1", token: AGENT_TOKEN, symbol: "AOBS", tierPct: 1, feePips: 0, tickSpacing: 200, gateOk: true, source: "pons-v2", hour: 0, volUsd: 0, movePct: 0, senders: 0, swaps: 0, px: null, usdgIs0: false } };
  const from = { symbol: "ETH", code: "eth", network: "robinhood", chain: "robinhood", kind: "native", contract: null, decimals: 18, deposit: true, withdrawal: true };
  const v = checkCandidate({ from, to, amount: 0.002, usd: 5 } as never, null, [], rails);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /own token; it is never traded/);
  const now = 1_800_000_000_000;
  const feed = [
    { kind: "launch", token: AGENT_TOKEN, source: "pons-v2", ts: (now - 5 * 60e3) / 1000, symbol: "AOBS", gate: { ok: true, standard: "PonsV2LauncherToken" }, creatorTaxBps: 100, pairSymbol: "ETH", ignitionTs: (now - 2 * 60e3) / 1000 },
    { kind: "launch", token: "0xaaa0000000000000000000000000000000000001", source: "pons-v2", ts: (now - 5 * 60e3) / 1000, symbol: "OTHER", gate: { ok: true, standard: "PonsV2LauncherToken" }, creatorTaxBps: 100, pairSymbol: "ETH", ignitionTs: (now - 2 * 60e3) / 1000 },
  ].map((r) => JSON.stringify(r)).join("\n");
  const snap = parseFeed(feed, now, { maxAgeMs: 6 * 3600e3, maxTierPct: 5, requireGate: true, earlyMaxAgeMs: 90 * 60e3 });
  assert.deepEqual(snap.early.map((e) => e.symbol), ["OTHER"], "the agent's own token never reaches the board");
  assert.equal(forbiddenReason(`AOBS is live at ${AGENT_TOKEN}.`), null, "the agent's own token address may appear in a post");
  assert.match(forbiddenReason("Send it to 0x000000000000000000000000000000000000dEaD.") ?? "", /not the token/);
});

test("the wallet's AOBS is never sold, bought, or approved: the general rails refuse either leg, exits included, and $OBS is on the same list", () => {
  // 2026-09-06: the wallet holds 9,900,000 AOBS. The desk sells only what it bought, so an exit never reaches it; this makes the refusal explicit at every layer.
  assert.ok(NEVER_TRADE.has(AGENT_TOKEN));
  assert.ok(NEVER_TRADE.has(OBS_CONTRACT), "the desk's flywheel is never pointed at $OBS either");
  const rails = railsFromEnv({ OBS_TRADING: "on" } as NodeJS.ProcessEnv);
  const eth = { symbol: "ETH", code: "eth", network: "robinhood", chain: "robinhood", kind: "native", contract: null, decimals: 18, deposit: true, withdrawal: true } as const;
  const aobs = { symbol: "AOBS", code: "aobs", network: "robinhood", chain: "robinhood", kind: "erc20", contract: AGENT_TOKEN, decimals: 18, deposit: true, withdrawal: true, candidate: { at: 1, poolId: "0x1", token: AGENT_TOKEN, symbol: "AOBS", tierPct: 1, feePips: 0, tickSpacing: 200, gateOk: true, source: "pons-v2", hour: 0, volUsd: 0, movePct: 0, senders: 0, swaps: 0, px: null, usdgIs0: false } } as const;
  const ctx = { rails, balances: { "ETH@robinhood": 0.4, "AOBS@robinhood": 9_900_000 }, nativeOnFromChain: 0.4, openOrders: 0, sentTodayUsd: 0 };
  const sell = checkRails({ from: aobs, to: eth, amount: 1000, usd: 10, exit: true } as never, ctx as never);
  assert.equal(sell.ok, false, "a sell of AOBS, even marked as an exit, is refused");
  assert.match((sell as { reason: string }).reason, /never-trade list/);
  const buy = checkRails({ from: eth, to: aobs, amount: 0.01, usd: 25 } as never, ctx as never);
  assert.equal(buy.ok, false);
  assert.match((buy as { reason: string }).reason, /never-trade list/);
  const obs = { ...aobs, symbol: "OBS", code: "obs", contract: OBS_CONTRACT };
  assert.equal(checkRails({ from: eth, to: obs, amount: 0.01, usd: 25 } as never, ctx as never).ok, false, "$OBS is refused the same way");
});
