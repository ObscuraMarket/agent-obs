// The console is for holders. A wallet gets its agent only while it holds OBS or AOBS on Robinhood Chain, above
// the operator's minimums: read on chain at sign-in and again, cached ten minutes, whenever the agent is reached, so
// a wallet that sold up loses its agent within the cache. Guests still read the desk and open the app's pages;
// the gate is on the agent, the account and the credits. OBS_CONSOLE_GATE=off opens the door to everyone.
// The operator's list (OBS_CONSOLE_ALLOWLIST, wallet addresses) is always let in, holdings or not; with
// OBS_CONSOLE_GATE=allowlist the list is the only way in, for the first users before the door opens to holders.
import { ASSETS } from "./assets.ts";
import { readTokenBalance } from "./signer.ts";
import { OBS_CONTRACT, AGENT_TOKEN, AGENT_TOKEN_SYMBOL } from "../config.ts";
import { Lru } from "../lru.ts";

export type GateMode = "on" | "allowlist" | "off";
/** PURE: how the door is kept. "on" is holders (and the list); "allowlist" is the list only; "off" is everyone. */
export function gateMode(env: NodeJS.ProcessEnv = process.env): GateMode {
  const m = (env.OBS_CONSOLE_GATE ?? "on").trim().toLowerCase();
  return m === "off" ? "off" : m === "allowlist" ? "allowlist" : "on";
}
export const gateOn = (env: NodeJS.ProcessEnv = process.env): boolean => gateMode(env) !== "off";
/** PURE: the operator's list, lower-cased addresses; commas, spaces or newlines between them, anything else ignored. */
export function allowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.OBS_CONSOLE_ALLOWLIST ?? "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s)));
}
export const allowlisted = (address: string, env: NodeJS.ProcessEnv = process.env): boolean => allowlist(env).has(address.trim().toLowerCase());
/** PURE: what an uninvited wallet is told while the door is list-only. */
export const NOT_INVITED = "The console is open to invited wallets for now. This wallet is not on the list yet.";
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
  /** In on the operator's list, whatever the wallet holds. */
  invited?: boolean;
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

// Keyed on any address a request names (the door endpoint takes one unsigned), so bounded: past five thousand the
// wallet asked about longest ago is read again on its next visit rather than kept (2026-09-08).
const cache = new Lru<string, { at: number; verdict: HolderVerdict }>(5_000);
const CACHE_MS = 10 * 60 * 1000;

/**
 * The door as it stands right now, without waiting on the chain: decided at once when the gate is off or list-only,
 * from the cache when a holder read is fresh, and unknown (null) otherwise, with a read started in the background so
 * the next call knows. Every signed-in request asks this, so a wallet taken off the list loses the console at once
 * rather than at the end of its seven-day bearer (2026-09-08).
 */
export function doorNow(address: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): HolderVerdict | null {
  const mode = gateMode(env);
  if (mode === "off") return { ok: true, obs: 0, aobs: 0, minObs: 0, minAobs: 0 };
  const a = address.toLowerCase();
  if (allowlisted(a, env)) return { ok: true, obs: 0, aobs: 0, minObs: minObs(env), minAobs: minAobs(env), invited: true };
  if (mode === "allowlist") return { ok: false, obs: 0, aobs: 0, minObs: minObs(env), minAobs: minAobs(env), reason: NOT_INVITED };
  const hit = cache.get(a);
  if (hit && now - hit.at < CACHE_MS) return hit.verdict;
  void holderGate(a, now, env).catch(() => undefined);
  return null;
}

/**
 * The wallet's standing at the door: open when the gate is off, in when on the operator's list, else read on chain
 * and cached ten minutes; list-only while the gate is set to allowlist. The server answers a closed door with the
 * code not_holder in every case, which the page already knows; the reason says which door it was.
 */
export async function holderGate(address: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<HolderVerdict> {
  const mode = gateMode(env);
  if (mode === "off") return { ok: true, obs: 0, aobs: 0, minObs: 0, minAobs: 0 };
  const a = address.toLowerCase();
  if (allowlisted(a, env)) return { ok: true, obs: 0, aobs: 0, minObs: minObs(env), minAobs: minAobs(env), invited: true };
  if (mode === "allowlist") return { ok: false, obs: 0, aobs: 0, minObs: minObs(env), minAobs: minAobs(env), reason: NOT_INVITED };
  const hit = cache.get(a);
  if (hit && now - hit.at < CACHE_MS) return hit.verdict;
  const chain = ASSETS["ETH@robinhood"];
  const [obsRaw, aobsRaw] = await Promise.all([
    readTokenBalance(chain, OBS_CONTRACT as `0x${string}`, a as `0x${string}`),
    readTokenBalance(chain, AGENT_TOKEN as `0x${string}`, a as `0x${string}`),
  ]);
  const verdict = holderVerdict(Number(obsRaw) / 1e18, Number(aobsRaw) / 1e18, minObs(env), minAobs(env));
  cache.set(a, { at: now, verdict });
  return verdict;
}

/** After a swap the person made here: read again next time rather than in ten minutes. */
export function forgetHolder(address: string): void {
  cache.delete(address.toLowerCase());
}
