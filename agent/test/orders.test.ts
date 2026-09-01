import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuotes, parseOrderStatus, parseWatchlist } from "../src/obscura/orders.ts";

test("quotes with no output are dropped and the best route comes first", () => {
  const q = parseQuotes([
    { partner: "binance", toAmount: "245.10", fixed: true, cex_id: 7 },
    { partner: "swapspace", toAmount: 0 },
    { partner: "relay", toAmount: 246.02, isRelay: true },
    "garbage",
  ]);
  assert.deepEqual(q.map((x) => x.partner), ["relay", "binance"]);
  assert.equal(q[0].isRelay, true);
  assert.equal(q[1].cexId, 7);
  assert.equal(q[1].fixed, true);
  assert.deepEqual(parseQuotes({ error: "nope" }), []);
});

test("an order status parses, a miss is null, and the deposit address stays with the caller", () => {
  const o = parseOrderStatus({ id: "abc123", status: "waiting", from: { address: "0xdeposit", amount: "0.1", currency: "eth" }, to: { amount: 245.1, currency: "usdc", txHash: null }, date: { createdAt: "2026-09-01T12:00:00Z" } });
  assert.equal(o?.id, "abc123");
  assert.equal(o?.status, "waiting");
  assert.equal(o?.from.amount, 0.1);
  assert.equal(o?.from.address, "0xdeposit");
  assert.equal(o?.to.txHash, null);
  assert.equal(parseOrderStatus({ status_id: 404, error: "not found" }), null);
  assert.equal(parseOrderStatus(null), null);
});

test("the watchlist spec parses and bad entries are dropped", () => {
  const w = parseWatchlist("eth/eth->usdc/erc20:0.1, btc/btc -> eth/eth : 0.01, junk, usdg/robinhood->nvda/robinhood:0");
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], { from: { code: "eth", network: "eth" }, to: { code: "usdc", network: "erc20" }, amount: 0.1 });
  assert.deepEqual(w[1].to, { code: "eth", network: "eth" });
});
