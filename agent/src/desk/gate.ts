// The console is for holders. A wallet gets its agent only while it holds OBS or AOBS on Robinhood Chain, above
// the operator's minimums: read on chain at sign-in and again, cached ten minutes, whenever the agent is reached, so
// a wallet that sold up loses its agent within the cache. Guests still read the desk and open the app's pages;
// the gate is on the agent, the account and the credits. OBS_CONSOLE_GATE=off opens the door to everyone.
import { ASSETS } from "./assets.ts";
import { readTokenBalance } from "./signer.ts";
import { OBS_CONTRACT, AGENT_TOKEN, AGENT_TOKEN_SYMBOL } from "../config.ts";

export const gateOn = (env: NodeJS.ProcessEnv = process.env): boolean => (env.OBS_CONSOLE_GATE ?? "on") !== "off";
/** Whole tokens. Either token clears the gate on its own. */
export const minObs = (env: NodeJS.ProcessEnv = process.env): number => Math.max(0, Number(env.OBS_CONSOLE_MIN_OBS ?? 1000) || 0);
export const minAobs = (env: NodeJS.ProcessEnv = process.env): number => Math.max(0, Number(env.OBS_CONSOLE_MIN_AOBS ?? 1000) || 0);

export interface HolderVerdict {
  ok: boolean;
  obs: number;
  aobs: number;
  minObs: number;
  minAobs: number;
  /** What to tell the person when the door is closed. */
  reason?: string;
}

/** PURE: does this wallet hold enough of either token. */
export function holderVerdict(obs: number, aobs: number, needObs: number, needAobs: number): HolderVerdict {
  const ok = (needObs > 0 && obs >= needObs) || (needAobs > 0 && aobs >= needAobs) || (needObs === 0 && needAobs === 0);
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return {
    ok, obs, aobs, minObs: needObs, minAobs: needAobs,
    ...(ok ? {} : { reason: `The console is for OBS and ${AGENT_TOKEN_SYMBOL} holders. This wallet holds ${fmt(obs)} OBS and ${fmt(aobs)} ${AGENT_TOKEN_SYMBOL}; it needs at least ${fmt(needObs)} OBS or ${fmt(needAobs)} ${AGENT_TOKEN_SYMBOL}. Trade opens the swap.` }),
  };
}

const cache = new Map<string, { at: number; verdict: HolderVerdict }>();
const CACHE_MS = 10 * 60 * 1000;

/** The wallet's standing at the door, read on chain, cached ten minutes; open when the gate is off. */
export async function holderGate(address: string, now = Date.now()): Promise<HolderVerdict> {
  if (!gateOn()) return { ok: true, obs: 0, aobs: 0, minObs: 0, minAobs: 0 };
  const a = address.toLowerCase();
  const hit = cache.get(a);
  if (hit && now - hit.at < CACHE_MS) return hit.verdict;
  const chain = ASSETS["ETH@robinhood"];
  const [obsRaw, aobsRaw] = await Promise.all([
    readTokenBalance(chain, OBS_CONTRACT as `0x${string}`, a as `0x${string}`),
    readTokenBalance(chain, AGENT_TOKEN as `0x${string}`, a as `0x${string}`),
  ]);
  const verdict = holderVerdict(Number(obsRaw) / 1e18, Number(aobsRaw) / 1e18, minObs(), minAobs());
  cache.set(a, { at: now, verdict });
  return verdict;
}

/** After a swap the person made here: read again next time rather than in ten minutes. */
export function forgetHolder(address: string): void {
  cache.delete(address.toLowerCase());
}
