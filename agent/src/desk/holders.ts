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
import { DATA_DIR, RPC_URL } from "../config.ts";
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
    let fromBlock: bigint;
    if (existing.length) fromBlock = BigInt(existing[existing.length - 1].block) + 1n;
    else {
      const backSec = launchAt != null ? Math.max(60, (now - launchAt) / 1000 + 120) : rules.firstPullHours * 3600;
      fromBlock = headBlock - BigInt(Math.ceil(backSec * BLOCKS_PER_SEC));
    }
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
    if (rows.length) {
      mkdirSync(dir(), { recursive: true });
      appendFileSync(file(token), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    const seen = new Set(existing.map((r) => r.tx));
    return [...existing, ...rows.filter((r) => !seen.has(r.tx))].sort((a, b) => a.block - b.block);
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
