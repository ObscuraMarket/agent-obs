// The live mirror: one brain, many executors. When the desk's own trade lands, every agent that is on and live sends
// the same trade from its own funded wallet at its own size, through the same lane (rails, route, quote, floor,
// simulate, send, receipt), and every agent that holds the token sells the same share when the desk sells. The
// agents decide nothing; Agent OBS does. Each agent's rows go to its own ledger, and a trade that cannot be made
// (no ETH, a refused rail, a revert) is written down as a note the person reads with /agent, never hidden.
//
// Pure where it matters: how much an agent puts in, what share it sells, and who acts on a trade are functions
// tested offline; the sends themselves are the lane's, the same code that trades the desk's own money.
import { ASSETS, assetKey } from "./assets.ts";
import { railsFromEnv, dailyLossHalt, spacingHalt, lastEntryAt, type Intent, type RailContext, type Rails } from "./rails.ts";
import { executeOnChain, latestEthUsd, quoteOnChain } from "./onchain.ts";
import { readNativeBalance, readTokenBalance } from "./signer.ts";
import { agentWallet, walletsOn, quoteUsd, readAgentCapital } from "./agentWallet.ts";
import { acquire } from "./walletLock.ts";
import { readFollow, followState, readFollowTrades, recordFollowTrade, recordFollowNote, liveHoldings, liveTrades, followerEquityUsd, followDayStart, capitalSinceUsd, latestPrices, type FollowRow, type FollowTradeRow } from "./follow.ts";
import { readBook, holdingsFrom, isHolding, positions, type Trade, type CapitalFlow } from "./book.ts";
import { readPrices } from "./analysis.ts";
import { raiseAlert } from "./alerts.ts";
import { doorNow } from "./gate.ts";
import { resolveAny } from "./candidates.ts";
import { dataPath } from "../config.ts";
import { readFileSync, writeFileSync } from "node:fs";

/** Live mirroring runs when agent wallets exist and the operator has not switched it off (OBS_FOLLOW_LIVE=off). */
export const liveOn = (env: NodeJS.ProcessEnv = process.env): boolean => (env.OBS_FOLLOW_LIVE ?? "on").trim().toLowerCase() !== "off" && walletsOn(env);

/**
 * PURE: the ETH an agent puts into an entry: its size at the desk's ETH price, within what its wallet holds above
 * the gas reserve. Less than half the size is not an entry worth making; it is a note instead.
 */
export function entryAmountEth(sizeUsd: number, ethUsd: number, balanceEth: number, gasReserveEth: number): { amount: number } | { reason: string } {
  if (!(ethUsd > 0)) return { reason: "ETH is unpriced right now" };
  const want = sizeUsd / ethUsd;
  // The reserve is kept twice over: once for this entry's gas and once for the exit's, since the exit rail refuses a
  // wallet under the reserve, and an entry sized to the reserve exactly left the wallet just under it (2026-09-08).
  const room = balanceEth - gasReserveEth * 2;
  if (!(room > 0) || room < want * 0.5) return { reason: `the agent's wallet holds ${balanceEth.toFixed(4)} ETH; $${sizeUsd} at $${ethUsd.toFixed(0)} an ETH needs ${want.toFixed(4)} ETH plus ${(gasReserveEth * 2).toFixed(4)} ETH of gas reserve for the round trip` };
  // Eight significant digits, never rounded up past the room: a round-up of a wei past the reserve was refused by the rails.
  const amt = Math.min(want, room);
  const r8 = Number(amt.toPrecision(8));
  return { amount: r8 > amt ? amt : r8 };
}

/**
 * PURE: whether an agent may start live: its wallet covers an entry by the mirror's own rule (half the size above
 * the gas reserve), or it already holds tokens it bought live, which stay live whatever its ETH is. A stricter bar
 * at /start than at the entry itself left a live agent holding two tokens unable to restart after a /stop, and a
 * paper start then hid what it held (2026-09-08).
 */
export function canStartLive(sizeUsd: number, ethUsd: number | null, balanceEth: number, gasReserveEth: number, holdsLive: boolean): { ok: true } | { ok: false; reason: string } {
  if (holdsLive) return { ok: true };
  if (!(ethUsd != null && ethUsd > 0)) return { ok: false, reason: "ETH is unpriced right now; try again in a moment" };
  const r = entryAmountEth(sizeUsd, ethUsd, balanceEth, gasReserveEth);
  if ("amount" in r) return { ok: true };
  const least = (sizeUsd / ethUsd) * 0.5 + gasReserveEth * 2;
  return { ok: false, reason: `Your agent's wallet holds ${balanceEth.toFixed(4)} ETH; $${sizeUsd} a trade needs at least ${least.toFixed(4)} ETH (half the size above ${(gasReserveEth * 2).toFixed(4)} ETH of gas reserve for the round trip). /fund it first, or /start paper.` };
}

// ---- A follower's own brake, spacing and size, on top of the desk's decision. Until 2026-09-08 the mirror handed
// the rails no equity and no last entry, so every desk entry, a $5 probe included, bought a full follower size with
// no ceiling on what a follower could lose in a day. The desk still decides; these decide how much, and whether now.

/** The smallest entry worth its gas: an entry scaled under this is a note, not a swap. */
export const MIN_ENTRY_USD = 1;

/**
 * PURE: the follower loss limits, the operator's variables: OBS_FOLLOW_DAILY_LOSS_PCT (15 unless set) and
 * OBS_FOLLOW_DAILY_LOSS_USD (0, meaning off: the desk's dollar limit is the desk's, not a $50 wallet's). Zero,
 * blank or unreadable means that limit is off.
 */
export function followLossLimits(env: NodeJS.ProcessEnv = process.env): { dailyLossPct: number; dailyLossUsd: number } {
  const pick = (raw: string | undefined, dflt: number): number => {
    const n = raw == null || raw.trim() === "" ? dflt : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : Infinity;
  };
  return { dailyLossPct: pick(env.OBS_FOLLOW_DAILY_LOSS_PCT, 15), dailyLossUsd: pick(env.OBS_FOLLOW_DAILY_LOSS_USD, 0) };
}

/** PURE: the desk's rails with the follower's two brake numbers in place of the desk's; everything else is the desk's. */
export function followerRails(rails: Rails, env: NodeJS.ProcessEnv = process.env): Rails {
  return { ...rails, ...followLossLimits(env) };
}

/**
 * PURE: the fraction of its full size the desk put into this entry: its dollars over its per-swap cap, so a $5
 * probe against a $200 cap is 2.5% and a follower puts 2.5% of its size in, never more than the whole size.
 * Unknown dollars or an unset cap mean the full size, as before.
 */
export function entryFraction(deskUsd: number | null | undefined, deskCapUsd: number): number {
  if (deskUsd == null || !(deskUsd > 0) || !(deskCapUsd > 0)) return 1;
  return Math.min(1, deskUsd / deskCapUsd);
}

/** PURE: the follower's entry in dollars: its size scaled by the desk's fraction, to the cent. */
export function scaledEntryUsd(sizeUsd: number, deskUsd: number | null | undefined, deskCapUsd: number): number {
  return Math.round(sizeUsd * entryFraction(deskUsd, deskCapUsd) * 100) / 100;
}

export interface FollowerEntryInputs {
  rails: Rails;
  /** The follower's first mark of the UTC day, moved by its fundings and withdrawals since; null when unknown. */
  dayStartEquityUsd: number | null;
  equityUsd: number | null;
  /** When the follower's own last entry went out, from its own rows. */
  lastEntryAt: number | null;
  /** A continuation of a token the follower already holds: the desk's add-on, and the follower has the token. Not spaced. */
  addOn: boolean;
  now: number;
}

/** PURE: why the follower sits this entry out, or null: its own day's loss brake first, then its own spacing. */
export function followerEntryHalt(x: FollowerEntryInputs): string | null {
  const brake = dailyLossHalt(x.dayStartEquityUsd, x.equityUsd, x.rails);
  if (brake) return `your agent's ${brake}`;
  if (x.addOn) return null;
  return spacingHalt(x.lastEntryAt, x.now, x.rails, "your agent's last entry");
}

/** PURE: the share of its own holding an agent sells when the desk sold `sold` of the `heldBefore` it had. */
export function exitShare(sold: number, heldBefore: number | null): number {
  if (heldBefore == null || !(heldBefore > 0)) return 1;
  return Math.min(1, sold / heldBefore);
}

/** PURE: who acts on a desk trade: an entry is for every agent that is on and live; an exit is for every agent holding the token, on or off. */
export function followersFor(kind: "entry" | "exit", rows: FollowRow[], holdersOf: (address: string) => number): string[] {
  const addresses = [...new Set(rows.map((r) => r.address))];
  // An entry is for an agent that is on, live, and whose wallet is still at the console's door: a wallet taken off
  // the list stops opening positions at once (its exits still run, below, since what it holds must be sold with the desk).
  if (kind === "entry") return addresses.filter((a) => { const s = followState(rows, a); return s.on && s.mode === "live" && doorNow(a)?.ok !== false; });
  return addresses.filter((a) => holdersOf(a) > 0);
}

/** PURE: the ETH price the desk's own row implies, else the desk's latest sample. */
export function ethUsdOf(intent: Intent, fallback: number | null): number | null {
  if (intent.from.symbol === "ETH" && intent.usd != null && intent.amount > 0) return intent.usd / intent.amount;
  if (intent.to.symbol === "ETH" && intent.to.candidate == null && intent.usd != null && intent.amount > 0 && intent.exit) return fallback;
  return fallback;
}

/**
 * The desk's trade, mirrored for every agent it concerns, a few agents at a time, each inside its own try; a
 * failure is that agent's note and never another agent's problem, and never the desk's.
 */
export async function mirrorForFollowers(intent: Intent, deskTrade: Trade, deskHeldBefore: number | null, now = Date.now()): Promise<void> {
  if (!liveOn()) return;
  if (deskTrade.status !== "settled" && deskTrade.status !== "pending") return;
  const isExit = !!intent.exit;
  // An entry the desk itself has no receipt for is not mirrored: a pending buy that later reverts would have put
  // every follower into a token the desk never held and never sells (audit, 2026-09-08). Exits still run on a
  // pending desk sell, since what a follower holds must leave whatever the desk's own receipt says.
  if (!isExit && deskTrade.status !== "settled") { console.log(`[follow] the desk's ${intent.to.symbol} entry has no receipt yet; no agent mirrors it`); return; }
  const rows = readFollow();
  if (!rows.length) return;
  const tradeRows: FollowTradeRow[] = readFollowTrades();
  const eth = ASSETS["ETH@robinhood"];
  const rails = railsFromEnv();
  const ethUsd = ethUsdOf(intent, latestEthUsd(now));
  const symbol = (isExit ? intent.from : intent.to).symbol.toUpperCase();
  const who = followersFor(isExit ? "exit" : "entry", rows, (a) => liveHoldings(tradeRows, a)[symbol] ?? 0);
  const one = async (address: string): Promise<void> => {
    const st = followState(rows, address);
    // The wallet's lock for the whole leg: a /withdraw from the console signs from this same wallet in another
    // process, and the two would collide on the nonce or the balance (2026-09-08). A held lock is this agent's
    // skip, noted the way any other skip is; the leg never waits on a withdrawal and never pulls the lock from it.
    let release: (() => void) | null = null;
    try {
      release = acquire(address, `${isExit ? "exit" : "entry"} ${symbol}`);
      if (!release) {
        const busy = "the agent's wallet is busy with a withdrawal or another trade";
        recordFollowNote(address, deskTrade.id, `${isExit ? "exit" : "entry"} of ${symbol} skipped: ${busy}`, now);
        // A skipped exit is someone else's money still in the token, the same as a refused one: the operator hears.
        if (isExit) await raiseAlert("exit", `an agent's exit of ${symbol} was skipped (wallet ${address.slice(0, 8)}): ${busy}`, now, undefined, undefined, `${address.toLowerCase()} ${symbol}`);
        return;
      }
      const w = agentWallet(address);
      const ethBal = Number(await readNativeBalance(eth, w.address)) / 1e18;
      if (!isExit) {
        // The follower's own brake and spacing, from its own rows and its own wallet. Its equity is its ETH in
        // dollars plus its tokens at the desk's latest samples, the mark its book shows; unpriced, the brake stays
        // off and no mark is written, rather than tripping on a guess. The day's first priced look writes the mark.
        const mine = liveTrades(tradeRows, address);
        const held = liveHoldings(tradeRows, address);
        const equityNow = followerEquityUsd(ethBal, ethUsd, positions([], mine, held, latestPrices(readPrices(), now)));
        let dayStart: number | null = null;
        if (equityNow != null) {
          const mark = followDayStart(address, equityNow, now);
          dayStart = mark.equityUsd + capitalSinceUsd(readAgentCapital(), address, mark.at, now);
        }
        const fr = followerRails(rails);
        const addOn = !!intent.addOn && (held[symbol] ?? 0) > 0;
        const halt = followerEntryHalt({ rails: fr, dayStartEquityUsd: dayStart, equityUsd: equityNow, lastEntryAt: lastEntryAt(mine), addOn, now });
        if (halt) { recordFollowNote(address, deskTrade.id, `entry of ${intent.to.symbol} skipped: ${halt}`, now); return; }
        // A probe or an add-on the desk sized under its cap is the same fraction of the follower's size.
        const deskUsd = intent.usd ?? deskTrade.from.usd;
        const wantUsd = scaledEntryUsd(st.sizeUsd, deskUsd, rails.maxSwapUsd);
        if (wantUsd < MIN_ENTRY_USD) { recordFollowNote(address, deskTrade.id, `entry of ${intent.to.symbol} skipped: the desk's $${(deskUsd ?? 0).toFixed(2)} entry is ${Math.round(entryFraction(deskUsd, rails.maxSwapUsd) * 100)}% of its size, $${wantUsd.toFixed(2)} at yours; under $${MIN_ENTRY_USD} is not worth the gas`, now); return; }
        const a = entryAmountEth(wantUsd, ethUsd ?? 0, ethBal, rails.gasReserveEth);
        if ("reason" in a) { recordFollowNote(address, deskTrade.id, `entry of ${intent.to.symbol} skipped: ${a.reason}`, now); return; }
        const i2: Intent = { from: eth, to: intent.to, amount: a.amount, usd: a.amount * (ethUsd as number), capUsd: st.sizeUsd, ...(addOn ? { addOn: true } : {}) };
        const c2: RailContext = { rails: fr, balances: { "ETH@robinhood": ethBal }, nativeOnFromChain: ethBal, openOrders: 0, dayStartEquityUsd: dayStart, equityUsd: equityNow, lastEntryAt: lastEntryAt(mine), now };
        const r = await executeOnChain(i2, c2, now, { wallet: w, record: (t) => recordFollowTrade(address, deskTrade.id, t) });
        if (r.ok) console.log(`[follow] ${address.slice(0, 8)} entered ${intent.to.symbol} with ${a.amount} ETH: ${r.trade.status}`);
        else recordFollowNote(address, deskTrade.id, `entry of ${intent.to.symbol} refused: ${r.reason}`, now);
      } else {
        const token = intent.from;
        const raw = await readTokenBalance(token, token.contract as `0x${string}`, w.address);
        const tokenBal = Number(raw) / 10 ** token.decimals;
        if (!(tokenBal > 0)) return;
        const share = exitShare(intent.amount, deskHeldBefore);
        const amount = share >= 0.999 ? tokenBal : Number((tokenBal * share).toPrecision(8));
        const px = intent.usd != null && intent.amount > 0 ? intent.usd / intent.amount : null;
        const i2: Intent = { from: token, to: eth, amount, usd: px != null ? amount * px : null, exit: true };
        const c2: RailContext = { rails, balances: { [assetKey(token)]: tokenBal, "ETH@robinhood": ethBal }, nativeOnFromChain: ethBal, openOrders: 0, now };
        const r = await executeOnChain(i2, c2, now, { wallet: w, record: (t) => recordFollowTrade(address, deskTrade.id, t) });
        if (r.ok) console.log(`[follow] ${address.slice(0, 8)} sold ${amount} ${token.symbol} (${Math.round(share * 100)}%): ${r.trade.status}`);
        else {
          recordFollowNote(address, deskTrade.id, `exit of ${token.symbol} refused: ${r.reason}`, now);
          // Someone else's money that the desk could not get out: the operator hears about it at once.
          await raiseAlert("exit", `an agent's exit of ${token.symbol} was refused (wallet ${address.slice(0, 8)}, ${Math.round(share * 100)}% of its holding): ${r.reason}`, now, undefined, undefined, `${address.toLowerCase()} ${symbol}`);
        }
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      recordFollowNote(address, deskTrade.id, `mirror failed: ${why.slice(0, 160)}`, now);
      console.error(`[follow] mirror for ${address.slice(0, 8)} failed: ${why}`);
      // A thrown exit is someone else's money still in the token, the same as a refused one; until 2026-09-08 it was a note only.
      if (isExit) await raiseAlert("exit", `an agent's exit of ${symbol} failed (wallet ${address.slice(0, 8)}): ${why.slice(0, 200)}`, now, undefined, undefined, `${address.toLowerCase()} ${symbol}`).catch(() => undefined);
    } finally {
      release?.();
    }
  };
  // Agents in parallel batches: each signs from its own wallet with its own nonce, so they never collide; the batch
  // width bounds the RPC load. One at a time, ten agents would have held the desk's cycle for minutes after each trade.
  const width = mirrorWidth();
  for (let i = 0; i < who.length; i += width) await Promise.all(who.slice(i, i + width).map(one));
}

/** PURE: how many agents are mirrored at once (OBS_FOLLOW_PARALLEL), four unless set; never under one. */
export function mirrorWidth(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OBS_FOLLOW_PARALLEL);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

// ---- The sweep: a follower left holding what the desk already sold. ----
//
// A mirrored exit that was skipped (the wallet's lock was held), refused by the rails, thrown, or killed with the
// process in a redeploy was never tried again, so a follower could sit in a token the desk had sold for good
// (audit, 2026-09-08). Once a cycle, after the desk's own settle, every follower's ledger is held up against the
// desk's book: a token the ledger says the follower holds and the desk does not is sold whole, through the same
// lane the mirror's exit runs, under the wallet's lock, in the follower's own ledger. A token the desk still holds
// is left alone: its exit is coming, and the mirror will carry it. A token the ledger holds but the wallet does
// not (sold by hand with /sell before the row landed, or sent out with /withdraw SYMBOL, which writes no trade row)
// is written off with a settled row that brings nothing back, so the ledger stops saying it is held. Only
// ledger-known tokens: a balance the ledger never saw is an airdrop, never sold. Throttled to one sweep per
// OBS_FOLLOW_SWEEP_MIN minutes so a busy desk is not slowed by wallet reads every tick.

/** How often the sweep runs at most, in minutes, unless OBS_FOLLOW_SWEEP_MIN says otherwise. */
export const DEFAULT_SWEEP_MIN = 5;
/** Where the last sweep's time is kept between cycles: each cycle is its own process. */
export const SWEEP_STAMP_FILE = "obs-follow-sweep.json";

/** PURE: minutes between sweeps (OBS_FOLLOW_SWEEP_MIN): five unless set to a non-negative number; zero means every cycle. */
export function sweepMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OBS_FOLLOW_SWEEP_MIN);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SWEEP_MIN;
}

/** PURE: whether a sweep is due now: none yet, or the last one is at least the throttle ago. A stamp from the future (a clock set back) does not block. */
export function sweepDue(lastAt: number | null, now: number, minMin: number): boolean {
  if (lastAt == null || !Number.isFinite(lastAt)) return true;
  if (lastAt > now) return true;
  return now - lastAt >= minMin * 60e3;
}

const SWEEP_BASE = new Set(["ETH", "USDG", "USDC", "USDT", "DAI"]);

/**
 * PURE: the tokens the desk itself holds, from its own book: what its ledgers leave in the wallet above dust, the
 * base assets aside. The book and not the chain, so a follower is judged against what the desk means to hold; a
 * pending desk sell already counts as gone, the way the mirror's exit already ran on it.
 */
export function deskHeldSymbols(flows: CapitalFlow[], trades: Trade[], env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  for (const [sym, qty] of Object.entries(holdingsFrom(flows, trades))) if (!SWEEP_BASE.has(sym) && isHolding(qty, env)) out.add(sym);
  return out;
}

/** PURE: the tokens a follower's ledger holds that the desk does not: what the sweep looks at, alphabetical. */
export function sweepTargets(followerHeld: Record<string, number>, deskHeld: Iterable<string>): string[] {
  const desk = new Set([...deskHeld].map((s) => s.toUpperCase()));
  return Object.entries(followerHeld).filter(([sym, qty]) => qty > 0 && !desk.has(sym.toUpperCase())).map(([sym]) => sym.toUpperCase()).sort();
}

export type SweepLeg = "sell" | "correct" | "wait";

/**
 * PURE: what one target gets. The wallet holds it: sell all of it. The wallet holds none (or dust): the ledger is
 * corrected, unless a buy of it is still in flight (a pending entry row), in which case the token may be on its way
 * and the sweep waits for the next pass.
 */
export function sweepLeg(chainQty: number, pendingInto: boolean, env: NodeJS.ProcessEnv = process.env): SweepLeg {
  if (isHolding(chainQty, env)) return "sell";
  return pendingInto ? "wait" : "correct";
}

/**
 * PURE: the row that writes a token off a follower's ledger: a settled exit of the whole ledger amount that brings
 * nothing back and prices nothing, so liveHoldings (a sum of to legs less from legs) drops it and the cost basis
 * records no realized figure for a sale the desk never made. A zero-amount row would not do: liveHoldings subtracts
 * the from leg, so the from leg must carry what the ledger still says.
 */
export function correctionRow(symbol: string, ledgerQty: number, id: string, why: string, now: number): Trade {
  return { at: now, id, status: "settled", venue: "pool", exit: true, from: { asset: symbol, network: "robinhood", amount: ledgerQty, usd: null }, to: { asset: "ETH", network: "robinhood", amount: 0, usd: null }, partner: "pool", note: why, updatedAt: now };
}

/** PURE: the ledger id a sweep's rows and notes carry, so /agent and the events feed can tell them from mirrored exits. */
export const sweepId = (symbol: string, now: number): string => `sweep-${symbol.toUpperCase()}-${now}`;

export interface SweepSummary {
  /** Why nothing ran, or null when the sweep ran. */
  skipped: "off" | "throttled" | "no followers" | null;
  followers: number;
  targets: number;
  sold: number;
  corrected: number;
  waited: number;
  failed: number;
}

export function readSweepStamp(): number | null {
  try { const v = JSON.parse(readFileSync(dataPath(SWEEP_STAMP_FILE), "utf8")) as { at?: unknown }; return typeof v.at === "number" && Number.isFinite(v.at) ? v.at : null; } catch { return null; }
}

function writeSweepStamp(now: number): void {
  try { writeFileSync(dataPath(SWEEP_STAMP_FILE), JSON.stringify({ at: now })); } catch (e) { console.error(`[follow] the sweep stamp could not be written: ${e instanceof Error ? e.message : String(e)}`); }
}

/** PURE: the sweep's one log line. */
export function sweepLine(s: SweepSummary): string {
  if (s.skipped) return `[follow] sweep skipped: ${s.skipped}`;
  return `[follow] sweep: ${s.followers} follower${s.followers === 1 ? "" : "s"} checked, ${s.targets} target${s.targets === 1 ? "" : "s"}, ${s.sold} sold, ${s.corrected} corrected, ${s.waited} waiting, ${s.failed} failed`;
}

/**
 * The sweep, once per throttle window: every follower's ledger against the desk's book, and each token the desk no
 * longer holds sold whole from the follower's wallet or written off, a few followers at a time, each inside its
 * own try. A failed sell is a note and an exit alert keyed by wallet and token, the same as a refused mirrored exit.
 */
export async function sweepFollowers(now = Date.now(), opts: { force?: boolean } = {}): Promise<SweepSummary> {
  const summary: SweepSummary = { skipped: null, followers: 0, targets: 0, sold: 0, corrected: 0, waited: 0, failed: 0 };
  const done = (): SweepSummary => { console.log(sweepLine(summary)); return summary; };
  if (!liveOn()) { summary.skipped = "off"; return done(); }
  if (!opts.force && !sweepDue(readSweepStamp(), now, sweepMinutes())) { summary.skipped = "throttled"; return done(); }
  const rows = readFollow();
  if (!rows.length) { summary.skipped = "no followers"; return done(); }
  // Stamped before the work, so a sweep that dies mid-way does not run again every tick until it is looked at.
  writeSweepStamp(now);
  const tradeRows: FollowTradeRow[] = readFollowTrades();
  const book = readBook();
  const deskHeld = deskHeldSymbols(book.flows, book.trades);
  const eth = ASSETS["ETH@robinhood"];
  const rails = railsFromEnv();
  const addresses = [...new Set(rows.map((r) => r.address))];
  summary.followers = addresses.length;
  const plan = addresses.map((address) => { const held = liveHoldings(tradeRows, address); return { address, held, targets: sweepTargets(held, deskHeld) }; }).filter((p) => p.targets.length);
  summary.targets = plan.reduce((n, p) => n + p.targets.length, 0);
  if (!plan.length) return done();
  const pendingInto = (address: string, symbol: string): boolean => liveTrades(tradeRows, address).some((t) => t.status === "pending" && !t.exit && t.to.asset.toUpperCase() === symbol);
  const one = async (p: { address: string; held: Record<string, number>; targets: string[] }): Promise<void> => {
    for (const symbol of p.targets) {
      const id = sweepId(symbol, now);
      const key = `${p.address.toLowerCase()} ${symbol}`;
      let release: (() => void) | null = null;
      try {
        const token = resolveAny(`${symbol}@robinhood`);
        if (!token || token.kind !== "erc20" || !token.contract) {
          summary.failed++;
          recordFollowNote(p.address, id, `${symbol} is on the ledger but the desk no longer knows the token, so it cannot be sold; /withdraw ${symbol} sends it to your wallet`, now);
          await raiseAlert("exit", `a follower still holds ${symbol} by its ledger (wallet ${p.address.slice(0, 8)}) and the desk cannot resolve the token to sweep it`, now, undefined, undefined, key);
          continue;
        }
        const w = agentWallet(p.address);
        const raw = await readTokenBalance(token, token.contract as `0x${string}`, w.address);
        const chainQty = Number(raw) / 10 ** token.decimals;
        const leg = sweepLeg(chainQty, pendingInto(p.address, symbol));
        if (leg === "wait") { summary.waited++; continue; }
        if (leg === "correct") {
          const why = `the ledger said ${p.held[symbol]} ${symbol} was held but the wallet holds none; written off (sold by hand or withdrawn as a token)`;
          if (recordFollowTrade(p.address, id, correctionRow(symbol, p.held[symbol], id, why, now)) === false) throw new Error(`the ledger did not take the correction row for ${symbol}`);
          recordFollowNote(p.address, id, `${symbol}: ${why}`, now);
          summary.corrected++;
          console.log(`[follow] ${p.address.slice(0, 8)} ${symbol}: ledger corrected, the wallet holds none`);
          continue;
        }
        // The wallet's lock for the whole leg, as the mirror's exit takes it: a held lock is a skip, and the next sweep tries again.
        release = acquire(p.address, `sweep ${symbol}`);
        if (!release) {
          summary.failed++;
          const busy = "the agent's wallet is busy with a withdrawal or another trade";
          recordFollowNote(p.address, id, `sweep of ${symbol} skipped: ${busy}`, now);
          await raiseAlert("exit", `a follower's sweep of ${symbol} was skipped (wallet ${p.address.slice(0, 8)}): ${busy}`, now, undefined, undefined, key);
          continue;
        }
        const ethBal = Number(await readNativeBalance(eth, w.address)) / 1e18;
        // The rails refuse an unpriced leg, and there is no desk fill to price this by: the pools price it now, as /sell does.
        const q = await quoteOnChain(token, eth, chainQty);
        const intent: Intent = { from: token, to: eth, amount: chainQty, usd: quoteUsd(q, chainQty, latestEthUsd(now)), exit: true };
        const ctx: RailContext = { rails, balances: { [assetKey(token)]: chainQty, "ETH@robinhood": ethBal }, nativeOnFromChain: ethBal, openOrders: 0, now };
        const r = await executeOnChain(intent, ctx, now, { wallet: w, record: (t) => recordFollowTrade(p.address, id, t) });
        if (r.ok) {
          summary.sold++;
          recordFollowNote(p.address, id, `sold all ${chainQty} ${symbol} for ETH: the desk had already sold its own and this wallet's exit never landed`, now);
          console.log(`[follow] ${p.address.slice(0, 8)} swept ${chainQty} ${symbol}: ${r.trade.status}`);
        } else {
          summary.failed++;
          recordFollowNote(p.address, id, `sweep of ${symbol} refused: ${r.reason}`, now);
          await raiseAlert("exit", `a follower's sweep of ${symbol} was refused (wallet ${p.address.slice(0, 8)}, its whole holding): ${r.reason}`, now, undefined, undefined, key);
        }
      } catch (e) {
        summary.failed++;
        const why = e instanceof Error ? e.message : String(e);
        recordFollowNote(p.address, id, `sweep of ${symbol} failed: ${why.slice(0, 160)}`, now);
        console.error(`[follow] sweep of ${symbol} for ${p.address.slice(0, 8)} failed: ${why}`);
        await raiseAlert("exit", `a follower's sweep of ${symbol} failed (wallet ${p.address.slice(0, 8)}): ${why.slice(0, 200)}`, now, undefined, undefined, key).catch(() => undefined);
      } finally {
        release?.();
        release = null;
      }
    }
  };
  // Followers in the mirror's batches, each from its own wallet; one follower's tokens go one after another under its lock.
  const width = mirrorWidth();
  for (let i = 0; i < plan.length; i += width) await Promise.all(plan.slice(i, i + width).map(one));
  return done();
}
