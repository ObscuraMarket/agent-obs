// The desk's own launch feed, straight from the chain. Every
// OBS_LAUNCH_PULL_SEC seconds it reads two things since the last block it
// saw: the launchpad factory's TokenLaunched events (a launch exists), and
// the pool manager's Initialize events under the launchpad's hook (the
// launch's curve pool was created by its first buy, and the desk can trade
// it from this block on). Each launch is a row in the watcher's shape in
// OBS_CHAIN_FEED; the pool's creation re-emits the row with firstSwapTs and
// puts the pool's key into the curve cache, so the live watch needs no
// chain read to take the token on. A launch's pool does not exist at
// launch: of eight launches ten minutes old, one had a pool. Nothing here
// trades.
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { RPC_URL, NEVER_TRADE, dataPath } from "../config.ts";
import { chainMemory } from "../obscura/pools.ts";
import { rememberCurve } from "./candidates.ts";
import { chainLaunchRow, pairSymbolOf, type ChainLaunchFacts } from "./chainlaunch.ts";

const FEED = process.env.OBS_CHAIN_FEED ?? (process.env.OBS_CANDIDATE_FEED ? join(dirname(process.env.OBS_CANDIDATE_FEED), "launch-chain.jsonl") : dataPath("feed/launch-chain.jsonl"));
const EVERY = Number(process.env.OBS_LAUNCH_PULL_SEC ?? 3);
const START_BACK = Number(process.env.OBS_LAUNCH_PULL_START_BLOCKS ?? 600);
const CURSOR = dataPath("obs-launchpull.json");
const UA = "AgentOBS/1.0 (+https://obscura.markets)";

const TOKEN_LAUNCHED = parseAbiItem("event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)");
const INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const FACTORY_ABI = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);
const ERC20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);

const mem = chainMemory() as { contracts?: { launchpads?: Record<string, string>; uniswapV4?: { poolManager?: string } } };
const factory = (mem.contracts?.launchpads?.ponsV2Launcher ?? "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e") as `0x${string}`;
const hook = (mem.contracts?.launchpads?.ponsV2Hook ?? "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044").toLowerCase();
const poolManager = mem.contracts?.uniswapV4?.poolManager as `0x${string}` | undefined;
if (!poolManager) {
  console.log("[launchpull] the chain memory names no pool manager; nothing to watch");
  process.exit(0);
}
const pub = createPublicClient({ transport: http(RPC_URL, { fetchOptions: { headers: { "User-Agent": UA } } }) });
mkdirSync(dirname(FEED), { recursive: true });

let last: bigint | null = null;
/** The rows written so far, by token, so a pool's creation re-emits the whole row with the first swap on it. */
const rows = new Map<string, ChainLaunchFacts>();
try {
  const c = JSON.parse(readFileSync(CURSOR, "utf8")) as { block?: number };
  if (c.block) last = BigInt(c.block);
} catch { /* fresh start */ }
if (existsSync(FEED)) {
  for (const line of readFileSync(FEED, "utf8").split("\n").slice(-6000)) {
    try {
      const r = JSON.parse(line) as { token?: string; symbol?: string; name?: string; pair?: string; creatorTaxBps?: number | null; ts?: number; block?: number; tx?: string; firstSwapTs?: number | null };
      if (r.token && r.pair) rows.set(r.token.toLowerCase(), { token: r.token.toLowerCase() as `0x${string}`, symbol: r.symbol ?? "", name: r.name ?? "", pairToken: r.pair.toLowerCase() as `0x${string}`, creatorTaxBps: r.creatorTaxBps ?? null, at: (r.ts ?? 0) * 1000, block: r.block ?? 0, tx: r.tx ?? "", firstSwapAt: r.firstSwapTs ? r.firstSwapTs * 1000 : null });
    } catch { /* skip */ }
  }
}

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

const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);

/** The token's name, symbol and factory record, for a token the feed has not seen. */
async function facts(token: `0x${string}`, pairFromEvent: `0x${string}`, block: bigint, tx: string): Promise<ChainLaunchFacts> {
  let symbol = "", name = "", creatorTaxBps: number | null = null, pairToken = pairFromEvent;
  try { symbol = clean(String(await pub.readContract({ address: token, abi: ERC20, functionName: "symbol" }))); } catch { /* unnamed */ }
  try { name = String(await pub.readContract({ address: token, abi: ERC20, functionName: "name" })); } catch { /* unnamed */ }
  try {
    const r = await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] });
    if (r.exists) { creatorTaxBps = Number(r.creatorTaxBps); pairToken = r.pairToken.toLowerCase() as `0x${string}`; }
  } catch { /* the event's pair stands */ }
  return { token, symbol, name, pairToken, creatorTaxBps, at: await timeOf(block), block: Number(block), tx, firstSwapAt: null };
}

function emit(f: ChainLaunchFacts): void {
  rows.set(f.token, f);
  appendFileSync(FEED, JSON.stringify(chainLaunchRow(f, Date.now())) + "\n");
}

async function pull(): Promise<void> {
  const head = await pub.getBlockNumber();
  if (last == null) last = head - BigInt(START_BACK);
  if (head <= last) return;
  const from = last + 1n;
  const to = head - from > 2000n ? from + 2000n : head;
  // Launches.
  for (const l of await pub.getLogs({ address: factory, event: TOKEN_LAUNCHED, fromBlock: from, toBlock: to })) {
    const token = (l.args.token as string).toLowerCase() as `0x${string}`;
    if (rows.has(token) || NEVER_TRADE.has(token)) continue;
    const f = await facts(token, (l.args.pairToken as string).toLowerCase() as `0x${string}`, l.blockNumber, l.transactionHash);
    emit(f);
    console.log(`[launchpull] ${f.symbol || token.slice(0, 10)} launched ${((Date.now() - f.at) / 1000).toFixed(0)} s ago on ${pairSymbolOf(f.pairToken) ?? "an unnamed pair"}${f.creatorTaxBps != null ? `, creator tax ${(f.creatorTaxBps / 100).toFixed(1)}%` : ""}; no pool yet`);
  }
  // Pools created under the launchpad's hook: the launch's first buy, and the moment the desk can trade it.
  for (const l of await pub.getLogs({ address: poolManager, event: INITIALIZE, fromBlock: from, toBlock: to })) {
    if (String(l.args.hooks).toLowerCase() !== hook) continue;
    const c0 = (l.args.currency0 as string).toLowerCase() as `0x${string}`;
    const c1 = (l.args.currency1 as string).toLowerCase() as `0x${string}`;
    const id = (l.args.id as string).toLowerCase() as `0x${string}`;
    rememberCurve({ poolId: id, currency0: c0, currency1: c1, fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing), hooks: hook as `0x${string}` });
    // The token is the side that is not a quote the desk names; when neither is, the launch row already says which.
    const token = pairSymbolOf(c0) ? c1 : pairSymbolOf(c1) ? c0 : (rows.has(c1) ? c1 : rows.has(c0) ? c0 : null);
    if (!token || NEVER_TRADE.has(token)) continue;
    const pair = token === c1 ? c0 : c1;
    const known = rows.get(token);
    const f: ChainLaunchFacts = known ? { ...known } : await facts(token, pair, l.blockNumber, l.transactionHash);
    if (f.firstSwapAt) continue;
    f.firstSwapAt = await timeOf(l.blockNumber);
    emit(f);
    console.log(`[launchpull] ${f.symbol || token.slice(0, 10)} got its pool ${((Date.now() - f.firstSwapAt) / 1000).toFixed(0)} s ago, ${((f.firstSwapAt - f.at) / 60e3).toFixed(1)} min after launch, on ${pairSymbolOf(f.pairToken) ?? "an unnamed pair"}: tradable`);
  }
  last = to;
  writeFileSync(CURSOR, JSON.stringify({ block: Number(to), at: Date.now() }));
}

console.log(`[launchpull] factory ${factory}, pools under hook ${hook.slice(0, 10)} on ${poolManager.slice(0, 10)} -> ${FEED}, every ${EVERY} s`);
for (;;) {
  try {
    await pull();
  } catch (e) {
    console.log(`[launchpull] ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
  }
  await new Promise((r) => setTimeout(r, EVERY * 1000));
}
