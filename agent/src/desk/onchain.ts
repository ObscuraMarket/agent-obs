// The on-chain lane: a swap in the Uniswap v4 pools on Robinhood Chain from
// the desk's own wallet, through the chain's UniversalRouter. Every leg goes
// through USDG, because that is where the depth is: ETH/USDG at 0.01% and
// NVDA/USDG at 0.3%, both hookless, both in the chain memory with their pool
// ids. The output is estimated from the pool's own state (exact within the
// active tick, which is exact enough for a $25 trade against $70k of depth),
// the transaction is simulated from the wallet before anything is signed,
// and the minimum output is the estimate less the slippage allowance.
//
// This chain's router does NOT accept the standard v4-periphery swap
// encodings. The shape that lands here is the path-based SWAP_EXACT_IN with
// SETTLE and TAKE, and an ExactInputParams with an extra empty bytes field
// before the amounts, tuple-wrapped. It is encoded below and checked, in
// simulation, every time before it is sent.
import { encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from "viem";
import { chainMemory, poolRead, type PoolSpec, type PoolRead } from "../obscura/pools.ts";
import { ASSETS, assetKey, chainOf, type Asset } from "./assets.ts";
import { checkRails, type Intent, type RailContext } from "./rails.ts";
import { recordTrade, readBook, latestTrades, boughtSymbols, intentTimedOut, INTENT_STALE_MIN, type Trade } from "./book.ts";
import { simulateFromWallet, sendTx, waitReceipt, readReceipt, readNativeBalance, readTokenBalance, readErc20Allowance, readPermit2Allowance, approveErc20Data, approvePermit2Data, type RawTx, type Wallet, type ReceiptRead } from "./signer.ts";
import { fomoOn, fomoRoute, maxGiveUpPct, type FomoRoute } from "./fomo.ts";
import { directOn, fundGas, sendDirect, WETH as wethAddress } from "./direct.ts";
import { aaOn, swapBatch, wethWithdrawData, type AaCall, ethInPlan, buildUserOp, simulateUserOp, simulateBatch, submitUserOp, waitUserOp, ensureDeposit, depositMinWei, depositTopUpWei, prefundWei, spendableEthRaw, receivedRawFromLogs, nativeOutFromSwapLogs, opOutcomeOf, type PreparedOp, type SwapBatchToken } from "./aa.ts";
import { WALLET_ADDRESS, NEVER_TRADE, WETH_CONTRACT } from "../config.ts";
import { ledgerWriteFailures } from "../ledger.ts";
import { raiseAlert, type AlertKind } from "./alerts.ts";
import { dynamicAssets, dynamicPoolSpec, readFeed, resolveAny, tokenInfo, upsertToken, exitVerdict, isHolding, type FeedSnapshot } from "./candidates.ts";
import { readPrices } from "./analysis.ts";
import { readTape, tapeStats, tapeWindowMin } from "./tape.ts";
import { readEntries, recordClose, positionSpans, closeFromSpan, entryForSpan, closeRow, ethUsdAt, type TradeClose } from "./trade-memory.ts";
import { railInput, quoteUsd, tapeLastUsd } from "./railInput.ts";
import { readTapePeaks } from "./tapePeaks.ts";
import type { QuoteRead } from "./thoughts.ts";

export const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const Q96 = 2n ** 96n;
const ACTIONS = "0x070b0e" as const; // SWAP_EXACT_IN, SETTLE, TAKE
const V4_SWAP = "0x10" as const;
/** Trade ids are unique within a process: a cycle that sold one token and bought another stamped both with its one `now`, and the later row erased the earlier in every ledger keyed by id (2026-09-08). */
let tradeSeq = 0;
export function nextTradeId(now: number, prefix = "pool"): string { tradeSeq += 1; return tradeSeq === 1 ? `${prefix}-${now}` : `${prefix}-${now}-${tradeSeq}`; }
const ROUTER_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const SLIPPAGE_PCT = Number(process.env.OBS_SLIPPAGE_PCT ?? 1);

export interface Hop {
  key: string;
  spec: PoolSpec;
  /** True when the hop sells the pool's token0. */
  zeroForOne: boolean;
  currencyOut: `0x${string}`;
  fee: number;
  tickSpacing: number;
}
export interface Route {
  from: Asset;
  to: Asset;
  currencyIn: `0x${string}`;
  hops: Hop[];
}

/** The currency address of a registry asset on Robinhood Chain; native ETH is the zero address. */
export function currencyOf(a: Asset): `0x${string}` {
  return a.kind === "native" ? NATIVE : (a.contract as `0x${string}`);
}
const robinhood = (symbol: string, dyn: Record<string, Asset>): Asset | null => ASSETS[`${symbol}@robinhood`] ?? dyn[`${symbol}@robinhood`] ?? null;

/** The pool a dynamic token trades in, and the symbol on the other side of it. */
function dynamicSpec(symbol: string, dyn: Record<string, Asset>): { spec: PoolSpec; quote: string } | null {
  const a = dyn[`${symbol}@robinhood`];
  const spec = a ? dynamicPoolSpec(a) : null;
  return spec ? { spec, quote: spec.quote ?? "USDG" } : null;
}

/** PURE: the hop that sells `from` for `to`: a reference pool, a dynamic token's side pool, or its launch curve. Null when there is none. */
function hop(from: string, to: string, pools: Record<string, PoolSpec>, dyn: Record<string, Asset>): Hop | null {
  const out = robinhood(to, dyn);
  if (!out) return null;
  // A dynamic token's own pool wins over any reference pool: named "<token>/USDG" for a side pool, "<quote>/<token>" for a launch curve.
  const dynSym = dynamicSpec(to, dyn) ? to : dynamicSpec(from, dyn) ? from : null;
  const d = dynSym ? dynamicSpec(dynSym, dyn) : null;
  let key: string;
  let spec: PoolSpec | undefined;
  if (d && dynSym) {
    spec = d.spec;
    key = d.spec.hookAddress ? `${d.quote}/${dynSym}` : `${dynSym}/USDG`;
  } else {
    key = from === "USDG" ? `${to}/USDG` : `${from}/USDG`;
    spec = pools[key];
  }
  if (!spec || spec.venue !== "uniswap-v4") return null;
  if (spec.hooks && !spec.hookAddress) return null;
  if (spec.token0 !== from && spec.token1 !== from) return null;
  if (spec.token0 !== to && spec.token1 !== to) return null;
  return { key, spec, zeroForOne: spec.token0 === from, currencyOut: currencyOf(out), fee: spec.feePips ?? Math.round(spec.feePct * 10000), tickSpacing: spec.tickSpacing };
}

/** PURE: the legs from A to B. The hub is USDG; a launch token quoted in NVDA or ETH is reached through that quote first. */
function legsFor(from: string, to: string, dyn: Record<string, Asset>): string[][] {
  const quoteOf = (sym: string) => dynamicSpec(sym, dyn)?.quote ?? null;
  const qFrom = quoteOf(from);
  const qTo = quoteOf(to);
  if (qFrom && from !== "USDG") return [[from, qFrom], ...(qFrom === to ? [] : legsFor(qFrom, to, dyn))];
  if (qTo && to !== "USDG") return [...(from === qTo ? [] : legsFor(from, qTo, dyn)), [qTo, to]];
  if (from === to) return [];
  if (from === "USDG" || to === "USDG") return [[from, to]];
  return [[from, "USDG"], ["USDG", to]];
}

/** PURE: the route from A to B. Null when a leg has no pool. */
export function routeFor(from: Asset, to: Asset, pools: Record<string, PoolSpec> = chainMemory().referencePools, dyn: Record<string, Asset> = dynamicFor(from, to)): Route | null {
  if (from.chain !== "robinhood" || to.chain !== "robinhood" || from.symbol === to.symbol) return null;
  const hops: Hop[] = [];
  for (const [a, b] of legsFor(from.symbol, to.symbol, dyn)) {
    const h = hop(a, b, pools, dyn);
    if (!h) return null;
    hops.push(h);
  }
  return hops.length ? { from, to, currencyIn: currencyOf(from), hops } : null;
}

/** The dynamic assets a route may need: the legs themselves when they are candidates, else whatever the feed and the token file know. */
function dynamicFor(from: Asset, to: Asset): Record<string, Asset> {
  const own: Record<string, Asset> = {};
  for (const a of [from, to]) if (a.candidate) own[`${a.symbol}@robinhood`] = a;
  if (Object.keys(own).length) return own;
  try {
    return dynamicAssets();
  } catch {
    return {};
  }
}

/** PURE: exact-in output inside the active tick. Raw units; sqrtP is Q64.96; fee in pips of a million. */
export function exactInWithinTick(amountIn: bigint, sqrtP: bigint, liquidity: bigint, feePips: number, zeroForOne: boolean): { out: bigint; sqrtPAfter: bigint } {
  const x = (amountIn * BigInt(1_000_000 - feePips)) / 1_000_000n;
  if (liquidity <= 0n || sqrtP <= 0n || x <= 0n) return { out: 0n, sqrtPAfter: sqrtP };
  if (zeroForOne) {
    const sqrtPAfter = (liquidity * sqrtP * Q96) / (liquidity * Q96 + x * sqrtP);
    return { out: (liquidity * (sqrtP - sqrtPAfter)) / Q96, sqrtPAfter };
  }
  const sqrtPAfter = sqrtP + (x * Q96) / liquidity;
  return { out: (liquidity * (sqrtPAfter - sqrtP) * Q96) / (sqrtP * sqrtPAfter), sqrtPAfter };
}

export interface PoolQuote {
  route: Route;
  amountIn: number;
  amountOut: number;
  /** The estimate less the slippage allowance; the transaction's floor. */
  minOut: number;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  minOutRaw: bigint;
  /** Dollars per unit as the pools set them, for the from and to assets. */
  priceInUsd: number | null;
  priceOutUsd: number | null;
  /** What the route costs against the pools' own mid prices: fees plus impact. */
  costPct: number | null;
  feePct: number;
  pools: Array<{ key: string; read: PoolRead }>;
}

const toRaw = (v: number, decimals: number): bigint => BigInt(Math.round(v * 10 ** Math.min(decimals, 9))) * 10n ** BigInt(Math.max(decimals - 9, 0));
const fromRaw = (v: bigint, decimals: number): number => Number(v) / 10 ** decimals;
/** PURE: never send more than the wallet holds. A float of the balance can round a few hundred wei above it, and a transfer of one wei too many reverts the sell. */
export function clampToBalanceRaw(amountRaw: bigint, balanceRaw: bigint): bigint {
  if (balanceRaw <= 0n) return 0n;
  return amountRaw > balanceRaw ? balanceRaw : amountRaw;
}

/** The route quoted from live pool state. Null when a pool did not answer. */
export async function quoteOnChain(from: Asset, to: Asset, amountIn: number, slippagePct = SLIPPAGE_PCT): Promise<PoolQuote | null> {
  const route = routeFor(from, to);
  if (!route || !(amountIn > 0)) return null;
  const pools: Array<{ key: string; read: PoolRead }> = [];
  let raw = toRaw(amountIn, from.decimals);
  for (const h of route.hops) {
    const read = await poolRead(h.spec);
    if (!read) return null;
    pools.push({ key: h.key, read });
    const feeForEstimate = h.spec.hookAddress ? Math.round(h.spec.feePct * 10000) : h.fee;
    raw = exactInWithinTick(raw, BigInt(read.sqrtPriceX96), BigInt(read.liquidity), feeForEstimate, h.zeroForOne).out;
  }
  const amountOutRaw = raw;
  // A curve's hook prices in ways the tick math cannot see; the floor sits wider there.
  const slip = route.hops.some((h) => h.spec.hookAddress) ? Math.max(slippagePct, Number(process.env.OBS_CURVE_SLIPPAGE_PCT ?? 8)) : slippagePct;
  const minOutRaw = (amountOutRaw * BigInt(Math.round((100 - slip) * 1000))) / 100_000n;
  const usdOf = (a: Asset): number | null => {
    if (a.symbol === "USDG") return 1;
    const p = pools.find((x) => x.key === `${a.symbol}/USDG`);
    if (p) return p.read.priceUsd;
    // A launch token quoted in NVDA or ETH: its pool price times that quote's dollar price from the same route.
    const own = pools.find((x) => x.key.split("/").includes(a.symbol) && x.key !== `${a.symbol}/USDG`);
    if (!own) return null;
    const quote = own.key.split("/").find((k) => k !== a.symbol) ?? "USDG";
    const qp = quote === "USDG" ? 1 : (pools.find((x) => x.key === `${quote}/USDG`)?.read.priceUsd ?? null);
    return qp == null ? null : own.read.priceUsd * qp;
  };
  const priceInUsd = usdOf(from);
  const priceOutUsd = usdOf(to);
  const amountOut = fromRaw(amountOutRaw, to.decimals);
  const costPct = priceInUsd != null && priceOutUsd != null && priceInUsd > 0 ? (1 - (amountOut * priceOutUsd) / (amountIn * priceInUsd)) * 100 : null;
  const feePct = (1 - route.hops.reduce((k, h) => k * (1 - h.fee / 1_000_000), 1)) * 100;
  return { route, amountIn, amountOut, minOut: fromRaw(minOutRaw, to.decimals), amountInRaw: toRaw(amountIn, from.decimals), amountOutRaw, minOutRaw, priceInUsd, priceOutUsd, costPct, feePct, pools };
}

/** PURE: the router call for a route, in the shape this chain's fork accepts. */
export function encodeSwap(route: Route, amountIn: bigint, minOut: bigint, recipient: `0x${string}`, deadline: bigint, router: `0x${string}` = chainMemory().contracts.uniswapV4.universalRouter as `0x${string}`): RawTx {
  const path = route.hops.map((h) => ({ intermediateCurrency: h.currencyOut, fee: h.fee, tickSpacing: h.tickSpacing, hooks: (h.spec.hookAddress ?? NATIVE) as `0x${string}`, hookData: "0x" as Hex }));
  const swap = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "currencyIn", type: "address" },
          {
            name: "path",
            type: "tuple[]",
            components: [
              { name: "intermediateCurrency", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
              { name: "hookData", type: "bytes" },
            ],
          },
          { name: "extra", type: "bytes" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
        ],
      },
    ],
    [{ currencyIn: route.currencyIn, path, extra: "0x", amountIn, amountOutMinimum: minOut }],
  );
  const currencyOut = route.hops[route.hops.length - 1].currencyOut;
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [route.currencyIn, 0n, true]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [currencyOut, recipient, 0n]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [ACTIONS, [swap, settle, take]]);
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "execute", args: [V4_SWAP, [input], deadline] });
  return { to: router, data, value: route.currencyIn === NATIVE ? amountIn : 0n };
}

/** The two one-time approvals an ERC-20 from-leg needs: token to Permit2, Permit2 to the router. Sends only what is missing. */
export async function ensureAllowances(from: Asset, amountRaw: bigint, now = Date.now(), wallet?: Wallet): Promise<string[]> {
  if (from.kind !== "erc20") return [];
  const c = chainMemory().contracts.uniswapV4;
  const token = from.contract as `0x${string}`;
  const permit2 = c.permit2 as `0x${string}`;
  const router = c.universalRouter as `0x${string}`;
  const owner = wallet?.address ?? (WALLET_ADDRESS as `0x${string}`);
  const sent: string[] = [];
  if ((await readErc20Allowance(from, token, permit2, owner)) < amountRaw) {
    const hash = await sendTx(from, { to: token, data: approveErc20Data(permit2), value: 0n }, wallet);
    const r = await waitReceipt(from, hash);
    if (!r || r.status !== "success") throw new Error(`token approval ${hash} did not land`);
    sent.push(hash);
  }
  const p = await readPermit2Allowance(from, permit2, token, router, owner);
  const nowSec = Math.floor(now / 1000);
  if (p.amount < amountRaw || p.expiration <= nowSec) {
    const hash = await sendTx(from, { to: permit2, data: approvePermit2Data(token, router, nowSec + 365 * 86400), value: 0n }, wallet);
    const r = await waitReceipt(from, hash);
    if (!r || r.status !== "success") throw new Error(`Permit2 approval ${hash} did not land`);
    sent.push(hash);
  }
  return sent;
}

/** What ensureAllowances would have to send, without sending it. For the probe. */
export async function ensureAllowancesNeeded(from: Asset, amountRaw: bigint, now = Date.now()): Promise<string[]> {
  if (from.kind !== "erc20") return [];
  const c = chainMemory().contracts.uniswapV4;
  const token = from.contract as `0x${string}`;
  const need: string[] = [];
  if ((await readErc20Allowance(from, token, c.permit2 as `0x${string}`)) < amountRaw) need.push(`${from.symbol}.approve(Permit2)`);
  const p = await readPermit2Allowance(from, c.permit2 as `0x${string}`, token, c.universalRouter as `0x${string}`);
  if (p.amount < amountRaw || p.expiration <= Math.floor(now / 1000)) need.push(`Permit2.approve(${from.symbol}, router)`);
  return need;
}

/** PURE: the most a route may cost against the pool mark, in percent. A launch token's pool charges its own tier each way, so its floor is that tier plus the ordinary allowance; everything else gets the ordinary allowance alone. */
export function costFloorPct(i: Intent, minFillRatio: number): number {
  const allowance = (1 - minFillRatio) * 100;
  const tier = Math.max(i.from.candidate?.tierPct ?? 0, i.to.candidate?.tierPct ?? 0);
  return allowance + tier;
}

export type OnChainResult = { ok: true; trade: Trade } | { ok: false; reason: string; trade?: Trade };

const balanceOf = (a: Asset, holder: string = WALLET_ADDRESS): Promise<bigint> => (a.kind === "native" ? readNativeBalance(a, holder) : readTokenBalance(a, a.contract as `0x${string}`, holder));

/**
 * Whose lane this is: the desk's own (the default: its wallet, its book, its sell proof), or a person's agent
 * wallet, whose rows go to that agent's own ledger and whose tokens the desk has already proven sellable.
 */
export interface RunAs {
  wallet: Wallet;
  /** Where the rows go; false means the ledger did not take the row, and the lane raises an alarm. */
  record: (t: Trade) => boolean | void;
}

/**
 * A row into a trade ledger, or an alarm. A row the ledger did not take is a swap the book has lost sight of, the
 * very thing the lane's intent row guards against (2026-09-08), so a person hears about it at once.
 */
async function recordOrAlert(record: RunAs["record"], t: Trade, now: number, alert: SendLane["alert"] = (k, text, at) => raiseAlert(k, text, at)): Promise<void> {
  if (record(t) !== false) return;
  const n = ledgerWriteFailures();
  await alert("cycle", `the trade ledger did not take the row for ${t.id} (${t.status}: ${t.from.amount} ${t.from.asset} to ${t.to.asset}${t.settlementTx ? `, tx ${t.settlementTx}` : ""}); the wallet holds what the chain says and the book does not know it; ${n} ledger write${n === 1 ? "" : "s"} failed in this process`, now);
}

/** The lane: rails, route, quote, floor, encode, simulate, approvals, send, receipt, the row. */
/** The desk's latest ETH price from its own samples, within three hours: for a leg the route cannot price, an ETH leg on a route that never passes the ETH/USDG pool. */
export function latestEthUsd(now = Date.now()): number | null {
  const s = readPrices().filter((x) => x.symbol === "ETH" && now - x.at <= 3 * 3600e3).sort((a, b) => b.at - a.at)[0];
  return s ? s.priceUsd : null;
}

/** PURE: a leg's dollar value: the route's price when it has one, else ETH at the desk's own price, else unpriced. A trade row with an unpriced ETH leg once read as a full loss in the desk's memory. */
export function legUsd(asset: Asset, amount: number, routePriceUsd: number | null, ethUsd: number | null): number | null {
  if (routePriceUsd != null) return amount * routePriceUsd;
  if (asset.symbol === "ETH" && ethUsd != null) return amount * ethUsd;
  return null;
}

export async function executeOnChain(i: Intent, c: RailContext, now = Date.now(), runAs?: RunAs): Promise<OnChainResult> {
  const address = runAs?.wallet.address ?? (WALLET_ADDRESS as `0x${string}`);
  // The desk's own swaps go out as one user operation when the operator says so (OBS_EXEC=aa, aa.ts); a follower's
  // wallet is a plain EOA and keeps the plain send whatever the switch says.
  const aa = aaOn() && !runAs;
  // The last check before anything is signed, independent of the rails object handed in: a never-trade contract on
  // either leg is refused here even if a caller built its own rails.
  for (const leg of [i.from, i.to]) if (leg.contract && NEVER_TRADE.has(leg.contract.toLowerCase())) return { ok: false, reason: `${leg.symbol} is on the never-trade list; not quoted, not approved, not sent` };
  // The rails hear whose wallet signs: an agent wallet's exit passes the trading switch (rails.ts, 2026-09-08).
  const gate = checkRails(i, runAs ? { ...c, runAs: true } : aa ? { ...c, aa: true } : c);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const q = await quoteOnChain(i.from, i.to, i.amount);
  if (!q) return { ok: false, reason: `no pool route from ${assetKey(i.from)} to ${assetKey(i.to)}, or the pools did not answer` };
  const ethUsd = latestEthUsd(now);
  const floor = costFloorPct(i, c.rails.minFillRatio);
  if (!i.exit && q.costPct != null && q.costPct > floor) return { ok: false, reason: `the pool route costs ${q.costPct.toFixed(2)}% against the mark; the floor is ${floor.toFixed(1)}%` };
  const deadline = BigInt(Math.floor(now / 1000) + 20 * 60);
  // An ERC-20 from-leg is clamped to the wallet's exact raw balance: the book's amount is a float of the balance and
  // can sit a few hundred wei above it, and a transfer of one wei more than the wallet holds reverts the whole sell.
  let amountInRaw = q.amountInRaw;
  // Under account abstraction an ETH leg is paid from the wallet's WETH, unwrapped inside the batch: the amount is
  // clamped to native plus WETH, since WETH.withdraw of one wei over the balance reverts the whole operation.
  let withdrawRaw = 0n;
  if (i.from.kind === "erc20" && i.from.contract) {
    try {
      amountInRaw = clampToBalanceRaw(q.amountInRaw, await readTokenBalance(i.from, i.from.contract as `0x${string}`, address));
    } catch { /* the quote's amount stands; the simulation says if it is too much */ }
    if (amountInRaw <= 0n) return { ok: false, reason: `the wallet holds no ${i.from.symbol} to send` };
  } else if (aa && i.from.kind === "native") {
    let spend: { native: bigint; weth: bigint };
    try {
      spend = await spendableEthRaw(address);
    } catch (err) {
      return { ok: false, reason: `the wallet's ETH and WETH could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
    const plan = ethInPlan(q.amountInRaw, spend.native, spend.weth);
    amountInRaw = plan.amountInRaw;
    withdrawRaw = plan.withdrawRaw;
    if (amountInRaw <= 0n) return { ok: false, reason: "the wallet holds no ETH or WETH to send" };
  }
  const amountIn = amountInRaw === q.amountInRaw ? i.amount : fromRaw(amountInRaw, i.from.decimals);
  const tx = encodeSwap(q.route, amountInRaw, q.minOutRaw, address, deadline);
  let approvals: string[] = [];
  let prepared: PreparedOp | null = null;
  // The route fomo's own app takes, when the operator has asked for it: the same pools underneath, through the
  // aggregator its followers are notified by. Only for the desk's own wallet, and only under the lane, since it is
  // the batch that makes it one operation. A route that will not quote or pays far less than the pools falls back
  // to the desk's own router rather than stopping the trade: the notification is worth a few percent, never a miss.
  let fomo: FomoRoute | null = null;
  if (aa && fomoOn()) {
    // A direct send needs the ETH leg wrapped: an ordinary transaction from this wallet cannot carry native value
    // it does not hold, and the app reads a plain router call as a buy where it reads a user operation as a receipt.
    const r = await fomoRoute({ from: i.from, to: i.to, amount: amountIn, amountInRaw, poolAmountOut: q.amountOut, user: address, ...(directOn() && i.from.kind === "native" ? { wethIn: wethAddress() } : {}) });
    if (r.ok) fomo = r.route;
    else console.log(`[fomo] the desk's own router is taking this one: ${r.reason}`);
  }
  // The send: an ordinary transaction when the operator asked for one and there is a fomo route to send, since that
  // is the only shape the app reads as a buy; the user operation otherwise, and whenever the direct send cannot be
  // set up. A notification is never worth a missed trade, so every failure here falls back rather than stopping.
  let direct: AaCall[] | null = null;
  if (aa && fomo && directOn()) {
    try {
      const g = await fundGas();
      if (g.hash) console.log(`[direct] gas topped up ${g.before} -> ${g.after} wei (${g.hash})`);
      direct = fomo.calls;
    } catch (err) {
      console.log(`[direct] falling back to the user operation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (aa && !direct) {
    const built = fomo ? await prepareFomoOp(i.from, fomo, now) : await prepareSwapOp(i.from, tx, withdrawRaw, amountInRaw, now);
    if (!built.ok) return { ok: false, reason: built.reason };
    prepared = built.prepared;
    approvals = built.approvals;
  } else if (!aa) {
    try {
      approvals = await ensureAllowances(i.from, amountInRaw, now, runAs?.wallet);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const sim = await simulateFromWallet(i.from, tx, address);
    if (!sim.ok) return { ok: false, reason: `the swap would revert: ${sim.reason}` };
  }
  const base: Trade = {
    at: now,
    id: nextTradeId(now),
    status: "pending",
    venue: "pool",
    ...(i.exit ? { exit: true } : {}),
    from: { asset: i.from.symbol, network: i.from.network, amount: amountIn, usd: i.usd ?? legUsd(i.from, amountIn, q.priceInUsd, ethUsd) },
    to: { asset: i.to.symbol, network: i.to.network, amount: fomo ? fomo.amountOut : q.amountOut, usd: legUsd(i.to, fomo ? fomo.amountOut : q.amountOut, q.priceOutUsd, ethUsd) },
    partner: fomo ? "fomo" : "pool",
    note: fomo
      ? `through fomo's own route, so the account's followers are told; expected ${fomo.amountOut} ${i.to.symbol}, ${fomo.giveUpPct >= 0 ? `${fomo.giveUpPct.toFixed(2)}% under` : `${(-fomo.giveUpPct).toFixed(2)}% over`} the pools' ${q.amountOut}${fomo.feeUsd != null ? `, its fees $${fomo.feeUsd.toFixed(2)}` : ""}${approvals.length ? `; ${approvals.join(", ")}` : ""}${prepared ? `; one user operation through the entry point (${prepared.userOpHash.slice(0, 10)}), gas from the gas wallet` : direct ? `; sent straight to the router as ${direct.length} ordinary transaction${direct.length === 1 ? "" : "s"}, which is the shape the app reads as a buy` : ""}`
      : `${q.route.hops.map((h) => h.key).join(" then ")} on chain; expected ${q.amountOut} ${i.to.symbol}, floor ${q.minOut}${q.costPct != null ? `, route cost ${q.costPct.toFixed(2)}% (fees ${q.feePct.toFixed(2)}%)` : ""}${approvals.length ? `; approvals ${approvals.join(", ")}` : ""}${prepared ? `; one user operation through the entry point (${prepared.userOpHash.slice(0, 10)}), gas from the gas wallet` : ""}`,
  };
  if (direct) {
    const poolManager = chainMemory().contracts.uniswapV4.poolManager;
    return sendSwap({ intent: i, base, tx, quote: q, address, ethUsd, now, aa: { fill: (logs) => aaFillFromLogs(logs, i.to, q.route, address, poolManager) } }, directLane(direct));
  }
  if (prepared) {
    const poolManager = chainMemory().contracts.uniswapV4.poolManager;
    return sendSwap({ intent: i, base, tx, quote: q, address, ethUsd, now, aa: { fill: (logs) => aaFillFromLogs(logs, i.to, q.route, address, poolManager) } }, aaLane(prepared));
  }
  return sendSwap({ intent: i, base, tx, quote: q, address, ethUsd, now, runAs });
}

/**
 * Fomo's own route as one user operation: the transactions Relay handed back, with the WETH the batch spends
 * unwrapped ahead of them (the wallet holds no native ETH), then the same deposit and simulation as any other
 * operation. The calls were checked against fomo's routers before this is called; nothing here trusts them again,
 * and the simulation is the last word.
 */
async function prepareFomoOp(from: Asset, route: FomoRoute, now: number): Promise<{ ok: true; prepared: PreparedOp; approvals: string[] } | { ok: false; reason: string }> {
  const calls = route.valueRaw > 0n ? [{ to: WETH_CONTRACT as `0x${string}`, value: 0n, data: wethWithdrawData(route.valueRaw) }, ...route.calls] : route.calls;
  const approvals = route.calls.length > 1 ? [`${from.symbol} approved to fomo's router in the batch`] : [];
  return finishOp(calls, approvals, now);
}

/**
 * The swap as one user operation (aa.ts): the approvals a token sell still lacks are read and put into the batch
 * ahead of the router call rather than sent on their own, the operation is built and signed, the wallet's
 * EntryPoint deposit is topped up by the gas wallet when it would not cover the prefund, and the whole thing is
 * simulated, the batch as a self-call and the validation as the EntryPoint runs it. A reason means nothing was sent.
 */
async function prepareSwapOp(from: Asset, tx: RawTx, withdrawRaw: bigint, amountInRaw: bigint, now: number): Promise<{ ok: true; prepared: PreparedOp; approvals: string[] } | { ok: false; reason: string }> {
  const c4 = chainMemory().contracts.uniswapV4;
  const approvals: string[] = [];
  let token: SwapBatchToken | undefined;
  if (from.kind === "erc20" && from.contract) {
    const contract = from.contract as `0x${string}`;
    const permit2 = c4.permit2 as `0x${string}`;
    const router = c4.universalRouter as `0x${string}`;
    const nowSec = Math.floor(now / 1000);
    try {
      const needErc20Approve = (await readErc20Allowance(from, contract, permit2)) < amountInRaw;
      const p = await readPermit2Allowance(from, permit2, contract, router);
      const needPermit2Approve = p.amount < amountInRaw || p.expiration <= nowSec;
      token = { contract, permit2, router, needErc20Approve, needPermit2Approve, expiration: nowSec + 365 * 86400 };
      if (needErc20Approve) approvals.push(`${from.symbol}.approve(Permit2) in the batch`);
      if (needPermit2Approve) approvals.push(`Permit2.approve(${from.symbol}, router) in the batch`);
    } catch (err) {
      return { ok: false, reason: `the allowances could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return finishOp(swapBatch({ tx, withdrawRaw, token }), approvals, now);
}

/** Build, fund and simulate one batch, whichever router it goes to. A reason means nothing was sent. */
async function finishOp(calls: AaCall[], approvals: string[], now: number): Promise<{ ok: true; prepared: PreparedOp; approvals: string[] } | { ok: false; reason: string }> {
  void now;
  let prepared: PreparedOp;
  try {
    prepared = await buildUserOp(calls);
  } catch (err) {
    return { ok: false, reason: `the swap would revert: ${err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message).split("\n")[0].slice(0, 220) : String(err)}` };
  }
  try {
    const prefund = prefundWei(prepared.gas);
    const min = depositMinWei() > prefund ? depositMinWei() : prefund;
    const topUp = depositTopUpWei() > min ? depositTopUpWei() : min;
    const d = await ensureDeposit(min, topUp);
    if (d.hash) console.log(`[aa] entry point deposit topped up from ${d.before} to ${d.after} wei (${d.hash})`);
  } catch (err) {
    return { ok: false, reason: `the entry point deposit could not be kept up: ${err instanceof Error ? err.message : String(err)}` };
  }
  const sim = await simulateUserOp(prepared);
  if (!sim.ok) return { ok: false, reason: `the user operation would fail: ${sim.reason}` };
  return { ok: true, prepared, approvals };
}

/**
 * PURE with logs: what a swap paid out under account abstraction, from the handleOps receipt's own logs: the
 * Transfer to the wallet for a token, the last hop's Swap delta for native ETH (which leaves no Transfer log and
 * which the app wraps within seconds of landing). Null when the logs say nothing.
 */
export function aaFillFromLogs(logs: ReceiptRead["logs"], to: Asset, route: Route, recipient: string, poolManager?: string): bigint | null {
  if (to.kind === "native") {
    const last = route.hops[route.hops.length - 1];
    return last?.spec.id ? nativeOutFromSwapLogs(logs, last.spec.id, !last.zeroForOne, poolManager) : null;
  }
  return to.contract ? receivedRawFromLogs(logs, to.contract, recipient) : null;
}

/** The lane's effects past the quote and the simulation, injectable so the order of the rows can be tested without a chain. */
export interface SendLane {
  send: (asset: Asset, tx: RawTx, wallet?: Wallet) => Promise<`0x${string}`>;
  /** The receipt: its status, what its gas cost, and under account abstraction its logs (the fill is read from them) and the batch's revert reason. */
  wait: (asset: Asset, hash: `0x${string}`) => Promise<{ status: "success" | "reverted"; gasCostWei: bigint; logs?: ReceiptRead["logs"]; reason?: string } | null>;
  balance: (asset: Asset, holder: string) => Promise<bigint>;
  alert: (kind: AlertKind, text: string, now: number) => Promise<boolean>;
  clock: () => number;
}
const LIVE_LANE: SendLane = { send: (a, tx, w) => sendTx(a, tx, w), wait: (a, h) => waitReceipt(a, h), balance: (a, holder) => balanceOf(a, holder), alert: (k, text, at) => raiseAlert(k, text, at), clock: () => Date.now() };

/**
 * The lane under account abstraction: the send is the prepared user operation through the gas wallet, the wait
 * reads the operation's own outcome out of the handleOps receipt (the transaction lands as success even when the
 * batch reverted), and ETH is counted as native plus WETH, which the app's sweep leaves unchanged.
 */
/**
 * The lane for an ordinary send: the route's calls go out as plain transactions from the trading wallet, in order,
 * and the swap's own hash is the one the book keeps. ETH is still counted as native plus WETH, since the wallet's
 * balance is wrapped either way.
 */
function directLane(calls: AaCall[]): SendLane {
  return {
    send: async () => (await sendDirect(calls)).hash,
    wait: async (a, h) => {
      const r = await waitReceipt(a, h);
      if (!r) return null;
      // The fill is read from the logs when the balance says nothing, the same as under a user operation.
      const full = await readReceipt(a, h).catch(() => null);
      return { status: r.status, gasCostWei: r.gasCostWei, ...(full ? { logs: full.logs } : {}) };
    },
    balance: async (a, holder) => (a.kind === "native" ? (await spendableEthRaw(holder)).total : balanceOf(a, holder)),
    alert: (k, text, at) => raiseAlert(k, text, at),
    clock: () => Date.now(),
  };
}

function aaLane(p: PreparedOp): SendLane {
  return {
    send: () => submitUserOp(p),
    wait: async (_asset, hash) => {
      const r = await waitUserOp(hash, p.userOpHash);
      return r ? { status: r.status, gasCostWei: r.gasCostWei, logs: r.logs, ...(r.op.reason ? { reason: r.op.reason } : {}) } : null;
    },
    balance: async (a, holder) => (a.kind === "native" ? (await spendableEthRaw(holder)).total : balanceOf(a, holder)),
    alert: LIVE_LANE.alert,
    clock: LIVE_LANE.clock,
  };
}

export interface SendJob {
  intent: Intent;
  /** The row as the lane will write it: pending, no hash, the estimate on the to leg. */
  base: Trade;
  tx: RawTx;
  quote: Pick<PoolQuote, "amountOut" | "amountOutRaw" | "priceOutUsd">;
  address: `0x${string}`;
  ethUsd: number | null;
  now: number;
  runAs?: RunAs;
  /** Set when the send is a user operation: the fill from the receipt's logs, and no gas of the wallet's to add back to a native leg. */
  aa?: { fill: (logs: ReceiptRead["logs"]) => bigint | null };
}

/**
 * Send, with the book ahead of the chain. The row goes into the ledger as pending with no hash BEFORE the
 * transaction is signed, again with its hash the moment the send returns, again with its outcome after the
 * receipt, and failed when the send throws; every writing carries the same id, and the latest row per id is the
 * one the book reads. Until 2026-09-08 the first row was written after the receipt, up to two minutes after the
 * send: a process that died in between left the token in the wallet with no row, and the exit scan sells only what
 * the ledger says was bought. The hash row came the same day: written only after the receipt, a redeploy inside
 * the wait left a landed swap as a hashless pending row, the settle pass failed it after its allowance, and a $200
 * position left the book with no rails on it. A row the ledger would not take is an alarm, since the book has just
 * lost sight of money in motion.
 */
export async function sendSwap(job: SendJob, lane: SendLane = LIVE_LANE): Promise<OnChainResult> {
  const { intent: i, base, tx, quote: q, address, ethUsd, now, runAs, aa } = job;
  const record = runAs?.record ?? recordTrade;
  const put = (t: Trade) => recordOrAlert(record, t, now, lane.alert);
  const before = await lane.balance(i.to, address);
  await put({ ...base, note: `${base.note}; signing and sending, no hash yet` });
  let hash: `0x${string}`;
  try {
    hash = await lane.send(i.from, tx, runAs?.wallet);
  } catch (err) {
    const failed: Trade = { ...base, status: "failed", updatedAt: lane.clock(), note: `not sent: ${err instanceof Error ? err.message : String(err)}` };
    await put(failed);
    return { ok: false, reason: failed.note ?? "send failed", trade: failed };
  }
  const explorerUrl = chainOf(i.from).explorerTx(hash);
  // The hash row before the wait: the send has returned, the swap is on the chain, and this is the row a process
  // killed inside the receipt wait leaves behind (2026-09-08).
  const pending: Trade = { ...base, updatedAt: lane.clock(), settlementTx: hash, explorerUrl, note: `${base.note}; sent, awaiting the receipt` };
  await put(pending);
  const receipt = await lane.wait(i.from, hash);
  if (!receipt) return { ok: true, trade: pending };
  if (receipt.status !== "success") {
    const failed: Trade = { ...base, status: "failed", updatedAt: lane.clock(), settlementTx: hash, explorerUrl, note: `reverted on chain${receipt.reason ? `: ${receipt.reason}` : ""}` };
    await put(failed);
    return { ok: false, reason: `swap ${hash} reverted${receipt.reason ? `: ${receipt.reason}` : ""}`, trade: failed };
  }
  const after = await lane.balance(i.to, address);
  let gotRaw = after - before;
  // The wallet paid the gas of a plain send, so a native leg gets it added back; under account abstraction the
  // gas wallet paid it, and when the balance reads say nothing the fill is read from the receipt's own logs.
  if (i.to.kind === "native" && !aa) gotRaw += receipt.gasCostWei;
  if (aa && gotRaw <= 0n && receipt.logs) {
    const logged = aa.fill(receipt.logs);
    if (logged != null && logged > 0n) gotRaw = logged;
  }
  const got = gotRaw > 0n ? fromRaw(gotRaw, i.to.decimals) : q.amountOut;
  const settled: Trade = {
    ...base,
    status: "settled",
    updatedAt: lane.clock(),
    settlementTx: hash,
    explorerUrl,
    to: { ...base.to, amount: got, usd: legUsd(i.to, got, q.priceOutUsd, ethUsd) },
    note: `${base.note}; received ${got} ${i.to.symbol}`,
  };
  await put(settled);
  // The sell proof is the desk's probe on its own first buy; a follower's token was proven by the desk already.
  if (!runAs && i.to.candidate && got > 0) {
    const proof = await proveSellable(i.to, gotRaw > 0n ? gotRaw : q.amountOutRaw, now);
    const withProof: Trade = { ...settled, note: `${settled.note}; ${proof}` };
    await put(withProof);
    return { ok: true, trade: withProof };
  }
  return { ok: true, trade: settled };
}

/**
 * The probe rule's second half. Right after the first buy of a launch token
 * the desk grants the two approvals and simulates selling what it just got.
 * A token whose sell reverts is blacklisted (bounded cost: the probe) and
 * never bought again; one whose sell simulates is proven and may be sized
 * up to the ordinary cap on later cycles.
 */
export async function proveSellable(token: Asset, amountRaw: bigint, now = Date.now()): Promise<string> {
  const eth = ASSETS["ETH@robinhood"];
  const known = tokenInfo(token.contract as string);
  const c = token.candidate as NonNullable<Asset["candidate"]>;
  const base = known ?? { symbol: token.symbol, contract: token.contract as `0x${string}`, decimals: token.decimals, poolId: c.poolId, feePct: c.tierPct, tickSpacing: c.tickSpacing, usdgIs0: c.usdgIs0, firstSeen: now, proven: null, blacklisted: false, ...(c.curve ? { curve: c.curve } : {}) };
  if (base.proven === true) return "sell already proven";
  try {
    const route = routeFor(token, eth);
    if (!route) throw new Error("no route back to ETH");
    if (aaOn()) {
      // Under account abstraction nothing is sent for the proof: the wallet holds no native ETH to pay for an
      // approval of its own, so the sell with both approvals ahead of it runs as one batch in simulation, the
      // self-call the account admits (aa.ts). The approvals go out inside the real exit's batch.
      const c4 = chainMemory().contracts.uniswapV4;
      const nowSec = Math.floor(now / 1000);
      const tx = encodeSwap(route, amountRaw, 1n, WALLET_ADDRESS as `0x${string}`, BigInt(nowSec + 1200));
      const calls = swapBatch({ tx, withdrawRaw: 0n, token: { contract: token.contract as `0x${string}`, permit2: c4.permit2 as `0x${string}`, router: c4.universalRouter as `0x${string}`, needErc20Approve: true, needPermit2Approve: true, expiration: nowSec + 365 * 86400 } });
      const sim = await simulateBatch(calls);
      if (!sim.ok) throw new Error(sim.reason);
      upsertToken({ ...base, proven: true, blacklisted: false, note: `sell proven ${new Date(now).toISOString()}` });
      return "sell proven: the token can be sold back through its pool (simulated as one batch with its approvals)";
    }
    await ensureAllowances(token, amountRaw, now);
    const sim = await simulateFromWallet(token, encodeSwap(route, amountRaw, 1n, WALLET_ADDRESS as `0x${string}`, BigInt(Math.floor(now / 1000) + 1200)));
    if (!sim.ok) throw new Error(sim.reason);
    upsertToken({ ...base, proven: true, blacklisted: false, note: `sell proven ${new Date(now).toISOString()}` });
    return "sell proven: the token can be sold back through its pool";
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    upsertToken({ ...base, proven: false, blacklisted: true, note: `sell failed in simulation: ${why}` });
    return `sell NOT proven (${why}); ${token.symbol} is blacklisted, no further buys`;
  }
}

/**
 * Exits the rails force, before the model thinks: every held launch token is
 * checked against the time stop, the floor and the volume roll-over, and sold
 * back to ETH when one trips. Exits skip the caps; they are never blocked.
 */
export async function exitCandidates(balances: Record<string, number>, prices: Record<string, number | null>, ctx: RailContext, feed: FeedSnapshot = readFeed(), now = Date.now(), exec: (i: Intent, c: RailContext, now: number) => Promise<OnChainResult> = executeOnChain, extraTrades: Trade[] = [], after?: (i: Intent, row: Trade, heldBefore: number) => Promise<void>): Promise<Trade[]> {
  const out: Trade[] = [];
  const eth = ASSETS["ETH@robinhood"];
  const dyn = dynamicAssets(feed);
  const book = readBook();
  const allTrades = [...book.trades, ...extraTrades];
  const samples = readPrices();
  // The peaks the watch persisted: the tape's window is short, and the position's high may be behind it (2026-09-08).
  const tapePeaks = readTapePeaks();
  // Only what the desk bought is ever sold: an airdrop in the wallet is not a position and is never touched.
  const bought = boughtSymbols(allTrades);
  for (const a of Object.values(dyn)) {
    const held = balances[a.symbol] ?? 0;
    if (a.contract && NEVER_TRADE.has(a.contract.toLowerCase())) continue;
    if (!bought.has(a.symbol) || !isHolding(held) || !a.candidate) continue;
    const hourly = feed.hourly[a.candidate.poolId.toLowerCase()] ?? [];
    const rows = readTape(a.candidate.poolId);
    const tape = tapeStats(rows, a.symbol, now, 15);
    // The mark is the tape's last swap in dollars, the price the watch reads the rails at, so a rail the watch saw
    // tripped is the rail this pass sees; the price feed stands in only when the pool has not traded in the window.
    // Priced from the feed alone, this pass dismissed a floor the watch had tripped at the tape's price, and the
    // watch had raised it once (2026-09-08).
    const quote = dynamicPoolSpec(a)?.quote ?? "USDG";
    const quotePriceUsd = quoteUsd(quote, prices, samples, now);
    const priceUsd = tapeLastUsd(rows, quotePriceUsd, now, tapeWindowMin()) ?? prices[a.symbol] ?? null;
    // The position held now, not a round trip closed earlier today: its peak, its age and its take-profit memory
    // start at this span's first buy, or at the candidate's first sighting when the ledger has no buy (railInput.ts).
    // The peak reads the tape and the watch's persisted high too, not the cycle-time samples alone (2026-09-08).
    const input = railInput({ symbol: a.symbol, qty: held, priceUsd, trades: allTrades, flows: book.flows, samples, tapeRows: rows, quote, quotePriceUsd, tapePeaks, hourly, tapeTrend: tape.trend, tapeBuyPressurePct: tape.buyPressurePct, now, seenAt: a.candidate.seenAt });
    const v = exitVerdict(input, ctx.rails);
    if (!v) continue;
    const amount = v.share >= 1 ? held : Number((held * v.share).toPrecision(8));
    const usd = priceUsd != null ? amount * priceUsd : null;
    const exitIntent: Intent = { from: a, to: eth, amount, usd, exit: true };
    const r = await exec(exitIntent, ctx, now);
    if (r.ok) {
      // The ETH that came back is priced so the close is recorded as what it was: the exit prices carry ETH for this.
      const toUsd = r.trade.to.usd ?? (prices.ETH != null && r.trade.to.amount != null ? r.trade.to.amount * prices.ETH : null);
      const row: Trade = { ...r.trade, to: { ...r.trade.to, usd: toUsd }, note: `exit (${v.kind}), ${v.reason}; ${r.trade.note ?? ""}` };
      if (exec === executeOnChain) await recordOrAlert(recordTrade, row, now);
      // The desk's real exit is every follower's exit too: what was sold, of what was held, so each sells the same share.
      if (exec === executeOnChain && after) await after(exitIntent, row, held).catch((e) => console.error(`[follow] exit mirror of ${a.symbol}: ${e instanceof Error ? e.message : String(e)}`));
      out.push(row);
      // A close is remembered from a settled sell only: a receipt still pending has no ETH leg yet, and the close it
      // produced read as a full loss in the desk's memory (2026-09-08). settleOnChain remembers it once it lands.
      if (v.share >= 1 && row.status === "settled") rememberClose(a.symbol, a.contract ?? "", [...allTrades, row], ethUsdAt(samples, prices.ETH ?? null), input.peakPnlPct, v.kind, exec !== executeOnChain, now);
    } else if ("trade" in r && r.trade) out.push(r.trade);
    else {
      // A position the rails wanted out of and could not sell: the one failure a person must hear about at once.
      console.error(`[desk] exit of ${a.symbol} refused: ${r.reason}`);
      if (exec === executeOnChain) await raiseAlert("exit", `the desk could not sell ${a.symbol} (${v.kind}: ${v.reason}); the chain refused it: ${r.reason}`, now);
    }
  }
  return out;
}

/** Rows the lane sent but could not wait for: settle them by their receipt. */
export async function settleOnChain(now = Date.now()): Promise<Trade[]> {
  const updated: Trade[] = [];
  const feed = readFeed();
  for (const t of latestTrades(readBook().trades).filter((x) => x.status === "pending" && x.venue === "pool")) {
    if (!t.settlementTx) {
      // The row the lane writes before its send (2026-09-08). With no hash there is no receipt to wait for, and it is
      // never settled from here: past the allowance it is failed, since the send did not come back (the process died
      // in it, or the ledger would not take the row after it), and only the wallet says whether the token arrived.
      if (!intentTimedOut(t, now)) continue;
      const row: Trade = { ...t, status: "failed", updatedAt: now, note: `${t.note ?? ""}; no hash was recorded within ${INTENT_STALE_MIN} min of the send: failed on the book; the wallet says whether ${t.to.asset} arrived` };
      await recordOrAlert(recordTrade, row, now);
      updated.push(row);
      await raiseAlert("cycle", `swap ${t.id} (${t.from.amount} ${t.from.asset} to ${t.to.asset}, sent ${new Date(t.at).toISOString().slice(11, 16)} UTC) never got its hash on the book and is failed there; check the wallet for ${t.to.asset}, and correct the trade ledger if it arrived`, now);
      continue;
    }
    // A launch token is a dynamic asset: the static registry alone left every pending sell of one pending forever (2026-09-08).
    const key = `${t.from.asset}@${t.from.network ?? "robinhood"}`;
    const from = ASSETS[key] ?? resolveAny(key, feed);
    if (!from) continue;
    const r = await waitReceipt(from, t.settlementTx as `0x${string}`, 5_000);
    if (!r) continue;
    // Under account abstraction the hash is a handleOps transaction, which lands as success whether or not the
    // batch ran; the operation's own event says which (aa.ts).
    let landed = r.status === "success";
    let why = "";
    if (landed && aaOn()) {
      const op = await opOutcomeOf(t.settlementTx as `0x${string}`);
      if (op && !op.success) {
        landed = false;
        why = op.reason ? ` (${op.reason})` : "";
      }
    }
    const row: Trade = { ...t, status: landed ? "settled" : "failed", updatedAt: now, note: `${t.note ?? ""}; ${landed ? "landed" : `reverted${why}`} (amount as estimated)` };
    await recordOrAlert(recordTrade, row, now);
    updated.push(row);
    // A sell that landed late closes its position in the desk's memory here, since the exit pass only remembers a
    // close from a sell that settled in its own window (2026-09-08). Closed means the wallet no longer holds the token.
    if (row.exit && landed && from.contract) {
      try {
        const left = Number(await readTokenBalance(from, from.contract as `0x${string}`, WALLET_ADDRESS as `0x${string}`)) / 10 ** from.decimals;
        if (!isHolding(left)) {
          const kind = /exit \(([a-z-]+)\)/.exec(row.note ?? "")?.[1] ?? "settled";
          rememberClose(t.from.asset, from.contract, latestTrades(readBook().trades), ethUsdAt(readPrices(), latestEthUsd(now)), null, kind, false, now);
        }
      } catch (e) {
        console.error(`[desk] the late close of ${t.from.asset} was not remembered: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return updated;
}

/** The pool routes for the watchlist legs on Robinhood Chain, as quotes the observation can print beside Obscura's. */
export async function poolQuotes(legs: Array<{ from: Asset; to: Asset; amount: number }>, now = Date.now()): Promise<QuoteRead[]> {
  const out: QuoteRead[] = [];
  for (const l of legs) {
    const q = await quoteOnChain(l.from, l.to, l.amount);
    out.push({ from: l.from.symbol, to: l.to.symbol, amountIn: l.amount, amountOut: q ? q.amountOut : null, partner: q ? `pool on chain${q.costPct != null ? `, ${q.costPct.toFixed(2)}% all in` : ""}` : "pool", at: now });
  }
  return out;
}

/**
 * A closed launch trade into the desk's memory: its result computed from its own buys and sells in the ledger
 * (the sell that just closed it included), its setup from the entry the desk recorded for that span.
 */
export function rememberClose(symbol: string, token: string, trades: Trade[], ethAt: (at: number) => number | null, peakPct: number | null, exitKind: string, paper: boolean, now = Date.now()): TradeClose | null {
  const mine = trades.filter((t) => String(t.id).startsWith("paper-") === paper);
  const last = positionSpans(mine, symbol).at(-1);
  if (!last) return null;
  const span = { ...last, exitedAt: last.exitedAt ?? now };
  const entry = entryForSpan(readEntries(), span, paper, now);
  const row = closeRow(span, entry, closeFromSpan(span, ethAt, now, entry?.usd ?? null), token, peakPct, exitKind, paper, now);
  recordClose(row);
  return row;
}

