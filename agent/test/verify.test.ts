import { test } from "node:test";
import assert from "node:assert/strict";
import { spreadPct, backendState, appRouteFor, tableLines, verdicts, missingFromBackend, type PairCheck } from "../src/obscura/verify.ts";

const check = (over: Partial<PairCheck>): PairCheck => ({
  pair: "ETH@robinhood -> USDG@robinhood",
  from: "ETH@robinhood",
  to: "USDG@robinhood",
  amount: 0.05,
  backend: { status: 200, count: 0, partner: null, toAmount: null, min: null, max: null, error: null },
  relay: null,
  pool: null,
  appRoute: "relay",
  ...over,
});

test("the spread is against the pool, and the backend's state is read from its status and its count", () => {
  assert.equal(spreadPct(99, 100), -1);
  assert.equal(spreadPct(null, 100), null);
  assert.equal(spreadPct(1, 0), null);
  assert.equal(backendState({ status: 500, count: 0, partner: null, toAmount: null, min: null, max: null, error: "HTTP 500" }), "server error");
  assert.equal(backendState({ status: 200, count: 0, partner: null, toAmount: null, min: null, max: null, error: null }), "empty");
  assert.equal(backendState({ status: 200, count: 1, partner: "cex pool", toAmount: 1, min: null, max: null, error: null }), "quoted");
  assert.equal(backendState({ status: 0, count: 0, partner: null, toAmount: null, min: null, max: null, error: "fetch failed" }), "unreachable");
  assert.equal(backendState({ status: 422, count: 0, partner: null, toAmount: null, min: null, max: null, error: "HTTP 422" }), "client error");
});

test("what the partner lists on Robinhood Chain that the backend does not offer", () => {
  assert.deepEqual(missingFromBackend(["eth", "usdg", "nvda", "cashcat", "spy", "aapl", "nvda"], ["cashcat", "NVDA", "pipedog"]), ["aapl", "eth", "spy", "usdg"]);
  assert.deepEqual(missingFromBackend(["nvda"], ["nvda"]), []);
});

test("the app's door: Relay for ETH and USDG on Robinhood Chain, the backend for a token a partner lists there, the backend off the chain", () => {
  assert.equal(appRouteFor({ code: "eth", network: "robinhood" }, { code: "usdg", network: "robinhood" }), "relay");
  assert.equal(appRouteFor({ code: "eth", network: "robinhood" }, { code: "nvda", network: "robinhood" }), "backend");
  assert.equal(appRouteFor({ code: "cashcat", network: "robinhood" }, { code: "eth", network: "robinhood" }), "backend");
  assert.equal(appRouteFor({ code: "eth", network: "eth" }, { code: "usdg", network: "robinhood" }), "relay");
  assert.equal(appRouteFor({ code: "eth", network: "eth" }, { code: "usdc", network: "erc20" }), "backend");
});

test("the verdicts name the crash, the losing route and the route that is fine, problems first", () => {
  const checks: PairCheck[] = [
    check({ backend: { status: 500, count: 0, partner: null, toAmount: null, min: null, max: null, error: "HTTP 500: Internal Server Error" }, relay: { status: 200, toAmount: 125.26, impactPct: -0.07, feeUsd: 0.53, error: null }, pool: { toAmount: 125.35, costPct: 0.3 } }),
    check({ pair: "ETH@robinhood -> NVDA@robinhood", to: "NVDA@robinhood", appRoute: "backend", backend: { status: 200, count: 1, partner: "cex pool", toAmount: 0.5338, min: 0.0005, max: null, error: null }, relay: { status: 400, toAmount: null, impactPct: null, feeUsd: null, error: "UNSUPPORTED_CURRENCY: Unsupported currency" }, pool: { toAmount: 0.5342, costPct: 0.4 } }),
    check({ pair: "USDG@robinhood -> NVDA@robinhood", from: "USDG@robinhood", to: "NVDA@robinhood", amount: 100, appRoute: "backend", backend: { status: 200, count: 1, partner: "cex pool", toAmount: 0.38, min: 250, max: null, error: null }, relay: null, pool: { toAmount: 0.425, costPct: 0.4 } }),
    check({ pair: "ETH@eth -> USDC@erc20", from: "ETH@eth", to: "USDC@erc20", appRoute: "backend", backend: { status: 200, count: 3, partner: "stealthex", toAmount: 123.75, min: 0.0003, max: null, error: null } }),
  ];
  const v = verdicts(checks);
  assert.match(v[0], /^BACKEND ETH@robinhood -> USDG@robinhood: HTTP 500\. The app never asks/);
  assert.ok(v.some((l) => l.startsWith("BACKEND USDG@robinhood -> NVDA@robinhood: cex pool pays -10.59%")), v.join("\n"));
  assert.ok(v.some((l) => l.startsWith("BACKEND USDG@robinhood -> NVDA@robinhood: the partner's minimum is 250")), v.join("\n"));
  assert.ok(v.some((l) => l.startsWith("RELAY ETH@robinhood -> USDG@robinhood: within -0.07% of the pool, fees $0.53. This is the route users get.")), v.join("\n"));
  assert.ok(v.some((l) => l.startsWith("BACKEND ETH@robinhood -> NVDA@robinhood: cex pool quotes within -0.07% of the pool.")), v.join("\n"));
  assert.ok(v.some((l) => l.startsWith("RELAY ETH@robinhood -> NVDA@robinhood: UNSUPPORTED_CURRENCY: Unsupported currency. Fine")), v.join("\n"));
  assert.ok(v.some((l) => l.startsWith("BACKEND ETH@eth -> USDC@erc20: stealthex quotes 123.750 (no pool reference")), v.join("\n"));
  const firstGood = v.findIndex((l) => / within | Fine|no pool reference/.test(l));
  const lastBad = v.map((l, i) => (/HTTP 500|pays -|minimum is/.test(l) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  assert.ok(lastBad < firstGood, "problems come first");
  const t = tableLines(checks);
  assert.equal(t.length, 4);
  assert.match(t[0], /server error 500/);
  assert.match(t[0], /relay: 125\.260 \(-0\.07%\)/);
  assert.match(t[1], /backend: cex pool 0\.533800 \(-0\.07%\)/);
  assert.match(t[3], /relay: not asked/);
});
