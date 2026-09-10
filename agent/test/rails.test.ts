import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRails, railsFromEnv, baseLeg, mapStatus, partnerAllowed, depositAddressLooksRight, clampToBalance, type Intent, type RailContext, dailyLossHalt, dayStartEquity, closeEvents, loopHalt } from "../src/desk/rails.ts";
import { resolveAsset, assetKey } from "../src/desk/assets.ts";

const ETH = resolveAsset("ETH@robinhood")!;
const USDG = resolveAsset("USDG@robinhood")!;
// These rails tests exercise the checks, not the default list, so USDG (registered, not routable today) is allowed here explicitly.
// The basis is on here so the fixture's ETH to USDG swap is the dollar leg, not a park; the ETH-base rule has its own test below.
const rails = railsFromEnv({ OBS_TRADING: "on", OBS_BASIS: "on", OBS_MAX_SWAP_USD: "25", OBS_MAX_OPEN_ORDERS: "1", OBS_GAS_RESERVE_ETH: "0.002", OBS_TRADE_ASSETS: "ETH@eth,USDC@erc20,ETH@robinhood,USDG@robinhood,NVDA@robinhood" } as NodeJS.ProcessEnv);
const ctx = (over: Partial<RailContext> = {}): RailContext => ({ rails, balances: { "ETH@robinhood": 0.05, "USDG@robinhood": 40 }, nativeOnFromChain: 0.05, openOrders: 0, ...over });
const intent = (over: Partial<Intent> = {}): Intent => ({ from: ETH, to: USDG, amount: 0.005, usd: 12, ...over });

test("the registry resolves symbols, defaults networks, and refuses strangers", () => {
  assert.equal(assetKey(resolveAsset("eth")!), "ETH@eth");
  assert.equal(assetKey(resolveAsset("USDG")!), "USDG@robinhood");
  assert.equal(assetKey(resolveAsset("nvda@robinhood")!), "NVDA@robinhood");
  assert.equal(resolveAsset("DOGE"), null);
  assert.equal(resolveAsset("ETH@solana"), null);
  assert.equal(resolveAsset("ETH@base")!.deposit, false, "Obscura will not take ETH on Base as a deposit");
  // The widened universe: majors and stables on Ethereum, the tokenized stock Obscura routes.
  assert.equal(assetKey(resolveAsset("wbtc")!), "WBTC@erc20");
  assert.equal(resolveAsset("WBTC@erc20")!.decimals, 8);
  for (const s of ["LINK", "UNI", "AAVE", "DAI"]) assert.equal(assetKey(resolveAsset(s)!), `${s}@erc20`);
  const rails = railsFromEnv({} as NodeJS.ProcessEnv);
  assert.deepEqual([...rails.allowedAssets].sort(), ["ETH@robinhood", "USDG@robinhood"], "the default allowlist is the base and the dollar leg; tokens join by grade");
  assert.ok(railsFromEnv({ OBS_BASIS: "on" } as NodeJS.ProcessEnv).allowedAssets.has("NVDA@robinhood"), "the stock only joins when the basis is switched on");
  assert.deepEqual([...rails.allowedChains], ["robinhood"], "the mandate: Robinhood Chain only");
  for (const k of ["WBTC@erc20", "LINK@erc20", "DAI@erc20", "USDC@erc20", "ETH@eth"]) assert.ok(!rails.allowedAssets.has(k), `${k} is registered and read, never traded`);
  assert.ok(resolveAsset("USDG@robinhood"), "the dollar leg of the basis trade");
});

test("the rails pass a small, funded, allowlisted swap and refuse everything else in order", () => {
  assert.deepEqual(checkRails(intent(), ctx()), { ok: true });
  const no = (i: Partial<Intent>, c: Partial<RailContext> = {}) => (checkRails(intent(i), ctx(c)) as { ok: false; reason: string }).reason;
  assert.match(no({}, { rails: { ...rails, tradingOn: false } }), /trading is off/);
  assert.match(no({ to: ETH }), /same asset/);
  assert.match(no({ from: resolveAsset("ETH@base")! }, { balances: { "ETH@base": 1 } }), /Robinhood Chain only/);
  // An Ethereum leg is refused by the chain rail even when the operator allowlisted it.
  const loose = { ...rails, allowedAssets: new Set([...rails.allowedAssets, "USDC@erc20"]) };
  assert.match(no({ to: resolveAsset("USDC@erc20")! }, { rails: loose }), /USDC@erc20 is on ethereum; this desk trades on Robinhood Chain only/);
  assert.match(no({ from: resolveAsset("USDG@robinhood")!, to: resolveAsset("NVDA@robinhood")!, amount: 1 }, { rails: { ...rails, allowedAssets: new Set(["ETH@robinhood"]) } }), /allowlist/);
  assert.match(no({ usd: null }), /unpriced/);
  assert.match(no({ usd: 30 }), /per-swap cap/);
  assert.deepEqual(checkRails(intent({ usd: 25.12 }), ctx()), { ok: true }, "a hair over the cap is the price having moved since the model sized the entry");
  assert.match(no({ usd: 25.5 }), /per-swap cap/, "two percent over is oversizing");
  assert.match(no({}, { openOrders: 1 }), /already open/);
  assert.match(no({ amount: 0.1 }), /holds 0\.05/);
  assert.match(no({ amount: 0.049 }), /gas reserve/);
  assert.match(no({ amount: 0.048 }), /gas reserve for the round trip/, "leaving exactly one reserve is refused: the entry's gas would put the wallet under it and every exit after it");
  assert.deepEqual(checkRails(intent({ amount: 0.046 }), ctx()), { ok: true }, "leaving two reserves passes");
  assert.match(no({ from: USDG, to: ETH, amount: 10 }, { nativeOnFromChain: 0.0001 }), /gas reserve on robinhood/);
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

test("an amount a hair over the balance means the whole balance; further over stays what was asked", () => {
  assert.equal(clampToBalance(1166.732246, 1166.73224555185), 1166.73224555185);
  assert.equal(clampToBalance(0.41, 0.41), 0.41);
  assert.equal(clampToBalance(0.5, 0.41), 0.5, "a real overask is left for the rails to refuse");
  assert.equal(clampToBalance(0.4, 0.41), 0.4);
});

test("the daily loss brake halts entries, never exits, from the day's opening mark", () => {
  const r = railsFromEnv({ OBS_TRADING: "on", OBS_DAILY_LOSS_USD: "50", OBS_DAILY_LOSS_PCT: "5", OBS_TRADE_ASSETS: "ETH@robinhood,USDG@robinhood" } as NodeJS.ProcessEnv);
  assert.equal(dailyLossHalt(1000, 960, r), null, "down $40 and 4%: under both limits");
  assert.match(dailyLossHalt(1000, 949, r)!, /down \$51\.00 .* limit is \$50/);
  assert.match(dailyLossHalt(800, 758, r)!, /down 5\.3% .* limit is 5%/);
  assert.equal(dailyLossHalt(null, 900, r), null, "no opening mark, no guessing");
  const day = Date.UTC(2026, 8, 3, 15, 0, 0);
  const snaps = [{ at: day - 3600e3 * 20, equityUsd: 1100 }, { at: day - 3600e3 * 10, equityUsd: 1000 }, { at: day - 3600e3 * 2, equityUsd: 990 }];
  assert.equal(dayStartEquity(snaps, day), 1000, "the first mark inside the UTC day, not yesterday's last");
  assert.equal(dayStartEquity([{ at: day - 3600e3 * 20, equityUsd: 1100 }], day), null);
  const halted = ctx({ dayStartEquityUsd: 1000, equityUsd: 940, rails: r });
  // An entry from USDG into ETH: not a park, so the brake is the first rail it meets.
  assert.match((checkRails(intent({ from: USDG, to: ETH, amount: 10, usd: 10 }), halted) as { ok: false; reason: string }).reason, /daily loss brake/);
  assert.deepEqual(checkRails(intent({ exit: true, from: USDG, to: ETH, amount: 10, usd: 10 }), { ...halted, balances: { "USDG@robinhood": 40, "ETH@robinhood": 0.05 } }), { ok: true }, "an exit still passes under the brake");
});

test("ETH is the base: a swap into USDG is refused as a park unless the basis needs it, and a launch-token exit comes back to ETH", () => {
  const base = railsFromEnv({ OBS_TRADING: "on" } as NodeJS.ProcessEnv);
  const c = (over: Partial<RailContext> = {}) => ctx({ rails: base, ...over });
  assert.match((checkRails(intent(), c()) as { ok: false; reason: string }).reason, /base is ETH/);
  assert.deepEqual(checkRails(intent({ from: USDG, to: ETH, amount: 10, usd: 10 }), c()), { ok: true }, "coming back to ETH is always fine");
  assert.deepEqual(checkRails(intent({ exit: true }), c()), { ok: true }, "an exit is never a park");
  assert.deepEqual(checkRails(intent(), c({ rails: railsFromEnv({ OBS_TRADING: "on", OBS_BASIS: "on" } as NodeJS.ProcessEnv) })), { ok: true }, "the basis trade needs the dollar leg");
  assert.deepEqual(checkRails(intent(), c({ rails: railsFromEnv({ OBS_TRADING: "on", OBS_BASE: "usdg" } as NodeJS.ProcessEnv) })), { ok: true }, "the operator can choose another base");
  const tok = { ...ETH, symbol: "TOK", code: "tok", kind: "erc20", contract: "0x" + "1".repeat(40), candidate: { poolId: "0x", feePips: 40000, tierPct: 4, tickSpacing: 400, usdgIs0: true, seenAt: 1 } } as unknown as typeof ETH;
  const sold = baseLeg(tok, USDG, base);
  assert.equal(sold.to.symbol, "ETH");
  assert.match(sold.note ?? "", /sold back to ETH/);
  assert.equal(baseLeg(tok, ETH, base).note, null, "already coming back to ETH");
  assert.equal(baseLeg(ETH, USDG, base).note, null, "not an exit; the rails decide that one");
  assert.equal(baseLeg(tok, USDG, rails).note, null, "with the basis on, USDG is a legitimate leg");
});

// 2026-09-09 as trade memory recorded it, real closes only, in the order they happened.
const T = (h: number, m: number) => Date.UTC(2026, 8, 9, h, m);
const yesterday = [
  { at: T(9, 48), symbol: "MANTA", realizedUsd: 29.05 },
  { at: T(12, 3), symbol: "4AI", realizedUsd: 24.52 },
  { at: T(12, 8), symbol: "BYCOCKET", realizedUsd: 1.83 },
  { at: T(13, 26), symbol: "MANTA", realizedUsd: -7.59 },
  { at: T(13, 57), symbol: "BYCOCKET", realizedUsd: 1.83 },
  { at: T(14, 37), symbol: "BARBELL", realizedUsd: -54.68 },
  { at: T(15, 7), symbol: "HARVEST", realizedUsd: -19.25 },
  { at: T(15, 27), symbol: "4AI", realizedUsd: -26.36 },
  { at: T(16, 4), symbol: "ECHELON", realizedUsd: -23.51 },
  { at: T(17, 30), symbol: "BYCOCKET", realizedUsd: 26.15 },
  { at: T(17, 30), symbol: "BYCOCKET", realizedUsd: -83.5 },
  { at: T(18, 53), symbol: "ARTON", realizedUsd: -71.54 },
];
const upTo = (h: number, m: number) => yesterday.filter((c) => c.at <= T(h, m));

test("closes become exit events: two lots sold in one swap are one exit, netted, and a paper close is not an exit", () => {
  const ev = closeEvents([...yesterday, { at: T(19, 0), symbol: "PAPER", realizedUsd: -500, paper: true }]);
  assert.equal(ev.length, 11, "twelve rows, the BYCOCKET pair merged, the paper row dropped");
  assert.equal(ev[0].symbol, "ARTON", "newest first");
  const byc = ev.find((e) => e.symbol === "BYCOCKET" && e.at === T(17, 30))!;
  assert.equal(Number(byc.realizedUsd.toFixed(2)), -57.35, "the +$26.15 and the -$83.50 are one $57.35 loss, not a win that resets a run");
  assert.equal(closeEvents([]).length, 0);
});

test("the loop brake halts entries after N losses in a row, clears on a green close, and expires on its own", () => {
  const r = railsFromEnv({ OBS_TRADING: "on", OBS_LOSS_STREAK: "3", OBS_LOSS_STREAK_HALT_H: "4", OBS_REENTRY_COOLDOWN_H: "0" } as NodeJS.ProcessEnv);
  assert.equal(loopHalt("X", upTo(15, 7), T(15, 8), r), null, "two losses in a row is not the brake");
  const halt = loopHalt("X", upTo(15, 27), T(15, 28), r)!;
  assert.match(halt, /loop brake: 3 losses in a row \(BARBELL -\$54\.68, HARVEST -\$19\.25, 4AI -\$26\.36\), the last at 15:27 UTC/);
  assert.match(halt, /no new entry for 4h after it, 4\.0h to go/);
  // What the brake would have refused on the day: every entry after 15:27, which is where $178.55 of the $203.07 went.
  for (const [h, m, sym] of [[15, 53, "ECHELON"], [16, 29, "BYCOCKET"], [17, 7, "MEME"], [17, 38, "ARTON"], [18, 18, "ARTON"]] as const) {
    assert.match(loopHalt(sym, upTo(h, m), T(h, m), r) ?? "", /loop brake/, `${sym} at ${h}:${m} is refused`);
  }
  for (const [h, m, sym] of [[13, 27, "4AI"], [14, 4, "BARBELL"], [14, 44, "HARVEST"], [15, 21, "MEME"]] as const) {
    assert.equal(loopHalt(sym, upTo(h, m), T(h, m), r), null, `${sym} at ${h}:${m} still goes`);
  }
  assert.equal(loopHalt("X", upTo(15, 27), T(19, 28), r), null, "four quiet hours after the last loss, it expires");
  assert.equal(loopHalt("X", [...upTo(15, 27), { at: T(16, 0), symbol: "WIN", realizedUsd: 12 }], T(16, 1), r), null, "one green close ends the run");
  assert.equal(loopHalt("X", upTo(15, 27), T(15, 28), railsFromEnv({ OBS_LOSS_STREAK: "0" } as NodeJS.ProcessEnv)), null, "zero disables it");
  assert.equal(loopHalt("X", null, T(15, 28), r), null, "no closes handed in: no guessing");
  assert.equal(loopHalt("X", [], T(15, 28), r), null);
});

test("a token the desk lost on is not bought back inside the cooldown, and the netted exit is what counts", () => {
  const r = railsFromEnv({ OBS_TRADING: "on", OBS_LOSS_STREAK: "0", OBS_REENTRY_COOLDOWN_H: "4" } as NodeJS.ProcessEnv);
  assert.match(loopHalt("BYCOCKET", yesterday, T(18, 0), r)!, /BYCOCKET lost \$57\.35 at 17:30 UTC; a token the desk lost on is not bought back for 4h, 3\.5h to go/);
  assert.match(loopHalt("ECHELON", yesterday, T(19, 0), r)!, /ECHELON lost \$23\.51/);
  assert.equal(loopHalt("MANTA", yesterday, T(18, 0), r), null, "MANTA's loss was at 13:26, outside the window");
  assert.equal(loopHalt("BYCOCKET", upTo(13, 57), T(14, 0), r), null, "its latest exit was a win: nothing to cool off");
  assert.equal(loopHalt("NEVER", yesterday, T(18, 0), r), null, "a token never closed has no history");
  assert.equal(loopHalt("BYCOCKET", yesterday, T(18, 0), railsFromEnv({ OBS_LOSS_STREAK: "0", OBS_REENTRY_COOLDOWN_H: "0" } as NodeJS.ProcessEnv)), null, "zero disables it (the streak is off here too, or it would answer for the run)");
});

test("the loop brake is a rail: an entry and an add-on are refused, an exit passes, and no closes means no brake", () => {
  const r = railsFromEnv({ OBS_TRADING: "on", OBS_LOSS_STREAK: "3", OBS_LOSS_STREAK_HALT_H: "4", OBS_TRADE_ASSETS: "ETH@robinhood,USDG@robinhood" } as NodeJS.ProcessEnv);
  const halted = ctx({ rails: r, closes: upTo(15, 27), now: T(15, 30) });
  const entry = intent({ from: USDG, to: ETH, amount: 10, usd: 10 });
  assert.match((checkRails(entry, halted) as { ok: false; reason: string }).reason, /loop brake: 3 losses in a row/);
  assert.match((checkRails({ ...entry, addOn: true }, halted) as { ok: false; reason: string }).reason, /loop brake/, "an add-on is money added during a losing run");
  assert.deepEqual(checkRails(intent({ exit: true, from: USDG, to: ETH, amount: 10, usd: 10 }), { ...halted, balances: { "USDG@robinhood": 40, "ETH@robinhood": 0.05 } }), { ok: true }, "an exit is never blocked");
  assert.deepEqual(checkRails(entry, ctx({ rails: r, now: T(15, 30) })), { ok: true }, "with no closes handed in, the rail stays out of the way");
  assert.equal(railsFromEnv({} as NodeJS.ProcessEnv).lossStreak, 3, "the defaults: three in a row");
  assert.equal(railsFromEnv({} as NodeJS.ProcessEnv).lossStreakHaltH, 4);
  assert.equal(railsFromEnv({} as NodeJS.ProcessEnv).reentryCooldownH, 4);
});

test("a launch token is never swapped straight into another: the buy leg would skip every entry brake as an exit", () => {
  // Review 2026-09-10: with OBS_MAX_CANDIDATES=2 the model could swap a held token A into token B. The intent counted as
  // an exit because it sells a candidate, so B was bought past the loop brake, the daily brake, spacing and the caps.
  const r = railsFromEnv({ OBS_TRADING: "on", OBS_TRADE_ASSETS: "ETH@robinhood,USDG@robinhood" } as NodeJS.ProcessEnv);
  const token = (symbol: string, contract: string) => ({ ...ETH, symbol, kind: "erc20", contract, decimals: 18, candidate: { tierPct: 1 } }) as never;
  const A = token("AAA", "0x000000000000000000000000000000000000aaaa");
  const B = token("BBB", "0x000000000000000000000000000000000000bbbb");
  const c = ctx({ rails: r, balances: { "ETH@robinhood": 0.5, "AAA@robinhood": 1000 }, nativeOnFromChain: 0.5 });
  for (const exit of [true, false]) {
    const v = checkRails({ from: A, to: B, amount: 1000, usd: 150, exit }, c);
    assert.equal(v.ok, false, `refused whether or not it is marked an exit (exit: ${exit})`);
    assert.match((v as { reason: string }).reason, /AAA to BBB is a launch token straight into another: sell to ETH first/);
  }
  // Leaving a token for the base is untouched by this rule.
  const out = checkRails({ from: A, to: ETH, amount: 1000, usd: 150, exit: true }, c);
  assert.doesNotMatch(out.ok ? "" : (out as { reason: string }).reason, /straight into another/);
});
