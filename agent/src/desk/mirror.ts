// The live mirror: one brain, many executors. When the desk's own trade lands, every agent that is on and live sends
// the same trade from its own funded wallet at its own size, through the same lane (rails, route, quote, floor,
// simulate, send, receipt), and every agent that holds the token sells the same share when the desk sells. The
// agents decide nothing; Agent OBS does. Each agent's rows go to its own ledger, and a trade that cannot be made
// (no ETH, a refused rail, a revert) is written down as a note the person reads with /agent, never hidden.
//
// Pure where it matters: how much an agent puts in, what share it sells, and who acts on a trade are functions
// tested offline; the sends themselves are the lane's, the same code that trades the desk's own money.
import { ASSETS, assetKey } from "./assets.ts";
import { railsFromEnv, type Intent, type RailContext } from "./rails.ts";
import { executeOnChain, latestEthUsd } from "./onchain.ts";
import { readNativeBalance, readTokenBalance } from "./signer.ts";
import { agentWallet, walletsOn } from "./agentWallet.ts";
import { readFollow, followState, readFollowTrades, recordFollowTrade, recordFollowNote, liveHoldings, type FollowRow, type FollowTradeRow } from "./follow.ts";
import type { Trade } from "./book.ts";
import { raiseAlert } from "./alerts.ts";

/** Live mirroring runs when agent wallets exist and the operator has not switched it off (OBS_FOLLOW_LIVE=off). */
export const liveOn = (env: NodeJS.ProcessEnv = process.env): boolean => (env.OBS_FOLLOW_LIVE ?? "on").trim().toLowerCase() !== "off" && walletsOn(env);

/**
 * PURE: the ETH an agent puts into an entry: its size at the desk's ETH price, within what its wallet holds above
 * the gas reserve. Less than half the size is not an entry worth making; it is a note instead.
 */
export function entryAmountEth(sizeUsd: number, ethUsd: number, balanceEth: number, gasReserveEth: number): { amount: number } | { reason: string } {
  if (!(ethUsd > 0)) return { reason: "ETH is unpriced right now" };
  const want = sizeUsd / ethUsd;
  const room = balanceEth - gasReserveEth;
  if (!(room > 0) || room < want * 0.5) return { reason: `the agent's wallet holds ${balanceEth.toFixed(4)} ETH; $${sizeUsd} at $${ethUsd.toFixed(0)} an ETH needs ${want.toFixed(4)} ETH plus the ${gasReserveEth} ETH gas reserve` };
  return { amount: Number(Math.min(want, room).toPrecision(8)) };
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
  const least = (sizeUsd / ethUsd) * 0.5 + gasReserveEth;
  return { ok: false, reason: `Your agent's wallet holds ${balanceEth.toFixed(4)} ETH; $${sizeUsd} a trade needs at least ${least.toFixed(4)} ETH (half the size above the ${gasReserveEth} ETH gas reserve). /fund it first, or /start paper.` };
}

/** PURE: the share of its own holding an agent sells when the desk sold `sold` of the `heldBefore` it had. */
export function exitShare(sold: number, heldBefore: number | null): number {
  if (heldBefore == null || !(heldBefore > 0)) return 1;
  return Math.min(1, sold / heldBefore);
}

/** PURE: who acts on a desk trade: an entry is for every agent that is on and live; an exit is for every agent holding the token, on or off. */
export function followersFor(kind: "entry" | "exit", rows: FollowRow[], holdersOf: (address: string) => number): string[] {
  const addresses = [...new Set(rows.map((r) => r.address))];
  if (kind === "entry") return addresses.filter((a) => { const s = followState(rows, a); return s.on && s.mode === "live"; });
  return addresses.filter((a) => holdersOf(a) > 0);
}

/** PURE: the ETH price the desk's own row implies, else the desk's latest sample. */
export function ethUsdOf(intent: Intent, fallback: number | null): number | null {
  if (intent.from.symbol === "ETH" && intent.usd != null && intent.amount > 0) return intent.usd / intent.amount;
  if (intent.to.symbol === "ETH" && intent.to.candidate == null && intent.usd != null && intent.amount > 0 && intent.exit) return fallback;
  return fallback;
}

/**
 * The desk's trade, mirrored for every agent it concerns. Sequential, one agent at a time, each inside its own
 * try; a failure is that agent's note and never the next agent's problem, and never the desk's.
 */
export async function mirrorForFollowers(intent: Intent, deskTrade: Trade, deskHeldBefore: number | null, now = Date.now()): Promise<void> {
  if (!liveOn()) return;
  if (deskTrade.status !== "settled" && deskTrade.status !== "pending") return;
  const isExit = !!intent.exit;
  const rows = readFollow();
  if (!rows.length) return;
  const tradeRows: FollowTradeRow[] = readFollowTrades();
  const eth = ASSETS["ETH@robinhood"];
  const rails = railsFromEnv();
  const ethUsd = ethUsdOf(intent, latestEthUsd(now));
  const symbol = (isExit ? intent.from : intent.to).symbol.toUpperCase();
  const who = followersFor(isExit ? "exit" : "entry", rows, (a) => liveHoldings(tradeRows, a)[symbol] ?? 0);
  for (const address of who) {
    const st = followState(rows, address);
    try {
      const w = agentWallet(address);
      const ethBal = Number(await readNativeBalance(eth, w.address)) / 1e18;
      if (!isExit) {
        const a = entryAmountEth(st.sizeUsd, ethUsd ?? 0, ethBal, rails.gasReserveEth);
        if ("reason" in a) { recordFollowNote(address, deskTrade.id, `entry of ${intent.to.symbol} skipped: ${a.reason}`, now); continue; }
        const i2: Intent = { from: eth, to: intent.to, amount: a.amount, usd: a.amount * (ethUsd as number), capUsd: st.sizeUsd };
        const c2: RailContext = { rails, balances: { "ETH@robinhood": ethBal }, nativeOnFromChain: ethBal, openOrders: 0, lastEntryAt: null, now };
        const r = await executeOnChain(i2, c2, now, { wallet: w, record: (t) => recordFollowTrade(address, deskTrade.id, t) });
        if (r.ok) console.log(`[follow] ${address.slice(0, 8)} entered ${intent.to.symbol} with ${a.amount} ETH: ${r.trade.status}`);
        else recordFollowNote(address, deskTrade.id, `entry of ${intent.to.symbol} refused: ${r.reason}`, now);
      } else {
        const token = intent.from;
        const raw = await readTokenBalance(token, token.contract as `0x${string}`, w.address);
        const tokenBal = Number(raw) / 10 ** token.decimals;
        if (!(tokenBal > 0)) continue;
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
          await raiseAlert("exit", `an agent's exit of ${token.symbol} was refused (wallet ${address.slice(0, 8)}, ${Math.round(share * 100)}% of its holding): ${r.reason}`, now);
        }
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      recordFollowNote(address, deskTrade.id, `mirror failed: ${why.slice(0, 160)}`, now);
      console.error(`[follow] mirror for ${address.slice(0, 8)} failed: ${why}`);
    }
  }
}
