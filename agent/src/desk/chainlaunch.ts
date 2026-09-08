// A launch as the desk reads it straight from the launchpad's contract,
// written as a feed row in the launch watcher's own shape so the feed
// parser needs no second path, and its ignition judged from its curve
// pool's first minutes of swaps. Pure: the poller (launchpull.ts) gathers
// the facts from chain and this turns them into rows and verdicts.
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
  /** When its curve pool was created, milliseconds: the first buy, and the moment the desk can trade it. Null until then. */
  firstSwapAt?: number | null;
  /** When real buyers arrived on its curve (see ignitionAt), milliseconds. Null until then, or never. */
  ignitedAt?: number | null;
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
    ignitionTs: f.ignitedAt ? Math.floor(f.ignitedAt / 1000) : null,
    firstSwapTs: f.firstSwapAt ? Math.floor(f.firstSwapAt / 1000) : null,
    block: f.block,
    tx: f.tx,
    from: "chain",
    loggedAt,
  };
}

/**
 * PURE: a side-pool row in the watcher's shape: a hookless pool pairing USDG with a launched token, the desk's way
 * into the token past its curve. The feed parser takes the pool's tick spacing from it (an odd spacing such as 888
 * cannot be derived from the id) and lists it on the early launch's sidePools. `ts` is in milliseconds.
 */
export function sidePoolRow(poolId: string, token: string, fee: number, tickSpacing: number, launch: string, loggedAt: number): Record<string, unknown> {
  return { ts: loggedAt, kind: "side-pool", id: poolId.toLowerCase(), token: token.toLowerCase(), fee, tickSpacing, launch };
}

// ---- Ignition: real buyers on the curve, judged by the desk itself. ----

export interface IgnitionRules {
  /** The launch has this long, in seconds, to ignite. */
  windowSec: number;
  minSwaps: number;
  /** Distinct swap senders: one wallet buying sixty times is not a crowd. */
  minSenders: number;
  /** Dollars swapped, waived when the pair cannot be priced. */
  minUsd: number;
}

export function ignitionRulesFromEnv(env: NodeJS.ProcessEnv = process.env): IgnitionRules {
  const n = (k: string, d: number) => Number(env[k] ?? d);
  return { windowSec: n("OBS_IGNITION_WINDOW_SEC", 600), minSwaps: n("OBS_IGNITION_SWAPS", 60), minSenders: n("OBS_IGNITION_SENDERS", 20), minUsd: n("OBS_IGNITION_USD", 10_000) };
}

export interface IgnitionSample {
  /** Milliseconds. */
  at: number;
  sender: string;
  /** Dollars moved on the quote side; 0 when the pair could not be priced. */
  usd: number;
}

/**
 * PURE: the moment a launch ignited: the first swap inside the window at
 * which the swaps, the distinct senders and the dollars have all cleared
 * the bar, in milliseconds; null while they have not. The dollar bar is
 * waived when no swap in the window could be priced (an unnamed pair), the
 * way the launch watcher judges it.
 */
export function ignitionAt(launchAt: number, samples: IgnitionSample[], r: IgnitionRules): number | null {
  const s = samples.filter((x) => x.at >= launchAt && x.at <= launchAt + r.windowSec * 1000).sort((a, b) => a.at - b.at);
  const priced = s.some((x) => x.usd > 0);
  const senders = new Set<string>();
  let usd = 0;
  for (let i = 0; i < s.length; i++) {
    senders.add(s[i].sender.toLowerCase());
    usd += s[i].usd;
    if (i + 1 >= r.minSwaps && senders.size >= r.minSenders && (!priced || usd >= r.minUsd)) return s[i].at;
  }
  return null;
}

/** PURE: the ignition row in the watcher's shape; the parser reads the token and the minutes. */
export function ignitionRow(f: ChainLaunchFacts, ignitedAt: number, loggedAt: number): Record<string, unknown> {
  return {
    kind: "ignition",
    token: f.token.toLowerCase(),
    symbol: f.symbol,
    ts: loggedAt,
    launchTs: f.at / 1000,
    ignitionTs: ignitedAt / 1000,
    minutesAfterLaunch: Math.max(0, Math.round((ignitedAt - f.at) / 60e3)),
    from: "chain",
  };
}
