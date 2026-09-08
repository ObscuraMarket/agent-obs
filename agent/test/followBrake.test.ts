// A follower's own loss brake, spacing and add-on scaling (2026-09-08): before this the mirror handed the rails no
// equity and no last entry, so a $5 desk probe bought a full follower size and nothing capped a follower's day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { followLossLimits, followerRails, entryFraction, scaledEntryUsd, deskFullTicketUsd, followerEquity, followerEntryHalt, MIN_ENTRY_USD } from "../src/desk/mirror.ts";
import { utcDay, dayStartMark, markOrNew, capitalSinceUsd, followerEquityUsd, followersToMark, latestPrices, liveTrades, liveHoldings, type FollowMarkRow, type FollowTradeRow, type FollowRow } from "../src/desk/follow.ts";
import { railsFromEnv, lastEntryAt, spacingHalt, checkRails, type Intent, type RailContext } from "../src/desk/rails.ts";
import { positions } from "../src/desk/book.ts";
import { ASSETS } from "../src/desk/assets.ts";
import type { AgentCapitalRow } from "../src/desk/agentWallet.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
// 2026-09-08 10:00:00Z, well inside a UTC day.
const T = Date.UTC(2026, 8, 8, 10, 0, 0);
const min = (n: number) => T + n * 60_000;
const env = (o: Record<string, string> = {}) => ({ OBS_TRADING: "on", OBS_MAX_SWAP_USD: "200", OBS_MIN_HOURS_BETWEEN_ENTRIES: "0.5", OBS_DAILY_LOSS_USD: "250", OBS_DAILY_LOSS_PCT: "15", ...o }) as NodeJS.ProcessEnv;

test("the day's mark: the first look writes it, later looks reuse it whatever the equity does, a new UTC day writes a new one", () => {
  assert.equal(utcDay(T), "2026-09-08");
  const first = markOrNew([], A, 1000, T);
  assert.equal(first.fresh, true, "no mark for the day: this look writes one");
  assert.deepEqual(first.mark, { address: A, day: "2026-09-08", equityUsd: 1000, at: T });
  const ledger: FollowMarkRow[] = [first.mark];
  const later = markOrNew(ledger, A, 700, min(90));
  assert.equal(later.fresh, false, "the day has its mark; the equity now is not it");
  assert.equal(later.mark.equityUsd, 1000);
  assert.equal(markOrNew(ledger, A.toUpperCase(), 700, min(90)).fresh, false, "the address is matched whatever its case");
  assert.equal(markOrNew(ledger, B, 500, min(90)).fresh, true, "another follower has its own mark");
  const tomorrow = Date.UTC(2026, 8, 9, 0, 0, 1);
  const next = markOrNew(ledger, A, 700, tomorrow);
  assert.equal(next.fresh, true, "a new UTC day starts from the equity then, not yesterday's mark");
  assert.equal(next.mark.day, "2026-09-09");
  assert.equal(dayStartMark(ledger, A, Date.UTC(2026, 8, 7, 23, 59, 59)), null, "a moment before the mark's day has no mark");
  // Two rows for one day (a race between two processes): the earliest is the day's mark.
  const doubled = [...ledger, { address: A, day: "2026-09-08", equityUsd: 990, at: T + 5 }];
  assert.equal(dayStartMark(doubled, A, min(10))?.equityUsd, 1000);
  assert.equal(dayStartMark([{ address: A, day: "2026-09-08", equityUsd: 0, at: T }], A, min(10)), null, "a mark of nothing is not a mark: the brake would divide by it");
});

test("a /fund after the mark is not a gain and a /withdraw is not a loss: the mark moves with them", () => {
  const tx = (n: number) => `0x${String(n).padStart(64, "0")}`;
  const flows: AgentCapitalRow[] = [
    { address: A, at: min(-30), kind: "deposit", asset: "ETH", amount: 0.4, usd: 1000, txHash: tx(1) },
    { address: A, at: min(20), kind: "deposit", asset: "ETH", amount: 0.2, usd: 500, txHash: tx(2) },
    { address: A, at: min(40), kind: "withdraw", asset: "ETH", amount: 0.08, usd: 200, txHash: tx(3) },
    { address: A, at: min(50), kind: "withdraw-token", asset: "PENGUIN", amount: 100, usd: 25, txHash: tx(4) },
    { address: A, at: min(55), kind: "withdraw", asset: "ETH", amount: 0.01, usd: null, txHash: tx(5) },
    { address: B, at: min(20), kind: "deposit", asset: "ETH", amount: 1, usd: 2500, txHash: tx(6) },
    { address: A, at: min(120), kind: "deposit", asset: "ETH", amount: 0.4, usd: 1000, txHash: tx(7) },
  ];
  assert.equal(capitalSinceUsd(flows, A, T, min(60)), 275, "500 in, 200 and 25 out; the unpriced row and the other wallet's row move nothing; the deposit before the mark is in the mark");
  assert.equal(capitalSinceUsd(flows, A, T, min(60)), capitalSinceUsd(flows, A.toUpperCase(), T, min(60)));
  assert.equal(capitalSinceUsd(flows, A, min(60), min(60)), 0);
  // A funding that landed before the mark and was verified after it is already in the mark (review, 2026-09-08):
  // the row is placed by when its ETH landed, not by when the desk verified it; the $500 verified at +20 landed at -10.
  const landedEarlier = flows.map((r) => (r.txHash === tx(2) ? { ...r, landedAt: min(-10) } : r));
  assert.equal(capitalSinceUsd(landedEarlier, A, T, min(60)), -225, "200 and 25 out, nothing in since the mark");
  const landedLater = flows.map((r) => (r.txHash === tx(1) ? { ...r, landedAt: min(5) } : r));
  assert.equal(capitalSinceUsd(landedLater, A, T, min(60)), 1275, "and one recorded before the mark that landed after it moves the mark");
  // A withdrawal of a fifth of the wallet is not a 20% drawdown: the mark comes down with it and the brake stays off.
  const r = followerRails(railsFromEnv(env()), {} as NodeJS.ProcessEnv);
  const dayStart = 1000 + capitalSinceUsd([{ address: A, at: min(20), kind: "withdraw", asset: "ETH", amount: 0.08, usd: 200, txHash: tx(8) }], A, T, min(30));
  assert.equal(followerEntryHalt({ rails: r, dayStartEquityUsd: dayStart, equityUsd: 800, lastEntryAt: null, addOn: false, now: min(30) }), null);
});

test("a follower's equity is its ETH in dollars plus its tokens marked the way its book marks them, or unknown", () => {
  const rows: FollowTradeRow[] = [
    { address: A, deskId: "d1", at: min(-60), id: "p1", status: "settled", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "PENGUIN", amount: 500, usd: 100 }, partner: "pool", venue: "pool" },
    { address: A, deskId: "d2", at: min(-50), id: "p2", status: "pending", from: { asset: "ETH", amount: 0.02, usd: 50 }, to: { asset: "DOHJ", amount: 1000, usd: 50 }, partner: "pool", venue: "pool" },
  ];
  const samples = [
    { at: min(-200), symbol: "PENGUIN", priceUsd: 0.1 },
    { at: min(-5), symbol: "penguin", priceUsd: 0.15 },
    { at: min(-4), symbol: "DOHJ", priceUsd: 0.04 },
    { at: min(-400), symbol: "KOT", priceUsd: 9 },
    { at: min(5), symbol: "DOHJ", priceUsd: 1 },
  ];
  const prices = latestPrices(samples, T);
  assert.deepEqual(prices, { PENGUIN: 0.15, DOHJ: 0.04 }, "the latest sample within three hours, upper-cased; the sample from the future and the stale one are not marks");
  const pos = positions([], liveTrades(rows, A), liveHoldings(rows, A), prices);
  assert.deepEqual(followerEquityUsd(0.1, 2500, pos), { usd: 250 + 75 + 50, unpriced: [] }, "0.1 ETH at $2500, 500 PENGUIN at $0.15, and the $50 of ETH still in flight to DOHJ, which is not a position until its receipt");
  assert.equal(followerEquityUsd(null, 2500, pos), null, "no wallet read, no equity");
  assert.equal(followerEquityUsd(0.1, null, pos), null, "ETH unpriced, no equity");
  // A token with no price is valued at its cost and named, so the brake still reads the rest (review, 2026-09-08:
  // one unpriced token made the equity unknown and switched the brake off entirely).
  assert.deepEqual(followerEquityUsd(0.1, 2500, positions([], liveTrades(rows, A), liveHoldings(rows, A), { DOHJ: 0.04 })), { usd: 250 + 100 + 50, unpriced: ["PENGUIN"] }, "PENGUIN at its $100 cost");
  const blind: FollowTradeRow[] = [{ ...rows[1], from: { ...rows[1].from, usd: null } }];
  assert.deepEqual(followerEquityUsd(0.1, 2500, positions([], liveTrades(blind, A), liveHoldings(blind, A), prices)), { usd: 250, unpriced: ["DOHJ"] }, "an in-flight swap with no dollars counts nothing and is named; the ETH alone is left");
  assert.deepEqual(followerEquityUsd(0.1, 2500, positions([], [], {}, {})), { usd: 250, unpriced: [] }, "nothing held: the ETH alone");
  // The whole reading, as the mirror and the mark pass ask it: the freshest sample of any age marks a token, and a
  // token marked from a sample older than the window is named as stale. RUG unpriced plus PORT down 90% is a brake, not a null.
  const crash: FollowTradeRow[] = [
    { address: A, deskId: "d1", at: min(-600), id: "c1", status: "settled", from: { asset: "ETH", amount: 0.2, usd: 500 }, to: { asset: "PORT", amount: 1000, usd: 500 }, partner: "pool", venue: "pool" },
    { address: A, deskId: "d2", at: min(-600), id: "c2", status: "settled", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "RUG", amount: 10, usd: 100 }, partner: "pool", venue: "pool" },
  ];
  const eq = followerEquity(0.1, 2500, liveTrades(crash, A), liveHoldings(crash, A), [{ at: min(-500), symbol: "PORT", priceUsd: 0.5 }, { at: min(-5), symbol: "PORT", priceUsd: 0.05 }], T)!;
  assert.deepEqual(eq, { usd: 250 + 50 + 100, unpriced: ["RUG"], stale: [] }, "PORT at its fresh sample, RUG at cost");
  const staleEq = followerEquity(0.1, 2500, liveTrades(crash, A), liveHoldings(crash, A), [{ at: min(-500), symbol: "PORT", priceUsd: 0.05 }], T)!;
  assert.deepEqual(staleEq, { usd: 250 + 50 + 100, unpriced: ["RUG"], stale: ["PORT"] }, "PORT at its last sample, eight hours old, and named as stale");
  assert.match(followerEntryHalt({ rails: followerRails(railsFromEnv(env()), {} as NodeJS.ProcessEnv), dayStartEquityUsd: 850, equityUsd: eq.usd, lastEntryAt: null, addOn: false, now: T })!, /daily loss brake: down 52\.9%/);
  assert.equal(followerEquity(null, 2500, [], {}, [], T), null);
});

test("the followers due a mark are the live ones on with no mark for the UTC day", () => {
  const rows: FollowRow[] = [
    { address: A, at: min(-60), action: "start", mode: "live", sizeUsd: 100 },
    { address: B, at: min(-60), action: "start", mode: "paper", sizeUsd: 100 },
    { address: "0x3333333333333333333333333333333333333333", at: min(-60), action: "start", mode: "live", sizeUsd: 100 },
    { address: "0x3333333333333333333333333333333333333333", at: min(-30), action: "stop" },
    { address: "0x4444444444444444444444444444444444444444", at: min(-60), action: "start", mode: "live", sizeUsd: 100 },
  ];
  const marks: FollowMarkRow[] = [{ address: "0x4444444444444444444444444444444444444444", day: "2026-09-08", equityUsd: 500, at: min(-20) }];
  assert.deepEqual(followersToMark(rows, marks, T), [A], "B is on paper, 0x3333 is off, 0x4444 has today's mark");
  assert.deepEqual(followersToMark(rows, marks, Date.UTC(2026, 8, 9, 0, 0, 1)), [A, "0x4444444444444444444444444444444444444444"], "a new UTC day: yesterday's mark is not today's");
  assert.deepEqual(followersToMark([], marks, T), []);
});

test("the follower's brake at the boundary: its own limits, the desk's numbers left aside, exits never braked", () => {
  const desk = railsFromEnv(env());
  assert.deepEqual(followLossLimits({} as NodeJS.ProcessEnv), { dailyLossPct: 15, dailyLossUsd: Infinity }, "15% unless set; the dollar limit off unless set");
  assert.deepEqual(followLossLimits({ OBS_FOLLOW_DAILY_LOSS_PCT: "10", OBS_FOLLOW_DAILY_LOSS_USD: "40" } as NodeJS.ProcessEnv), { dailyLossPct: 10, dailyLossUsd: 40 });
  assert.deepEqual(followLossLimits({ OBS_FOLLOW_DAILY_LOSS_PCT: "0", OBS_FOLLOW_DAILY_LOSS_USD: "lots" } as NodeJS.ProcessEnv), { dailyLossPct: Infinity, dailyLossUsd: Infinity }, "zero or unreadable is off");
  const r = followerRails(desk, {} as NodeJS.ProcessEnv);
  assert.equal(r.dailyLossPct, 15);
  assert.equal(r.dailyLossUsd, Infinity, "the desk's $250 is the desk's");
  assert.equal(r.minHoursBetweenEntries, 0.5, "everything else is the desk's");
  const at = (equityUsd: number, dayStartEquityUsd: number | null = 1000) => followerEntryHalt({ rails: r, dayStartEquityUsd, equityUsd, lastEntryAt: null, addOn: false, now: T });
  assert.equal(at(850.01), null, "down 14.999%: under the limit");
  assert.match(at(850)!, /^your agent's daily loss brake: down 15\.0% since 00:00 UTC, the limit is 15%; no new entries until tomorrow$/, "down exactly 15%: braked");
  assert.match(at(600)!, /down 40\.0%/);
  assert.equal(at(1200), null, "up on the day");
  assert.equal(at(600, null), null, "no mark, no guessing: the brake stays off");
  // The desk's $250 would have braked a $1000 wallet at $749; the follower's dollar limit is off, so only the percent speaks.
  assert.match(at(700)!, /down 30\.0%/);
  const withUsd = followerRails(desk, { OBS_FOLLOW_DAILY_LOSS_USD: "40" } as NodeJS.ProcessEnv);
  assert.match(followerEntryHalt({ rails: withUsd, dayStartEquityUsd: 1000, equityUsd: 960, lastEntryAt: null, addOn: false, now: T })!, /down \$40\.00 since 00:00 UTC, the limit is \$40/, "a dollar limit the operator set, at the boundary");
  assert.equal(followerEntryHalt({ rails: withUsd, dayStartEquityUsd: 1000, equityUsd: 960.01, lastEntryAt: null, addOn: false, now: T }), null);
  // The same numbers through the rails themselves: the lane's own check refuses the entry too, and never an exit.
  const eth = ASSETS["ETH@robinhood"];
  const tok = { ...ASSETS["USDG@robinhood"], symbol: "PENGUIN", contract: "0x000000000000000000000000000000000000dead", candidate: { poolId: "0xpool", tierPct: 1 } } as unknown as Intent["to"];
  const ctx: RailContext = { rails: r, balances: { "ETH@robinhood": 0.1, "PENGUIN@robinhood": 500 }, nativeOnFromChain: 0.1, openOrders: 0, dayStartEquityUsd: 1000, equityUsd: 850, lastEntryAt: null, now: T };
  const entry: Intent = { from: eth, to: tok, amount: 0.02, usd: 50, capUsd: 100 };
  assert.match((checkRails(entry, ctx) as { reason: string }).reason, /daily loss brake/);
  const exit: Intent = { from: tok, to: eth, amount: 500, usd: 60, exit: true };
  assert.equal(checkRails(exit, ctx).ok, true, "an exit is never braked; the follower's tokens leave with the desk's");
});

test("spacing runs from the follower's own rows, not the desk's; an add-on of a token it holds is not spaced", () => {
  const r = followerRails(railsFromEnv(env()), {} as NodeJS.ProcessEnv);
  const rows: FollowTradeRow[] = [
    { address: A, deskId: "d1", at: min(-20), id: "p1", status: "settled", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "PENGUIN", amount: 500, usd: 100 }, partner: "pool", venue: "pool" },
    { address: A, deskId: "d2", at: min(-10), id: "p2", status: "settled", exit: true, from: { asset: "PENGUIN", amount: 500, usd: 120 }, to: { asset: "ETH", amount: 0.048, usd: 120 }, partner: "pool", venue: "pool" },
    { address: A, deskId: "d3", at: min(-8), id: "p3", status: "failed", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "DOHJ", amount: 1, usd: 100 }, partner: "pool", venue: "pool" },
    { address: B, deskId: "d4", at: min(-2), id: "p4", status: "settled", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "KOT", amount: 1, usd: 100 }, partner: "pool", venue: "pool" },
  ];
  const mine = liveTrades(rows, A);
  assert.equal(lastEntryAt(mine), min(-20), "the exit and the failed row are not entries; B's row is B's");
  const halt = (lastEntry: number | null, now: number, addOn = false) => followerEntryHalt({ rails: r, dayStartEquityUsd: 1000, equityUsd: 1000, lastEntryAt: lastEntry, addOn, now });
  assert.match(halt(lastEntryAt(mine), T)!, /^your agent's last entry was 0\.3h ago; entries are at least 0\.5h apart$/, "twenty minutes since its own last entry, under the half hour");
  assert.equal(halt(lastEntryAt(mine), min(10)), null, "thirty minutes: on time");
  assert.equal(halt(null, T), null, "no entry yet: nothing to space from");
  assert.equal(halt(lastEntryAt(mine), T, true), null, "an add-on of a token it holds is a continuation, not spaced");
  assert.equal(lastEntryAt(liveTrades(rows, B)), min(-2), "B's entry two minutes ago is B's alone; A's spacing never saw it");
  // A pending entry counts: the ETH has gone out.
  const pending: FollowTradeRow[] = [{ address: A, deskId: "d5", at: min(-5), id: "p5", status: "pending", from: { asset: "ETH", amount: 0.04, usd: 100 }, to: { asset: "KOT", amount: 1, usd: 100 }, partner: "pool", venue: "pool" }];
  assert.equal(lastEntryAt(liveTrades([...rows, ...pending], A)), min(-5));
  // The rule is the desk's own, one function: the desk's wording and the follower's differ only in whose entry it was.
  assert.equal(spacingHalt(min(-20), T, r), "the last entry was 0.3h ago; entries are at least 0.5h apart");
  assert.equal(spacingHalt(min(-20), T, { ...r, minHoursBetweenEntries: 0 }), null, "no spacing set: none applied");
  // The brake comes before the spacing: a braked follower hears about the brake, the reason that lasts the day.
  assert.match(followerEntryHalt({ rails: r, dayStartEquityUsd: 1000, equityUsd: 800, lastEntryAt: min(-20), addOn: false, now: T })!, /daily loss brake/);
});

test("an entry the desk sized under its full ticket is the same fraction of the follower's size, never above the size, never dust", () => {
  // The full ticket is the smaller of the swap cap and the grade A cap (review, 2026-09-08: the swap cap alone made a
  // grade B entry a quarter of a follower's size once the live rails set it above the grade caps).
  assert.equal(deskFullTicketUsd({ maxSwapUsd: 25 }, {} as NodeJS.ProcessEnv), 25, "the default rails: the $25 swap cap under the $75 A cap");
  assert.equal(deskFullTicketUsd({ maxSwapUsd: 100 }, {} as NodeJS.ProcessEnv), 75, "a $100 swap cap: the $75 A cap is the desk's biggest normal ticket");
  assert.equal(deskFullTicketUsd({ maxSwapUsd: 100 }, { OBS_CANDIDATE_MAX_USD_A: "150" } as NodeJS.ProcessEnv), 100);
  assert.equal(deskFullTicketUsd({ maxSwapUsd: Number.NaN }, { OBS_CANDIDATE_MAX_USD_A: "60" } as NodeJS.ProcessEnv), 60, "an unreadable swap cap is left out");
  assert.equal(entryFraction(200, 200), 1, "a full-size desk entry");
  assert.equal(entryFraction(5, 200), 0.025, "a $5 probe against a $200 ticket");
  assert.equal(entryFraction(5, deskFullTicketUsd({ maxSwapUsd: 25 }, {} as NodeJS.ProcessEnv)), 0.2, "a $5 probe on the default rails is a fifth");
  assert.equal(entryFraction(25, deskFullTicketUsd({ maxSwapUsd: 100 }, {} as NodeJS.ProcessEnv)), 1 / 3, "a grade B entry against the A cap");
  assert.equal(entryFraction(50, 200), 0.25, "an add-on of a quarter");
  assert.equal(entryFraction(210, 200), 1, "the price moved a hair over the ticket: still the full size, never more");
  assert.equal(entryFraction(null, 200), 1, "unpriced desk entry: the full size, as before");
  assert.equal(entryFraction(50, 0), 1, "no ticket set: the full size");
  assert.equal(scaledEntryUsd(100, 5, 200), 2.5, "a $100 follower puts $2.50 into the desk's $5 probe");
  assert.equal(scaledEntryUsd(100, 50, 200), 25);
  assert.equal(scaledEntryUsd(100, 200, 200), 100);
  assert.equal(scaledEntryUsd(100, 300, 200), 100, "never above the size");
  assert.equal(scaledEntryUsd(33, 10, 200), 1.65, "to the cent");
  assert.equal(scaledEntryUsd(10, 5, 200), 0.25);
  assert.ok(scaledEntryUsd(10, 5, 200) < MIN_ENTRY_USD, "a $10 follower's share of a $5 probe is a quarter: a note, not a swap");
  assert.ok(scaledEntryUsd(100, 5, 200) >= MIN_ENTRY_USD);
});
