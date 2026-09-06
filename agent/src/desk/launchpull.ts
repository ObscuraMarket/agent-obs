// The desk's own launch feed, straight from the launchpad's contract. Every
// OBS_LAUNCH_PULL_SEC seconds it reads the factory's TokenLaunched events
// since the last block it saw, reads each launch's record, symbol and block
// time, and appends a row in the watcher's shape to OBS_CHAIN_FEED. The
// feed parser reads that file beside the watcher's, so a launch is on the
// live watch within seconds of its block rather than when the watcher
// gets to it. Nothing here trades.
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { RPC_URL, NEVER_TRADE, dataPath } from "../config.ts";
import { chainMemory } from "../obscura/pools.ts";
import { chainLaunchRow } from "./chainlaunch.ts";

const FEED = process.env.OBS_CHAIN_FEED ?? (process.env.OBS_CANDIDATE_FEED ? join(dirname(process.env.OBS_CANDIDATE_FEED), "launch-chain.jsonl") : dataPath("feed/launch-chain.jsonl"));
const EVERY = Number(process.env.OBS_LAUNCH_PULL_SEC ?? 3);
const START_BACK = Number(process.env.OBS_LAUNCH_PULL_START_BLOCKS ?? 600);
const CURSOR = dataPath("obs-launchpull.json");
const UA = "AgentOBS/1.0 (+https://obscura.markets)";

const TOKEN_LAUNCHED = parseAbiItem("event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)");
const FACTORY_ABI = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);
const ERC20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);

const factory = ((chainMemory() as { contracts?: { launchpads?: Record<string, string> } }).contracts?.launchpads?.ponsV2Launcher ?? "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e") as `0x${string}`;
const pub = createPublicClient({ transport: http(RPC_URL, { fetchOptions: { headers: { "User-Agent": UA } } }) });
mkdirSync(dirname(FEED), { recursive: true });

let last: bigint | null = null;
const seen = new Set<string>();
try {
  const c = JSON.parse(readFileSync(CURSOR, "utf8")) as { block?: number };
  if (c.block) last = BigInt(c.block);
} catch { /* fresh start */ }
if (existsSync(FEED)) for (const line of readFileSync(FEED, "utf8").split("\n").slice(-4000)) { try { const r = JSON.parse(line) as { token?: string }; if (r.token) seen.add(r.token.toLowerCase()); } catch { /* skip */ } }

const blockTimes = new Map<bigint, number>();
async function timeOf(block: bigint): Promise<number> {
  const known = blockTimes.get(block);
  if (known) return known;
  const b = await pub.getBlock({ blockNumber: block });
  const t = Number(b.timestamp) * 1000;
  blockTimes.set(block, t);
  if (blockTimes.size > 500) blockTimes.delete(blockTimes.keys().next().value as bigint);
  return t;
}

async function pull(): Promise<number> {
  const head = await pub.getBlockNumber();
  if (last == null) last = head - BigInt(START_BACK);
  if (head <= last) return 0;
  const from = last + 1n;
  const to = head - from > 2000n ? from + 2000n : head;
  const logs = await pub.getLogs({ address: factory, event: TOKEN_LAUNCHED, fromBlock: from, toBlock: to });
  let wrote = 0;
  for (const l of logs) {
    const token = (l.args.token as string).toLowerCase() as `0x${string}`;
    if (seen.has(token) || NEVER_TRADE.has(token)) continue;
    let symbol = "", name = "", creatorTaxBps: number | null = null, pairToken = (l.args.pairToken as string).toLowerCase() as `0x${string}`;
    try { symbol = String(await pub.readContract({ address: token, abi: ERC20, functionName: "symbol" })); } catch { /* unnamed */ }
    try { name = String(await pub.readContract({ address: token, abi: ERC20, functionName: "name" })); } catch { /* unnamed */ }
    try {
      const r = await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] });
      if (r.exists) { creatorTaxBps = Number(r.creatorTaxBps); pairToken = r.pairToken.toLowerCase() as `0x${string}`; }
    } catch { /* the event's pair stands */ }
    const at = await timeOf(l.blockNumber);
    const row = chainLaunchRow({ token, symbol: symbol.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12), name, pairToken, creatorTaxBps, at, block: Number(l.blockNumber), tx: l.transactionHash }, Date.now());
    appendFileSync(FEED, JSON.stringify(row) + "\n");
    seen.add(token);
    wrote++;
    console.log(`[launchpull] ${row.symbol || token.slice(0, 10)} launched ${((Date.now() - at) / 1000).toFixed(0)} s ago on ${row.pairSymbol ?? "an unnamed pair"}${creatorTaxBps != null ? `, creator tax ${(creatorTaxBps / 100).toFixed(1)}%` : ""}`);
  }
  last = to;
  writeFileSync(CURSOR, JSON.stringify({ block: Number(to), at: Date.now() }));
  return wrote;
}

console.log(`[launchpull] factory ${factory} -> ${FEED}, every ${EVERY} s`);
for (;;) {
  try {
    await pull();
  } catch (e) {
    console.log(`[launchpull] ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
  }
  await new Promise((r) => setTimeout(r, EVERY * 1000));
}
