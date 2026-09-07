import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, consoleAssets, judgeSwap, amountOutFromLogs, eligibility, isAddress, isTxHash, type ConsoleSwap } from "../src/desk/console.ts";
import { resolveAsset, type Asset } from "../src/desk/assets.ts";

const ETH = resolveAsset("ETH@robinhood") as Asset;
const USDG = resolveAsset("USDG@robinhood") as Asset;
const ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
const ME = "0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38";

test("a typed line reads as a command, however the pair is written", () => {
  assert.deepEqual(parseCommand("swap 0.05 ETH USDG"), { kind: "swap", amount: 0.05, from: "ETH", to: "USDG" });
  assert.deepEqual(parseCommand("quote 100 usdg to eth"), { kind: "quote", amount: 100, from: "USDG", to: "ETH" });
  assert.deepEqual(parseCommand("swap 1,000 USDG -> NVDA"), { kind: "swap", amount: 1000, from: "USDG", to: "NVDA" });
  assert.deepEqual(parseCommand("  help "), { kind: "help" });
  assert.deepEqual(parseCommand("?"), { kind: "help" });
  assert.deepEqual(parseCommand("bal"), { kind: "balance" });
  assert.deepEqual(parseCommand("status"), { kind: "status" });
  assert.deepEqual(parseCommand("connect"), { kind: "connect" });
  assert.deepEqual(parseCommand(""), { kind: "empty" });
  assert.deepEqual(parseCommand("swap ETH USDG"), { kind: "unknown", text: "swap ETH USDG" });
  assert.deepEqual(parseCommand("swap 0 ETH USDG"), { kind: "unknown", text: "swap 0 ETH USDG" });
  assert.deepEqual(parseCommand("dance"), { kind: "unknown", text: "dance" });
});

test("the console's ETH is Robinhood Chain's, never mainnet's, and an unknown token is said", () => {
  const p = consoleAssets("eth", "usdg");
  assert.ok(!("error" in p));
  assert.equal(p.from.network, "robinhood");
  assert.equal(p.to.symbol, "USDG");
  const q = consoleAssets("ETH@eth", "NVDA");
  assert.ok(!("error" in q));
  assert.equal(q.from.network, "robinhood", "a network written by the user is ignored: the console is one chain");
  assert.match((consoleAssets("ETH", "NOPE") as { error: string }).error, /NOPE is not a token the desk knows/);
  assert.match((consoleAssets("", "ETH") as { error: string }).error, /the from token is not/);
  assert.match((consoleAssets("ETH", "eth") as { error: string }).error, /same token/);
});

test("a swap counts only when it is theirs, went to the router, succeeded, and carried the ETH they said", () => {
  const good = { from: ME, to: ROUTER, value: 50000000000000000n };
  assert.deepEqual(judgeSwap(good, { status: "success" }, ME.toLowerCase(), ROUTER.toUpperCase().replace("0X", "0x"), ETH, 0.05), { ok: true });
  assert.equal(judgeSwap(good, { status: "reverted" }, ME, ROUTER, ETH, 0.05).ok, false);
  assert.match((judgeSwap({ ...good, from: "0x000000000000000000000000000000000000dEaD" }, { status: "success" }, ME, ROUTER, ETH, 0.05) as { reason: string }).reason, /not sent by this address/);
  assert.match((judgeSwap({ ...good, to: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" }, { status: "success" }, ME, ROUTER, ETH, 0.05) as { reason: string }).reason, /did not go to the swap router/);
  assert.match((judgeSwap({ ...good, value: 10000000000000000n }, { status: "success" }, ME, ROUTER, ETH, 0.05) as { reason: string }).reason, /ETH sent does not match/);
  assert.deepEqual(judgeSwap({ ...good, value: 50000000000000010n }, { status: "success" }, ME, ROUTER, ETH, 0.05), { ok: true }, "a rounding wei is not a mismatch");
  assert.deepEqual(judgeSwap({ from: ME, to: ROUTER, value: 0n }, { status: "success" }, ME, ROUTER, USDG, 100), { ok: true }, "a token input carries no ETH");
});

test("what the swap paid is read from the to-token's Transfer logs to the user, and ETH out is not claimed", () => {
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const me = "0x" + ME.toLowerCase().slice(2).padStart(64, "0");
  const other = "0x" + "dead".padStart(64, "0");
  const logs = [
    { address: USDG.contract as string, topics: [TRANSFER, other, me], data: "0x" + (125_259_427n).toString(16) },
    { address: USDG.contract as string, topics: [TRANSFER, me, other], data: "0x" + (1n).toString(16) },
    { address: "0x0000000000000000000000000000000000000001", topics: [TRANSFER, other, me], data: "0xff" },
  ];
  assert.equal(amountOutFromLogs(logs, USDG, ME), 125.259427);
  assert.equal(amountOutFromLogs(logs, ETH, ME), null);
  assert.equal(amountOutFromLogs([], USDG, ME), null);
});

test("eligibility is a count of this address's verified swaps against the bar, newest first", () => {
  const rows: ConsoleSwap[] = [
    { at: 1, address: ME.toLowerCase(), txHash: "0x" + "1".repeat(64), from: "ETH", to: "USDG", amountIn: 0.05, amountOut: 125, block: 1 },
    { at: 3, address: ME.toLowerCase(), txHash: "0x" + "3".repeat(64), from: "USDG", to: "ETH", amountIn: 100, amountOut: null, block: 3 },
    { at: 2, address: "0x000000000000000000000000000000000000dead", txHash: "0x" + "2".repeat(64), from: "ETH", to: "NVDA", amountIn: 0.1, amountOut: 1, block: 2 },
  ];
  const e = eligibility(ME, rows, 3);
  assert.equal(e.swaps, 2);
  assert.equal(e.required, 3);
  assert.equal(e.eligible, false);
  assert.deepEqual(e.recent.map((r) => r.at), [3, 1]);
  assert.equal(eligibility(ME, rows, 2).eligible, true);
  assert.equal(eligibility("0x000000000000000000000000000000000000dead", rows, 1).eligible, true);
  assert.ok(isAddress(ME));
  assert.ok(!isAddress("0x1234"));
  assert.ok(isTxHash("0x" + "a".repeat(64)));
  assert.ok(!isTxHash("0x" + "a".repeat(63)));
});
