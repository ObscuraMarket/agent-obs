import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRails, railsFromEnv, sentTodayUsd, mapStatus, partnerAllowed, depositAddressLooksRight, type Intent, type RailContext } from "../src/desk/rails.ts";
import { resolveAsset, assetKey } from "../src/desk/assets.ts";

const ETH = resolveAsset("ETH@robinhood")!;
const USDG = resolveAsset("USDG@robinhood")!;
const rails = railsFromEnv({ OBS_TRADING: "on", OBS_MAX_SWAP_USD: "25", OBS_DAILY_SWAP_USD: "100", OBS_MAX_OPEN_ORDERS: "1", OBS_GAS_RESERVE_ETH: "0.002" } as NodeJS.ProcessEnv);
const ctx = (over: Partial<RailContext> = {}): RailContext => ({ rails, balances: { "ETH@robinhood": 0.05, "USDG@robinhood": 40 }, nativeOnFromChain: 0.05, openOrders: 0, sentTodayUsd: 0, ...over });
const intent = (over: Partial<Intent> = {}): Intent => ({ from: ETH, to: USDG, amount: 0.005, usd: 12, ...over });

test("the registry resolves symbols, defaults networks, and refuses strangers", () => {
  assert.equal(assetKey(resolveAsset("eth")!), "ETH@eth");
  assert.equal(assetKey(resolveAsset("USDG")!), "USDG@robinhood");
  assert.equal(assetKey(resolveAsset("nvda@robinhood")!), "NVDA@robinhood");
  assert.equal(resolveAsset("DOGE"), null);
  assert.equal(resolveAsset("ETH@solana"), null);
  assert.equal(resolveAsset("ETH@base")!.deposit, false, "Obscura will not take ETH on Base as a deposit");
});

test("the rails pass a small, funded, allowlisted swap and refuse everything else in order", () => {
  assert.deepEqual(checkRails(intent(), ctx()), { ok: true });
  const no = (i: Partial<Intent>, c: Partial<RailContext> = {}) => (checkRails(intent(i), ctx(c)) as { ok: false; reason: string }).reason;
  assert.match(no({}, { rails: { ...rails, tradingOn: false } }), /trading is off/);
  assert.match(no({ to: ETH }), /same asset/);
  assert.match(no({ from: resolveAsset("ETH@base")! }, { balances: { "ETH@base": 1 } }), /allowlist/);
  assert.match(no({ usd: null }), /unpriced/);
  assert.match(no({ usd: 30 }), /per-swap cap/);
  assert.match(no({}, { sentTodayUsd: 95 }), /daily cap/);
  assert.match(no({}, { openOrders: 1 }), /already open/);
  assert.match(no({ amount: 0.1 }), /holds 0\.05/);
  assert.match(no({ amount: 0.049 }), /gas reserve/);
  assert.match(no({ from: USDG, to: ETH, amount: 10 }, { nativeOnFromChain: 0.0001 }), /gas reserve on robinhood/);
});

test("the daily cap counts sent swaps once per id and ignores proposals", () => {
  const now = 1_000_000_000_000;
  const trades = [
    { at: now - 3600e3, id: "a", status: "pending" as const, from: { asset: "ETH", amount: 0.01, usd: 24 }, to: { asset: "USDG", amount: 0, usd: null }, partner: "x" },
    { at: now - 3600e3, id: "a", updatedAt: now - 1800e3, status: "settled" as const, from: { asset: "ETH", amount: 0.01, usd: 24 }, to: { asset: "USDG", amount: 23.5, usd: null }, partner: "x" },
    { at: now - 7200e3, id: "b", status: "proposed" as const, from: { asset: "ETH", amount: 0.01, usd: 24 }, to: { asset: "USDG", amount: 0, usd: null }, partner: null },
    { at: now - 30 * 3600e3, id: "c", status: "settled" as const, from: { asset: "ETH", amount: 0.01, usd: 24 }, to: { asset: "USDG", amount: 23.5, usd: null }, partner: "x" },
  ];
  assert.equal(sentTodayUsd(trades, now), 24);
});

test("Obscura's status words map to the ledger's three states", () => {
  for (const s of ["finished", "completed", "complete", "done", "SUCCESS"]) assert.equal(mapStatus(s), "settled");
  for (const s of ["failed", "refunded", "expired", "not found"]) assert.equal(mapStatus(s), "failed");
  for (const s of ["waiting", "confirming", "exchanging", "sending", ""]) assert.equal(mapStatus(s), "pending");
});

test("partners and deposit addresses are checked", () => {
  assert.equal(partnerAllowed("StealthEX", rails), true);
  assert.equal(partnerAllowed("bybit", { ...rails, allowedPartners: new Set(["stealthex"]) }), false);
  assert.equal(depositAddressLooksRight("0x89a26d6e7f572a12CDf0252Fd0A581268dfA3F38", ETH), true);
  assert.equal(depositAddressLooksRight("bc1qxyz", ETH), false);
  assert.equal(depositAddressLooksRight(null, ETH), false);
});
