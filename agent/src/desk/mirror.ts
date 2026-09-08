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
import { executeOnChain, latestEthUsd } from "./onchain.ts";
import { readNativeBalance, readTokenBalance } from "./signer.ts";
import { agentWallet, walletsOn, readAgentCapital } from "./agentWallet.ts";
import { acquire } from "./walletLock.ts";
import { readFollow, followState, readFollowTrades, recordFollowTrade, recordFollowNote, liveHoldings, liveTrades, followerEquityUsd, followDayStart, capitalSinceUsd, latestPrices, type FollowRow, type FollowTradeRow } from "./follow.ts";
import { positions, type Trade } from "./book.ts";
import { readPrices } from "./analysis.ts";
import { raiseAlert } from "./alerts.ts";
import { doorNow } from "./gate.ts";

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
