// A launch as the desk reads it straight from the launchpad's contract,
// written as a feed row in the launch watcher's own shape so the feed
// parser needs no second path. Pure: the poller (launchpull.ts) gathers the
// facts from chain and this turns them into the row.
import { USDG_CONTRACT } from "../config.ts";
import { ASSETS } from "./assets.ts";
import { curvePoolIdFor } from "./candidates.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

/** PURE: the pair's symbol from its address, for the pairs the desk can name; null for anything else. */
export function pairSymbolOf(pairToken: string): string | null {
  const a = pairToken.toLowerCase();
  if (a === ZERO) return "ETH";
  if (a === USDG_CONTRACT.toLowerCase()) return "USDG";
  if (a === ASSETS["NVDA@robinhood"]?.contract?.toLowerCase()) return "NVDA";
  return null;
}

export interface ChainLaunchFacts {
  token: `0x${string}`;
  symbol: string;
  name: string;
  pairToken: `0x${string}`;
  creatorTaxBps: number | null;
  /** The launch block's time, milliseconds. */
  at: number;
  block: number;
  tx: string;
}

/** PURE: the feed row. `ts` is in seconds like the watcher's rows; the gate is the launchpad's own standard, since the factory knows the token. */
export function chainLaunchRow(f: ChainLaunchFacts, loggedAt: number): Record<string, unknown> {
  const pairSymbol = pairSymbolOf(f.pairToken);
  const curvePoolId = curvePoolIdFor(f.token, pairSymbol, pairSymbol ? null : f.pairToken);
  return {
    kind: "launch",
    token: f.token.toLowerCase(),
    source: "pons-v2",
    ts: Math.floor(f.at / 1000),
    pair: f.pairToken.toLowerCase(),
    pairSymbol,
    symbol: f.symbol,
    name: f.name,
    creatorTaxBps: f.creatorTaxBps,
    curvePoolId,
    gate: { ok: true, standard: "PonsV2LauncherToken" },
    ignitionTs: null,
    firstSwapTs: null,
    block: f.block,
    tx: f.tx,
    from: "chain",
    loggedAt,
  };
}
