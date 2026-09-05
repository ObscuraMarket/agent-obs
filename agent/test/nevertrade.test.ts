import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_TOKEN, NEVER_TRADE } from "../src/config.ts";
import { checkCandidate, railsFromEnv } from "../src/desk/rails.ts";
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
