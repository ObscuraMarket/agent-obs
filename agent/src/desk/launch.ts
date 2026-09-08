// The launch itself, read from the chain. A pons v2 launch fixes most of
// what a token will be in its first transaction and its factory record:
// how much the launcher bought for itself (the dev buy), which wallets it
// declared exempt from the opening tax (the declared bundle), what creator
// tax it set and who receives the fees (a third party is the builder or
// KOL deal), and whether it has anywhere to bring flow from (the links in
// the token's own metadata). The deployer's record over the last hours
// (how many launches, how many graduated) and the launch's phase (on its
// curve, swept, in its pool, rescued) come from the same factory. Each
// read is a line the agent can cite, a score with its reasons, and a gate
// the rails apply. The points and thresholds follow the open sniper
// terminal bodkin (github.com/Phosphenq/bodkin, MIT), which measured them
// on this chain on 2026-09-03; the reads are written here in the desk's
// own shape. Every read is kept in obs-launches.jsonl so the replay can
// score which of these facts told the winners from the losers.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, parseAbiItem, decodeFunctionData, parseEventLogs, type Address, type Hex } from "viem";
import { DATA_DIR, RPC_URL } from "../config.ts";
import { chainMemory } from "../obscura/pools.ts";
import { appendLedger, readLedger } from "../ledger.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const BLOCKS_PER_SEC = 10;
const ZERO = "0x0000000000000000000000000000000000000000";
/** 1B tokens, the only launch config live on 2026-09-03. */
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const PHASE_NAME = ["curve", "swept", "pool", "rescued"] as const;
export const LAUNCH_LEDGER = "obs-launches.jsonl";
const CACHE_FILE = "obs-launches.json";

const FACTORY_ABI = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);
const TOKEN_LAUNCHED = parseAbiItem("event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)");
const POOL_GRADUATED = parseAbiItem("event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)");
const TOKEN_ABI = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)",
]);
const CURVE_ABI = parseAbi([
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
]);
export const ROUTER_ABI = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
]);
/** SnipeTaxCharged on the curve: a buy that paid the opening tax (the first seconds, bots). */
const SNIPE_TAX_TOPIC = "0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934";

export interface LaunchRules {
  /** The launcher's own buy, as a share of supply, at most this. */
  maxDevSharePct: number;
  maxCreatorTaxBps: number;
  /** Wallets declared exempt from the opening tax, at most this many. */
  maxExempt: number;
  requireSocials: boolean;
  minScore: number;
  /** A deployer with at least this many prior launches in the window and none graduated is serial. */
  serialPrior: number;
  /** The deployer window, in blocks (400,000 is about eleven hours at ten blocks a second). */
  deployerWindowBlocks: number;
}

export function launchRulesFromEnv(env: NodeJS.ProcessEnv = process.env): LaunchRules {
  const n = (k: string, d: number) => Number(env[k] ?? d);
  return {
    maxDevSharePct: n("OBS_LAUNCH_MAX_DEV_SHARE_PCT", 8),
    maxCreatorTaxBps: n("OBS_LAUNCH_MAX_CREATOR_TAX_BPS", 300),
    maxExempt: n("OBS_LAUNCH_MAX_EXEMPT", 2),
    requireSocials: (env.OBS_LAUNCH_REQUIRE_SOCIALS ?? "on") !== "off",
    minScore: n("OBS_LAUNCH_MIN_SCORE", 60),
    serialPrior: n("OBS_LAUNCH_SERIAL_PRIOR", 5),
    deployerWindowBlocks: n("OBS_LAUNCH_DEPLOYER_WINDOW_BLOCKS", 400_000),
  };
}

/** What the chain says about one launch. Fields that could not be read are null and say so in the line. */
export interface LaunchFacts {
  token: string;
  symbol: string;
  at: number;
  /** False when the factory has no record: not a pons v2 launch, so there is no launch read to gate on. */
  exists: boolean;
  phase: number | null;
  deployer: string | null;
  curve: string | null;
  feeRecipient: string | null;
  feeToThirdParty: boolean | null;
  creatorTaxBps: number | null;
  pairToken: string | null;
  /** The launcher's own buy in the launch transaction: the quote spent (in pair units) and the share of supply received. */
  devBuyQuote: number | null;
  devSharePct: number | null;
  exemptions: string[] | null;
  socials: { twitter: boolean; website: boolean; telegram: boolean } | null;
  descriptionLen: number | null;
  /** Launches by the same deployer inside the window before this one, and how many of those graduated. */
  deployerPrior: number | null;
  deployerGraduated: number | null;
  /** The curve's first minute: buys, distinct recipients, buys that paid the opening tax. */
  earlyBuys: number | null;
  earlyBuyers: number | null;
  earlyTaxedBuys: number | null;
  /** Anything that could not be read, in words. */
  unread: string[];
}

export interface LaunchScore { total: number; reasons: string[] }
export interface LaunchVerdict { ok: boolean; why: string }
export interface LaunchRead extends LaunchFacts { score: LaunchScore | null; verdict: LaunchVerdict }

/** PURE: the points, each with its reason. Starts at 50, clamps to 0..100. */
export function scoreLaunch(f: LaunchFacts): LaunchScore {
  let s = 50;
  const r: string[] = [];
  const add = (pts: number, why: string) => { s += pts; r.push(`${pts >= 0 ? "+" : ""}${pts} ${why}`); };
  if (f.devSharePct != null) {
    const d = f.devSharePct;
    if (d === 0) add(-10, "no dev buy, nothing at stake");
    else if (d < 1) add(0, `dev buy ${d.toFixed(2)}%, token-sized`);
    else if (d <= 6) add(15, `dev buy ${d.toFixed(2)}%, inside the 1 to 6% band`);
    else if (d <= 10) add(0, `dev buy ${d.toFixed(2)}%, heavy`);
    else add(-25, `dev buy ${d.toFixed(2)}%, over 10%`);
  }
  if (f.creatorTaxBps != null) {
    const tax = f.creatorTaxBps;
    if (tax === 0) add(5, "no creator tax");
    else if (tax <= 200) add(10, `creator tax ${tax / 100}%, the creator earns on volume`);
    else if (tax <= 500) add(-5, `creator tax ${tax / 100}%`);
    else add(-25, `creator tax ${tax / 100}%, traders pay ${1 + tax / 100}% a side`);
    if (f.feeToThirdParty) add(5, "fees routed to a third party (the builder or KOL deal pattern)");
  }
  if (f.socials) {
    if (!f.socials.twitter && !f.socials.website && !f.socials.telegram) add(-15, "no socials");
    else {
      if (f.socials.twitter) add(8, "has an X link");
      if (f.socials.website) add(8, "has a website");
      if (f.socials.telegram) add(3, "has a telegram");
    }
    if ((f.descriptionLen ?? 0) >= 40) add(4, "a real description");
  }
  if (f.exemptions) {
    const n = f.exemptions.length;
    if (n === 0) add(5, "no declared bundle wallets");
    else if (n <= 3) add(-5, `${n} wallet${n > 1 ? "s" : ""} exempt from the opening tax`);
    else add(-20, `${n} wallets exempt from the opening tax, a declared bundle`);
  }
  if (f.deployerPrior != null && f.deployerGraduated != null) {
    const { deployerPrior: prior, deployerGraduated: grad } = f;
    if (prior === 0) add(5, "a fresh deployer");
    else if (grad / prior >= 0.3) add(15, `the deployer graduated ${grad} of ${prior} recent launches`);
    else if (prior >= 5 && grad === 0) add(-25, `a serial deployer, ${prior} launches, none graduated`);
    else add(-5, `the deployer has ${prior} recent launches, ${grad} graduated`);
  }
  if (f.earlyBuys != null && f.earlyBuyers != null) {
    if (f.earlyBuyers >= 10) add(10, `${f.earlyBuyers} distinct buyers in the first minute`);
    else if (f.earlyBuyers >= 4) add(5, `${f.earlyBuyers} distinct buyers in the first minute`);
    if (f.earlyBuys > 0 && f.earlyTaxedBuys === f.earlyBuys) add(-10, "every first-minute buy paid the opening tax (bots only)");
  }
  return { total: Math.max(0, Math.min(100, s)), reasons: r };
}

/**
 * PURE: the rules for a token with a trading record behind it. Socials and the
 * score bar are launch-day questions; a day of real trading answers them
 * better. The hard rules stay: a swept or rescued launch, a heavy dev buy, a
 * high creator tax, a declared bundle and a serial deployer.
 */
export function launchRulesForRecord(rules: LaunchRules): LaunchRules {
  return { ...rules, requireSocials: false, minScore: 0 };
}

/** PURE: the gate. Only a pons v2 launch has a verdict; anything else passes with no launch read. */
export function launchVerdict(f: LaunchFacts, score: LaunchScore | null, rules: LaunchRules): LaunchVerdict {
  if (!f.exists) return { ok: true, why: "not a pons v2 launch, no launch read" };
  const fails: string[] = [];
  if (f.phase === 1) fails.push("the launch is swept: between its curve and its pool nothing can trade");
  if (f.phase === 3) fails.push("the launch was rescued, there is no market");
  if (f.devSharePct != null && f.devSharePct > rules.maxDevSharePct) fails.push(`the dev buy is ${f.devSharePct.toFixed(1)}% of supply (${rules.maxDevSharePct}% allowed)`);
  if (f.creatorTaxBps != null && f.creatorTaxBps > rules.maxCreatorTaxBps) fails.push(`the creator tax is ${f.creatorTaxBps / 100}% (${rules.maxCreatorTaxBps / 100}% allowed)`);
  if (f.exemptions && f.exemptions.length > rules.maxExempt) fails.push(`${f.exemptions.length} wallets were exempted from the opening tax (${rules.maxExempt} allowed)`);
  if (rules.requireSocials && f.socials && !f.socials.twitter && !f.socials.website && !f.socials.telegram) fails.push("it has no X link, website or telegram");
  if (f.deployerPrior != null && f.deployerGraduated != null && f.deployerPrior >= rules.serialPrior && f.deployerGraduated === 0) fails.push(`a serial deployer: ${f.deployerPrior} launches in the window, none graduated`);
  if (score && score.total < rules.minScore) fails.push(`score ${score.total} under the ${rules.minScore} bar`);
  return fails.length ? { ok: false, why: fails.join("; ") } : { ok: true, why: `score ${score?.total ?? "n/a"}` };
}

/** PURE: the line the agent reads. */
export function launchLine(r: LaunchRead): string {
  // A factory that did not answer is not "not a launch": the line says the read was not made, and the gate refuses
  // a new entry on it (readgate.ts, 2026-09-08).
  if (!r.exists) return r.unread.includes("the factory record") ? `Launch ${r.symbol}: not read (the factory record could not be read).` : `Launch ${r.symbol}: not a pons v2 launch, so no launch read.`;
  const bits: string[] = [];
  bits.push(`pons v2, ${r.phase == null ? "phase unread" : r.phase === 0 ? "on its curve" : r.phase === 2 ? "graduated to its pool" : PHASE_NAME[r.phase] ?? `phase ${r.phase}`}`);
  const qty = (x: number) => (x >= 100 ? Math.round(x).toLocaleString("en-US") : x >= 1 ? x.toFixed(2) : x.toPrecision(3));
  if (r.devSharePct != null) bits.push(r.devSharePct === 0 ? "no dev buy" : `dev buy ${r.devSharePct.toFixed(2)}% of supply${r.devBuyQuote != null ? ` for ${qty(r.devBuyQuote)} of the pair` : ""}`);
  if (r.creatorTaxBps != null) bits.push(`creator tax ${r.creatorTaxBps / 100}%, fees to ${r.feeToThirdParty ? "a third party" : "the deployer"}`);
  if (r.exemptions) bits.push(r.exemptions.length ? `${r.exemptions.length} wallet${r.exemptions.length > 1 ? "s" : ""} exempt from the opening tax` : "no wallets exempt from the opening tax");
  if (r.socials) {
    const has = [r.socials.twitter ? "an X link" : null, r.socials.website ? "a website" : null, r.socials.telegram ? "a telegram" : null].filter(Boolean);
    bits.push(has.length ? has.join(", ") : "no socials");
  }
  if (r.deployerPrior != null) bits.push(r.deployerPrior === 0 ? "a fresh deployer" : `deployer ${r.deployerPrior} prior launches in 11 h, ${r.deployerGraduated ?? 0} graduated`);
  if (r.earlyBuys != null) bits.push(`first minute ${r.earlyBuys} buys from ${r.earlyBuyers} wallets, ${r.earlyTaxedBuys} paid the opening tax`);
  if (r.unread.length) bits.push(`not read: ${r.unread.join(", ")}`);
  const score = r.score ? ` Score ${r.score.total} (${r.score.reasons.join("; ")}).` : "";
  return `Launch ${r.symbol}: ${bits.join("; ")}.${score} ${r.verdict.ok ? "LAUNCH OK" : `LAUNCH FAIL: ${r.verdict.why}`}.`;
}

/** PURE: the launcher's buy and exemptions from launchAndBuy calldata; null when the transaction used another path. */
export function decodeLaunchCall(input: Hex): { quoteIn: bigint; recipient: string; exemptions: string[] } | null {
  try {
    const d = decodeFunctionData({ abi: ROUTER_ABI, data: input });
    if (d.functionName !== "launchAndBuy") return null;
    const [, , , quoteIn, , recipient, ex] = d.args;
    return { quoteIn, recipient: recipient.toLowerCase(), exemptions: [...ex].map((x) => x.toLowerCase()) };
  } catch {
    return null;
  }
}

// ---- the chain reads ----

interface Cache {
  tokens: Record<string, Partial<LaunchFacts> & { readAt: number }>;
  deployers: Record<string, { prior: number; graduated: number; readAt: number; beforeBlock: number }>;
  graduated: { tokens: string[]; toBlock: number; readAt: number } | null;
}
let cache: Cache | null = null;
function loadCache(): Cache {
  if (cache) return cache;
  const p = join(DATA_DIR, CACHE_FILE);
  try { cache = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Cache) : null; } catch { cache = null; }
  cache ??= { tokens: {}, deployers: {}, graduated: null };
  cache.tokens ??= {}; cache.deployers ??= {};
  return cache;
}
function saveCache(): void {
  if (!cache) return;
  try { writeFileSync(join(DATA_DIR, CACHE_FILE), JSON.stringify(cache)); } catch { /* the cache is a convenience */ }
}

function addresses(): { factory: Address; hook: Address } {
  const lp = (chainMemory() as { contracts?: { launchpads?: Record<string, string> } }).contracts?.launchpads ?? {};
  return { factory: (lp.ponsV2Launcher ?? "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e") as Address, hook: (lp.ponsV2Hook ?? "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044") as Address };
}
const client = () => createPublicClient({ transport: http(RPC_URL, { fetchOptions: { headers: { "User-Agent": UA } } }) });
const DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const decimalsCache = new Map<string, number>();
/** The pair asset's decimals: 18 for native ETH, read once for a token pair (USDG has 6). */
async function pairDecimals(pub: ReturnType<typeof client>, pair: Address): Promise<number> {
  if (pair.toLowerCase() === ZERO) return 18;
  const k = pair.toLowerCase();
  const hit = decimalsCache.get(k);
  if (hit != null) return hit;
  const d = Number(await pub.readContract({ address: pair, abi: DECIMALS_ABI, functionName: "decimals" }).catch(() => 18));
  decimalsCache.set(k, d);
  return d;
}

/** The set of graduated tokens over the window, read once an hour in 100k-block chunks. */
async function graduatedSet(pub: ReturnType<typeof client>, head: bigint, windowBlocks: number, now: number): Promise<Set<string>> {
  const c = loadCache();
  if (c.graduated && now - c.graduated.readAt < 3600e3) return new Set(c.graduated.tokens);
  const { factory } = addresses();
  const from = head > BigInt(windowBlocks) ? head - BigInt(windowBlocks) : 0n;
  const out = new Set<string>(c.graduated?.tokens ?? []);
  let b = c.graduated && BigInt(c.graduated.toBlock) > from ? BigInt(c.graduated.toBlock) + 1n : from;
  while (b <= head) {
    const end = b + 99_999n > head ? head : b + 99_999n;
    const logs = await pub.getLogs({ address: factory, event: POOL_GRADUATED, fromBlock: b, toBlock: end });
    for (const l of logs) if (l.args.token) out.add(l.args.token.toLowerCase());
    b = end + 1n;
  }
  c.graduated = { tokens: [...out], toBlock: Number(head), readAt: now };
  return out;
}

/** Launches by the deployer inside the window before the launch block, and how many graduated. Cached an hour per deployer. */
async function deployerRecord(pub: ReturnType<typeof client>, deployer: Address, beforeBlock: bigint, head: bigint, rules: LaunchRules, now: number): Promise<{ prior: number; graduated: number }> {
  const c = loadCache();
  const k = deployer.toLowerCase();
  const hit = c.deployers[k];
  if (hit && now - hit.readAt < 3600e3 && hit.beforeBlock === Number(beforeBlock)) return { prior: hit.prior, graduated: hit.graduated };
  const { factory } = addresses();
  const from = beforeBlock > BigInt(rules.deployerWindowBlocks) ? beforeBlock - BigInt(rules.deployerWindowBlocks) : 0n;
  const tokens: string[] = [];
  let b = from;
  while (b < beforeBlock) {
    const end = b + 99_999n >= beforeBlock ? beforeBlock - 1n : b + 99_999n;
    const logs = await pub.getLogs({ address: factory, event: TOKEN_LAUNCHED, args: { deployer }, fromBlock: b, toBlock: end });
    for (const l of logs) if (l.args.token) tokens.push(l.args.token.toLowerCase());
    b = end + 1n;
  }
  const grads = tokens.length ? await graduatedSet(pub, head, rules.deployerWindowBlocks, now) : new Set<string>();
  const rec = { prior: tokens.length, graduated: tokens.filter((t) => grads.has(t)).length };
  c.deployers[k] = { ...rec, readAt: now, beforeBlock: Number(beforeBlock) };
  return rec;
}

/**
 * Read one launch. `launchAt` (ms) narrows the search for the launch transaction; the factory record
 * and the phase are read every call (the phase moves), the rest once and cached.
 */
export async function readLaunch(token: Address, symbol: string, launchAt: number | null, rules: LaunchRules = launchRulesFromEnv(), now = Date.now()): Promise<LaunchRead> {
  const pub = client();
  const { factory } = addresses();
  const c = loadCache();
  const k = token.toLowerCase();
  const unread: string[] = [];
  const facts: LaunchFacts = { token: k, symbol, at: now, exists: false, phase: null, deployer: null, curve: null, feeRecipient: null, feeToThirdParty: null, creatorTaxBps: null, pairToken: null, devBuyQuote: null, devSharePct: null, exemptions: null, socials: null, descriptionLen: null, deployerPrior: null, deployerGraduated: null, earlyBuys: null, earlyBuyers: null, earlyTaxedBuys: null, unread };
  let rec: { exists: boolean; phase: number; deployer: Address; curve: Address; creatorFeeRecipient: Address; creatorTaxBps: number; pairToken: Address } | null = null;
  try {
    const r = await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] });
    rec = { exists: r.exists, phase: Number(r.phase), deployer: r.deployer, curve: r.curve, creatorFeeRecipient: r.creatorFeeRecipient, creatorTaxBps: Number(r.creatorTaxBps), pairToken: r.pairToken };
  } catch {
    unread.push("the factory record");
  }
  if (!rec) return { ...facts, score: null, verdict: { ok: true, why: "the factory record could not be read" } };
  if (!rec.exists) {
    const read: LaunchRead = { ...facts, exists: false, score: null, verdict: launchVerdict(facts, null, rules) };
    return read;
  }
  Object.assign(facts, { exists: true, phase: rec.phase, deployer: rec.deployer.toLowerCase(), curve: rec.curve.toLowerCase(), feeRecipient: rec.creatorFeeRecipient.toLowerCase(), feeToThirdParty: rec.creatorFeeRecipient.toLowerCase() !== rec.deployer.toLowerCase(), creatorTaxBps: rec.creatorTaxBps, pairToken: rec.pairToken.toLowerCase() });

  const cached = c.tokens[k];
  if (cached && cached.devSharePct !== undefined) {
    for (const key of ["devBuyQuote", "devSharePct", "exemptions", "socials", "descriptionLen", "earlyBuys", "earlyBuyers", "earlyTaxedBuys"] as const) (facts as unknown as Record<string, unknown>)[key] = cached[key] ?? null;
  } else {
    // The token's own metadata: links and a description.
    try {
      const info = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "getTokenInfo" });
      const s = info[3];
      facts.socials = { twitter: !!s.twitter?.trim(), website: !!s.website?.trim(), telegram: !!s.telegram?.trim() };
      facts.descriptionLen = (info[2] ?? "").length;
    } catch {
      unread.push("the token's links");
    }
    // The launch transaction: found by the TokenLaunched event, then the calldata and the curve's own buys in it.
    try {
      const head = await pub.getBlockNumber();
      const est = launchAt ? head - BigInt(Math.max(0, Math.floor(((now - launchAt) / 1000) * BLOCKS_PER_SEC))) : null;
      let log: { blockNumber: bigint; transactionHash: Hex } | null = null;
      const windows: Array<[bigint, bigint]> = est ? [[est - 15_000n, est + 15_000n], [est - 60_000n, est - 15_001n], [est + 15_001n, head]] : [[head - 100_000n, head], [head - 400_000n, head - 100_001n]];
      for (const [a, b] of windows) {
        const from = a < 0n ? 0n : a;
        if (from > b) continue;
        const logs = await pub.getLogs({ address: factory, event: TOKEN_LAUNCHED, args: { token }, fromBlock: from, toBlock: b > head ? head : b });
        if (logs.length && logs[0].blockNumber != null && logs[0].transactionHash) { log = { blockNumber: logs[0].blockNumber, transactionHash: logs[0].transactionHash }; break; }
      }
      if (!log) unread.push("the launch transaction");
      else {
        const [tx, receipt] = await Promise.all([pub.getTransaction({ hash: log.transactionHash }), pub.getTransactionReceipt({ hash: log.transactionHash })]);
        const call = decodeLaunchCall(tx.input);
        let devTokens = 0n, spent = 0n;
        for (const b of parseEventLogs({ abi: CURVE_ABI, logs: receipt.logs, eventName: "CurveBuy" })) if (b.address.toLowerCase() === rec.curve.toLowerCase()) { devTokens += b.args.tokensOut; spent += b.args.quoteIn; }
        const quote = call?.quoteIn && call.quoteIn > 0n ? call.quoteIn : spent;
        facts.devSharePct = (Number(devTokens) / Number(SUPPLY)) * 100;
        facts.devBuyQuote = Number(quote) / 10 ** (await pairDecimals(pub, rec.pairToken));
        facts.exemptions = call ? call.exemptions : [];
        // The curve's first minute: who bought, who paid the opening tax.
        try {
          const logs = await pub.getLogs({ address: rec.curve, fromBlock: log.blockNumber, toBlock: log.blockNumber + 600n });
          const buys = parseEventLogs({ abi: CURVE_ABI, logs, eventName: "CurveBuy" });
          facts.earlyBuys = buys.length;
          facts.earlyBuyers = new Set(buys.map((b) => b.args.recipient.toLowerCase())).size;
          facts.earlyTaxedBuys = logs.filter((l) => l.topics[0] === SNIPE_TAX_TOPIC).length;
        } catch {
          unread.push("the curve's first minute");
        }
        // The deployer's record before this launch.
        try {
          const d = await deployerRecord(pub, rec.deployer, log.blockNumber, head, rules, now);
          facts.deployerPrior = d.prior;
          facts.deployerGraduated = d.graduated;
        } catch {
          unread.push("the deployer's record");
        }
      }
    } catch {
      unread.push("the launch transaction");
    }
    if (!unread.length || facts.devSharePct != null) {
      c.tokens[k] = { readAt: now, devBuyQuote: facts.devBuyQuote, devSharePct: facts.devSharePct, exemptions: facts.exemptions, socials: facts.socials, descriptionLen: facts.descriptionLen, earlyBuys: facts.earlyBuys, earlyBuyers: facts.earlyBuyers, earlyTaxedBuys: facts.earlyTaxedBuys };
    }
  }
  // The deployer's record is cheap once cached; read it here for a cached token too.
  if (facts.deployerPrior == null && rec.deployer && !cached?.deployerPrior) {
    try {
      const head = await pub.getBlockNumber();
      const est = launchAt ? head - BigInt(Math.max(0, Math.floor(((now - launchAt) / 1000) * BLOCKS_PER_SEC))) : head;
      const d = await deployerRecord(pub, rec.deployer, est, head, rules, now);
      facts.deployerPrior = d.prior;
      facts.deployerGraduated = d.graduated;
    } catch { /* stays unread */ }
  }
  saveCache();
  const score = scoreLaunch(facts);
  const verdict = launchVerdict(facts, score, rules);
  const read: LaunchRead = { ...facts, score, verdict };
  // The ledger keeps the first full read of each token, for the replay.
  if (!readLedger<{ token: string }>(LAUNCH_LEDGER).some((r) => r.token === k)) appendLedger(LAUNCH_LEDGER, read as unknown as Record<string, unknown>);
  return read;
}
