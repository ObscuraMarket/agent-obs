// Launch candidates: the tokens a launch watcher finds on Robinhood Chain,
// read from its feed as a generic JSONL (OBS_CANDIDATE_FEED) and turned into
// assets the desk may trade in the pool lane. The feed is somebody else's
// output; nothing here writes to it, and nothing here trusts it: a candidate
// must have passed the watcher's gate, sit in a hookless USDG pool at a tier
// the desk accepts, and be recent. Its pool's tick spacing is derived from
// the pool id itself, so the desk never needs the watcher's state.
//
// Tokens the desk has actually traded live in data/obs-tokens.json with what
// the desk learned about them: whether a sell was proven to work (the probe
// rule), or whether the token could not be sold and is blacklisted.
import { existsSync, openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, keccak256 } from "viem";
import { dataPath, USDG_CONTRACT } from "../config.ts";
import { ASSETS, type Asset } from "./assets.ts";
import type { PoolSpec } from "../obscura/pools.ts";

export const ZERO = "0x0000000000000000000000000000000000000000" as const;
const TAIL_BYTES = 6 * 1024 * 1024;
const TOKENS_FILE = "obs-tokens.json";

export interface Candidate {
  at: number;
  poolId: `0x${string}`;
  token: `0x${string}`;
  symbol: string;
  /** The pool's fee tier in percent; what the desk pays each way. */
  tierPct: number;
  feePips: number;
  tickSpacing: number | null;
  gateOk: boolean;
  source: string;
  hour: number;
  volUsd: number;
  movePct: number;
  senders: number;
  swaps: number;
  /** USDG per token at the candidate mark, when the feed had one. */
  px: number | null;
  usdgIs0: boolean;
}
export interface HourlyStat {
  hour: number;
  at: number;
  usd: number;
  px: number | null;
  senders: number;
}
/** A launch the watcher saw start, from minute one: the curve, the gate, the tax, ignition, and any hookless side pool since. */
export interface EarlyLaunch {
  at: number;
  token: `0x${string}`;
  symbol: string;
  source: string;
  gateOk: boolean;
  standard: string | null;
  creatorTaxBps: number | null;
  curvePoolId: string | null;
  firstSwapAt: number | null;
  /** Minutes after launch the watcher called ignition, or null if it has not. */
  ignitedAfterMin: number | null;
  /** Hookless USDG side pools seen for the token, cheapest tier first. */
  sidePools: Array<{ poolId: `0x${string}`; feePips: number; tierPct: number; tickSpacing: number }>;
}
export interface FeedSnapshot {
  candidates: Candidate[];
  /** Launches inside the early window, newest first. */
  early: EarlyLaunch[];
  /** Per pool id, the hourly rows in order. */
  hourly: Record<string, HourlyStat[]>;
  readAt: number;
  path: string | null;
}
export interface FeedOptions {
  maxAgeMs: number;
  maxTierPct: number;
  requireGate: boolean;
  /** How long after launch a launch still counts as early. */
  earlyMaxAgeMs: number;
}
/** PURE: the feed writes some timestamps in seconds and some in milliseconds; this reads both as milliseconds. */
export const toMs = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
};

/** PURE: the v4 pool id for a key, currencies sorted the way the manager sorts them. */
export function poolIdFor(a: `0x${string}`, b: `0x${string}`, feePips: number, tickSpacing: number, hooks: `0x${string}` = ZERO): `0x${string}` {
  const [c0, c1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [c0, c1, feePips, tickSpacing, hooks]));
}
const SPACINGS = [1, 2, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 121, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 2000];
/** PURE: the tick spacing that reproduces a hookless USDG pool's id, or null. */
export function deriveTickSpacing(token: `0x${string}`, feePips: number, poolId: string, usdg: `0x${string}` = USDG_CONTRACT as `0x${string}`): number | null {
  const want = poolId.toLowerCase();
  return SPACINGS.find((ts) => poolIdFor(usdg, token, feePips, ts) === want) ?? null;
}
const usdgIsToken0 = (token: string, usdg = USDG_CONTRACT) => usdg.toLowerCase() < token.toLowerCase();

/** PURE: the feed's tail parsed into current candidates and per-pool hourly stats. Bad lines are skipped. */
export function parseFeed(text: string, now: number, opts: FeedOptions): Omit<FeedSnapshot, "readAt" | "path"> {
  const sidePools = new Map<string, { fee: number; tickSpacing: number }>();
  const sidePoolsByToken = new Map<string, Array<{ poolId: `0x${string}`; feePips: number; tickSpacing: number }>>();
  const hourly: Record<string, HourlyStat[]> = {};
  const byToken = new Map<string, Candidate>();
  const launches = new Map<string, EarlyLaunch>();
  const ignitions = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = String(r.kind ?? "");
    const id = typeof r.id === "string" ? r.id.toLowerCase() : "";
    if (kind === "side-pool" && id && Number.isFinite(Number(r.fee)) && Number.isFinite(Number(r.tickSpacing))) {
      sidePools.set(id, { fee: Number(r.fee), tickSpacing: Number(r.tickSpacing) });
      if (typeof r.token === "string") {
        const list = sidePoolsByToken.get(r.token.toLowerCase()) ?? [];
        if (!list.some((x) => x.poolId === id)) list.push({ poolId: id as `0x${string}`, feePips: Number(r.fee), tickSpacing: Number(r.tickSpacing) });
        sidePoolsByToken.set(r.token.toLowerCase(), list);
      }
    } else if (kind === "launch" && typeof r.token === "string") {
      const at = toMs(r.ts);
      if (!at) continue;
      const gate = (r.gate ?? {}) as Record<string, unknown>;
      launches.set(r.token.toLowerCase(), {
        at,
        token: r.token.toLowerCase() as `0x${string}`,
        symbol: String(r.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12),
        source: String(r.source ?? r.launchSource ?? ""),
        gateOk: gate.ok === true || r.gateOk === true,
        standard: typeof gate.standard === "string" ? gate.standard : null,
        creatorTaxBps: Number.isFinite(Number(r.creatorTaxBps)) && r.creatorTaxBps != null ? Number(r.creatorTaxBps) : null,
        curvePoolId: typeof r.curvePoolId === "string" ? r.curvePoolId : null,
        firstSwapAt: toMs(r.firstSwapTs) || null,
        ignitedAfterMin: toMs(r.ignitionTs) ? Math.max(0, Math.round((toMs(r.ignitionTs) - at) / 60e3)) : null,
        sidePools: [],
      });
    } else if (kind === "ignition" && typeof r.token === "string") {
      const m = Number(r.minutesAfterLaunch);
      ignitions.set(r.token.toLowerCase(), Number.isFinite(m) ? m : 0);
    } else if (kind === "hourly" && id) {
      const lh = (r.lastHour ?? {}) as Record<string, unknown>;
      const px = Number(lh.px);
      (hourly[id] ??= []).push({ hour: Number(r.hour ?? 0), at: Number(r.ts ?? 0), usd: Number(lh.usd ?? 0) || 0, px: Number.isFinite(px) && px > 0 && px < 1e12 ? px : null, senders: Number(r.senders ?? 0) || 0 });
    } else if (kind === "candidate" && id && typeof r.token === "string") {
      const at = Number(r.ts ?? 0);
      const tierPct = Number(r.tier);
      if (!Number.isFinite(at) || !Number.isFinite(tierPct)) continue;
      const feePips = Math.round(tierPct * 10000);
      const token = r.token.toLowerCase() as `0x${string}`;
      const px = Number(r.px);
      const c: Candidate = {
        at,
        poolId: id as `0x${string}`,
        token,
        symbol: String(r.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12),
        tierPct,
        feePips,
        tickSpacing: null,
        gateOk: r.gateOk === true,
        source: String(r.launchSource ?? ""),
        hour: Number(r.hour ?? 0) || 0,
        volUsd: Number(r.volUsd ?? 0) || 0,
        movePct: Number(r.movePct ?? 0) || 0,
        senders: Number(r.senders ?? 0) || 0,
        swaps: Number(r.swaps ?? 0) || 0,
        px: Number.isFinite(px) && px > 0 ? px : null,
        usdgIs0: usdgIsToken0(token),
      };
      const prev = byToken.get(token);
      if (!prev || c.at >= prev.at) byToken.set(token, c);
    }
  }
  const candidates: Candidate[] = [];
  for (const c of byToken.values()) {
    if (now - c.at > opts.maxAgeMs) continue;
    if (opts.requireGate && !c.gateOk) continue;
    if (!(c.tierPct > 0) || c.tierPct > opts.maxTierPct) continue;
    if (!c.symbol || ASSETS[`${c.symbol}@robinhood`]) continue;
    const sp = sidePools.get(c.poolId);
    c.tickSpacing = sp && sp.fee === c.feePips ? sp.tickSpacing : deriveTickSpacing(c.token, c.feePips, c.poolId);
    if (c.tickSpacing == null) continue;
    candidates.push(c);
  }
  candidates.sort((a, b) => b.volUsd - a.volUsd);
  const early: EarlyLaunch[] = [];
  for (const l of launches.values()) {
    if (now - l.at > opts.earlyMaxAgeMs || now < l.at) continue;
    const ign = ignitions.get(l.token);
    if (ign != null && l.ignitedAfterMin == null) l.ignitedAfterMin = ign;
    l.sidePools = (sidePoolsByToken.get(l.token) ?? [])
      .map((sp) => ({ ...sp, tierPct: sp.feePips / 10000 }))
      .filter((sp) => sp.tierPct > 0 && sp.tierPct <= opts.maxTierPct)
      .sort((a, b) => a.tierPct - b.tierPct);
    if (l.symbol && !ASSETS[`${l.symbol}@robinhood`]) early.push(l);
  }
  early.sort((a, b) => b.at - a.at);
  return { candidates, early, hourly };
}

/** PURE: an early launch as a tradable candidate row, when it has ignited and a hookless side pool exists; null otherwise. */
export function earlyAsCandidate(l: EarlyLaunch, now: number, requireIgnition = true): Candidate | null {
  if (!l.gateOk || !l.sidePools.length) return null;
  if (requireIgnition && l.ignitedAfterMin == null) return null;
  if (l.creatorTaxBps != null && l.creatorTaxBps > 100) return null;
  const sp = l.sidePools[0];
  return { at: now, poolId: sp.poolId, token: l.token, symbol: l.symbol, tierPct: sp.tierPct, feePips: sp.feePips, tickSpacing: sp.tickSpacing, gateOk: true, source: l.source, hour: 0, volUsd: 0, movePct: 0, senders: 0, swaps: 0, px: null, usdgIs0: usdgIsToken0(l.token) };
}

export function feedOptions(env: NodeJS.ProcessEnv = process.env): FeedOptions {
  return { maxAgeMs: Number(env.OBS_CANDIDATE_MAX_AGE_H ?? 6) * 3600e3, maxTierPct: Number(env.OBS_CANDIDATE_MAX_TIER_PCT ?? 5), requireGate: (env.OBS_CANDIDATE_REQUIRE_GATE ?? "on") !== "off", earlyMaxAgeMs: Number(env.OBS_EARLY_MAX_AGE_MIN ?? 90) * 60e3 };
}

/** The last few megabytes of the feed file; the feed is append-only so the tail is the present. */
function tailOf(path: string, bytes = TAIL_BYTES): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

let cache: { at: number; snap: FeedSnapshot } | null = null;
/** The feed as of now. Empty when no feed is configured or the file is missing. Cached for a minute. */
export function readFeed(now = Date.now(), env: NodeJS.ProcessEnv = process.env): FeedSnapshot {
  if (cache && now - cache.at < 60_000) return cache.snap;
  const path = env.OBS_CANDIDATE_FEED?.trim() || null;
  let snap: FeedSnapshot = { candidates: [], early: [], hourly: {}, readAt: now, path };
  if (path && existsSync(path)) {
    try {
      snap = { ...parseFeed(tailOf(path), now, feedOptions(env)), readAt: now, path };
    } catch {
      /* an unreadable feed is an empty feed */
    }
  }
  cache = { at: now, snap };
  return snap;
}

// ---- Tokens the desk has traded, and what it learned about them. ----

export interface DynamicToken {
  symbol: string;
  contract: `0x${string}`;
  decimals: number;
  poolId: `0x${string}`;
  feePct: number;
  tickSpacing: number;
  usdgIs0: boolean;
  firstSeen: number;
  /** null until a sell has been simulated after a buy; true when it passed; false when it reverted. */
  proven: boolean | null;
  blacklisted: boolean;
  note?: string;
}
export function readTokens(): DynamicToken[] {
  const p = dataPath(TOKENS_FILE);
  if (!existsSync(p)) return [];
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as DynamicToken[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function upsertToken(t: DynamicToken): void {
  const all = readTokens().filter((x) => x.contract.toLowerCase() !== t.contract.toLowerCase());
  all.push(t);
  writeFileSync(dataPath(TOKENS_FILE), JSON.stringify(all, null, 2) + "\n");
}
export const tokenInfo = (contract: string): DynamicToken | null => readTokens().find((t) => t.contract.toLowerCase() === contract.toLowerCase()) ?? null;

/** PURE: a candidate as a registry-shaped asset the rails and the pool lane understand. */
export function candidateAsset(c: Candidate): Asset {
  return {
    symbol: c.symbol,
    code: c.symbol.toLowerCase(),
    network: "robinhood",
    chain: "robinhood",
    kind: "erc20",
    contract: c.token,
    decimals: 18,
    deposit: false,
    withdrawal: false,
    candidate: { poolId: c.poolId, feePips: c.feePips, tierPct: c.tierPct, tickSpacing: c.tickSpacing as number, usdgIs0: c.usdgIs0, seenAt: c.at },
  };
}
function tokenAsset(t: DynamicToken): Asset {
  return {
    symbol: t.symbol,
    code: t.symbol.toLowerCase(),
    network: "robinhood",
    chain: "robinhood",
    kind: "erc20",
    contract: t.contract,
    decimals: t.decimals,
    deposit: false,
    withdrawal: false,
    candidate: { poolId: t.poolId, feePips: Math.round(t.feePct * 10000), tierPct: t.feePct, tickSpacing: t.tickSpacing, usdgIs0: t.usdgIs0, seenAt: t.firstSeen },
  };
}

/** Every asset beyond the static registry: live candidates and tokens the desk has traded, keyed SYMBOL@robinhood. Static symbols win. */
export function dynamicAssets(feed: FeedSnapshot = readFeed()): Record<string, Asset> {
  const out: Record<string, Asset> = {};
  for (const t of readTokens()) out[`${t.symbol}@robinhood`] = tokenAsset(t);
  for (const l of feed.early) {
    const c = earlyAsCandidate(l, feed.readAt, (process.env.OBS_EARLY_REQUIRE_IGNITION ?? "on") !== "off");
    if (c) out[`${c.symbol}@robinhood`] = candidateAsset(c);
  }
  for (const c of feed.candidates) out[`${c.symbol}@robinhood`] = candidateAsset(c);
  for (const k of Object.keys(out)) if (ASSETS[k]) delete out[k];
  return out;
}

/** "BLOKKS", "blokks@robinhood" -> the static registry first, then the dynamic one. */
export function resolveAny(spec: string, feed?: FeedSnapshot): Asset | null {
  const m = String(spec ?? "").trim().match(/^([A-Za-z0-9]+)(?:@([A-Za-z0-9-]+))?$/);
  if (!m) return null;
  const symbol = m[1].toUpperCase();
  const network = (m[2] ?? "").toLowerCase();
  const staticKey = Object.keys(ASSETS).find((k) => k === `${symbol}@${network}`) ?? (network ? null : Object.keys(ASSETS).find((k) => k.startsWith(`${symbol}@`)));
  if (staticKey && (!network || staticKey.endsWith(`@${network}`))) return ASSETS[staticKey];
  if (network && network !== "robinhood") return null;
  return dynamicAssets(feed)[`${symbol}@robinhood`] ?? null;
}

/** PURE: the pool spec the lane needs for a dynamic asset's USDG pool. */
export function dynamicPoolSpec(a: Asset): PoolSpec | null {
  if (!a.candidate) return null;
  const c = a.candidate;
  return {
    venue: "uniswap-v4",
    id: c.poolId,
    token0: c.usdgIs0 ? "USDG" : a.symbol,
    token1: c.usdgIs0 ? a.symbol : "USDG",
    decimals0: c.usdgIs0 ? 6 : a.decimals,
    decimals1: c.usdgIs0 ? a.decimals : 6,
    usdToken: c.usdgIs0 ? 0 : 1,
    feePct: c.tierPct,
    tickSpacing: c.tickSpacing,
    hooks: false,
  };
}

export interface ExitRails {
  candidateMaxHoldH: number;
  candidateFloorPct: number;
  candidateVolumeDropPct: number;
}
/** PURE: why a held launch token must be sold now, or null. Time stop, floor, or volume rolling over two hours running. */
export function exitSignal(input: { ageH: number; pnlPct: number | null; hourly: HourlyStat[] }, r: ExitRails): string | null {
  if (input.ageH >= r.candidateMaxHoldH) return `held ${input.ageH.toFixed(1)}h, past the ${r.candidateMaxHoldH}h time stop`;
  if (input.pnlPct != null && input.pnlPct <= -r.candidateFloorPct) return `down ${Math.abs(input.pnlPct).toFixed(1)}%, through the ${r.candidateFloorPct}% floor`;
  const h = input.hourly.slice(-3);
  if (h.length === 3) {
    const k = 1 - r.candidateVolumeDropPct / 100;
    if (h[2].usd < h[1].usd * k && h[1].usd < h[0].usd * k) return `volume rolled over: $${h[0].usd.toFixed(0)} then $${h[1].usd.toFixed(0)} then $${h[2].usd.toFixed(0)} an hour`;
  }
  return null;
}

// ---- The bar. Which candidates are worth a probe, which are worth size. ----

export type Grade = "A" | "B" | "C";
export interface GradeRules {
  gradeA: { minVolUsd: number; minSenders: number; maxMovePct: number; maxTierPct: number; minDepthUsd: number; maxDrawdownPct: number; maxHour: number };
  gradeB: { minVolUsd: number; minSenders: number; maxMovePct: number; maxTierPct: number; maxDrawdownPct: number };
  /** Dollars a position may reach by grade; C is the probe size. */
  capUsd: Record<Grade, number>;
  /** An hour whose volume fell below this share of the hour before counts as rolling over. */
  trendFloor: number;
}
export function gradeRulesFromEnv(env: NodeJS.ProcessEnv = process.env): GradeRules {
  const n = (k: string, d: number) => Number(env[k] ?? d);
  return {
    gradeA: { minVolUsd: n("OBS_GRADE_A_MIN_VOL_USD", 250_000), minSenders: n("OBS_GRADE_A_MIN_SENDERS", 40), maxMovePct: n("OBS_GRADE_A_MAX_MOVE_PCT", 30), maxTierPct: n("OBS_GRADE_A_MAX_TIER_PCT", 3), minDepthUsd: n("OBS_GRADE_A_MIN_DEPTH_USD", 20_000), maxDrawdownPct: n("OBS_GRADE_A_MAX_DRAWDOWN_PCT", 25), maxHour: n("OBS_GRADE_A_MAX_HOUR", 3) },
    gradeB: { minVolUsd: n("OBS_GRADE_B_MIN_VOL_USD", 100_000), minSenders: n("OBS_GRADE_B_MIN_SENDERS", 20), maxMovePct: n("OBS_GRADE_B_MAX_MOVE_PCT", 50), maxTierPct: n("OBS_GRADE_B_MAX_TIER_PCT", 4), maxDrawdownPct: n("OBS_GRADE_B_MAX_DRAWDOWN_PCT", 40) },
    capUsd: { A: n("OBS_CANDIDATE_MAX_USD_A", 75), B: n("OBS_CANDIDATE_MAX_USD_B", 25), C: n("OBS_CANDIDATE_MAX_USD_C", 5) },
    trendFloor: 1 - n("OBS_CANDIDATE_VOLUME_DROP_PCT", 30) / 100,
  };
}

export interface Graded {
  grade: Grade | null;
  /** Dollars a position in this token may reach; the probe size until a sell is proven. */
  capUsd: number;
  /** Why it is where it is, for the observation. */
  why: string;
  /** Measured inputs beyond the candidate row. */
  depthUsd: number | null;
  drawdownPct: number | null;
  trend: "holding" | "rolling over" | "unknown";
}

/** PURE: the grade of a candidate from its row, its hourly trail and its pool depth. Null is below the bar. */
export function gradeCandidate(c: Candidate, trail: HourlyStat[], depthUsd: number | null, r: GradeRules): Graded {
  const px = trail.map((h) => h.px).filter((v): v is number => v != null && v > 0);
  const peak = px.length ? Math.max(...px) : null;
  const last = px.length ? px[px.length - 1] : null;
  const drawdownPct = peak != null && last != null && peak > 0 ? ((peak - last) / peak) * 100 : null;
  const t = trail.slice(-2);
  const trend: Graded["trend"] = t.length === 2 ? (t[1].usd < t[0].usd * r.trendFloor ? "rolling over" : "holding") : "unknown";
  const move = Math.abs(c.movePct);
  const fails: string[] = [];
  const a = r.gradeA;
  if (c.volUsd < a.minVolUsd) fails.push(`prior-hour volume $${Math.round(c.volUsd).toLocaleString("en-US")} under $${a.minVolUsd.toLocaleString("en-US")}`);
  if (c.senders < a.minSenders) fails.push(`${c.senders} senders under ${a.minSenders}`);
  if (move > a.maxMovePct) fails.push(`move ${c.movePct.toFixed(1)}% past ${a.maxMovePct}%`);
  if (c.tierPct > a.maxTierPct) fails.push(`tier ${c.tierPct}% over ${a.maxTierPct}%`);
  if (c.hour > a.maxHour) fails.push(`hour ${c.hour} past hour ${a.maxHour}`);
  if (depthUsd == null || depthUsd < a.minDepthUsd) fails.push(depthUsd == null ? "depth not read" : `depth $${Math.round(depthUsd).toLocaleString("en-US")} under $${a.minDepthUsd.toLocaleString("en-US")}`);
  if (trend !== "holding") fails.push(trend === "rolling over" ? "volume rolling over" : "no hourly trail yet");
  if (drawdownPct != null && drawdownPct > a.maxDrawdownPct) fails.push(`${drawdownPct.toFixed(0)}% off its peak`);
  if (!fails.length) return { grade: "A", capUsd: r.capUsd.A, why: "clears every bar for size", depthUsd, drawdownPct, trend };
  const b = r.gradeB;
  const bOk = c.volUsd >= b.minVolUsd && c.senders >= b.minSenders && move <= b.maxMovePct && c.tierPct <= b.maxTierPct && trend !== "rolling over" && (drawdownPct == null || drawdownPct <= b.maxDrawdownPct);
  if (bOk) return { grade: "B", capUsd: r.capUsd.B, why: `short of A: ${fails.slice(0, 2).join(", ")}`, depthUsd, drawdownPct, trend };
  const cOk = trend !== "rolling over" && (drawdownPct == null || drawdownPct <= b.maxDrawdownPct);
  if (cOk) return { grade: "C", capUsd: r.capUsd.C, why: `probe only: ${fails.slice(0, 2).join(", ")}`, depthUsd, drawdownPct, trend };
  return { grade: null, capUsd: 0, why: `below the bar: ${trend === "rolling over" ? "volume rolling over" : `${drawdownPct?.toFixed(0)}% off its peak`}`, depthUsd, drawdownPct, trend };
}

