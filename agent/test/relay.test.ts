import { test } from "node:test";
import assert from "node:assert/strict";
import { toSmallest, relayBody, parseRelayQuote, relayQuote, relayChainId } from "../src/obscura/relay.ts";
import { resolveAsset, type Asset } from "../src/desk/assets.ts";

const ETH = resolveAsset("ETH@robinhood") as Asset;
const USDG = resolveAsset("USDG@robinhood") as Asset;
const NVDA = resolveAsset("NVDA@robinhood") as Asset;
const W = "0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38";

test("amounts go to Relay in the smallest unit without float error", () => {
  assert.equal(toSmallest(0.05, 18), "50000000000000000");
  assert.equal(toSmallest(100, 6), "100000000");
  assert.equal(toSmallest(0.1 + 0.2, 6), "300000");
  assert.equal(toSmallest(1e-7, 18), "100000000000");
  assert.equal(toSmallest(0, 18), "0");
});

test("the request is the app's: chain 4663 for Robinhood Chain, the zero address for ETH, the contract for a token", () => {
  assert.equal(relayChainId("robinhood"), 4663);
  assert.equal(relayChainId("erc20"), 1);
  assert.equal(relayChainId("sol"), null);
  const b = relayBody(ETH, USDG, 0.05, W);
  assert.ok(b);
  assert.equal(b.originChainId, 4663);
  assert.equal(b.destinationChainId, 4663);
  assert.equal(b.originCurrency, "0x0000000000000000000000000000000000000000");
  assert.equal(b.destinationCurrency.toLowerCase(), "0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  assert.equal(b.amount, "50000000000000000");
  assert.equal(b.user, W);
  assert.equal(b.recipient, W);
  assert.equal(relayBody(USDG, ETH, 100, W)?.amount, "100000000");
  assert.equal(relayBody(ETH, USDG, 0, W), null);
});

test("Relay's reply is read the way the app reads it: the formatted output, the impact, the fees, the steps", () => {
  const raw = {
    details: { currencyIn: { amountFormatted: "0.05", amountUsd: "125.34" }, currencyOut: { amountFormatted: "125.259427", amountUsd: "125.26" }, rate: "2506.69", totalImpact: { percent: "-0.07" }, timeEstimate: 0 },
    fees: { gas: { amountUsd: "0.455374" }, relayer: { amountUsd: "0.075204" }, app: { amountUsd: "0" } },
    steps: [{ id: "swap", kind: "transaction", items: [{ status: "incomplete", data: { to: "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f", value: "50000000000000000", chainId: 4663, data: "0xcd" } }] }],
  };
  const q = parseRelayQuote(raw);
  assert.ok(q);
  assert.equal(q.amountOut, 125.259427);
  assert.equal(q.amountIn, 0.05);
  assert.equal(q.impactPct, -0.07);
  assert.equal(q.feeUsd, 0.530578);
  assert.equal(q.rate, 2506.69);
  assert.deepEqual(q.steps, [{ id: "swap", kind: "transaction", txs: [{ to: "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f", value: "50000000000000000", chainId: 4663 }] }]);
  assert.equal(parseRelayQuote({ details: { currencyOut: { amountFormatted: "0" } } }), null);
  assert.equal(parseRelayQuote("nope"), null);
});

test("a refusal keeps Relay's own words, and a network failure is a reason, never a throw", async () => {
  const seen: string[] = [];
  const ok = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    seen.push(String(url));
    assert.equal(JSON.parse(String(init?.body)).originChainId, 4663);
    return new Response(JSON.stringify({ details: { currencyIn: { amountFormatted: "0.05" }, currencyOut: { amountFormatted: "125.2" } }, fees: {}, steps: [] }), { status: 200 });
  }) as typeof fetch;
  const a = await relayQuote(ETH, USDG, 0.05, W, ok);
  assert.equal(a.status, 200);
  assert.equal(a.quote?.amountOut, 125.2);
  assert.equal(seen[0], "https://api.relay.link/quote/v2");
  const refused = await relayQuote(ETH, NVDA, 0.05, W, (async () => new Response(JSON.stringify({ message: "Unsupported currency", errorCode: "UNSUPPORTED_CURRENCY" }), { status: 400 })) as typeof fetch);
  assert.deepEqual(refused, { status: 400, quote: null, error: "UNSUPPORTED_CURRENCY: Unsupported currency" });
  const down = await relayQuote(ETH, USDG, 0.05, W, (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch);
  assert.equal(down.error, "connect ECONNREFUSED");
  const off = await relayQuote(resolveAsset("ETH@eth") as Asset, { ...USDG, network: "sol" } as Asset, 1, W, ok);
  assert.equal(off.status, 0);
  assert.match(off.error ?? "", /not asked/);
});
