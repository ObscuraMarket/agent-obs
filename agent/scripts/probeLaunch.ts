// What the desk can know about the newest launches, straight from chain: the
// factory's last TokenLaunched events, each launch's derived curve pool id,
// and whether that pool's key resolves (its Initialize event exists yet).
//   npx tsx scripts/probeLaunch.ts [blocks back]
import { createPublicClient, http, parseAbiItem } from "viem";
import { RPC_URL } from "../src/config.ts";
import { chainMemory } from "../src/obscura/pools.ts";
import { curvePoolIdFor, curveKey } from "../src/desk/candidates.ts";
import { pairSymbolOf } from "../src/desk/chainlaunch.ts";

const back = BigInt(process.argv[2] ?? 300);
const TOKEN_LAUNCHED = parseAbiItem("event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)");
const factory = ((chainMemory() as { contracts?: { launchpads?: Record<string, string> } }).contracts?.launchpads?.ponsV2Launcher ?? "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e") as `0x${string}`;
const pub = createPublicClient({ transport: http(RPC_URL) });
const head = await pub.getBlockNumber();
const logs = await pub.getLogs({ address: factory, event: TOKEN_LAUNCHED, fromBlock: head - back, toBlock: head });
console.log(`${logs.length} launches in the last ${back} blocks (head ${head})`);
const pick = process.argv[3] === "oldest" ? logs.slice(0, 8) : logs.slice(-6);
for (const l of pick) {
  const token = (l.args.token as string).toLowerCase() as `0x${string}`;
  const pair = (l.args.pairToken as string).toLowerCase() as `0x${string}`;
  const sym = pairSymbolOf(pair);
  const id = curvePoolIdFor(token, sym, sym ? null : pair);
  const t0 = Date.now();
  const key = id ? await curveKey(id) : null;
  console.log(`${token.slice(0, 10)} pair ${sym ?? pair.slice(0, 10)} block ${l.blockNumber} (${Number(head - l.blockNumber)} blocks ago) id ${id ? id.slice(0, 12) : "none"} key ${key ? `ok (hooks ${key.hooks.slice(0, 10)}, fee ${key.fee}, spacing ${key.tickSpacing})` : "NOT FOUND"} in ${Date.now() - t0} ms`);
}
