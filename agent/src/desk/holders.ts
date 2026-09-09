// Who holds the token. Read from the chain, not an explorer: a token's
// Transfer events give every buyer and seller with block and size, kept per
// token in data/holders/<token>.jsonl and reduced to what a trader wants to
// know before touching it. How many wallets hold it and how concentrated
// it is (the largest wallet, the top ten) once the pool, the hooks and the
// burn address are set aside. Whether the first buyers look like one hand:
// many buyers landing in the same block, or in identical sizes, inside the
// first seconds (a bundle). How fresh the biggest wallets are, from their
// transaction counts. Each read is a line the agent can cite, and a gate the
// rails apply: a bundled or single-hand token is not bought.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, decodeEventLog } from "viem";
import { DATA_DIR, RPC_URL, EXPLORER_URL } from "../config.ts";
import { chainMemory } from "../obscura/pools.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TRANSFER_ABI = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const CHUNK = 50_000n;
const BLOCKS_PER_SEC = 10;
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

export interface TransferRow {
  at: number;
  block: number;
  tx: string;
  from: string;
  to: string;
  /** Whole token units. */
  amount: number;
}

export interface HolderRules {
  /** The largest wallet, and the top ten together, may hold at most this share of circulating supply. */
  maxTop1Pct: number;
  maxTop10Pct: number;
  /** Early buys (inside the first earlySec seconds) that share a block with two or more other buys, or an identical size, count as bundled; at most this share. */
  maxBundlePct: number;
  earlySec: number;
  /** At least this many wallets must hold the token. */
  minWallets: number;
  /** Among the top ten wallets, at most this many may be fresh (transaction count at or under freshTxCount). */
  maxFreshTop10: number;
  freshTxCount: number;
  /** How much history to pull on the first read, in hours, when the launch time is unknown. */
  firstPullHours: number;
}

export function holderRulesFromEnv(env: NodeJS.ProcessEnv = process.env): HolderRules {
  const n = (k: string, d: number) => Number(env[k] ?? d);
  return {
    maxTop1Pct: n("OBS_HOLDERS_MAX_TOP1_PCT", 25),
    maxTop10Pct: n("OBS_HOLDERS_MAX_TOP10_PCT", 60),
    maxBundlePct: n("OBS_HOLDERS_MAX_BUNDLE_PCT", 50),
    earlySec: n("OBS_HOLDERS_EARLY_SEC", 30),
    minWallets: n("OBS_HOLDERS_MIN_WALLETS", 30),
    maxFreshTop10: n("OBS_HOLDERS_MAX_FRESH_TOP10", 7),
    freshTxCount: n("OBS_HOLDERS_FRESH_TX_COUNT", 3),
    firstPullHours: n("OBS_HOLDERS_FIRST_PULL_HOURS", 6),
  };
}

export interface HolderRead {
  symbol: string;
  token: string;
  at: number;
  transfers: number;
  wallets: number;
  /** Shares of circulating supply (everything not held by the pool, the hooks, the burn address or the token itself). */
  top1Pct: number | null;
  top10Pct: number | null;
  /** The first buyers, inside earlySec of the first transfer. */
  earlyBuyers: number;
  earlySameBlock: number;
  earlySameSize: number;
  bundlePct: number | null;
  /** Fresh wallets among the top ten, or null when their transaction counts were not read. */
  freshTop10: number | null;
  /** Every address the read set aside as infrastructure, the busiest sender included. */
  infra: string[];
  ok: boolean;
  why: string;
}

const dir = () => join(DATA_DIR, "holders");
const file = (token: string) => join(dir(), `${token.toLowerCase()}.jsonl`);

export function readTransfers(token: string): TransferRow[] {
  const p = file(token);
  if (!existsSync(p)) return [];
  const out: TransferRow[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as TransferRow;
      if (!seen.has(r.tx)) {
        seen.add(r.tx);
        out.push(r);
      }
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.block - b.block);
}

/**
 * Pull new Transfer events for a token since the last stored block (or, on
 * the first read, since `launchAt` when known, else the last firstPullHours)
 * and append them. Returns the whole tape. The chain not answering leaves
 * what was stored.
 */
export async function updateTransfers(token: `0x${string}`, decimals: number, now = Date.now(), launchAt: number | null = null, rules: HolderRules = holderRulesFromEnv()): Promise<TransferRow[]> {
  const existing = readTransfers(token);
  const pub = createPublicClient({ transport: http(RPC_URL, { fetchOptions: { headers: { "User-Agent": UA } } }) });
  try {
    const head = await pub.getBlock({ blockTag: "latest" });
    const headBlock = head.number;
    const headAt = Number(head.timestamp) * 1000;
    const backSec = launchAt != null ? Math.max(60, (now - launchAt) / 1000 + 120) : rules.firstPullHours * 3600;
    const fromLaunch = headBlock - BigInt(Math.ceil(backSec * BLOCKS_PER_SEC));
    // A stored scan is normally extended forward from its last block. But one that never held the mint can never
    // reach it that way, and its wallet count stays a floor for the life of the token: on 2026-09-09, with the
    // explorer refusing every read, that floor was the only thing the desk had and every candidate failed on it.
    // So a scan that does not reach the launch is filled in from the launch once, and the rows it already has are
    // kept (they are merged by transaction below). Only when a launch time is known: without one there is no
    // beginning to scan from and the window would be a guess.
    const backfill = existing.length > 0 && launchAt != null && !scanFromLaunch(existing);
    let fromBlock: bigint;
    if (backfill) fromBlock = fromLaunch;
    else if (existing.length) fromBlock = BigInt(existing[existing.length - 1].block) + 1n;
    else fromBlock = fromLaunch;
    if (fromBlock < 0n) fromBlock = 0n;
    if (fromBlock > headBlock) return existing;
    const rows: TransferRow[] = [];
    for (let start = fromBlock; start <= headBlock; start += CHUNK) {
      const end = start + CHUNK - 1n > headBlock ? headBlock : start + CHUNK - 1n;
      const logs = await pub.getLogs({ address: token, event: TRANSFER_ABI[0], fromBlock: start, toBlock: end });
      for (const l of logs) {
        const d = decodeEventLog({ abi: TRANSFER_ABI, data: l.data, topics: l.topics }).args as { from: string; to: string; value: bigint };
        const block = Number(l.blockNumber);
        rows.push({ at: headAt - Math.round((Number(headBlock) - block) / BLOCKS_PER_SEC) * 1000, block, tx: `${l.transactionHash}:${l.logIndex}`, from: d.from.toLowerCase(), to: d.to.toLowerCase(), amount: Number(d.value) / 10 ** decimals });
      }
    }
    const seen = new Set(existing.map((r) => r.tx));
    const fresh = rows.filter((r) => !seen.has(r.tx));
    if (fresh.length) {
      mkdirSync(dir(), { recursive: true });
      appendFileSync(file(token), fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    return [...existing, ...fresh].sort((a, b) => a.block - b.block);
  } catch {
    return existing;
  }
}

/** PURE: balances from transfers, everything lowercased. */
export function balancesFrom(rows: TransferRow[]): Map<string, number> {
  const b = new Map<string, number>();
  for (const r of rows) {
    if (r.from !== ZERO) b.set(r.from, (b.get(r.from) ?? 0) - r.amount);
    b.set(r.to, (b.get(r.to) ?? 0) + r.amount);
  }
  return b;
}

/**
 * PURE: the read. `infrastructure` is the set of addresses that are not
 * holders (the pool manager, the hooks, the token, the burn address); the
 * address that sent the most transfers is treated as the pool or the curve
 * too, since that is where buys come from. `txCounts` gives the top wallets'
 * transaction counts when they were read.
 */
export function holderRead(rows: TransferRow[], symbol: string, token: string, now: number, r: HolderRules, infrastructure: string[] = [], txCounts: Map<string, number> | null = null): HolderRead {
  const infra = new Set([ZERO, DEAD, token.toLowerCase(), ...infrastructure.map((a) => a.toLowerCase())]);
  const base: HolderRead = { symbol, token, at: now, transfers: rows.length, wallets: 0, top1Pct: null, top10Pct: null, earlyBuyers: 0, earlySameBlock: 0, earlySameSize: 0, bundlePct: null, freshTop10: null, infra: [...infra], ok: false, why: "" };
  if (!rows.length) return { ...base, why: "no transfers read" };
  // The busiest sender is the pool or the curve: buys come out of it.
  const sent = new Map<string, number>();
  for (const x of rows) sent.set(x.from, (sent.get(x.from) ?? 0) + 1);
  const busiest = [...sent.entries()].filter(([a]) => a !== ZERO).sort((a, b) => b[1] - a[1])[0];
  if (busiest && busiest[1] >= Math.max(5, rows.length * 0.2)) infra.add(busiest[0]);
  const balances = [...balancesFrom(rows).entries()].filter(([a, v]) => !infra.has(a) && v > 1e-9).sort((a, b) => b[1] - a[1]);
  const circulating = balances.reduce((s, [, v]) => s + v, 0);
  const wallets = balances.length;
  const top1Pct = circulating > 0 && balances.length ? (balances[0][1] / circulating) * 100 : null;
  const top10Pct = circulating > 0 ? (balances.slice(0, 10).reduce((s, [, v]) => s + v, 0) / circulating) * 100 : null;
  // The first buyers: transfers out of infrastructure to wallets inside earlySec of the first one. Only
  // meaningful when the read covers the launch, which shows as the mint (a transfer from the zero address)
  // being the first row; a read cut short of the launch says so instead of guessing.
  const coversLaunch = rows[0].from === ZERO;
  const buys = rows.filter((x) => infra.has(x.from) && !infra.has(x.to));
  const first = buys[0]?.at ?? rows[0].at;
  const early = coversLaunch ? buys.filter((x) => x.at <= first + r.earlySec * 1000) : [];
  const byBlock = new Map<number, number>();
  const bySize = new Map<string, number>();
  for (const x of early) {
    byBlock.set(x.block, (byBlock.get(x.block) ?? 0) + 1);
    bySize.set(x.amount.toPrecision(6), (bySize.get(x.amount.toPrecision(6)) ?? 0) + 1);
  }
  const earlyBuyers = new Set(early.map((x) => x.to)).size;
  const earlySameBlock = early.filter((x) => (byBlock.get(x.block) ?? 0) >= 3).length;
  const earlySameSize = early.filter((x) => (bySize.get(x.amount.toPrecision(6)) ?? 0) >= 3).length;
  const bundled = new Set(early.filter((x) => (byBlock.get(x.block) ?? 0) >= 3 || (bySize.get(x.amount.toPrecision(6)) ?? 0) >= 3).map((x) => x.to)).size;
  const bundlePct = coversLaunch && earlyBuyers ? (bundled / earlyBuyers) * 100 : null;
  let freshTop10: number | null = null;
  if (txCounts) {
    const top = balances.slice(0, 10).map(([a]) => a);
    const known = top.filter((a) => txCounts.has(a));
    freshTop10 = known.length ? known.filter((a) => (txCounts.get(a) ?? 0) <= r.freshTxCount).length : null;
  }
  const fails: string[] = [];
  if (wallets < r.minWallets) fails.push(`${wallets} wallets (${r.minWallets} needed)`);
  if (top1Pct != null && top1Pct > r.maxTop1Pct) fails.push(`the largest wallet holds ${top1Pct.toFixed(0)}% (${r.maxTop1Pct}% allowed)`);
  if (top10Pct != null && top10Pct > r.maxTop10Pct) fails.push(`the top ten hold ${top10Pct.toFixed(0)}% (${r.maxTop10Pct}% allowed)`);
  if (bundlePct != null && earlyBuyers >= 5 && bundlePct > r.maxBundlePct) fails.push(`${bundlePct.toFixed(0)}% of the first buyers look bundled (${r.maxBundlePct}% allowed)`);
  if (freshTop10 != null && freshTop10 > r.maxFreshTop10) fails.push(`${freshTop10} of the top ten wallets are fresh (${r.maxFreshTop10} allowed)`);
  const read: HolderRead = { ...base, wallets, top1Pct, top10Pct, earlyBuyers, earlySameBlock, earlySameSize, bundlePct, freshTop10, infra: [...infra] };
  if (fails.length) return { ...read, ok: false, why: fails.join(", ") };
  return { ...read, ok: true, why: `${wallets} wallets, largest ${top1Pct?.toFixed(0) ?? "?"}%, top ten ${top10Pct?.toFixed(0) ?? "?"}%, first ${r.earlySec} s ${earlyBuyers} buyers${bundlePct != null ? ` (${bundlePct.toFixed(0)}% bundled)` : ""}${freshTop10 != null ? `, ${freshTop10} of the top ten fresh` : ""}` };
}

/** PURE: the read as one observation line the agent can cite. */
export function holdersLine(h: HolderRead): string {
  if (!h.transfers) return `Holders ${h.symbol}: not read yet.`;
  // A read that could not count the holders says so first, and never leads with a number the model would take as one.
  if (!h.ok && /^holders not read/.test(h.why)) return `Holders ${h.symbol} (${h.transfers} transfers): ${h.why}. HOLDERS NOT READ.`;
  const bits = [`${h.wallets} wallets`, `largest ${h.top1Pct?.toFixed(0) ?? "?"}%`, `top ten ${h.top10Pct?.toFixed(0) ?? "?"}% of circulating`, h.bundlePct != null ? `first ${h.earlyBuyers} buyers: ${h.earlySameBlock} sharing a block, ${h.earlySameSize} identical sizes (${h.bundlePct.toFixed(0)}% bundled)` : "launch outside the read window, so the first buyers are unknown"];
  if (h.freshTop10 != null) bits.push(`${h.freshTop10} of the top ten wallets are fresh`);
  return `Holders ${h.symbol} (${h.transfers} transfers): ${bits.join("; ")}. ${h.ok ? "HOLDERS OK" : `HOLDERS FAIL: ${h.why}`}.`;
}

/** Which of a few addresses are contracts (a pool, a locker, a vesting or treasury contract), one call each, remembered for the process. An address the chain did not answer for counts as a wallet. */
const codeKnown = new Map<string, boolean>();
export async function contractsAmong(addresses: string[]): Promise<string[]> {
  const pub = createPublicClient({ transport: http(RPC_URL, { fetchOptions: { headers: { "User-Agent": UA } } }) });
  const out: string[] = [];
  await Promise.all(
    addresses.map(async (a) => {
      const k = a.toLowerCase();
      if (!codeKnown.has(k)) {
        try {
          const code = await pub.getCode({ address: k as `0x${string}` });
          codeKnown.set(k, !!code && code !== "0x");
        } catch {
          /* unread: treated as a wallet */
        }
      }
      if (codeKnown.get(k)) out.push(k);
    }),
  );
  return out;
}

/** One holder as the explorer lists it. */
export interface ExplorerHolder { address: string; isContract: boolean; balance: number }

/**
 * PURE: the holder read for a token with days of trading, from the explorer's holder list rather than a transfer
 * scan that reaches back hours. Wallets is the explorer's count; the largest wallet and the top ten are shares of
 * what people hold, with contracts (pools, lockers, vesting) and the infrastructure set aside. The first buyers are
 * a launch-day question and are not asked.
 */
export function holderReadFromList(list: ExplorerHolder[], holdersCount: number, symbol: string, token: string, now: number, r: HolderRules, infrastructure: string[] = [], countIsFloor = false): HolderRead {
  const infra = new Set([ZERO, DEAD, token.toLowerCase(), ...infrastructure.map((a) => a.toLowerCase())]);
  const people = list.filter((h) => !h.isContract && !infra.has(h.address.toLowerCase()) && h.balance > 0).sort((a, b) => b.balance - a.balance);
  const contracts = list.filter((h) => h.isContract && !infra.has(h.address.toLowerCase()));
  const circulating = people.reduce((s, h) => s + h.balance, 0);
  const top1Pct = circulating > 0 && people.length ? (people[0].balance / circulating) * 100 : null;
  const top10Pct = circulating > 0 ? (people.slice(0, 10).reduce((s, h) => s + h.balance, 0) / circulating) * 100 : null;
  const base: HolderRead = { symbol, token, at: now, transfers: list.length, wallets: holdersCount, top1Pct, top10Pct, earlyBuyers: 0, earlySameBlock: 0, earlySameSize: 0, bundlePct: null, freshTop10: null, infra: [...infra, ...contracts.map((c) => c.address.toLowerCase())], ok: true, why: "" };
  const fails: string[] = [];
  // A floor (the explorer's own count was not read and its list had more pages) under the bar is unknown, not a fail.
  if (holdersCount < r.minWallets && !countIsFloor) fails.push(`${holdersCount} wallets (${r.minWallets} needed)`);
  if (top1Pct != null && top1Pct > r.maxTop1Pct) fails.push(`the largest wallet holds ${top1Pct.toFixed(0)}% (${r.maxTop1Pct}% allowed)`);
  if (top10Pct != null && top10Pct > r.maxTop10Pct) fails.push(`the top ten hold ${top10Pct.toFixed(0)}% (${r.maxTop10Pct}% allowed)`);
  const aside = contracts.length ? ` (${contracts.length} contract${contracts.length > 1 ? "s" : ""} among the largest holders set aside as infrastructure)` : "";
  if (fails.length) return { ...base, ok: false, why: fails.join("; ") + aside };
  return { ...base, ok: true, why: `${countIsFloor ? "at least " : ""}${holdersCount} wallets by the explorer, largest ${top1Pct?.toFixed(0) ?? "?"}%, top ten ${top10Pct?.toFixed(0) ?? "?"}% of what people hold; a token with days of trading, so the first buyers are not asked${aside}` };
}

const explorerCache = new Map<string, { at: number; list: ExplorerHolder[]; holders: number; countIsFloor: boolean }>();
/** How old a last good explorer read may be and still stand in while the explorer refuses. */
const EXPLORER_STALE_MS = 6 * 3600e3;
/** A pause between explorer calls, so a cycle reading several tokens does not look like a burst. */
const EXPLORER_PAUSE_MS = 300;
let explorerLastCallAt = 0;
/** PURE: the explorer's holder count from its token record, whichever name its API gives it; null when it has none. */
export function explorerHolderCount(info: { holders?: string | number | null; holders_count?: string | number | null } | null | undefined): number | null {
  const n = Number(info?.holders_count ?? info?.holders);
  return Number.isFinite(n) && n > 0 ? n : null;
}
/**
 * The explorer's holder count and its top holders for a token, cached ten minutes. The token record carries the
 * count (holders_count on the explorer's current API, holders on the older one) and the decimals; when that record
 * does not answer, the holder list still does, and the count is then what its first pages show, a floor when more
 * pages remain. Throws only when the list itself does not answer.
 */
export async function explorerHolders(token: string, ttlMs = 10 * 60e3, decimalsHint: number | null = null): Promise<{ list: ExplorerHolder[]; holders: number; countIsFloor: boolean; ageMin?: number }> {
  const k = token.toLowerCase();
  const c = explorerCache.get(k);
  if (c && Date.now() - c.at < ttlMs) return c;
  const headers = { "User-Agent": UA, accept: "application/json" };
  const get = async (url: string, retried = false): Promise<unknown> => {
    const wait = EXPLORER_PAUSE_MS - (Date.now() - explorerLastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    explorerLastCallAt = Date.now();
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (res.status >= 500 && !retried) {
      // A 5xx from the explorer is usually a moment, not an outage: one more try after a breath.
      await new Promise((r) => setTimeout(r, 1500));
      return get(url, true);
    }
    if (!res.ok) throw new Error(`explorer answered ${res.status}`);
    return res.json();
  };
  // The last good read stands in while the explorer refuses, up to six hours old, and says how old it is.
  const standIn = (e: unknown): { list: ExplorerHolder[]; holders: number; countIsFloor: boolean; ageMin: number } => {
    if (c && Date.now() - c.at < EXPLORER_STALE_MS) return { ...c, ageMin: Math.round((Date.now() - c.at) / 60e3) };
    throw e;
  };
  let count: number | null = null;
  let decimals = decimalsHint ?? 18;
  try {
    const info = (await get(`${EXPLORER_URL}/api/v2/tokens/${token}`)) as { holders?: string | number; holders_count?: string | number; decimals?: string | number } | null;
    count = explorerHolderCount(info);
    if (info?.decimals != null && Number.isFinite(Number(info.decimals))) decimals = Number(info.decimals);
  } catch {
    /* the list decides */
  }
  const list: ExplorerHolder[] = [];
  let next: Record<string, unknown> | null = null;
  let pages = 0;
  try {
    do {
      const qs = next ? `?${new URLSearchParams(Object.entries(next).map(([a, b]) => [a, String(b)] as [string, string])).toString()}` : "";
      const page = (await get(`${EXPLORER_URL}/api/v2/tokens/${token}/holders${qs}`)) as { items?: Array<{ address?: { hash?: string; is_contract?: boolean }; value?: string | number }>; next_page_params?: Record<string, unknown> | null };
      for (const h of page.items ?? []) {
        const address = String(h.address?.hash ?? "").toLowerCase();
        if (address) list.push({ address, isContract: !!h.address?.is_contract, balance: Number(h.value ?? 0) / 10 ** decimals });
      }
      next = page.next_page_params ?? null;
      pages++;
    } while (count == null && next && pages < 3);
  } catch (e) {
    return standIn(e);
  }
  const out = { at: Date.now(), list, holders: count ?? list.length, countIsFloor: count == null && !!next };
  explorerCache.set(k, out);
  return out;
}

/**
 * PURE: a transfer-scan read for a token with days of trading, with the wallet count set aside. The scan reaches
 * back hours and counts the wallets it saw move, which is no measure of how many hold a token that old; when the
 * explorer's count could not be read, that failure alone is not a verdict, and the read says what was not read.
 */
export function withoutWalletCount(h: HolderRead, note: string, minWallets = 30): HolderRead {
  if (h.ok) return { ...h, why: `${h.why} (${note})` };
  // A scan that saw fewer wallets than the bar cannot judge concentration either: among a handful of wallets the top
  // ten hold everything by construction. That read is not read, and it says so instead of failing on an artifact.
  if (h.wallets < minWallets) return { ...h, ok: false, why: `holders not read: ${note}, and the scan saw only ${h.wallets} wallet${h.wallets === 1 ? "" : "s"} move, too few to judge` };
  const countFail = new RegExp(`^${h.wallets} wallets \\(\\d+ needed\\)(, |; )?`);
  if (!countFail.test(h.why)) return { ...h, why: `${h.why} (${note})` };
  const rest = h.why.replace(countFail, "");
  if (rest.trim()) return { ...h, why: `${rest} (${note})` };
  return { ...h, ok: true, why: `wallet count not read (${note}); largest ${h.top1Pct?.toFixed(0) ?? "?"}%, top ten ${h.top10Pct?.toFixed(0) ?? "?"}% among the wallets that moved recently` };
}

/**
 * PURE: whether a transfer scan reaches back to the token's birth: it holds the mint, the transfer from the zero
 * address. A scan without it started somewhere in the token's life, and the wallets it saw move are a floor, never
 * the holder count. LENNY's scan began hours after its launch, and the desk sold on "17 wallets" when the explorer
 * went quiet and the token's age was lost with the feed (2026-09-08).
 */
export function scanFromLaunch(rows: TransferRow[]): boolean {
  return rows.some((r) => r.from === ZERO);
}

/** Transaction counts for a few wallets, one call each; a wallet the chain did not answer for is left out. */
export async function txCounts(addresses: string[]): Promise<Map<string, number>> {
  const pub = createPublicClient({ transport: http(RPC_URL, { fetchOptions: { headers: { "User-Agent": UA } } }) });
  const out = new Map<string, number>();
  await Promise.all(
    addresses.map(async (a) => {
      try {
        out.set(a.toLowerCase(), await pub.getTransactionCount({ address: a as `0x${string}` }));
      } catch {
        /* unread */
      }
    }),
  );
  return out;
}

/** The infrastructure addresses every read sets aside: the pool manager and the router, plus what the caller knows (hooks). */
export function infrastructureAddresses(extra: Array<string | undefined | null> = []): string[] {
  const c = chainMemory().contracts.uniswapV4;
  return [c.poolManager, c.universalRouter, c.positionManager, ...extra.filter((x): x is string => !!x)];
}
