// Trading through fomo's own route (OBS_ROUTE=fomo), so that the people watching the agent's fomo account are told
// when it buys and when it sells.
//
// This is a DISTRIBUTION choice, not an execution one. The desk's own router goes straight to the pools and fills
// better; fomo's route is an aggregator that costs a few percent more. What it buys is the notification: a swap
// that goes through fomo's contracts appears on the account its followers watch, and a swap that goes straight to
// the pools does not, however real it is on chain.
//
// What fomo's app actually does, read off the chain (2026-09-09): every trade is ONE user operation of two calls,
// approve(token) then the router, submitted by fomo's own bundler. The router is Relay's: transferAndMulticall for
// a token input, multicall for an ETH input. So the desk asks Relay for the same quote the app would get, and puts
// the transactions Relay hands back into the batch it already sends through the entry point.
//
// A third party telling this wallet what to call is the risk here, and it is answered three ways rather than by
// trust: every target in the batch is checked against an allowlist (the routers, and the token being approved),
// the value the batch may spend is capped at the swap's own amount, and Relay's promised output is held against
// the desk's own pool quote so a route that pays far less than the pool is refused before anything is signed.
import { parseAbi, decodeFunctionData, type Address, type Hex } from "viem";
import { relayQuote, type RelayQuote } from "../obscura/relay.ts";
import type { Asset } from "./assets.ts";
import type { AaCall } from "./aa.ts";

/** Relay's two entry points on this chain, which are the contracts fomo's own trades call. Lower case. */
export const FOMO_ROUTERS: readonly string[] = [
  "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be", // transferAndMulticall, a token going in
  "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f", // multicall, ETH going in
];

const ERC20 = parseAbi(["function approve(address spender, uint256 amount)"]);

/** PURE: the route is fomo's only when the operator says so. Anything else keeps the desk's own router. */
export function fomoOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OBS_ROUTE ?? "").toLowerCase() === "fomo";
}

/** PURE: how much worse than the desk's own pool quote a fomo route may be before it is refused. */
export function maxGiveUpPct(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OBS_FOMO_MAX_GIVEUP_PCT ?? 6);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

export interface RouteCheck {
  ok: boolean;
  reason?: string;
}

/**
 * PURE: is this batch safe to sign? Every call must be to a router on the allowlist or an approve of the token
 * being spent, to one of those routers; the value across the batch must not exceed what the swap is spending. A
 * batch that fails this is never signed, whatever Relay said.
 */
export function checkCalls(calls: AaCall[], p: { from: Asset; maxValueRaw: bigint }): RouteCheck {
  if (!calls.length) return { ok: false, reason: "fomo's route came back with nothing to send" };
  let value = 0n;
  for (const c of calls) {
    const to = String(c.to).toLowerCase();
    value += c.value;
    if (FOMO_ROUTERS.includes(to)) continue;
    // The only other call fomo's own trades make is the approve of the token going in, to one of those routers.
    if (p.from.kind === "erc20" && p.from.contract && to === p.from.contract.toLowerCase()) {
      let spender: string;
      try {
        const d = decodeFunctionData({ abi: ERC20, data: c.data as Hex });
        if (d.functionName !== "approve") return { ok: false, reason: `fomo's route calls ${p.from.symbol}.${d.functionName}, which is not an approval` };
        spender = String(d.args[0]).toLowerCase();
      } catch {
        return { ok: false, reason: `fomo's route calls ${p.from.symbol} with something this desk cannot read` };
      }
      if (!FOMO_ROUTERS.includes(spender)) return { ok: false, reason: `fomo's route would approve ${spender}, which is not one of its routers` };
      if (c.value !== 0n) return { ok: false, reason: "an approval that also sends ETH is not signed" };
      continue;
    }
    return { ok: false, reason: `fomo's route would call ${to}, which is not one of its routers` };
  }
  if (value > p.maxValueRaw) return { ok: false, reason: `fomo's route would send ${value} wei, more than the ${p.maxValueRaw} the swap is spending` };
  return { ok: true };
}

/** PURE: Relay's steps as the calls of one batch, in the order it gave them. */
export function callsFromSteps(q: RelayQuote): AaCall[] {
  const calls: AaCall[] = [];
  for (const s of q.steps) {
    for (const t of s.txs) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(t.to)) continue;
      calls.push({ to: t.to as Address, value: BigInt(t.value || "0"), data: (t.data || "0x") as Hex });
    }
  }
  return calls;
}

/** PURE: the ETH the batch spends, which an ETH-in swap has to unwrap from WETH first. */
export function valueOf(calls: AaCall[]): bigint {
  return calls.reduce((n, c) => n + c.value, 0n);
}

/**
 * PURE: is the route worth taking against the desk's own pool quote? Fomo's route is expected to be worse, and the
 * point is the notification; what is refused is a route that is far worse, which is the shape of a bad quote, a
 * stale one, or a pool the aggregator cannot really reach.
 */
export function worthIt(fomoOut: number, poolOut: number, maxGiveUp = 6): RouteCheck & { giveUpPct: number } {
  if (!(poolOut > 0)) return { ok: fomoOut > 0, giveUpPct: 0, ...(fomoOut > 0 ? {} : { reason: "neither route quoted" }) };
  const giveUpPct = ((poolOut - fomoOut) / poolOut) * 100;
  if (fomoOut <= 0) return { ok: false, giveUpPct: 100, reason: "fomo's route quoted nothing" };
  if (giveUpPct > maxGiveUp) return { ok: false, giveUpPct, reason: `fomo's route pays ${giveUpPct.toFixed(2)}% less than the pools, over the ${maxGiveUp}% this desk gives up for the notification` };
  return { ok: true, giveUpPct };
}

export interface FomoRoute {
  calls: AaCall[];
  /** What Relay says the swap pays out, in whole units. */
  amountOut: number;
  /** The ETH the batch spends, to be unwrapped from WETH inside it. */
  valueRaw: bigint;
  giveUpPct: number;
  feeUsd: number | null;
  impactPct: number | null;
}

/**
 * The route fomo's app would take for this swap, checked and ready to batch, or the reason it is not being taken.
 * Nothing is signed here; the caller puts the calls in a user operation.
 */
export async function fomoRoute(p: { from: Asset; to: Asset; amount: number; amountInRaw: bigint; poolAmountOut: number; user: string; maxGiveUp?: number }, quote = relayQuote): Promise<{ ok: true; route: FomoRoute } | { ok: false; reason: string }> {
  // The RAW amount, never the float: a large-supply token does not survive a double, and asking the router for a
  // wei more than the wallet holds reverts the whole batch (2026-09-09, 4AI).
  const a = await quote(p.from, p.to, p.amountInRaw, p.user);
  if (!a.quote) return { ok: false, reason: `fomo's route did not quote ${p.from.symbol} to ${p.to.symbol}: ${a.error ?? "no answer"}` };
  const worth = worthIt(a.quote.amountOut, p.poolAmountOut, p.maxGiveUp ?? maxGiveUpPct());
  if (!worth.ok) return { ok: false, reason: worth.reason ?? "fomo's route is not worth taking" };
  const calls = callsFromSteps(a.quote);
  const valueRaw = valueOf(calls);
  const safe = checkCalls(calls, { from: p.from, maxValueRaw: p.from.kind === "native" ? p.amountInRaw : 0n });
  if (!safe.ok) return { ok: false, reason: safe.reason ?? "fomo's route was refused" };
  return { ok: true, route: { calls, amountOut: a.quote.amountOut, valueRaw, giveUpPct: worth.giveUpPct, feeUsd: a.quote.feeUsd, impactPct: a.quote.impactPct } };
}
